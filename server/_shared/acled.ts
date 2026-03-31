/**
 * Shared ACLED API fetch with Redis caching + multi-account rotation.
 *
 * Three endpoints call ACLED independently (risk-scores, unrest-events,
 * acled-events) with overlapping queries. This shared layer ensures
 * identical queries hit Redis instead of making redundant upstream calls.
 *
 * Multi-account: parses ACLED_ACCOUNTS env (comma-separated email:password
 * pairs). On 401/403, marks the current account as blocked (30 min cooldown)
 * and rotates to the next. Falls back to legacy ACLED_EMAIL/ACLED_PASSWORD.
 */
import { CHROME_UA } from './constants';
import { cachedFetchJson } from './redis';
import { proxyFetch } from './proxy-fetch';

const ACLED_API_URL = 'https://acleddata.com/api/acled/read';
const ACLED_TOKEN_URL = 'https://acleddata.com/oauth/token';
const ACLED_CACHE_TTL = 900; // 15 min — matches ACLED rate-limit window
const ACLED_TIMEOUT_MS = 15_000;
const BLOCK_COOLDOWN_MS = 30 * 60_000; // 30 min cooldown per blocked account
const REFRESH_COOLDOWN_MS = 30_000; // Don't retry same account refresh within 30s

// ---- Multi-account state ----

interface AcledAccount {
  email: string;
  password: string;
  accessToken: string | null;
  refreshToken: string | null;
  blocked: boolean;
  blockedAt: number;
  lastRefreshAttempt: number;
}

const accounts: AcledAccount[] = [];
let currentAccountIdx = 0;
let initialized = false;

/** In-flight token refresh promise (coalesce concurrent 403 retries) */
let refreshPromise: Promise<string | null> | null = null;

function initAccounts(): void {
  if (initialized) return;
  initialized = true;

  // Parse ACLED_ACCOUNTS=email1:pass1,email2:pass2,...
  const accountsStr = process.env.ACLED_ACCOUNTS;
  if (accountsStr) {
    for (const pair of accountsStr.split(',')) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx < 1) continue;
      const email = trimmed.slice(0, colonIdx);
      const password = trimmed.slice(colonIdx + 1);
      if (email && password) {
        accounts.push({
          email, password,
          accessToken: null, refreshToken: null,
          blocked: false, blockedAt: 0, lastRefreshAttempt: 0,
        });
      }
    }
  }

  // Fallback: legacy single-account env vars
  if (accounts.length === 0) {
    const email = process.env.ACLED_EMAIL;
    const password = process.env.ACLED_PASSWORD;
    if (email && password) {
      accounts.push({
        email, password,
        accessToken: process.env.ACLED_ACCESS_TOKEN || null,
        refreshToken: process.env.ACLED_REFRESH_TOKEN || null,
        blocked: false, blockedAt: 0, lastRefreshAttempt: 0,
      });
    }
  }

  // Seed first account with existing tokens from env (if using ACLED_ACCOUNTS)
  if (accounts.length > 0 && !accounts[0].accessToken && process.env.ACLED_ACCESS_TOKEN) {
    accounts[0].accessToken = process.env.ACLED_ACCESS_TOKEN;
    accounts[0].refreshToken = process.env.ACLED_REFRESH_TOKEN || null;
  }

  console.log(`[ACLED] Initialized ${accounts.length} account(s)`);
}

/** Get the next available (non-blocked) account, or null if all blocked */
function getActiveAccount(): AcledAccount | null {
  initAccounts();
  if (accounts.length === 0) return null;

  const now = Date.now();
  // Unblock accounts past cooldown
  for (const acc of accounts) {
    if (acc.blocked && now - acc.blockedAt > BLOCK_COOLDOWN_MS) {
      acc.blocked = false;
      acc.accessToken = null; // Force re-auth
      console.log(`[ACLED] Unblocked account: ${acc.email}`);
    }
  }

  // Try from current index forward, wrapping around
  for (let i = 0; i < accounts.length; i++) {
    const idx = (currentAccountIdx + i) % accounts.length;
    if (!accounts[idx].blocked) {
      currentAccountIdx = idx;
      return accounts[idx];
    }
  }
  return null; // All blocked
}

function markBlocked(acc: AcledAccount): void {
  acc.blocked = true;
  acc.blockedAt = Date.now();
  acc.accessToken = null;
  acc.refreshToken = null;
  console.warn(`[ACLED] Account blocked: ${acc.email} (cooldown ${BLOCK_COOLDOWN_MS / 60_000}min)`);

  // Auto-rotate to next
  currentAccountIdx = (currentAccountIdx + 1) % accounts.length;
}

async function refreshAccountToken(acc: AcledAccount): Promise<string | null> {
  const now = Date.now();
  if (now - acc.lastRefreshAttempt < REFRESH_COOLDOWN_MS) return null;
  acc.lastRefreshAttempt = now;

  try {
    // Try refresh_token first if available
    if (acc.refreshToken) {
      const resp = await proxyFetch(ACLED_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `refresh_token=${encodeURIComponent(acc.refreshToken)}&grant_type=refresh_token&client_id=acled`,
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { access_token?: string; refresh_token?: string };
        if (data.access_token) {
          acc.accessToken = data.access_token;
          if (data.refresh_token) acc.refreshToken = data.refresh_token;
          console.log(`[ACLED] Token refreshed via refresh_token: ${acc.email}`);
          return data.access_token;
        }
      }
    }

    // Try password grant
    const resp = await proxyFetch(ACLED_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(acc.email)}&password=${encodeURIComponent(acc.password)}&grant_type=password&client_id=acled`,
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        markBlocked(acc);
      }
      return null;
    }

    const data = (await resp.json()) as { access_token?: string; refresh_token?: string };
    if (data.access_token) {
      acc.accessToken = data.access_token;
      if (data.refresh_token) acc.refreshToken = data.refresh_token;
      acc.blocked = false; // Successful auth = unblock
      console.log(`[ACLED] Token refreshed via password: ${acc.email}`);
      return data.access_token;
    }
  } catch (err) {
    console.warn(`[ACLED] Token refresh failed for ${acc.email}:`, err);
  }
  return null;
}

/** Get a valid token, rotating accounts as needed */
async function getValidToken(): Promise<string | null> {
  initAccounts();

  // Try up to accounts.length rotations
  for (let attempt = 0; attempt < accounts.length; attempt++) {
    const acc = getActiveAccount();
    if (!acc) return null;

    // Has a token? Use it
    if (acc.accessToken) return acc.accessToken;

    // No token — refresh
    const token = await refreshAccountToken(acc);
    if (token) return token;

    // Refresh failed but account not blocked — try next
    if (!acc.blocked) {
      currentAccountIdx = (currentAccountIdx + 1) % accounts.length;
    }
  }
  return null;
}

/** Handle 401/403 by marking current account blocked and trying next */
async function handleAuthFailure(): Promise<string | null> {
  const acc = getActiveAccount();
  if (acc) {
    markBlocked(acc);
  }

  // Try the next account
  const nextAcc = getActiveAccount();
  if (!nextAcc) return null;

  if (nextAcc.accessToken) return nextAcc.accessToken;
  return refreshAccountToken(nextAcc);
}

// ---- Public API ----

export interface AcledRawEvent {
  event_id_cnty?: string;
  event_type?: string;
  sub_event_type?: string;
  country?: string;
  location?: string;
  latitude?: string;
  longitude?: string;
  event_date?: string;
  fatalities?: string;
  source?: string;
  actor1?: string;
  actor2?: string;
  admin1?: string;
  notes?: string;
  tags?: string;
}

interface FetchAcledOptions {
  eventTypes: string;
  startDate: string;
  endDate: string;
  country?: string;
  limit?: number;
}

/**
 * Fetch ACLED events with automatic Redis caching.
 * Cache key is derived from query parameters so identical queries across
 * different handlers share the same cached result.
 */
export async function fetchAcledCached(opts: FetchAcledOptions): Promise<AcledRawEvent[]> {
  let token = await getValidToken();
  if (!token) return [];

  const cacheKey = `acled:shared:${opts.eventTypes}:${opts.startDate}:${opts.endDate}:${opts.country || 'all'}:${opts.limit || 500}`;
  const result = await cachedFetchJson<AcledRawEvent[]>(cacheKey, ACLED_CACHE_TTL, async () => {
    const params = new URLSearchParams({
      event_type: opts.eventTypes,
      event_date: `${opts.startDate}|${opts.endDate}`,
      event_date_where: 'BETWEEN',
      limit: String(opts.limit || 500),
      _format: 'json',
    });
    if (opts.country) params.set('country', opts.country);

    const doFetch = async (bearerToken: string) => {
      return proxyFetch(`${ACLED_API_URL}?${params}`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${bearerToken}`,
          'User-Agent': CHROME_UA,
        },
        signal: AbortSignal.timeout(ACLED_TIMEOUT_MS),
      });
    };

    let resp = await doFetch(token!);

    // On 401/403, rotate account and retry
    if (resp.status === 401 || resp.status === 403) {
      if (!refreshPromise) {
        refreshPromise = handleAuthFailure().finally(() => { refreshPromise = null; });
      }
      const newToken = await refreshPromise;
      if (newToken) {
        token = newToken;
        resp = await doFetch(newToken);
      }
    }

    if (!resp.ok) throw new Error(`ACLED API error: ${resp.status}`);
    const data = (await resp.json()) as { data?: AcledRawEvent[]; message?: string; error?: string };
    if (data.message || data.error) throw new Error(data.message || data.error || 'ACLED API error');

    const events = data.data || [];
    return events.length > 0 ? events : null;
  },
    600, // negative cache 10 min — ACLED account blocked, avoid hammering
  );
  return result || [];
}

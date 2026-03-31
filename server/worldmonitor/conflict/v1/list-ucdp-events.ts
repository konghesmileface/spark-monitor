import type {
  ServerContext,
  ListUcdpEventsRequest,
  ListUcdpEventsResponse,
  UcdpViolenceEvent,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { proxyFetch } from '../../../_shared/proxy-fetch';
import { CHROME_UA } from '../../../_shared/constants';

const CACHE_KEY = 'conflict:ucdp-events:v1';
const MAX_AGE_MS = 25 * 60 * 60 * 1000; // 25h — reject if cron hasn't refreshed

let fallback: { events: UcdpViolenceEvent[]; ts: number } | null = null;

// ========================================================================
// Direct UCDP GED API fallback (when Redis cache is empty/stale)
// ========================================================================

const UCDP_FETCH_TIMEOUT_MS = 30_000;
const UCDP_PAGE_SIZE = 1000;
const UCDP_MAX_EVENTS = 2000;
const TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

const VIOLENCE_TYPE_MAP: Record<number, string> = {
  1: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  2: 'UCDP_VIOLENCE_TYPE_NON_STATE',
  3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED',
};

// Cooldown to avoid hammering the UCDP API on repeated failures
let ucdpApiBackoffUntil = 0;
const UCDP_BACKOFF_MS = 10 * 60 * 1000; // 10 min

function buildVersionCandidates(): string[] {
  const year = new Date().getFullYear() - 2000;
  return [...new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1'])];
}

async function fetchUcdpPage(version: string, page: number, token?: string) {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
  };
  if (token) headers['x-ucdp-access-token'] = token;
  const resp = await proxyFetch(
    `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`,
    { headers, signal: AbortSignal.timeout(UCDP_FETCH_TIMEOUT_MS) },
  );
  if (!resp.ok) throw new Error(`UCDP API ${resp.status}`);
  return resp.json() as Promise<{ Result?: unknown[]; TotalPages?: number }>;
}

async function fetchUcdpDirect(): Promise<UcdpViolenceEvent[]> {
  if (Date.now() < ucdpApiBackoffUntil) return [];

  const token = (process.env.UCDP_ACCESS_TOKEN || '').trim() || undefined;
  const candidates = buildVersionCandidates();

  let page0: { Result?: unknown[]; TotalPages?: number } | null = null;
  let version = '';

  for (const v of candidates) {
    try {
      page0 = await fetchUcdpPage(v, 0, token);
      if (Array.isArray(page0?.Result) && page0.Result.length > 0) {
        version = v;
        break;
      }
    } catch (err) { console.warn(`[UCDP] Version ${v} failed:`, (err as Error).message); }
  }

  if (!page0?.Result?.length) {
    console.warn('[UCDP] No data from any version candidate:', candidates.join(', '));
    ucdpApiBackoffUntil = Date.now() + UCDP_BACKOFF_MS;
    return [];
  }
  console.log(`[UCDP] Using version ${version}, TotalPages=${page0.TotalPages}`);

  // Fetch last few pages (newest events are at the end)
  const totalPages = Math.max(1, Number(page0.TotalPages) || 1);
  const newestPage = totalPages - 1;
  const allEvents: unknown[] = [];

  const pagesToFetch: Promise<unknown[] | null>[] = [];
  for (let offset = 0; offset < 4 && (newestPage - offset) >= 0; offset++) {
    const pageNum = newestPage - offset;
    if (pageNum === 0) {
      pagesToFetch.push(Promise.resolve(page0.Result));
    } else {
      pagesToFetch.push(
        fetchUcdpPage(version, pageNum, token)
          .then((d) => d.Result as unknown[] ?? null)
          .catch(() => null),
      );
    }
  }

  const results = await Promise.all(pagesToFetch);
  for (const r of results) {
    if (Array.isArray(r)) allEvents.push(...r);
  }

  // Find the latest date for the trailing window
  let latestMs = NaN;
  for (const e of allEvents) {
    const ms = Date.parse((e as Record<string, string>).date_start || '');
    if (Number.isFinite(ms) && (!Number.isFinite(latestMs) || ms > latestMs)) latestMs = ms;
  }

  // Map and filter events
  const mapped: UcdpViolenceEvent[] = [];
  for (const raw of allEvents) {
    const e = raw as Record<string, unknown>;
    const dateStartMs = Date.parse(e.date_start as string);
    if (!Number.isFinite(dateStartMs)) continue;
    if (Number.isFinite(latestMs) && dateStartMs < latestMs - TRAILING_WINDOW_MS) continue;

    mapped.push({
      id: String(e.id || ''),
      dateStart: dateStartMs,
      dateEnd: Date.parse(e.date_end as string) || 0,
      location: {
        latitude: Number(e.latitude) || 0,
        longitude: Number(e.longitude) || 0,
      },
      country: (e.country as string) || '',
      sideA: ((e.side_a as string) || '').substring(0, 200),
      sideB: ((e.side_b as string) || '').substring(0, 200),
      deathsBest: Number(e.best) || 0,
      deathsLow: Number(e.low) || 0,
      deathsHigh: Number(e.high) || 0,
      violenceType: (VIOLENCE_TYPE_MAP[e.type_of_violence as number] || 'UCDP_VIOLENCE_TYPE_UNSPECIFIED') as UcdpViolenceEvent['violenceType'],
      sourceOriginal: ((e.source_original as string) || '').substring(0, 300),
    });
  }

  mapped.sort((a, b) => b.dateStart - a.dateStart);
  return mapped.slice(0, UCDP_MAX_EVENTS);
}

// ========================================================================
// RPC handler
// ========================================================================

export async function listUcdpEvents(
  _ctx: ServerContext,
  req: ListUcdpEventsRequest,
): Promise<ListUcdpEventsResponse> {
  // 1. Try Redis cache (populated by seed cron)
  try {
    const raw = await getCachedJson(CACHE_KEY, true) as { events?: UcdpViolenceEvent[]; fetchedAt?: number } | null;
    if (raw?.events?.length && (!raw.fetchedAt || (Date.now() - raw.fetchedAt) < MAX_AGE_MS)) {
      fallback = { events: raw.events, ts: Date.now() };
      let events = raw.events;
      if (req.country) events = events.filter((e) => e.country === req.country);
      return { events, pagination: undefined };
    }
  } catch { /* fall through */ }

  // 2. Try in-memory fallback (12h window)
  if (fallback && (Date.now() - fallback.ts) < 12 * 60 * 60 * 1000) {
    let events = fallback.events;
    if (req.country) events = events.filter((e) => e.country === req.country);
    return { events, pagination: undefined };
  }

  // 3. Try direct UCDP API fetch
  try {
    const events = await fetchUcdpDirect();
    if (events.length > 0) {
      fallback = { events, ts: Date.now() };
      let filtered = events;
      if (req.country) filtered = filtered.filter((e) => e.country === req.country);
      return { events: filtered, pagination: undefined };
    }
  } catch { /* fall through */ }

  return { events: [], pagination: undefined };
}

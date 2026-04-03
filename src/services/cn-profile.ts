/**
 * User profile service — localStorage UUID + backend CRUD.
 */

export const CN_INTEL_BASE = import.meta.env.VITE_CN_INTEL_BASE || '';
const PROFILE_KEY = 'cn_user_profile_id';
const HEARTBEAT_INTERVAL = 300_000; // 5min

/**
 * Authenticated fetch wrapper for cn-intel-service.
 * Auto-attaches Bearer token from localStorage.
 * Redirects to login.html on 401 (with guard to prevent duplicate redirects).
 * Adds a 30 s timeout to prevent hanging requests.
 */
let _tokenExpiredNotified = false;
const CN_FETCH_TIMEOUT = 30_000; // 30 seconds

export function cnFetch(url: string, init?: RequestInit & { timeout?: number }): Promise<Response> {
  const token = localStorage.getItem('wm_token') || '';
  const headers = new Headers(init?.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  // Compose abort: honour caller's signal and add timeout
  const controller = new AbortController();
  const callerSignal = init?.signal;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), { once: true });
    }
  }
  const timeoutMs = init?.timeout ?? CN_FETCH_TIMEOUT;
  const timer = setTimeout(() => controller.abort('cnFetch timeout'), timeoutMs);
  return fetch(url, { ...init, headers, signal: controller.signal })
    .then(res => {
      clearTimeout(timer);
      if (res.status === 401 && !_tokenExpiredNotified) {
        _tokenExpiredNotified = true;
        localStorage.removeItem('wm_token');
        localStorage.removeItem('wm_user');
        // Stay on main page — show a toast instead of redirecting to login.html
        _showTokenExpiredToast();
      }
      return res;
    })
    .catch(err => {
      clearTimeout(timer);
      throw err;
    });
}

/** Show a non-intrusive toast when token expires — user stays on current page. */
function _showTokenExpiredToast(): void {
  const existing = document.getElementById('wm-token-expired-toast');
  if (existing) return;
  const toast = document.createElement('div');
  toast.id = 'wm-token-expired-toast';
  Object.assign(toast.style, {
    position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
    zIndex: '99999', background: '#dc3545', color: '#fff', padding: '12px 24px',
    borderRadius: '8px', fontSize: '14px', boxShadow: '0 4px 12px rgba(0,0,0,.3)',
    display: 'flex', alignItems: 'center', gap: '12px',
  });
  toast.innerHTML = `
    <span>登录已过期，请重新登录</span>
    <a href="login.html" style="color:#fff;text-decoration:underline;font-weight:600">去登录</a>
    <button style="background:none;border:none;color:#fff;cursor:pointer;font-size:18px;padding:0 4px">&times;</button>
  `;
  toast.querySelector('button')!.addEventListener('click', () => toast.remove());
  document.body.appendChild(toast);
}

export interface UserProfile {
  user_id: string;
  company_name: string;
  company_size: string;
  business_scope: string;
  key_products: string[];
  industries: string[];
  tracked_sectors: string[];
  tracked_stocks: string[];
  tracked_keywords: string[];
  exclude_keywords: string[];
  supply_chain_up: string[];
  supply_chain_down: string[];
  competitors: string[];
  compliance_concerns: string[];
  business_regions: string[];
  focus_policy_areas: string[];
  report_frequency: string;
  ai_provider_order: string[];
  alert_min_score: number;
  last_seen_at: string | null;
}

export interface AIProvider {
  name: string;
  label: string;
  available: boolean;
  has_custom_key?: boolean;
  masked_key?: string;
}

let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** Get or create a persistent user ID (UUID v4 in localStorage). */
export function getUserId(): string {
  let id = localStorage.getItem(PROFILE_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : _fallbackUUID();
    localStorage.setItem(PROFILE_KEY, id);
  }
  return id;
}

/** Load profile from backend. Returns null if not yet created. */
export async function loadProfile(): Promise<{ profile: UserProfile | null; industries: string[] }> {
  const uid = getUserId();
  const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/profile?user_id=${encodeURIComponent(uid)}`);
  if (!res.ok) return { profile: null, industries: [] };
  return res.json();
}

/** Save profile to backend. */
export async function saveProfile(data: Partial<UserProfile>): Promise<UserProfile | null> {
  const uid = getUserId();
  const body = { ...data, user_id: uid };
  const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.profile || null;
}

/** Send heartbeat to update last_seen_at. */
export async function heartbeat(): Promise<void> {
  const uid = getUserId();
  try {
    await cnFetch(`${CN_INTEL_BASE}/api/cn/profile/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: uid }),
    });
  } catch {
    // Silently ignore heartbeat failures
  }
}

/** Start periodic heartbeat (call once at app init). */
export function startHeartbeat(): void {
  if (_heartbeatTimer) return;
  heartbeat(); // immediate
  _heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL);
}

/** Stop heartbeat. */
export function stopHeartbeat(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

/** Get personalized feed. */
export async function getFeed(
  type: 'policy' | 'mood' | 'all' = 'policy',
  limit = 100,
): Promise<{ items: any[]; total: number }> {
  const uid = getUserId();
  const res = await cnFetch(
    `${CN_INTEL_BASE}/api/cn/feed?user_id=${encodeURIComponent(uid)}&type=${type}&limit=${limit}`,
  );
  if (!res.ok) return { items: [], total: 0 };
  return res.json();
}

/** Fetch available AI providers and user's custom order. */
export async function getAIProviders(): Promise<{ providers: AIProvider[]; user_order: string[] }> {
  const uid = getUserId();
  try {
    const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/ai/providers?user_id=${encodeURIComponent(uid)}`);
    if (!res.ok) return { providers: [], user_order: [] };
    return res.json();
  } catch {
    return { providers: [], user_order: [] };
  }
}

/** Check if user has set up industries in their profile (cached). */
export async function isNewUser(): Promise<boolean> {
  try {
    const { profile } = await loadProfile();
    return !profile || !profile.industries || profile.industries.length === 0;
  } catch {
    return true;
  }
}

/** Check if onboarding has been completed (localStorage). */
export function hasCompletedOnboarding(): boolean {
  return localStorage.getItem('cn_onboarding_done') === '1';
}

/** Mark onboarding as done. */
export function markOnboardingComplete(): void {
  localStorage.setItem('cn_onboarding_done', '1');
}

/** Save custom API keys for AI providers. */
export async function saveAIKeys(keys: Record<string, string>): Promise<Record<string, string>> {
  const uid = getUserId();
  try {
    const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/ai/keys`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: uid, keys }),
    });
    if (!res.ok) return {};
    const json = await res.json();
    return json.keys || {};
  } catch {
    return {};
  }
}

/** Delete a single custom API key for a provider. */
export async function deleteAIKey(provider: string): Promise<boolean> {
  const uid = getUserId();
  try {
    const res = await cnFetch(
      `${CN_INTEL_BASE}/api/cn/ai/key/${encodeURIComponent(provider)}?user_id=${encodeURIComponent(uid)}`,
      { method: 'DELETE' },
    );
    return res.ok;
  } catch {
    return false;
  }
}

function _fallbackUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

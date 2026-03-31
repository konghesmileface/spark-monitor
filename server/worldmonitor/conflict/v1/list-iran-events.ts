import type {
  ServerContext,
  ListIranEventsRequest,
  ListIranEventsResponse,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { getCachedJson, cachedFetchJson } from '../../../_shared/redis';
import { proxyFetch } from '../../../_shared/proxy-fetch';
import { CHROME_UA } from '../../../_shared/constants';

const REDIS_KEY = 'conflict:iran-events:v1';
const GDELT_CACHE_KEY = 'conflict:iran-gdelt:v1';
const GDELT_CACHE_TTL = 3600; // 1 hour

const IRAN_COORDS: Record<string, [number, number]> = {
  tehran: [35.69, 51.39], isfahan: [32.65, 51.68], shiraz: [29.59, 52.58],
  tabriz: [38.08, 46.29], mashhad: [36.31, 59.60], qom: [34.64, 50.88],
  ahvaz: [31.32, 48.67], kermanshah: [34.31, 47.06], rasht: [37.28, 49.59],
  yazd: [31.90, 54.37], kerman: [30.28, 57.08], bandar: [27.19, 56.27],
  iraq: [33.22, 43.68], syria: [34.80, 38.99], lebanon: [33.89, 35.50],
  israel: [31.77, 35.22], gaza: [31.50, 34.47], yemen: [15.37, 44.19],
  iran: [32.43, 53.69],
};

function geocodeTitle(title: string): { lat: number; lng: number } {
  const lower = title.toLowerCase();
  for (const [name, coords] of Object.entries(IRAN_COORDS)) {
    if (lower.includes(name)) return { lat: coords[0], lng: coords[1] };
  }
  // Default to Iran center
  return { lat: 32.43, lng: 53.69 };
}

function classifySeverity(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes('attack') || lower.includes('strike') || lower.includes('bomb') || lower.includes('missile') || lower.includes('kill')) return 'critical';
  if (lower.includes('sanction') || lower.includes('nuclear') || lower.includes('military') || lower.includes('threat')) return 'high';
  if (lower.includes('protest') || lower.includes('tension') || lower.includes('warning')) return 'medium';
  return 'low';
}

async function fetchWithRetry(url: string, retries = 2, delayMs = 5000): Promise<Response | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      if (i > 0) await new Promise(r => setTimeout(r, delayMs * i));
      const resp = await proxyFetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(45_000),
      });
      if (resp.status === 429) { console.warn('[iran-events] GDELT 429, retry', i + 1); continue; }
      return resp;
    } catch { if (i === retries) return null; }
  }
  return null;
}

async function fetchIranEventsFromGdelt(): Promise<ListIranEventsResponse['events']> {
  try {
    const query = encodeURIComponent('(Iran OR Tehran OR IRGC) (conflict OR military OR nuclear OR sanction OR missile)');
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&maxrecords=30&format=json&timespan=3d&sort=DateDesc`;
    const resp = await fetchWithRetry(url);
    if (!resp || !resp.ok) return [];
    const data = await resp.json() as { articles?: Array<{ url: string; title: string; seendate: string; domain: string; language: string }> };
    const articles = data.articles || [];
    if (articles.length === 0) return [];

    return articles
      .filter(a => a.title && a.language === 'English')
      .slice(0, 20)
      .map((a, i) => {
        const coords = geocodeTitle(a.title);
        return {
          id: `gdelt-iran-${Date.now()}-${i}`,
          title: a.title,
          description: `Source: ${a.domain}`,
          severity: classifySeverity(a.title),
          category: 'conflict',
          location: { latitude: coords.lat, longitude: coords.lng },
          occurredAt: new Date(a.seendate).getTime() || Date.now(),
          sourceUrl: a.url,
        };
      });
  } catch (e) {
    console.warn('[iran-events] GDELT fetch failed:', e);
    return [];
  }
}

export async function listIranEvents(
  _ctx: ServerContext,
  _req: ListIranEventsRequest,
): Promise<ListIranEventsResponse> {
  // Try relay-seeded data first
  try {
    const cached = await getCachedJson(REDIS_KEY);
    if (cached && typeof cached === 'object' && 'events' in (cached as Record<string, unknown>)) {
      const resp = cached as ListIranEventsResponse;
      if (resp.events?.length) return resp;
    }
  } catch { /* fall through */ }

  // Fallback: GDELT live fetch
  try {
    const result = await cachedFetchJson<ListIranEventsResponse>(GDELT_CACHE_KEY, GDELT_CACHE_TTL, async () => {
      const events = await fetchIranEventsFromGdelt();
      return events.length > 0 ? { events, scrapedAt: String(Date.now()) } : null;
    },
      600, // negative cache 10 min — GDELT rate-limits aggressively
    );
    if (result?.events?.length) return result;
  } catch { /* fall through */ }

  return { events: [], scrapedAt: '0' };
}

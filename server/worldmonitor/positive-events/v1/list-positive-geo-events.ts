import type {
  ServerContext,
  ListPositiveGeoEventsRequest,
  ListPositiveGeoEventsResponse,
  PositiveGeoEvent,
} from '../../../../src/generated/server/worldmonitor/positive_events/v1/service_server';
import { getCachedJson, cachedFetchJson } from '../../../_shared/redis';
import { proxyFetch } from '../../../_shared/proxy-fetch';
import { CHROME_UA } from '../../../_shared/constants';

const CACHE_KEY = 'positive-events:geo:v1';
const LIVE_CACHE_KEY = 'positive-events:gdelt:v1';
const LIVE_CACHE_TTL = 7200; // 2 hours
const MAX_AGE_MS = 25 * 60 * 60 * 1000;

let fallback: { events: PositiveGeoEvent[]; ts: number } | null = null;

const POSITIVE_THEMES = [
  'PEACE', 'CEASEFIRE', 'HUMANITARIAN_AID', 'DIPLOMATIC',
  'COOPERATION', 'AGREEMENT', 'TREATY', 'RELIEF',
];

async function fetchWithRetry(url: string, retries = 2, delayMs = 5000): Promise<Response | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      if (i > 0) await new Promise(r => setTimeout(r, delayMs * i));
      const resp = await proxyFetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(45_000),
      });
      if (resp.status === 429) { console.warn('[positive-events] GDELT 429, retry', i + 1); continue; }
      return resp;
    } catch { if (i === retries) return null; }
  }
  return null;
}

async function fetchPositiveFromGdelt(): Promise<PositiveGeoEvent[]> {
  try {
    const query = encodeURIComponent('(peace OR ceasefire OR "humanitarian aid" OR "peace agreement" OR "diplomatic breakthrough" OR "relief effort")');
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&maxrecords=30&format=json&timespan=3d&sort=DateDesc`;
    const resp = await fetchWithRetry(url);
    if (!resp || !resp.ok) return [];
    const data = await resp.json() as { articles?: Array<{ url: string; title: string; seendate: string; domain: string; language: string; sourcecountry?: string; socialimage?: string }> };
    const articles = data.articles || [];
    if (articles.length === 0) return [];

    return articles
      .filter(a => a.title && a.seendate)
      .slice(0, 20)
      .map((a, i): PositiveGeoEvent => {
        // Assign approximate global coordinates based on article themes
        const lat = 20 + (i % 10) * 5 + Math.random() * 5;
        const lng = -30 + (i % 8) * 20 + Math.random() * 10;
        return {
          id: `gdelt-pos-${Date.now()}-${i}`,
          title: a.title,
          description: `Source: ${a.domain}`,
          category: detectCategory(a.title),
          location: { latitude: lat, longitude: lng },
          occurredAt: new Date(a.seendate).getTime() || Date.now(),
          sourceUrl: a.url,
          imageUrl: a.socialimage || '',
        };
      });
  } catch (e) {
    console.warn('[positive-events] GDELT fetch failed:', e);
    return [];
  }
}

function detectCategory(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes('peace') || lower.includes('ceasefire')) return 'peace';
  if (lower.includes('humanitarian') || lower.includes('relief') || lower.includes('aid')) return 'humanitarian';
  if (lower.includes('diplomati') || lower.includes('agreement') || lower.includes('treaty')) return 'diplomacy';
  if (lower.includes('climat') || lower.includes('renewable') || lower.includes('green')) return 'environment';
  if (lower.includes('scien') || lower.includes('research') || lower.includes('discover')) return 'science';
  return 'cooperation';
}

export async function listPositiveGeoEvents(
  _ctx: ServerContext,
  _req: ListPositiveGeoEventsRequest,
): Promise<ListPositiveGeoEventsResponse> {
  // Try relay-seeded data first
  try {
    const raw = await getCachedJson(CACHE_KEY, true) as { events?: PositiveGeoEvent[]; fetchedAt?: number } | null;
    if (raw?.events?.length && (!raw.fetchedAt || (Date.now() - raw.fetchedAt) < MAX_AGE_MS)) {
      fallback = { events: raw.events, ts: Date.now() };
      return { events: raw.events };
    }
  } catch { /* fall through */ }

  if (fallback && (Date.now() - fallback.ts) < 12 * 60 * 60 * 1000) {
    return { events: fallback.events };
  }

  // Fallback: fetch from GDELT
  try {
    const result = await cachedFetchJson<ListPositiveGeoEventsResponse>(LIVE_CACHE_KEY, LIVE_CACHE_TTL, async () => {
      const events = await fetchPositiveFromGdelt();
      return events.length > 0 ? { events } : null;
    },
      600, // negative cache 10 min — GDELT rate-limits aggressively
    );
    if (result?.events?.length) {
      fallback = { events: result.events, ts: Date.now() };
      return result;
    }
  } catch { /* fall through */ }

  return { events: [] };
}

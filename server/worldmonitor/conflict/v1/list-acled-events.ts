/**
 * RPC: listAcledEvents -- Conflict events from ACLED + GDELT fallback
 *
 * Tries ACLED API first; on failure (403/401), falls back to GDELT
 * conflict event search filtered by country.
 */

import type {
  ServerContext,
  ListAcledEventsRequest,
  ListAcledEventsResponse,
  AcledConflictEvent,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { fetchAcledCached } from '../../../_shared/acled';
import { proxyFetch } from '../../../_shared/proxy-fetch';
import { CHROME_UA } from '../../../_shared/constants';

const REDIS_CACHE_KEY = 'conflict:acled:v1';
const REDIS_CACHE_TTL = 900; // 15 min

const fallbackAcledCache = new Map<string, { data: ListAcledEventsResponse; ts: number }>();

// Country → approximate center coordinates for GDELT geocoding fallback
const COUNTRY_COORDS: Record<string, [number, number]> = {
  'Ukraine': [48.38, 31.17], 'Syria': [34.80, 38.99], 'Yemen': [15.55, 48.52],
  'Afghanistan': [33.94, 67.71], 'Sudan': [12.86, 30.22], 'Somalia': [5.15, 46.20],
  'Ethiopia': [9.15, 40.49], 'Iraq': [33.22, 43.68], 'Myanmar': [19.76, 96.08],
  'Nigeria': [9.08, 7.49], 'Mali': [17.57, -4.00], 'DRC': [-4.04, 21.76],
  'Colombia': [4.57, -74.30], 'Palestine': [31.95, 35.23],
};

async function fetchAcledConflicts(req: ListAcledEventsRequest): Promise<AcledConflictEvent[]> {
  try {
    const now = Date.now();
    const startMs = req.start || (now - 30 * 24 * 60 * 60 * 1000);
    const endMs = req.end || now;
    const startDate = new Date(startMs).toISOString().split('T')[0]!;
    const endDate = new Date(endMs).toISOString().split('T')[0]!;

    const rawEvents = await fetchAcledCached({
      eventTypes: 'Battles|Explosions/Remote violence|Violence against civilians',
      startDate,
      endDate,
      country: req.country || undefined,
    });

    return rawEvents
      .filter((e) => {
        const lat = parseFloat(e.latitude || '');
        const lon = parseFloat(e.longitude || '');
        return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
      })
      .map((e): AcledConflictEvent => ({
        id: `acled-${e.event_id_cnty}`,
        eventType: e.event_type || '',
        country: e.country || '',
        location: {
          latitude: parseFloat(e.latitude || '0'),
          longitude: parseFloat(e.longitude || '0'),
        },
        occurredAt: new Date(e.event_date || '').getTime(),
        fatalities: parseInt(e.fatalities || '', 10) || 0,
        actors: [e.actor1, e.actor2].filter(Boolean) as string[],
        source: e.source || '',
        admin1: e.admin1 || '',
      }));
  } catch {
    return [];
  }
}

/** GDELT fallback when ACLED is down */
async function fetchConflictsFromGdelt(country?: string): Promise<AcledConflictEvent[]> {
  try {
    const countryQuery = country ? `"${country}"` : '(conflict OR battle OR attack OR airstrike OR shelling)';
    const query = encodeURIComponent(`${countryQuery} (killed OR attack OR battle OR airstrike OR bombing OR shelling OR explosion)`);
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&maxrecords=40&format=json&timespan=7d&sort=DateDesc`;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 5000 * attempt));
      try {
        const resp = await proxyFetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
          signal: AbortSignal.timeout(45_000),
        });
        if (resp.status === 429) { console.warn('[acled-gdelt] 429, retry', attempt + 1); continue; }
        if (!resp.ok) return [];
        const data = await resp.json() as { articles?: Array<{ url: string; title: string; seendate: string; domain: string; sourcecountry?: string }> };
        const articles = data.articles || [];
        if (articles.length === 0) return [];

        const defaultCoords = country ? (COUNTRY_COORDS[country] || [0, 0]) : [0, 0];
        return articles
          .filter(a => a.title && a.seendate)
          .slice(0, 30)
          .map((a, i): AcledConflictEvent => {
            const lat = defaultCoords[0] + (Math.random() - 0.5) * 4;
            const lng = defaultCoords[1] + (Math.random() - 0.5) * 4;
            return {
              id: `gdelt-conflict-${Date.now()}-${i}`,
              eventType: detectEventType(a.title),
              country: country || a.sourcecountry || '',
              location: { latitude: lat, longitude: lng },
              occurredAt: new Date(a.seendate).getTime() || Date.now(),
              fatalities: 0,
              actors: [],
              source: `GDELT/${a.domain}`,
              admin1: '',
            };
          });
      } catch { if (attempt === 2) return []; }
    }
    return [];
  } catch {
    return [];
  }
}

function detectEventType(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes('battle') || lower.includes('clash')) return 'Battles';
  if (lower.includes('airstrike') || lower.includes('bombing') || lower.includes('shell') || lower.includes('explosion') || lower.includes('missile')) return 'Explosions/Remote violence';
  if (lower.includes('civilian') || lower.includes('massacre') || lower.includes('killed')) return 'Violence against civilians';
  return 'Battles';
}

export async function listAcledEvents(
  _ctx: ServerContext,
  req: ListAcledEventsRequest,
): Promise<ListAcledEventsResponse> {
  const cacheKey = `${REDIS_CACHE_KEY}:${req.country || 'all'}:${req.start || 0}:${req.end || 0}`;
  try {
    const result = await cachedFetchJson<ListAcledEventsResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        // Try ACLED first
        const events = await fetchAcledConflicts(req);
        if (events.length > 0) return { events, pagination: undefined };

        // Fallback to GDELT
        const gdeltEvents = await fetchConflictsFromGdelt(req.country);
        return gdeltEvents.length > 0 ? { events: gdeltEvents, pagination: undefined } : null;
      },
      600, // negative cache 10 min — ACLED 403 + GDELT 429 cascading
    );
    if (result) {
      if (fallbackAcledCache.size > 50) fallbackAcledCache.clear();
      fallbackAcledCache.set(cacheKey, { data: result, ts: Date.now() });
    }
    return result || fallbackAcledCache.get(cacheKey)?.data || { events: [], pagination: undefined };
  } catch {
    return fallbackAcledCache.get(cacheKey)?.data || { events: [], pagination: undefined };
  }
}

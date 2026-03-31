/**
 * ListUnrestEvents RPC -- merges ACLED and GDELT data into deduplicated,
 * severity-classified, sorted unrest events.
 */

import type {
  ServerContext,
  ListUnrestEventsRequest,
  ListUnrestEventsResponse,
  UnrestEvent,
  UnrestSourceType,
  ConfidenceLevel,
} from '../../../../src/generated/server/worldmonitor/unrest/v1/service_server';

import {
  GDELT_DOC_URL,
  mapAcledEventType,
  classifySeverity,
  classifyGdeltSeverity,
  classifyGdeltEventType,
  deduplicateEvents,
  sortBySeverityAndRecency,
} from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { proxyFetch } from '../../../_shared/proxy-fetch';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { fetchAcledCached } from '../../../_shared/acled';

const REDIS_CACHE_KEY = 'unrest:events:v1';
const REDIS_CACHE_TTL = 900; // 15 min — ACLED + GDELT merge
const SEED_KEY = 'unrest:events:v1';
const SEED_META_KEY = 'seed-meta:unrest:events';
const SEED_FRESHNESS_MS = 45 * 60 * 1000; // 45 min

// ---------- ACLED Fetch (ported from api/acled.js + src/services/protests.ts) ----------

async function fetchAcledProtests(req: ListUnrestEventsRequest): Promise<UnrestEvent[]> {
  try {
    const now = Date.now();
    const startMs = req.start || (now - 30 * 24 * 60 * 60 * 1000);
    const endMs = req.end || now;
    const startDate = new Date(startMs).toISOString().split('T')[0]!;
    const endDate = new Date(endMs).toISOString().split('T')[0]!;

    const rawEvents = await fetchAcledCached({
      eventTypes: 'Protests',
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
      .map((e): UnrestEvent => {
        const fatalities = parseInt(e.fatalities || '', 10) || 0;
        return {
          id: `acled-${e.event_id_cnty}`,
          title: e.notes?.slice(0, 200) || `${e.sub_event_type} in ${e.location}`,
          summary: typeof e.notes === 'string' ? e.notes.substring(0, 500) : '',
          eventType: mapAcledEventType(e.event_type || '', e.sub_event_type || ''),
          city: e.location || '',
          country: e.country || '',
          region: e.admin1 || '',
          location: {
            latitude: parseFloat(e.latitude || '0'),
            longitude: parseFloat(e.longitude || '0'),
          },
          occurredAt: new Date(e.event_date || '').getTime(),
          severity: classifySeverity(fatalities, e.event_type || ''),
          fatalities,
          sources: [e.source].filter(Boolean) as string[],
          sourceType: 'UNREST_SOURCE_TYPE_ACLED' as UnrestSourceType,
          tags: e.tags?.split(';').map((t: string) => t.trim()).filter(Boolean) ?? [],
          actors: [e.actor1, e.actor2].filter(Boolean) as string[],
          confidence: 'CONFIDENCE_LEVEL_HIGH' as ConfidenceLevel,
        };
      });
  } catch {
    return [];
  }
}

// ---------- GDELT Fetch (DOC API — GEO v2 API removed 2025) ----------

/** Country name → approximate centroid [lat, lon] for geocoding GDELT articles */
const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  'United States': [39.8, -98.5], 'United Kingdom': [54.0, -2.0], 'France': [46.6, 2.2],
  'Germany': [51.2, 10.4], 'Russia': [61.5, 105.3], 'China': [35.9, 104.2],
  'India': [20.6, 79.0], 'Brazil': [-14.2, -51.9], 'Japan': [36.2, 138.3],
  'Australia': [-25.3, 133.8], 'Canada': [56.1, -106.3], 'Mexico': [23.6, -102.6],
  'Turkey': [39.9, 32.9], 'Iran': [32.4, 53.7], 'Iraq': [33.2, 43.7],
  'Israel': [31.8, 35.2], 'Palestine': [31.9, 35.2], 'Syria': [35.0, 38.5],
  'Egypt': [26.8, 30.8], 'South Africa': [-30.6, 22.9], 'Nigeria': [9.1, 8.7],
  'Kenya': [-0.02, 37.9], 'Ethiopia': [9.1, 40.5], 'Sudan': [12.9, 30.2],
  'South Korea': [35.9, 127.8], 'North Korea': [40.3, 127.5],
  'Pakistan': [30.4, 69.3], 'Afghanistan': [33.9, 67.7], 'Bangladesh': [23.7, 90.4],
  'Indonesia': [-0.8, 113.9], 'Philippines': [12.9, 121.8], 'Thailand': [15.9, 100.9],
  'Myanmar': [21.9, 96.0], 'Vietnam': [14.1, 108.3], 'Malaysia': [4.2, 101.9],
  'Ukraine': [48.4, 31.2], 'Poland': [51.9, 19.1], 'Italy': [41.9, 12.6],
  'Spain': [40.5, -3.7], 'Greece': [39.1, 21.8], 'Netherlands': [52.1, 5.3],
  'Belgium': [50.5, 4.5], 'Sweden': [60.1, 18.6], 'Norway': [60.5, 8.5],
  'Argentina': [-38.4, -63.6], 'Colombia': [4.6, -74.3], 'Venezuela': [6.4, -66.6],
  'Peru': [-9.2, -75.0], 'Chile': [-35.7, -71.5], 'Ecuador': [-1.8, -78.2],
  'Saudi Arabia': [23.9, 45.1], 'UAE': [23.4, 53.8], 'Yemen': [15.6, 48.5],
  'Lebanon': [33.9, 35.9], 'Jordan': [30.6, 36.2], 'Libya': [26.3, 17.2],
  'Tunisia': [34.0, 9.5], 'Morocco': [31.8, -7.1], 'Algeria': [28.0, 1.7],
  'Somalia': [5.2, 46.2], 'Congo': [-4.0, 21.8], 'Mozambique': [-18.7, 35.5],
  'Tanzania': [-6.4, 34.9], 'Uganda': [1.4, 32.3], 'Ghana': [7.9, -1.0],
  'Senegal': [14.5, -14.5], 'Mali': [17.6, -4.0], 'Niger': [17.6, 8.1],
  'Burkina Faso': [12.3, -1.6], 'Chad': [15.5, 18.7], 'Cameroon': [7.4, 12.4],
  'Georgia': [42.3, 43.4], 'Armenia': [40.1, 45.0], 'Azerbaijan': [40.1, 47.6],
  'Sri Lanka': [7.9, 80.8], 'Nepal': [28.4, 84.1], 'Cambodia': [12.6, 104.9],
  'Haiti': [19.1, -72.3], 'Cuba': [21.5, -78.0], 'Honduras': [15.2, -86.2],
  'Guatemala': [15.8, -90.2], 'Nicaragua': [12.9, -85.2],
  'Serbia': [44.0, 21.0], 'Hungary': [47.2, 19.5], 'Romania': [45.9, 25.0],
  'Czech Republic': [49.8, 15.5], 'Austria': [47.5, 14.6], 'Switzerland': [46.8, 8.2],
  'Portugal': [39.4, -8.2], 'Ireland': [53.4, -8.2], 'Finland': [61.9, 25.7],
  'Denmark': [56.3, 9.5], 'New Zealand': [-40.9, 174.9], 'Taiwan': [23.7, 121.0],
  'Singapore': [1.4, 103.8], 'Macedonia': [41.5, 21.7],
};

async function fetchGdeltEvents(): Promise<UnrestEvent[]> {
  try {
    const params = new URLSearchParams({
      query: '(protest OR riot OR demonstration OR strike)',
      mode: 'artlist',
      format: 'json',
      maxrecords: '75',
      timespan: '3d',
    });

    let response: Response | null = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 5000 * attempt));
      try {
        const resp = await proxyFetch(`${GDELT_DOC_URL}?${params}`, {
          headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
          signal: AbortSignal.timeout(45_000),
        });
        if (resp.status === 429) { console.warn('[unrest] GDELT 429, retry', attempt + 1); continue; }
        response = resp;
        break;
      } catch { if (attempt === 2) return []; }
    }

    if (!response || !response.ok) return [];

    const data = (await response.json()) as { articles?: Array<{
      url?: string; title?: string; seendate?: string;
      domain?: string; language?: string; sourcecountry?: string;
    }> };
    const articles = data?.articles || [];
    if (articles.length === 0) return [];

    // Group articles by source country
    const countryGroups = new Map<string, { count: number; titles: string[]; latestDate: string }>();
    for (const art of articles) {
      const country = art.sourcecountry || '';
      if (!country || !COUNTRY_CENTROIDS[country]) continue;
      const group = countryGroups.get(country) || { count: 0, titles: [], latestDate: '' };
      group.count++;
      if (group.titles.length < 3 && art.title) group.titles.push(art.title);
      if (art.seendate && art.seendate > group.latestDate) group.latestDate = art.seendate;
      countryGroups.set(country, group);
    }

    // Convert grouped articles to unrest events
    const events: UnrestEvent[] = [];
    for (const [country, group] of countryGroups) {
      if (group.count < 3) continue; // Filter noise: require at least 3 articles
      const [lat, lon] = COUNTRY_CENTROIDS[country]!;
      // Add small random offset so multiple country events don't stack
      const jitterLat = lat + (Math.random() - 0.5) * 2;
      const jitterLon = lon + (Math.random() - 0.5) * 2;
      const dateMs = group.latestDate
        ? new Date(group.latestDate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z')).getTime()
        : Date.now();

      events.push({
        id: `gdelt-${country.replace(/\s/g, '-').toLowerCase()}-${Date.now()}`,
        title: `${country}: ${group.count} protest reports`,
        summary: group.titles.slice(0, 2).join(' | '),
        eventType: classifyGdeltEventType(group.titles.join(' ')),
        city: '',
        country,
        region: '',
        location: { latitude: jitterLat, longitude: jitterLon },
        occurredAt: Number.isFinite(dateMs) ? dateMs : Date.now(),
        severity: classifyGdeltSeverity(group.count, group.titles.join(' ')),
        fatalities: 0,
        sources: ['GDELT'],
        sourceType: 'UNREST_SOURCE_TYPE_GDELT' as UnrestSourceType,
        tags: [],
        actors: [],
        confidence: (group.count > 20
          ? 'CONFIDENCE_LEVEL_HIGH'
          : 'CONFIDENCE_LEVEL_MEDIUM') as ConfidenceLevel,
      });
    }

    return events;
  } catch {
    return [];
  }
}

// ---------- RPC Implementation ----------

function filterSeedEvents(
  events: UnrestEvent[],
  req: ListUnrestEventsRequest,
): UnrestEvent[] {
  let filtered = events;
  if (req.country) {
    const country = req.country.toLowerCase();
    filtered = filtered.filter(
      (e) => e.country.toLowerCase() === country || e.country.toLowerCase().includes(country),
    );
  }
  if (req.start > 0) {
    filtered = filtered.filter((e) => e.occurredAt >= req.start);
  }
  if (req.end > 0) {
    filtered = filtered.filter((e) => e.occurredAt <= req.end);
  }
  return filtered;
}

export async function listUnrestEvents(
  _ctx: ServerContext,
  req: ListUnrestEventsRequest,
): Promise<ListUnrestEventsResponse> {
  try {
    // Try seed data first
    try {
      const [seedData, seedMeta] = await Promise.all([
        getCachedJson(SEED_KEY, true) as Promise<ListUnrestEventsResponse | null>,
        getCachedJson(SEED_META_KEY, true) as Promise<{ fetchedAt?: number } | null>,
      ]);
      if (seedData?.events?.length) {
        const isFresh = (seedMeta?.fetchedAt ?? 0) > 0 && (Date.now() - seedMeta!.fetchedAt!) < SEED_FRESHNESS_MS;
        if (isFresh || !process.env.SEED_FALLBACK_UNREST) {
          const filtered = filterSeedEvents(seedData.events, req);
          const sorted = sortBySeverityAndRecency(filtered);
          return { events: sorted, clusters: [], pagination: undefined };
        }
      }
    } catch {}

    // Fallback: live fetch with caching
    const startBucket = req.start > 0 ? new Date(req.start).toISOString().slice(0, 10) : 'default';
    const endBucket = req.end > 0 ? new Date(req.end).toISOString().slice(0, 10) : 'default';
    const cacheKey = `${REDIS_CACHE_KEY}:${req.country || 'all'}:${startBucket}:${endBucket}`;
    const result = await cachedFetchJson<ListUnrestEventsResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        const [acledResult, gdeltResult] = await Promise.allSettled([
          fetchAcledProtests(req),
          fetchGdeltEvents(),
        ]);
        const acledEvents = acledResult.status === 'fulfilled' ? acledResult.value : [];
        const gdeltEvents = gdeltResult.status === 'fulfilled' ? gdeltResult.value : [];
        if (acledResult.status === 'rejected') console.warn('[unrest] ACLED fetch failed:', acledResult.reason);
        if (gdeltResult.status === 'rejected') console.warn('[unrest] GDELT fetch failed:', gdeltResult.reason);
        const merged = deduplicateEvents([...acledEvents, ...gdeltEvents]);
        const sorted = sortBySeverityAndRecency(merged);
        if (sorted.length > 0) console.log(`[unrest] ${sorted.length} events (ACLED=${acledEvents.length}, GDELT=${gdeltEvents.length})`);
        return sorted.length > 0 ? { events: sorted, clusters: [], pagination: undefined } : null;
      },
      600, // negative cache 10 min — GDELT rate-limits aggressively
    );
    return result || { events: [], clusters: [], pagination: undefined };
  } catch {
    return { events: [], clusters: [], pagination: undefined };
  }
}

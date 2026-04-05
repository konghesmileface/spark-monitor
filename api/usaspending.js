import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

const API_BASE = 'https://api.usaspending.gov/api/v2';

let cached = null;
let cachedAt = 0;
const CACHE_TTL = 3600_000; // 1 hour

let inflight = null;
let negUntil = 0;
const NEG_TTL = 300_000; // 5 min negative cache

const AWARD_TYPE_MAP = {
  'A': 'contract', 'B': 'contract', 'C': 'contract', 'D': 'contract',
  '02': 'grant', '03': 'grant', '04': 'grant', '05': 'grant',
  '06': 'grant', '10': 'grant',
  '07': 'loan', '08': 'loan',
};

function getDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

async function fetchFromUSASpending() {
  const periodStart = getDateDaysAgo(7);
  const periodEnd = new Date().toISOString().split('T')[0];

  const response = await fetch(`${API_BASE}/search/spending_by_award/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      filters: {
        time_period: [{ start_date: periodStart, end_date: periodEnd }],
        award_type_codes: ['A', 'B', 'C', 'D'],
      },
      fields: [
        'Award ID', 'Recipient Name', 'Award Amount',
        'Awarding Agency', 'Description', 'Start Date', 'Award Type',
      ],
      limit: 15,
      order: 'desc',
      sort: 'Award Amount',
    }),
  });

  if (!response.ok) throw new Error(`USASpending API HTTP ${response.status}`);

  const data = await response.json();
  const results = data.results || [];

  const awards = results.map((r) => ({
    id: String(r['Award ID'] || ''),
    recipientName: String(r['Recipient Name'] || 'Unknown'),
    amount: Number(r['Award Amount']) || 0,
    agency: String(r['Awarding Agency'] || 'Unknown'),
    description: String(r['Description'] || '').slice(0, 200),
    startDate: String(r['Start Date'] || ''),
    awardType: AWARD_TYPE_MAP[String(r['Award Type'] || '')] || 'other',
  }));

  return {
    awards,
    totalAmount: awards.reduce((sum, a) => sum + a.amount, 0),
    periodStart,
    periodEnd,
    fetchedAt: new Date().toISOString(),
  };
}

async function getData() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL) return cached;
  if (now < negUntil) throw new Error('USASpending data temporarily unavailable');
  if (inflight) return inflight;

  inflight = fetchFromUSASpending()
    .then((result) => {
      cached = result;
      cachedAt = Date.now();
      inflight = null;
      return result;
    })
    .catch((err) => {
      inflight = null;
      negUntil = Date.now() + NEG_TTL;
      throw err;
    });

  return inflight;
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    const data = await getData();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=3600, stale-while-revalidate=1800, stale-if-error=3600',
        ...corsHeaders,
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'USASpending data temporarily unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}

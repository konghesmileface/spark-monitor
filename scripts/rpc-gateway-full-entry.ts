#!/usr/bin/env node
/**
 * Full RPC Gateway — serves ALL 22 domain APIs for self-hosted deployment.
 *
 * Replaces the simplified rpc-gateway.cjs (which only handled market + economic)
 * with the complete Vercel serverless function equivalents compiled into a single
 * Node.js HTTP server.
 *
 * Build: node scripts/build-rpc-gateway-full.mjs
 * Run:   node scripts/rpc-gateway-full.mjs
 *
 * Required env vars:
 *   UPSTASH_REDIS_REST_URL   — Upstash adapter (http://127.0.0.1:8079)
 *   UPSTASH_REDIS_REST_TOKEN — Token for adapter (local-dev-token)
 *
 * Optional env vars (enable specific data sources):
 *   FINNHUB_API_KEY, FRED_API_KEY, EIA_API_KEY, GROQ_API_KEY,
 *   OPENROUTER_API_KEY, ACLED_ACCESS_TOKEN, UCDP_ACCESS_TOKEN,
 *   CLOUDFLARE_API_TOKEN, NASA_FIRMS_API_KEY, WTO_API_KEY,
 *   AVIATIONSTACK_API, OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET,
 *   WS_RELAY_URL, HTTP_PROXY/HTTPS_PROXY
 */

import http from 'node:http';
import events from 'node:events';
import { ProxyAgent } from 'undici';

// ── Suppress AbortSignal MaxListenersExceededWarning ─────────
// Every Redis operation (redis.ts) creates AbortSignal.timeout() via fetch(),
// and under load hundreds of concurrent abort signals accumulate listeners
// on the shared internal EventTarget scheduler. Node.js default limit is 10,
// which triggers noisy warnings and can cause periodic restarts.
// Setting to 0 (unlimited) is safe here — these are short-lived timeout signals.
events.setMaxListeners(0);

// ── Proxy dispatcher for GFW bypass ─────────────────────────
const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || 'http://127.0.0.1:17890';
try {
  (globalThis as any).__proxyDispatcher = new ProxyAgent({
    uri: PROXY_URL,
    connect: { timeout: 30_000 },  // 30s connect timeout (GDELT via proxy is slow)
  });
  console.log(`[rpc-gw-full] Proxy dispatcher: ${PROXY_URL}`);
} catch (err) {
  console.warn(`[rpc-gw-full] Failed to create proxy dispatcher: ${err}`);
}

// ── Import server utilities ─────────────────────────────────
import { createRouter, type RouteDescriptor } from '../server/router';
import { serverOptions } from '../server/gateway';

// ── Import all 22 domain handlers ───────────────────────────
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler';
import { climateHandler } from '../server/worldmonitor/climate/v1/handler';
import { conflictHandler } from '../server/worldmonitor/conflict/v1/handler';
import { cyberHandler } from '../server/worldmonitor/cyber/v1/handler';
import { displacementHandler } from '../server/worldmonitor/displacement/v1/handler';
import { economicHandler } from '../server/worldmonitor/economic/v1/handler';
import { givingHandler } from '../server/worldmonitor/giving/v1/handler';
import { infrastructureHandler } from '../server/worldmonitor/infrastructure/v1/handler';
import { intelligenceHandler } from '../server/worldmonitor/intelligence/v1/handler';
import { maritimeHandler } from '../server/worldmonitor/maritime/v1/handler';
import { marketHandler } from '../server/worldmonitor/market/v1/handler';
import { militaryHandler } from '../server/worldmonitor/military/v1/handler';
import { naturalHandler } from '../server/worldmonitor/natural/v1/handler';
import { newsHandler } from '../server/worldmonitor/news/v1/handler';
import { positiveEventsHandler } from '../server/worldmonitor/positive-events/v1/handler';
import { predictionHandler } from '../server/worldmonitor/prediction/v1/handler';
import { researchHandler } from '../server/worldmonitor/research/v1/handler';
import { seismologyHandler } from '../server/worldmonitor/seismology/v1/handler';
import { supplyChainHandler } from '../server/worldmonitor/supply-chain/v1/handler';
import { tradeHandler } from '../server/worldmonitor/trade/v1/handler';
import { unrestHandler } from '../server/worldmonitor/unrest/v1/handler';
import { wildfireHandler } from '../server/worldmonitor/wildfire/v1/handler';

// ── Import all 22 route creators ────────────────────────────
import { createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server';
import { createClimateServiceRoutes } from '../src/generated/server/worldmonitor/climate/v1/service_server';
import { createConflictServiceRoutes } from '../src/generated/server/worldmonitor/conflict/v1/service_server';
import { createCyberServiceRoutes } from '../src/generated/server/worldmonitor/cyber/v1/service_server';
import { createDisplacementServiceRoutes } from '../src/generated/server/worldmonitor/displacement/v1/service_server';
import { createEconomicServiceRoutes } from '../src/generated/server/worldmonitor/economic/v1/service_server';
import { createGivingServiceRoutes } from '../src/generated/server/worldmonitor/giving/v1/service_server';
import { createInfrastructureServiceRoutes } from '../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { createIntelligenceServiceRoutes } from '../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { createMaritimeServiceRoutes } from '../src/generated/server/worldmonitor/maritime/v1/service_server';
import { createMarketServiceRoutes } from '../src/generated/server/worldmonitor/market/v1/service_server';
import { createMilitaryServiceRoutes } from '../src/generated/server/worldmonitor/military/v1/service_server';
import { createNaturalServiceRoutes } from '../src/generated/server/worldmonitor/natural/v1/service_server';
import { createNewsServiceRoutes } from '../src/generated/server/worldmonitor/news/v1/service_server';
import { createPositiveEventsServiceRoutes } from '../src/generated/server/worldmonitor/positive_events/v1/service_server';
import { createPredictionServiceRoutes } from '../src/generated/server/worldmonitor/prediction/v1/service_server';
import { createResearchServiceRoutes } from '../src/generated/server/worldmonitor/research/v1/service_server';
import { createSeismologyServiceRoutes } from '../src/generated/server/worldmonitor/seismology/v1/service_server';
import { createSupplyChainServiceRoutes } from '../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { createTradeServiceRoutes } from '../src/generated/server/worldmonitor/trade/v1/service_server';
import { createUnrestServiceRoutes } from '../src/generated/server/worldmonitor/unrest/v1/service_server';
import { createWildfireServiceRoutes } from '../src/generated/server/worldmonitor/wildfire/v1/service_server';

// ── Merge all routes ────────────────────────────────────────
const allRoutes: RouteDescriptor[] = [
  ...createAviationServiceRoutes(aviationHandler, serverOptions),
  ...createClimateServiceRoutes(climateHandler, serverOptions),
  ...createConflictServiceRoutes(conflictHandler, serverOptions),
  ...createCyberServiceRoutes(cyberHandler, serverOptions),
  ...createDisplacementServiceRoutes(displacementHandler, serverOptions),
  ...createEconomicServiceRoutes(economicHandler, serverOptions),
  ...createGivingServiceRoutes(givingHandler, serverOptions),
  ...createInfrastructureServiceRoutes(infrastructureHandler, serverOptions),
  ...createIntelligenceServiceRoutes(intelligenceHandler, serverOptions),
  ...createMaritimeServiceRoutes(maritimeHandler, serverOptions),
  ...createMarketServiceRoutes(marketHandler, serverOptions),
  ...createMilitaryServiceRoutes(militaryHandler, serverOptions),
  ...createNaturalServiceRoutes(naturalHandler, serverOptions),
  ...createNewsServiceRoutes(newsHandler, serverOptions),
  ...createPositiveEventsServiceRoutes(positiveEventsHandler, serverOptions),
  ...createPredictionServiceRoutes(predictionHandler, serverOptions),
  ...createResearchServiceRoutes(researchHandler, serverOptions),
  ...createSeismologyServiceRoutes(seismologyHandler, serverOptions),
  ...createSupplyChainServiceRoutes(supplyChainHandler, serverOptions),
  ...createTradeServiceRoutes(tradeHandler, serverOptions),
  ...createUnrestServiceRoutes(unrestHandler, serverOptions),
  ...createWildfireServiceRoutes(wildfireHandler, serverOptions),
];

// Log route summary
const domainCounts = new Map<string, number>();
for (const route of allRoutes) {
  const domain = route.path.split('/')[2] || 'unknown';
  domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
}
console.log(`[rpc-gw-full] Loaded ${allRoutes.length} routes across ${domainCounts.size} domains:`);
for (const [domain, count] of [...domainCounts.entries()].sort()) {
  console.log(`  ${domain}: ${count} routes`);
}

const router = createRouter(allRoutes);

// ── EIA proxy handler (standalone, not part of RPC system) ──
async function handleEIA(pathname: string): Promise<{ status: number; body: unknown } | null> {
  const path = pathname.replace('/api/eia', '');
  const apiKey = process.env.EIA_API_KEY;

  if (!apiKey) {
    return { status: 200, body: { configured: false, skipped: true, reason: 'EIA_API_KEY not configured' } };
  }

  if (path === '/health' || path === '' || path === '/') {
    return { status: 200, body: { configured: true } };
  }

  if (path === '/petroleum') {
    const series: Record<string, string> = {
      wti: 'PET.RWTC.W', brent: 'PET.RBRTE.W',
      production: 'PET.WCRFPUS2.W', inventory: 'PET.WCESTUS1.W',
    };
    const results: Record<string, unknown> = {};
    const fetchResults = await Promise.all(
      Object.entries(series).map(async ([key, seriesId]) => {
        try {
          const resp = await fetch(
            `https://api.eia.gov/v2/seriesid/${seriesId}?api_key=${apiKey}&num=2`,
            { headers: { Accept: 'application/json' } },
          );
          if (!resp.ok) return null;
          const data = (await resp.json()) as any;
          const values = data?.response?.data || [];
          if (values.length >= 1) {
            return { key, data: { current: values[0]?.value, previous: values[1]?.value || values[0]?.value, date: values[0]?.period, unit: values[0]?.unit } };
          }
        } catch (e: any) { console.error(`[EIA] Failed to fetch ${key}:`, e.message); }
        return null;
      }),
    );
    for (const r of fetchResults) { if (r) results[r.key] = r.data; }
    return { status: 200, body: results };
  }

  return null;
}

// ── USASpending proxy handler ────────────────────────────────
const USA_SPENDING_API = 'https://api.usaspending.gov/api/v2';
let usaSpendingCache: { data: unknown; at: number } | null = null;
const USA_SPENDING_CACHE_TTL = 3600_000; // 1 hour

const AWARD_TYPE_MAP: Record<string, string> = {
  'A': 'contract', 'B': 'contract', 'C': 'contract', 'D': 'contract',
  '02': 'grant', '03': 'grant', '04': 'grant', '05': 'grant',
  '06': 'grant', '10': 'grant',
  '07': 'loan', '08': 'loan',
};

async function handleUSASpending(): Promise<{ status: number; body: unknown }> {
  const now = Date.now();
  if (usaSpendingCache && now - usaSpendingCache.at < USA_SPENDING_CACHE_TTL) {
    return { status: 200, body: usaSpendingCache.data };
  }

  try {
    const daysBack = 7;
    const periodEnd = new Date().toISOString().split('T')[0];
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    const periodStart = startDate.toISOString().split('T')[0];

    const resp = await fetch(`${USA_SPENDING_API}/search/spending_by_award/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: {
          time_period: [{ start_date: periodStart, end_date: periodEnd }],
          award_type_codes: ['A', 'B', 'C', 'D'],
        },
        fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Description', 'Start Date', 'Award Type'],
        limit: 15,
        order: 'desc',
        sort: 'Award Amount',
      }),
    });

    if (!resp.ok) {
      console.error(`[USASpending] API HTTP ${resp.status}`);
      return { status: 502, body: { error: `USASpending API HTTP ${resp.status}` } };
    }

    const data = (await resp.json()) as { results?: Array<Record<string, unknown>> };
    const results = data.results || [];

    const awards = results.map((r: Record<string, unknown>) => ({
      id: String(r['Award ID'] || ''),
      recipientName: String(r['Recipient Name'] || 'Unknown'),
      amount: Number(r['Award Amount']) || 0,
      agency: String(r['Awarding Agency'] || 'Unknown'),
      description: String(r['Description'] || '').slice(0, 200),
      startDate: String(r['Start Date'] || ''),
      awardType: AWARD_TYPE_MAP[String(r['Award Type'] || '')] || 'other',
    }));

    const body = {
      awards,
      totalAmount: awards.reduce((sum: number, a: { amount: number }) => sum + a.amount, 0),
      periodStart,
      periodEnd,
      fetchedAt: new Date().toISOString(),
    };

    usaSpendingCache = { data: body, at: now };
    return { status: 200, body };
  } catch (e: any) {
    console.error('[USASpending] Fetch failed:', e.message);
    if (usaSpendingCache) {
      return { status: 200, body: usaSpendingCache.data };
    }
    return { status: 502, body: { error: 'USASpending data temporarily unavailable' } };
  }
}

// ── HTTP Server ─────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8077);
const REQUEST_TIMEOUT_MS = 60_000;  // 60s — some upstream APIs (GDELT, HAPI) are slow through proxy

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, X-WorldMonitor-Key',
};

function jsonReply(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    ...CORS_HEADERS,
  });
  res.end(json);
}

const server = http.createServer(async (nodeReq, nodeRes) => {
  const timer = setTimeout(() => {
    if (!nodeRes.headersSent) {
      jsonReply(nodeRes, 504, { error: 'Gateway timeout' });
    }
  }, REQUEST_TIMEOUT_MS);

  try {
    // CORS preflight
    if (nodeReq.method === 'OPTIONS') {
      clearTimeout(timer);
      nodeRes.writeHead(204, { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' });
      nodeRes.end();
      return;
    }

    const url = new URL(nodeReq.url!, `http://${nodeReq.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Health check
    if (pathname === '/health') {
      clearTimeout(timer);
      jsonReply(nodeRes, 200, {
        status: 'ok',
        routes: allRoutes.length,
        domains: domainCounts.size,
        uptime: process.uptime(),
        redis: process.env.UPSTASH_REDIS_REST_URL ? 'configured' : 'in-memory',
      });
      return;
    }

    // EIA proxy (standalone handler, not part of RPC system)
    if (pathname.startsWith('/api/eia')) {
      const eiaResult = await handleEIA(pathname);
      clearTimeout(timer);
      if (eiaResult) {
        jsonReply(nodeRes, eiaResult.status, eiaResult.body);
      } else {
        jsonReply(nodeRes, 404, { error: 'EIA endpoint not found' });
      }
      return;
    }

    // USASpending proxy (standalone handler, not part of RPC system)
    if (pathname === '/api/usaspending') {
      const usaResult = await handleUSASpending();
      clearTimeout(timer);
      jsonReply(nodeRes, usaResult.status, usaResult.body);
      return;
    }

    // Convert Node.js IncomingMessage → Web API Request
    const headers = new Headers();
    for (const [key, value] of Object.entries(nodeReq.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }

    let bodyBuffer: Buffer | null = null;
    if (nodeReq.method === 'POST' || nodeReq.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
      bodyBuffer = Buffer.concat(chunks);
    }

    let request = new Request(url.toString(), {
      method: nodeReq.method,
      headers,
      body: bodyBuffer,
      // @ts-expect-error duplex required for Node.js request bodies
      duplex: 'half',
    });

    // Route matching
    let handler = router.match(request);

    // POST→GET conversion for stale clients
    if (!handler && nodeReq.method === 'POST' && bodyBuffer) {
      try {
        const postBody = JSON.parse(bodyBuffer.toString('utf8')) as Record<string, unknown>;
        const getUrl = new URL(url.toString());
        for (const [k, v] of Object.entries(postBody)) {
          if (Array.isArray(v)) v.forEach((item) => getUrl.searchParams.append(k, String(item)));
          else if (v != null) getUrl.searchParams.set(k, String(v));
        }
        const getReq = new Request(getUrl.toString(), { method: 'GET', headers });
        const getHandler = router.match(getReq);
        if (getHandler) {
          handler = getHandler;
          request = getReq;
        }
      } catch { /* non-JSON body — skip conversion */ }
    }

    if (!handler) {
      clearTimeout(timer);
      jsonReply(nodeRes, 404, { error: `Not found: ${pathname}` });
      return;
    }

    // Execute handler
    const response = await handler(request);
    clearTimeout(timer);

    // Convert Web API Response → Node.js ServerResponse
    const resHeaders: Record<string, string> = { ...CORS_HEADERS };
    response.headers.forEach((v, k) => { resHeaders[k] = v; });

    if (response.body) {
      const arrayBuffer = await response.arrayBuffer();
      nodeRes.writeHead(response.status, resHeaders);
      nodeRes.end(Buffer.from(arrayBuffer));
    } else {
      nodeRes.writeHead(response.status, resHeaders);
      nodeRes.end();
    }
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[rpc-gw-full] Unhandled error:', msg);
    if (!nodeRes.headersSent) {
      jsonReply(nodeRes, 500, { error: 'Internal server error' });
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[rpc-gw-full] ═══════════════════════════════════════════`);
  console.log(`[rpc-gw-full] Full RPC Gateway on http://127.0.0.1:${PORT}`);
  console.log(`[rpc-gw-full] ${allRoutes.length} routes across ${domainCounts.size} domains`);
  console.log(`[rpc-gw-full] Proxy: ${PROXY_URL}`);
  console.log(`[rpc-gw-full] Redis: ${process.env.UPSTASH_REDIS_REST_URL || '(in-memory fallback)'}`);
  console.log(`[rpc-gw-full] ═══════════════════════════════════════════`);
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[rpc-gw-full] Received ${sig}, shutting down...`);
    server.close();
    process.exit(0);
  });
}

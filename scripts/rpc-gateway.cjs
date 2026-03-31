#!/usr/bin/env node
/**
 * RPC Gateway — serves /api/market/v1/* and /api/economic/v1/* endpoints
 * by reading relay-seeded data from Redis.
 *
 * On Vercel these are edge functions; this script provides equivalent
 * functionality for self-hosted deployment.
 *
 * Supported RPCs:
 *   Market:
 *     GET /api/market/v1/list-market-quotes?symbols=...
 *     GET /api/market/v1/list-crypto-quotes?ids=...
 *     GET /api/market/v1/list-commodity-quotes?symbols=...
 *     GET /api/market/v1/get-sector-summary?period=...
 *     GET /api/market/v1/list-stablecoin-markets?coins=...
 *     GET /api/market/v1/list-etf-flows
 *     GET /api/market/v1/get-country-stock-index?countryCode=...
 *     GET /api/market/v1/list-gulf-quotes
 *
 *   Economic (reads from Redis if available, else returns empty stubs):
 *     GET /api/economic/v1/get-fred-series?seriesId=...&limit=...
 *     GET /api/economic/v1/list-world-bank-indicators?...
 *     GET /api/economic/v1/get-energy-prices?commodities=...
 *     GET /api/economic/v1/get-macro-signals
 *     GET /api/economic/v1/get-energy-capacity?...
 *     GET /api/economic/v1/get-bis-policy-rates
 *     GET /api/economic/v1/get-bis-exchange-rates
 *     GET /api/economic/v1/get-bis-credit
 *
 * Usage:
 *   PORT=8077 node rpc-gateway.cjs
 */

const http = require('http');
const Redis = require('ioredis');

const PORT = Number(process.env.PORT || 8077);
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379/0';
const REQUEST_TIMEOUT_MS = 10000;

// ── Redis connection ─────────────────────────────────────────
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 3000);
    console.log(`[rpc-gw] Redis reconnecting in ${delay}ms (attempt ${times})`);
    return delay;
  },
  lazyConnect: false,
});

redis.on('connect', () => console.log('[rpc-gw] Redis connected'));
redis.on('error', (err) => console.error('[rpc-gw] Redis error:', err.message));

// ── Helpers ──────────────────────────────────────────────────

function jsonReply(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function redisGet(key) {
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn(`[rpc-gw] Redis GET ${key} failed:`, err.message);
    return null;
  }
}

function parseCSV(val) {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

// ── Market Symbols (must match relay's MARKET_SYMBOLS) ───────

const STOCK_SYMBOLS = [
  '^DJI', '^GSPC', '^IXIC',
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'AVGO',
  'BRK-B', 'LLY', 'UNH', 'JPM', 'V', 'MA', 'HD', 'COST', 'NFLX',
  'PG', 'JNJ', 'BAC', 'XOM', 'WMT', 'NVO', 'ORCL', 'TSM',
];

const COMMODITY_SYMBOLS = ['CL=F', 'GC=F', 'SI=F', 'HG=F', 'NG=F', '^VIX'];
const SECTOR_SYMBOLS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH'];

const SECTOR_NAMES = {
  XLK: 'Technology', XLF: 'Financials', XLE: 'Energy', XLV: 'Healthcare',
  XLY: 'Consumer Discretionary', XLI: 'Industrials', XLP: 'Consumer Staples',
  XLU: 'Utilities', XLB: 'Materials', XLRE: 'Real Estate', XLC: 'Communication',
  SMH: 'Semiconductors',
};

const COUNTRY_INDEX = {
  US: '^GSPC', GB: '^FTSE', DE: '^GDAXI', FR: '^FCHI', JP: '^N225',
  CN: '000001.SS', HK: '^HSI', IN: '^BSESN', KR: '^KS11', TW: '^TWII',
  AU: '^AXJO', BR: '^BVSP', CA: '^GSPTSE', MX: '^MXX', AR: '^MERV',
  RU: 'IMOEX.ME', ZA: '^J203.JO', SA: '^TASI.SR', AE: 'DFMGI.AE',
  IL: '^TA125.TA', TR: 'XU100.IS', PL: '^WIG20', NL: '^AEX', CH: '^SSMI',
  ES: '^IBEX', IT: 'FTSEMIB.MI', SE: '^OMX', NO: '^OSEAX', SG: '^STI', TH: '^SET.BK',
};

// ── Market RPC Handlers ──────────────────────────────────────

async function listMarketQuotes(params) {
  const requestedSymbols = parseCSV(params.get('symbols'));
  const symbolSet = new Set(requestedSymbols.length ? requestedSymbols : STOCK_SYMBOLS);

  // Try bootstrap data first (written by relay as a single blob)
  const bootstrap = await redisGet('market:stocks-bootstrap:v1');
  if (bootstrap && bootstrap.quotes && bootstrap.quotes.length > 0) {
    const filtered = bootstrap.quotes.filter(q => symbolSet.has(q.symbol));
    if (filtered.length > 0) {
      return { quotes: filtered, finnhubSkipped: false, skipReason: '', rateLimited: false };
    }
  }

  // Try the keyed cache
  const cacheKey = 'market:quotes:v1:' + [...symbolSet].sort().join(',');
  const cached = await redisGet(cacheKey);
  if (cached && cached.quotes) {
    return cached;
  }

  return { quotes: [], finnhubSkipped: false, skipReason: 'No data seeded', rateLimited: false };
}

async function listCryptoQuotes(params) {
  const data = await redisGet('market:crypto:v1');
  if (data && data.quotes && data.quotes.length > 0) {
    return { quotes: data.quotes };
  }
  return { quotes: [] };
}

async function listCommodityQuotes(params) {
  const requestedSymbols = parseCSV(params.get('symbols'));
  const symbolSet = new Set(requestedSymbols.length ? requestedSymbols : COMMODITY_SYMBOLS);

  // Try bootstrap commodity data
  const bootstrap = await redisGet('market:commodities-bootstrap:v1');
  if (bootstrap && bootstrap.quotes && bootstrap.quotes.length > 0) {
    const filtered = bootstrap.quotes.filter(q => symbolSet.has(q.symbol));
    if (filtered.length > 0) {
      return { quotes: filtered };
    }
  }

  // Try keyed cache
  const cacheKey = 'market:quotes:v1:' + [...symbolSet].sort().join(',');
  const cached = await redisGet(cacheKey);
  if (cached && cached.quotes) {
    return cached;
  }

  // Also try the commodities-specific key
  const commKey = 'market:commodities:v1:' + [...symbolSet].sort().join(',');
  const commCached = await redisGet(commKey);
  if (commCached && commCached.quotes) {
    return commCached;
  }

  return { quotes: [] };
}

async function getSectorSummary(params) {
  const data = await redisGet('market:sectors:v1');
  if (data && data.sectors && data.sectors.length > 0) {
    return data;
  }

  // Try from quotes cache (relay writes sectors under quotes key too)
  const quotesKey = 'market:quotes:v1:' + [...SECTOR_SYMBOLS].sort().join(',');
  const quotesData = await redisGet(quotesKey);
  if (quotesData && quotesData.quotes && quotesData.quotes.length > 0) {
    const sectors = quotesData.quotes.map(q => ({
      symbol: q.symbol,
      name: SECTOR_NAMES[q.symbol] || q.symbol,
      change: q.change || 0,
    }));
    return { sectors };
  }

  return { sectors: [] };
}

async function listStablecoinMarkets(params) {
  const data = await redisGet('market:stablecoins:v1');
  if (data && data.stablecoins) {
    return data;
  }
  return { timestamp: new Date().toISOString(), stablecoins: [] };
}

async function listEtfFlows(params) {
  const data = await redisGet('market:etf-flows:v1');
  if (data && data.etfs) {
    return data;
  }
  return {
    timestamp: new Date().toISOString(),
    summary: { etfCount: 0, totalVolume: 0, totalEstFlow: 0, netDirection: 'UNAVAILABLE', inflowCount: 0, outflowCount: 0 },
    etfs: [],
    rateLimited: false,
  };
}

async function getCountryStockIndex(params) {
  const countryCode = (params.get('countryCode') || '').toUpperCase();
  const symbol = COUNTRY_INDEX[countryCode];
  if (!symbol) {
    return { countryCode, indexName: '', symbol: '', price: 0, change: 0, sparkline: [], found: false };
  }

  // Try finding in bootstrap data
  const bootstrap = await redisGet('market:stocks-bootstrap:v1');
  if (bootstrap && bootstrap.quotes) {
    const match = bootstrap.quotes.find(q => q.symbol === symbol);
    if (match) {
      return {
        countryCode,
        indexName: match.name || match.display || symbol,
        symbol,
        price: match.price || 0,
        change: match.change || 0,
        sparkline: match.sparkline || [],
        found: true,
      };
    }
  }

  return { countryCode, indexName: symbol, symbol, price: 0, change: 0, sparkline: [], found: false };
}

async function listGulfQuotes(params) {
  const data = await redisGet('market:gulf-quotes:v1');
  if (data && data.quotes) {
    return data;
  }
  return { quotes: [] };
}

// ── Economic RPC Handlers (reads Redis, falls back to stubs) ─

function stubEconomicResponse(rpcName) {
  const stubs = {
    'get-fred-series': { series: null },
    'list-world-bank-indicators': { data: [], pagination: null },
    'get-energy-prices': { prices: [] },
    'get-macro-signals': { signals: [], timestamp: new Date().toISOString() },
    'get-energy-capacity': { data: [] },
    'get-bis-policy-rates': { rates: [] },
    'get-bis-exchange-rates': { rates: [] },
    'get-bis-credit': { data: [] },
  };
  return stubs[rpcName] || {};
}

// ── Route Table ──────────────────────────────────────────────

const MARKET_ROUTES = {
  'list-market-quotes': listMarketQuotes,
  'list-crypto-quotes': listCryptoQuotes,
  'list-commodity-quotes': listCommodityQuotes,
  'get-sector-summary': getSectorSummary,
  'list-stablecoin-markets': listStablecoinMarkets,
  'list-etf-flows': listEtfFlows,
  'get-country-stock-index': getCountryStockIndex,
  'list-gulf-quotes': listGulfQuotes,
};

const ECONOMIC_RPCS = [
  'get-fred-series',
  'list-world-bank-indicators',
  'get-energy-prices',
  'get-macro-signals',
  'get-energy-capacity',
  'get-bis-policy-rates',
  'get-bis-exchange-rates',
  'get-bis-credit',
];

// ── HTTP Server ──────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      jsonReply(res, 504, { error: 'Gateway timeout' });
    }
  }, REQUEST_TIMEOUT_MS);

  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      clearTimeout(timer);
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // Health check
    if (pathname === '/health') {
      clearTimeout(timer);
      const status = redis.status;
      jsonReply(res, status === 'ready' ? 200 : 503, {
        status: status === 'ready' ? 'ok' : 'error',
        redis: status,
        uptime: process.uptime(),
      });
      return;
    }

    // POST→GET conversion (frontend may POST with JSON body)
    let params = url.searchParams;
    if (req.method === 'POST') {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        params = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) {
          if (Array.isArray(v)) params.set(k, v.join(','));
          else if (v != null) params.set(k, String(v));
        }
      } catch { /* keep URL params */ }
    }

    // ── Market RPCs ──
    const marketMatch = pathname.match(/^\/api\/market\/v1\/(.+)$/);
    if (marketMatch) {
      const rpcName = marketMatch[1];
      const handler = MARKET_ROUTES[rpcName];
      if (handler) {
        const result = await handler(params);
        clearTimeout(timer);
        jsonReply(res, 200, result);
        return;
      }
      clearTimeout(timer);
      jsonReply(res, 404, { error: 'Unknown market RPC: ' + rpcName });
      return;
    }

    // ── Economic RPCs ──
    const econMatch = pathname.match(/^\/api\/economic\/v1\/(.+)$/);
    if (econMatch) {
      const rpcName = econMatch[1];
      if (ECONOMIC_RPCS.includes(rpcName)) {
        // Try reading from Redis first
        const redisKeyMap = {
          'get-fred-series': 'economic:fred:v1:' + (params.get('seriesId') || '') + ':' + (params.get('limit') || '0'),
          'get-energy-prices': 'economic:energy:v1:' + (parseCSV(params.get('commodities')).sort().join(',') || 'all'),
          'get-macro-signals': 'economic:macro:v1',
          'get-energy-capacity': 'economic:capacity:v1',
          'get-bis-policy-rates': 'economic:bis:policy:v1',
          'get-bis-exchange-rates': 'economic:bis:eer:v1',
          'get-bis-credit': 'economic:bis:credit:v1',
        };

        const redisKey = redisKeyMap[rpcName];
        if (redisKey) {
          const cached = await redisGet(redisKey);
          if (cached) {
            clearTimeout(timer);
            jsonReply(res, 200, cached);
            return;
          }
        }

        // Return stub response
        clearTimeout(timer);
        jsonReply(res, 200, stubEconomicResponse(rpcName));
        return;
      }
      clearTimeout(timer);
      jsonReply(res, 404, { error: 'Unknown economic RPC: ' + rpcName });
      return;
    }

    // 404 for everything else
    clearTimeout(timer);
    jsonReply(res, 404, { error: 'Not found: ' + pathname });

  } catch (err) {
    clearTimeout(timer);
    if (!res.headersSent) {
      console.error('[rpc-gw] Request error:', err.message);
      jsonReply(res, 500, { error: err.message });
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[rpc-gw] RPC Gateway listening on http://127.0.0.1:' + PORT);
  console.log('[rpc-gw] Redis: ' + REDIS_URL);
  console.log('[rpc-gw] Market RPCs: ' + Object.keys(MARKET_ROUTES).length);
  console.log('[rpc-gw] Economic RPCs: ' + ECONOMIC_RPCS.length + ' (stub)');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[rpc-gw] Shutting down...');
  server.close();
  await redis.quit();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[rpc-gw] Shutting down...');
  server.close();
  await redis.quit();
  process.exit(0);
});

#!/usr/bin/env node
/**
 * Redis HTTP Adapter — bridges standard Redis (TCP) to Upstash REST API format.
 *
 * This lightweight adapter allows World Monitor's 63 server handlers + 7 relay
 * modules to use a local Redis instance through the same Upstash REST API they
 * were built for — zero changes to application code.
 *
 * Supported endpoints:
 *   GET  /get/{key}                      → redis.get(key)
 *   GET  /set/{key}/{value}/EX/{ttl}     → redis.set(key, value, 'EX', ttl)
 *   POST /set/{key}/{value}/EX/{ttl}     → redis.set(key, value, 'EX', ttl)
 *   POST /                               → single command (JSON body: ["CMD","arg1",...])
 *   POST /pipeline                       → batch commands (JSON body: [["CMD",...], ...])
 *   GET  /health                         → connection status
 *
 * Usage:
 *   REDIS_URL=redis://127.0.0.1:6379 ADAPTER_TOKEN=local-dev-token node redis-http-adapter.cjs
 *
 * Then set in .env.local:
 *   UPSTASH_REDIS_REST_URL=http://localhost:8079
 *   UPSTASH_REDIS_REST_TOKEN=local-dev-token
 */

const http = require('http');
const Redis = require('ioredis');

const PORT = Number(process.env.ADAPTER_PORT || 8079);
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const BEARER_TOKEN = process.env.ADAPTER_TOKEN || 'local-dev-token';
const REQUEST_TIMEOUT_MS = 5000;

// ── Redis connection ─────────────────────────────────────────
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 3000);
    console.log(`[adapter] Redis reconnecting in ${delay}ms (attempt ${times})`);
    return delay;
  },
  lazyConnect: false,
});

redis.on('connect', () => console.log('[adapter] Redis connected'));
redis.on('error', (err) => console.error('[adapter] Redis error:', err.message));

// ── Helpers ──────────────────────────────────────────────────

function jsonReply(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function checkAuth(req, res) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== BEARER_TOKEN) {
    jsonReply(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) { // 10MB limit
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Execute a single Redis command and return the result.
 * Commands are arrays like ["SET", "key", "value", "EX", "300"].
 */
async function execCommand(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('Invalid command format');
  }
  const cmd = String(args[0]).toUpperCase();
  const cmdArgs = args.slice(1).map(String);

  const result = await redis.call(cmd, ...cmdArgs);
  return result;
}

// ── HTTP Server ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Timeout guard
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      jsonReply(res, 504, { error: 'Gateway timeout' });
    }
  }, REQUEST_TIMEOUT_MS);

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // ── Health check (no auth required) ──
    if (pathname === '/health' && req.method === 'GET') {
      clearTimeout(timer);
      const status = redis.status; // 'connect' | 'ready' | 'close' | 'reconnecting' | 'end'
      jsonReply(res, status === 'ready' ? 200 : 503, {
        status: status === 'ready' ? 'ok' : 'error',
        redis: status,
        uptime: process.uptime(),
      });
      return;
    }

    // ── Auth check for all other routes ──
    if (!checkAuth(req, res)) {
      clearTimeout(timer);
      return;
    }

    // ── GET /get/{key} — Redis GET ──
    if (req.method === 'GET' && pathname.startsWith('/get/')) {
      const key = decodeURIComponent(pathname.slice(5)); // strip "/get/"
      const result = await redis.get(key);
      clearTimeout(timer);
      jsonReply(res, 200, { result });
      return;
    }

    // ── GET|POST /set/{key}/{value}/EX/{ttl} — Redis SET with EX ──
    if ((req.method === 'GET' || req.method === 'POST') && pathname.startsWith('/set/')) {
      // Parse: /set/{key}/{value}/EX/{ttl}
      // We need to be careful with URL encoding — the value may contain slashes
      // Upstash format: /set/URL_ENCODED_KEY/URL_ENCODED_VALUE/EX/TTL
      const rest = pathname.slice(5); // strip "/set/"
      const exIdx = rest.lastIndexOf('/EX/');
      if (exIdx === -1) {
        clearTimeout(timer);
        jsonReply(res, 400, { error: 'Missing /EX/{ttl} suffix' });
        return;
      }
      const ttl = parseInt(rest.slice(exIdx + 4), 10);
      const keyValue = rest.slice(0, exIdx);
      // Key is the first segment, value is everything after first /
      const slashIdx = keyValue.indexOf('/');
      if (slashIdx === -1) {
        clearTimeout(timer);
        jsonReply(res, 400, { error: 'Missing value in /set/{key}/{value}/EX/{ttl}' });
        return;
      }
      const key = decodeURIComponent(keyValue.slice(0, slashIdx));
      const value = decodeURIComponent(keyValue.slice(slashIdx + 1));

      const result = await redis.set(key, value, 'EX', ttl);
      clearTimeout(timer);
      jsonReply(res, 200, { result });
      return;
    }

    // ── POST /pipeline — batch commands ──
    if (req.method === 'POST' && pathname === '/pipeline') {
      const body = await readBody(req);
      const commands = JSON.parse(body);
      if (!Array.isArray(commands)) {
        clearTimeout(timer);
        jsonReply(res, 400, { error: 'Pipeline body must be a JSON array' });
        return;
      }

      const pipeline = redis.pipeline();
      for (const cmd of commands) {
        if (!Array.isArray(cmd) || cmd.length === 0) continue;
        const name = String(cmd[0]).toUpperCase();
        const args = cmd.slice(1).map(String);
        pipeline.call(name, ...args);
      }

      const results = await pipeline.exec();
      clearTimeout(timer);

      // ioredis pipeline returns [[err, result], ...] — convert to Upstash format
      const response = (results || []).map(([err, result]) => {
        if (err) return { error: err.message };
        return { result };
      });
      jsonReply(res, 200, response);
      return;
    }

    // ── POST / — single command ──
    if (req.method === 'POST' && (pathname === '/' || pathname === '')) {
      const body = await readBody(req);
      const args = JSON.parse(body);
      const result = await execCommand(args);
      clearTimeout(timer);
      jsonReply(res, 200, { result });
      return;
    }

    // ── 404 ──
    clearTimeout(timer);
    jsonReply(res, 404, { error: `Unknown route: ${req.method} ${pathname}` });

  } catch (err) {
    clearTimeout(timer);
    if (!res.headersSent) {
      console.error('[adapter] Request error:', err.message);
      jsonReply(res, 500, { error: err.message });
    }
  }
});

server.listen(PORT, () => {
  console.log(`[adapter] Redis HTTP Adapter listening on http://localhost:${PORT}`);
  console.log(`[adapter] Redis URL: ${REDIS_URL}`);
  console.log(`[adapter] Bearer token: ${BEARER_TOKEN.slice(0, 4)}...`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[adapter] Shutting down...');
  server.close();
  await redis.quit();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[adapter] Shutting down...');
  server.close();
  await redis.quit();
  process.exit(0);
});

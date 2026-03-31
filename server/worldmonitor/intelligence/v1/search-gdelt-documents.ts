import type {
  ServerContext,
  SearchGdeltDocumentsRequest,
  SearchGdeltDocumentsResponse,
  GdeltArticle,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';
import http from 'http';
import tls from 'tls';

const REDIS_CACHE_KEY = 'intel:gdelt-docs:v1';
const REDIS_CACHE_TTL = 1800; // 30 min — GDELT is slow through GFW proxy, cache longer

// ========================================================================
// Constants
// ========================================================================

const GDELT_MAX_RECORDS = 20;
const GDELT_DEFAULT_RECORDS = 10;
const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';

// GDELT is hosted on Google Cloud (104.197.47.124), blocked by GFW.
// undici ProxyAgent fails inside Vite SSR (TLS handshake timeout ~14s exceeds undici default).
// Use native Node.js http.request CONNECT tunnel which handles slow TLS handshakes correctly.
const _proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || '';

function gdeltFetch(urlStr: string, opts?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response> {
  if (!_proxyUrl) return fetch(urlStr, opts);

  const proxyParsed = new URL(_proxyUrl);
  const target = new URL(urlStr);

  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
    if (opts?.signal?.aborted) return onAbort();
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    const connectReq = http.request({
      host: proxyParsed.hostname,
      port: Number(proxyParsed.port) || 17890,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      timeout: 45_000,
    });

    connectReq.on('connect', (_res, socket) => {
      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
        timeout: 45_000,
      }, () => {
        const path = target.pathname + target.search;
        const reqHeaders = [
          `GET ${path} HTTP/1.1`,
          `Host: ${target.hostname}`,
          `User-Agent: ${opts?.headers?.['User-Agent'] || CHROME_UA}`,
          `Accept: application/json`,
          `Connection: close`,
          '',
          '',
        ].join('\r\n');
        tlsSocket.write(reqHeaders);
      });

      const chunks: Buffer[] = [];
      tlsSocket.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      tlsSocket.on('end', () => {
        opts?.signal?.removeEventListener('abort', onAbort);
        const raw = Buffer.concat(chunks).toString('utf-8');
        const bodyStart = raw.indexOf('\r\n\r\n');
        if (bodyStart < 0) {
          if (raw.length === 0) {
            // Server closed connection without data — likely rate-limited
            return reject(new Error('GDELT returned empty response (rate-limited?)'));
          }
          console.warn('[GDELT] No body separator. Raw length:', raw.length);
          return reject(new Error('No HTTP body in GDELT response'));
        }

        const headerSection = raw.slice(0, bodyStart);
        const statusMatch = headerSection.match(/^HTTP\/[\d.]+ (\d+)/);
        const status = statusMatch ? Number(statusMatch[1]) : 200;
        const body = raw.slice(bodyStart + 4);

        // Handle chunked transfer encoding
        let finalBody = body;
        if (headerSection.toLowerCase().includes('transfer-encoding: chunked')) {
          finalBody = decodeChunked(body);
        }

        // Trim any trailing whitespace or garbage after JSON
        const jsonEnd = finalBody.lastIndexOf('}');
        if (jsonEnd >= 0 && jsonEnd < finalBody.length - 1) {
          finalBody = finalBody.slice(0, jsonEnd + 1);
        }

        resolve(new Response(finalBody, {
          status,
          headers: { 'content-type': headerSection.toLowerCase().includes('application/json') ? 'application/json' : 'text/plain' },
        }));
      });
      tlsSocket.on('error', (err: Error) => {
        opts?.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
    });

    connectReq.on('error', (err) => {
      opts?.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    connectReq.end();
  });
}

/** Decode HTTP chunked transfer encoding */
function decodeChunked(raw: string): string {
  const parts: string[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const lineEnd = raw.indexOf('\r\n', pos);
    if (lineEnd < 0) break;
    const sizeHex = raw.slice(pos, lineEnd).trim();
    const size = parseInt(sizeHex, 16);
    if (isNaN(size) || size === 0) break;
    const chunkStart = lineEnd + 2;
    parts.push(raw.slice(chunkStart, chunkStart + size));
    pos = chunkStart + size + 2; // skip chunk data + \r\n
  }
  return parts.join('');
}

// ========================================================================
// GDELT rate-limit serializer — max 1 request per 5.5 s (API limit: 1/5s)
// ========================================================================

let gdeltQueueTail: Promise<void> = Promise.resolve();
let lastGdeltRequestMs = 0;
let gdeltIntervalMs = 6_000;           // starts at 6s, grows on 429
const GDELT_BASE_INTERVAL_MS = 6_000;
const GDELT_MAX_INTERVAL_MS = 30_000;  // cap at 30s
const GDELT_MAX_RETRIES = 3;

function enqueueGdeltFetch<T>(fn: () => Promise<T>): Promise<T> {
  const work = gdeltQueueTail.then(async () => {
    const elapsed = Date.now() - lastGdeltRequestMs;
    if (elapsed < gdeltIntervalMs) {
      await new Promise((r) => setTimeout(r, gdeltIntervalMs - elapsed));
    }
    lastGdeltRequestMs = Date.now();
    return fn();
  });
  // Chain: next caller waits for this one to finish
  gdeltQueueTail = work.then(() => {}, () => {});
  return work;
}

/** Exponential backoff on 429 — increase interval, retry up to GDELT_MAX_RETRIES */
function onGdelt429(): void {
  gdeltIntervalMs = Math.min(gdeltIntervalMs * 2, GDELT_MAX_INTERVAL_MS);
  console.warn(`[GDELT] 429 rate-limited — interval increased to ${gdeltIntervalMs}ms`);
}

/** Successful request — reset interval to base */
function onGdeltSuccess(): void {
  if (gdeltIntervalMs !== GDELT_BASE_INTERVAL_MS) {
    gdeltIntervalMs = GDELT_BASE_INTERVAL_MS;
    console.log(`[GDELT] Success — interval reset to ${GDELT_BASE_INTERVAL_MS}ms`);
  }
}

// ========================================================================
// RPC handler
// ========================================================================

export async function searchGdeltDocuments(
  _ctx: ServerContext,
  req: SearchGdeltDocumentsRequest,
): Promise<SearchGdeltDocumentsResponse> {
  let query = req.query;
  if (!query || query.length < 2) {
    return { articles: [], query: query || '', error: 'Query parameter required (min 2 characters)' };
  }

  // Append tone filter to query if provided (e.g., "tone>5" for positive articles)
  if (req.toneFilter) {
    query = `${query} ${req.toneFilter}`;
  }

  const maxRecords = Math.min(
    req.maxRecords > 0 ? req.maxRecords : GDELT_DEFAULT_RECORDS,
    GDELT_MAX_RECORDS,
  );
  const timespan = req.timespan || '72h';

  try {
    const cacheKey = `${REDIS_CACHE_KEY}:${query}:${timespan}:${maxRecords}`;
    const result = await cachedFetchJson<SearchGdeltDocumentsResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        // Serialize GDELT requests to respect rate limit, with retry on 429.
        let response: Response | null = null;
        for (let attempt = 0; attempt <= GDELT_MAX_RETRIES; attempt++) {
          response = await enqueueGdeltFetch(async () => {
            const gdeltUrl = new URL(GDELT_DOC_API);
            gdeltUrl.searchParams.set('query', query);
            gdeltUrl.searchParams.set('mode', 'artlist');
            gdeltUrl.searchParams.set('maxrecords', maxRecords.toString());
            gdeltUrl.searchParams.set('format', 'json');
            gdeltUrl.searchParams.set('sort', req.sort || 'date');
            gdeltUrl.searchParams.set('timespan', timespan);

            // GDELT via proxy needs ~25-30s (14s TLS + 12s data)
            return gdeltFetch(gdeltUrl.toString(), {
              headers: { 'User-Agent': CHROME_UA },
              signal: AbortSignal.timeout(45_000),
            });
          });

          if (response.status === 429) {
            onGdelt429();
            if (attempt < GDELT_MAX_RETRIES) {
              // Wait before next retry (the queue itself will enforce the interval)
              await new Promise(r => setTimeout(r, gdeltIntervalMs));
              continue;
            }
          }

          // Check for rate-limit disguised as 200 + plain text
          const contentType = response.headers.get('content-type') || '';
          if (response.ok && !contentType.includes('json')) {
            onGdelt429();
            if (attempt < GDELT_MAX_RETRIES) {
              await new Promise(r => setTimeout(r, gdeltIntervalMs));
              continue;
            }
          }

          break;
        }

        if (!response || !response.ok) {
          throw new Error(`GDELT returned ${response?.status ?? 'no response'}`);
        }

        onGdeltSuccess();

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('json')) {
          throw new Error('GDELT returned non-JSON (likely rate-limited)');
        }

        const data = (await response.json()) as {
          articles?: Array<{
            title?: string;
            url?: string;
            domain?: string;
            source?: { domain?: string };
            seendate?: string;
            socialimage?: string;
            language?: string;
            tone?: number;
          }>;
        };

        const articles: GdeltArticle[] = (data.articles || []).map((article) => ({
          title: article.title || '',
          url: article.url || '',
          source: article.domain || article.source?.domain || '',
          date: article.seendate || '',
          image: article.socialimage || '',
          language: article.language || '',
          tone: typeof article.tone === 'number' ? article.tone : 0,
        }));

        if (articles.length === 0) return null;
        return { articles, query, error: '' } as SearchGdeltDocumentsResponse;
      },
    );
    return result || { articles: [], query, error: '' };
  } catch (error) {
    return {
      articles: [],
      query,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Proxy-aware fetch for GFW bypass in dev mode.
 * Uses the ProxyAgent shared via globalThis from vite.config.ts.
 *
 * Strategy: ONLY route GFW-blocked domains through the proxy.
 * All other domains go direct to avoid proxy IP rate-limiting.
 * Most data APIs (Finnhub, FRED, WTO, NASA, etc.) are
 * accessible from China and work better direct (no shared IP limits).
 * GDELT is hosted on Google Cloud and blocked by GFW — must go through proxy.
 */

/** Domains that REQUIRE proxy (blocked by GFW in China) */
const PROXY_REQUIRED_DOMAINS = [
  // Google
  'googleapis.com',
  'google.com',
  'googlevideo.com',
  'gstatic.com',
  // Yahoo Finance
  'finance.yahoo.com',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'fc.yahoo.com',
  // Social media (blocked in China)
  'twitter.com',
  'x.com',
  'reddit.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  // AI services
  'openai.com',
  'anthropic.com',
  'groq.com',
  'api.groq.com',
  'openrouter.ai',
  // News sites sometimes blocked
  'bbc.co.uk',
  'bbc.com',
  // Telegram
  'telegram.org',
  't.me',
  // GDELT — hosted on Google Cloud (104.197.47.124), blocked by GFW
  'gdeltproject.org',
  'api.gdeltproject.org',
  // Data APIs that are slow/unreliable direct from China
  'api.coingecko.com',
  'ucdpapi.pcr.uu.se',
  'api.unhcr.org',
  'acleddata.com',
  // Defense/intel RSS feeds often slow direct
  'defenseone.com',
  'breakingdefense.com',
  'twz.com',
  'defensenews.com',
  'militarytimes.com',
  'foreignpolicy.com',
  'foreignaffairs.com',
  'atlanticcouncil.org',
  'techcrunch.com',
  // USNI Fleet Tracker (US Navy news)
  'news.usni.org',
  'usni.org',
  // Polymarket prediction (Cloudflare may block direct)
  'gamma-api.polymarket.com',
  // GitHub trending (may be slow direct from China)
  'github.com',
  // NGA maritime safety (sometimes unreliable direct)
  'msi.nga.mil',
  // GPS jamming data
  'gpsjam.org',
  // Tech events RSS (unreliable direct from some regions)
  'dev.events',
  'techmeme.com',
  // OpenSky for military flight tracking
  'opensky-network.org',
  // WTO API (sometimes slow direct from HK)
  'api.wto.org',
  // HAPI humanitarian data
  'hapi.humdata.org',
  // BIS stats
  'stats.bis.org',
];

function needsProxy(urlStr: string): boolean {
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(urlStr)) return false;
  try {
    const host = new URL(urlStr).hostname;
    return PROXY_REQUIRED_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

export function proxyFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const dispatcher = (globalThis as any).__proxyDispatcher;
  if (dispatcher) {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (urlStr && needsProxy(urlStr)) {
      return fetch(url, { ...init, dispatcher } as any);
    }
    // Direct fetch for non-GFW-blocked domains
    return fetch(url, init);
  }
  return fetch(url, init);
}

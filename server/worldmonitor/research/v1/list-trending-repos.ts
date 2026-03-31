/**
 * RPC: listTrendingRepos
 *
 * Fetches trending GitHub repos by scraping the GitHub trending page HTML.
 * Previous JSON APIs (gitterapp, herokuapp) are defunct (404).
 * Returns empty array on any failure.
 */

import type {
  ServerContext,
  ListTrendingReposRequest,
  ListTrendingReposResponse,
  GithubRepo,
} from '../../../../src/generated/server/worldmonitor/research/v1/service_server';

import { CHROME_UA, clampInt } from '../../../_shared/constants';
import { proxyFetch } from '../../../_shared/proxy-fetch';
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'research:trending:v2';
const REDIS_CACHE_TTL = 3600; // 1 hr — daily trending data

// ---------- HTML scraper ----------

function parseTrendingHtml(html: string, pageSize: number): GithubRepo[] {
  const repos: GithubRepo[] = [];
  const articles = html.split('<article class="Box-row">');

  for (let i = 1; i < articles.length && repos.length < pageSize; i++) {
    const art = articles[i]!;

    // Repo link: /<author>/<name> (skip /login?... links)
    const repoMatch = art.match(/href="\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"/);
    if (!repoMatch) continue;
    const fullName = repoMatch[1]!;

    // Description
    const descMatch = art.match(/<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const description = descMatch ? descMatch[1]!.trim().replace(/\s+/g, ' ') : '';

    // Language
    const langMatch = art.match(/itemprop="programmingLanguage">(.*?)<\/span>/);
    const language = langMatch ? langMatch[1]!.trim() : '';

    // Total stars (from stargazers link)
    const starsMatch = art.match(/href="\/[^"]+\/stargazers"[^>]*>\s*([\d,]+)\s*<\/a>/);
    const stars = starsMatch ? parseInt(starsMatch[1]!.replace(/,/g, ''), 10) || 0 : 0;

    // Stars today
    const todayMatch = art.match(/([\d,]+)\s+stars\s+today/);
    const starsToday = todayMatch ? parseInt(todayMatch[1]!.replace(/,/g, ''), 10) || 0 : 0;

    // Forks
    const forksMatch = art.match(/href="\/[^"]+\/forks"[^>]*>\s*([\d,]+)\s*<\/a>/);
    const forks = forksMatch ? parseInt(forksMatch[1]!.replace(/,/g, ''), 10) || 0 : 0;

    repos.push({
      fullName,
      description,
      language,
      stars,
      starsToday,
      forks,
      url: `https://github.com/${fullName}`,
    });
  }

  return repos;
}

// ---------- Fetch ----------

async function fetchTrendingRepos(req: ListTrendingReposRequest): Promise<GithubRepo[]> {
  const language = req.language || 'python';
  const period = req.period || 'daily';
  const pageSize = clampInt(req.pageSize, 50, 1, 100);

  const url = `https://github.com/trending/${encodeURIComponent(language)}?since=${period}`;

  const response = await proxyFetch(url, {
    headers: { Accept: 'text/html', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) return [];

  const html = await response.text();
  return parseTrendingHtml(html, pageSize);
}

// ---------- Handler ----------

export async function listTrendingRepos(
  _ctx: ServerContext,
  req: ListTrendingReposRequest,
): Promise<ListTrendingReposResponse> {
  try {
    const cacheKey = `${REDIS_CACHE_KEY}:${req.language || 'python'}:${req.period || 'daily'}:${clampInt(req.pageSize, 50, 1, 100)}`;
    const result = await cachedFetchJson<ListTrendingReposResponse>(cacheKey, REDIS_CACHE_TTL, async () => {
      const repos = await fetchTrendingRepos(req);
      return repos.length > 0 ? { repos, pagination: undefined } : null;
    });
    return result || { repos: [], pagination: undefined };
  } catch {
    return { repos: [], pagination: undefined };
  }
}

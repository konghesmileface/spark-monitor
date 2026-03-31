import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

export default createRelayHandler({
  relayPath: '/ais/traffic',
  timeout: 12000,
  requireApiKey: true,
  requireRateLimit: true,
  cacheHeaders: (ok) => ({
    'Cache-Control': ok
      ? 'public, max-age=15, s-maxage=30, stale-while-revalidate=60, stale-if-error=120'
      : 'public, max-age=5, s-maxage=10, stale-while-revalidate=30',
    ...(ok && { 'CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60, stale-if-error=120' }),
  }),
});

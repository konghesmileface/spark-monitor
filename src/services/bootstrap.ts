const hydrationCache = new Map<string, unknown>();

export function getHydratedData(key: string): unknown | undefined {
  return hydrationCache.get(key);
}

function populateCache(data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined) {
      hydrationCache.set(k, v);
    }
  }
}

async function fetchTier(tier: string, signal: AbortSignal): Promise<void> {
  try {
    const resp = await fetch(`/api/bootstrap?tier=${tier}`, { signal });
    if (!resp.ok) return;
    const { data } = (await resp.json()) as { data: Record<string, unknown> };
    populateCache(data);
  } catch {
    // silent — panels fall through to individual calls
  }
}

export async function fetchBootstrapData(): Promise<void> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 800);
  try {
    await Promise.all([
      fetchTier('slow', ctrl.signal),
      fetchTier('fast', ctrl.signal),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

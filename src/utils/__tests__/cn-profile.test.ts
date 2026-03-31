/**
 * Unit tests for cn-profile.ts — getUserId() and cnFetch() behavior.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  get length() { return storage.size; },
  key: (index: number) => [...storage.keys()][index] ?? null,
};

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });
Object.defineProperty(globalThis, 'location', {
  value: { href: 'http://localhost:4173/' },
  writable: true,
});

// Mock fetch
const fetchMock = vi.fn();
Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true });

describe('getUserId', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('creates and persists a UUID v4', async () => {
    const mod = await import('@/services/cn-profile');
    const id1 = mod.getUserId();
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const id2 = mod.getUserId();
    expect(id2).toBe(id1);
  });

  it('returns stored ID if present', async () => {
    storage.set('cn_user_profile_id', 'existing-id');
    const mod = await import('@/services/cn-profile');
    expect(mod.getUserId()).toBe('existing-id');
  });
});

describe('cnFetch', () => {
  beforeEach(() => {
    storage.clear();
    fetchMock.mockReset();
  });

  it('attaches Bearer token from localStorage', async () => {
    storage.set('wm_token', 'my-test-token');
    fetchMock.mockResolvedValue({ status: 200, ok: true });

    const mod = await import('@/services/cn-profile');
    await mod.cnFetch('http://localhost:8078/api/test');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer my-test-token');
  });

  it('redirects to login.html on 401', async () => {
    storage.set('wm_token', 'expired-token');
    fetchMock.mockResolvedValue({ status: 401, ok: false });

    const mod = await import('@/services/cn-profile');
    await mod.cnFetch('http://localhost:8078/api/test');

    // Token should be removed
    expect(storage.has('wm_token')).toBe(false);
    expect(storage.has('wm_user')).toBe(false);
  });
});

describe('CN_INTEL_BASE', () => {
  it('defaults to localhost:8078', async () => {
    const mod = await import('@/services/cn-profile');
    expect(mod.CN_INTEL_BASE).toContain('8078');
  });
});

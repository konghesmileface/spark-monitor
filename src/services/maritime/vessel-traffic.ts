import { startSmartPollLoop, type SmartPollLoopHandle } from '@/services/runtime';
import { isAisConfigured } from './index';

// ---- Types ----

export interface CompactVessel {
  mmsi: number;
  lat: number;
  lon: number;
  shipType: number;
  heading: number;
  speed: number;
  course: number;
  name: string;
}

export type VesselCategory = 'cargo' | 'tanker' | 'passenger' | 'fishing' | 'military' | 'highspeed' | 'special' | 'tug' | 'sailing' | 'other';

// ---- Ship-type classification ----

export function classifyVessel(shipType: number): VesselCategory {
  if (shipType >= 70 && shipType <= 79) return 'cargo';
  if (shipType >= 80 && shipType <= 89) return 'tanker';
  if (shipType >= 60 && shipType <= 69) return 'passenger';
  if (shipType === 30) return 'fishing';
  if (shipType === 35) return 'military';
  if (shipType >= 40 && shipType <= 49) return 'highspeed';
  if (shipType === 31 || shipType === 32 || shipType === 52) return 'tug';
  if (shipType >= 50 && shipType <= 59) return 'special';
  if (shipType === 36) return 'sailing';
  return 'other';
}

export const VESSEL_COLORS: Record<VesselCategory, string> = {
  cargo:     '#4a9eff',
  tanker:    '#ff6b35',
  passenger: '#00c853',
  fishing:   '#8e24aa',
  military:  '#ff1744',
  highspeed: '#00e5ff',
  special:   '#ffd600',
  tug:       '#78909c',
  sailing:   '#ffffff',
  other:     '#607d8b',
};

// ---- State ----

const TRAFFIC_PROXY_URL = '/api/ais-traffic';
const LOCAL_TRAFFIC_FALLBACK = 'http://localhost:3004/ais/traffic';
const isClientRuntime = typeof window !== 'undefined';
const isLocalhost = isClientRuntime && window.location.hostname === 'localhost';
const wsRelayUrl = isClientRuntime ? (import.meta.env.VITE_WS_RELAY_URL || '') : '';
const DIRECT_RAILWAY_TRAFFIC_URL = wsRelayUrl
  ? wsRelayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '') + '/ais/traffic'
  : '';

let latestVessels: CompactVessel[] = [];
let pollLoop: SmartPollLoopHandle | null = null;
let isPolling = false;
let inFlight = false;
let onUpdate: ((vessels: CompactVessel[]) => void) | null = null;

// ---- Fetch ----

async function fetchTrafficData(signal?: AbortSignal): Promise<CompactVessel[]> {
  let raw: unknown = null;

  try {
    const resp = await fetch(TRAFFIC_PROXY_URL, { headers: { Accept: 'application/json' }, signal });
    if (resp.ok) raw = await resp.json();
  } catch { /* fall through */ }

  if (!raw && isLocalhost && DIRECT_RAILWAY_TRAFFIC_URL) {
    try {
      const resp = await fetch(DIRECT_RAILWAY_TRAFFIC_URL, { headers: { Accept: 'application/json' }, signal });
      if (resp.ok) raw = await resp.json();
    } catch { /* fall through */ }
  }

  if (!raw && isLocalhost) {
    try {
      const resp = await fetch(LOCAL_TRAFFIC_FALLBACK, { headers: { Accept: 'application/json' }, signal });
      if (resp.ok) raw = await resp.json();
    } catch { /* fall through */ }
  }

  if (!raw || typeof raw !== 'object') return [];

  const data = raw as { t?: number; c?: number; v?: unknown[] };
  if (!Array.isArray(data.v)) return [];

  const vessels: CompactVessel[] = [];
  for (const entry of data.v) {
    if (!Array.isArray(entry) || entry.length < 8) continue;
    vessels.push({
      mmsi: entry[0] as number,
      lat: entry[1] as number,
      lon: entry[2] as number,
      shipType: entry[3] as number,
      heading: entry[4] as number,
      speed: entry[5] as number,
      course: entry[6] as number,
      name: entry[7] as string,
    });
  }
  return vessels;
}

// ---- Polling ----

async function poll(signal?: AbortSignal): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    latestVessels = await fetchTrafficData(signal);
    if (onUpdate) onUpdate(latestVessels);
  } catch {
    // Silently continue with stale data
  } finally {
    inFlight = false;
  }
}

export function startVesselTrafficPolling(callback?: (vessels: CompactVessel[]) => void): void {
  if (callback) onUpdate = callback;
  if (isPolling) return;
  if (!isAisConfigured()) return;
  isPolling = true;
  void poll();
  pollLoop?.stop();
  pollLoop = startSmartPollLoop(({ signal }) => poll(signal), {
    intervalMs: 15_000,
    pauseWhenHidden: true,
    refreshOnVisible: true,
    runImmediately: false,
  });
}

export function stopVesselTrafficPolling(): void {
  pollLoop?.stop();
  pollLoop = null;
  isPolling = false;
  inFlight = false;
  onUpdate = null;
  latestVessels = [];
}

export function getVesselTraffic(): CompactVessel[] {
  return latestVessels;
}

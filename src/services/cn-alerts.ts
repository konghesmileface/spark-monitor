/**
 * Alert service — SSE connection management + REST API for alerts.
 */

import { getUserId, cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';

export interface AlertImpact {
  direction?: 'positive' | 'negative' | 'neutral';
  positive: string[];
  negative: string[];
  affected_sectors: string[];
  impact_level: 'HIGH' | 'MEDIUM' | 'LOW';
  summary: string;
}

export interface Alert {
  id: string;
  user_id: string;
  tier: 'FLASH' | 'PRIORITY' | 'ROUTINE';
  title: string;
  url: string;
  score: number;
  source: string;
  category: string;
  match_reason: string;
  created_at: string;
  read: boolean;
  impact?: AlertImpact | null;
}

export type FlashCallback = (alert: Alert) => void;

let _eventSource: EventSource | null = null;
let _flashCallbacks: FlashCallback[] = [];

/** Get alerts from inbox. */
export async function getAlerts(
  tier = '',
  unreadOnly = false,
  limit = 50,
): Promise<{ alerts: Alert[]; total: number; unread: number }> {
  const uid = getUserId();
  const params = new URLSearchParams({ user_id: uid, limit: String(limit) });
  if (tier) params.set('tier', tier);
  if (unreadOnly) params.set('unread_only', 'true');

  const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/alerts?${params}`);
  if (!res.ok) return { alerts: [], total: 0, unread: 0 };
  return res.json();
}

/** Mark alerts as read. */
export async function markRead(alertIds: string[]): Promise<void> {
  const uid = getUserId();
  await cnFetch(`${CN_INTEL_BASE}/api/cn/alerts/mark-read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: uid, alert_ids: alertIds }),
  });
}

/** Get alert statistics. */
export async function getAlertStats(): Promise<Record<string, number>> {
  const uid = getUserId();
  const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/alerts/stats?user_id=${encodeURIComponent(uid)}`);
  if (!res.ok) return {};
  return res.json();
}

/** Start SSE connection for FLASH alerts. */
export function connectFlashStream(): void {
  if (_eventSource) return;
  // Desktop sidecar buffers entire response (no streaming) and EventSource
  // doesn't go through the fetch patch, so SSE fails on desktop clients.
  if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) return;
  const uid = getUserId();
  const token = localStorage.getItem('wm_token') || '';
  const params = new URLSearchParams({ user_id: uid });
  if (token) params.set('token', token);
  _eventSource = new EventSource(`${CN_INTEL_BASE}/api/cn/alerts/stream?${params}`);

  _eventSource.onmessage = (event) => {
    try {
      const alert: Alert = JSON.parse(event.data);
      if (alert.tier === 'FLASH') {
        for (const cb of _flashCallbacks) cb(alert);
      }
    } catch {
      // Ignore parse errors (heartbeats, etc.)
    }
  };

  _eventSource.onerror = () => {
    // Auto-reconnect after 10s
    disconnectFlashStream();
    setTimeout(connectFlashStream, 10_000);
  };
}

/** Disconnect SSE stream. */
export function disconnectFlashStream(): void {
  if (_eventSource) {
    _eventSource.close();
    _eventSource = null;
  }
}

/** Register callback for FLASH alerts. */
export function onFlashAlert(callback: FlashCallback): void {
  _flashCallbacks.push(callback);
}

/** Unregister callback. */
export function offFlashAlert(callback: FlashCallback): void {
  _flashCallbacks = _flashCallbacks.filter(cb => cb !== callback);
}

/** Get impact analysis for a specific alert. */
export async function getAlertImpact(alertId: string): Promise<AlertImpact | null> {
  const uid = getUserId();
  const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/alerts/${encodeURIComponent(alertId)}/impact?user_id=${encodeURIComponent(uid)}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.impact || null;
}

/**
 * USASpending.gov API Service
 * Tracks federal government contracts and awards
 * Data fetched via server-side proxy (/api/usaspending) to avoid GFW blocking
 */

import { getApiBaseUrl } from '@/services/runtime';
import { timeoutSignal } from '@/utils';
import { dataFreshness } from './data-freshness';

export interface GovernmentAward {
  id: string;
  recipientName: string;
  amount: number;
  agency: string;
  description: string;
  startDate: string;
  awardType: 'contract' | 'grant' | 'loan' | 'other';
}

export interface SpendingSummary {
  awards: GovernmentAward[];
  totalAmount: number;
  periodStart: string;
  periodEnd: string;
  fetchedAt: Date;
}

/**
 * Fetch recent government awards/contracts via server-side proxy
 */
export async function fetchRecentAwards(_options: {
  daysBack?: number;
  limit?: number;
  awardTypes?: ('contract' | 'grant' | 'loan')[];
} = {}): Promise<SpendingSummary> {
  try {
    const base = getApiBaseUrl();
    const response = await fetch(`${base}/api/usaspending`, {
      signal: timeoutSignal(90_000),
    });

    if (!response.ok) {
      throw new Error(`USASpending proxy HTTP ${response.status}`);
    }

    const data = await response.json();
    const awards: GovernmentAward[] = (data.awards || []).map((r: Record<string, unknown>) => ({
      id: String(r.id || ''),
      recipientName: String(r.recipientName || 'Unknown'),
      amount: Number(r.amount) || 0,
      agency: String(r.agency || 'Unknown'),
      description: String(r.description || '').slice(0, 200),
      startDate: String(r.startDate || ''),
      awardType: (r.awardType as GovernmentAward['awardType']) || 'other',
    }));

    if (awards.length > 0) {
      dataFreshness.recordUpdate('spending', awards.length);
    }

    return {
      awards,
      totalAmount: data.totalAmount || awards.reduce((sum: number, a: GovernmentAward) => sum + a.amount, 0),
      periodStart: data.periodStart || '',
      periodEnd: data.periodEnd || '',
      fetchedAt: new Date(data.fetchedAt || Date.now()),
    };
  } catch (error) {
    console.error('[USASpending] Fetch failed:', error);
    dataFreshness.recordError('spending', error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

/**
 * Format currency for display
 */
export function formatAwardAmount(amount: number): string {
  if (amount >= 1_000_000_000) {
    return `$${(amount / 1_000_000_000).toFixed(1)}B`;
  }
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (amount >= 1_000) {
    return `$${(amount / 1_000).toFixed(0)}K`;
  }
  return `$${amount.toFixed(0)}`;
}

/**
 * Get award type emoji
 */
export function getAwardTypeIcon(type: GovernmentAward['awardType']): string {
  switch (type) {
    case 'contract': return '\u{1F4C4}';
    case 'grant': return '\u{1F381}';
    case 'loan': return '\u{1F4B2}';
    default: return '\u{1F4CB}';
  }
}

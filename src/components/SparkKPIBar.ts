import type { MarketData } from '@/types';
import { formatPrice, formatChange } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';

/**
 * SparkKPIBar — Scrolling market ticker bar displayed above the map in Spark variant.
 * Shows key market indicators: indices, commodities, forex.
 */

// KPI symbols displayed in order (matched against MarketData.symbol or display)
const KPI_SYMBOL_ORDER = [
  '^GSPC',     // S&P 500
  '^DJI',      // Dow Jones
  '^IXIC',     // Nasdaq
  '000001.SS', // Shanghai Composite
  '399001.SZ', // Shenzhen Component
  '399006.SZ', // ChiNext
  '000300.SS', // CSI 300
  '^HSI',      // Hang Seng
  'CL=F',      // WTI Crude
  'GC=F',      // Gold
  '^VIX',      // VIX
  'CNY=X',     // USD/CNY
  'BTC-USD',   // Bitcoin
  'DX-Y.NYB',  // Dollar Index
];
const KPI_SYMBOLS = new Set(KPI_SYMBOL_ORDER);

const KPI_LABELS: Record<string, string> = {
  '^GSPC': 'S&P 500',
  '^DJI': 'Dow',
  '^IXIC': 'Nasdaq',
  '000001.SS': '上证',
  '399001.SZ': '深证',
  '399006.SZ': '创业板',
  '000300.SS': '沪深300',
  '^HSI': 'HSI',
  'CL=F': 'WTI',
  'GC=F': 'Gold',
  '^VIX': 'VIX',
  'CNY=X': 'USD/CNY',
  'BTC-USD': 'BTC',
  'DX-Y.NYB': 'DXY',
};

export class SparkKPIBar {
  private element: HTMLElement;
  private dataPool = new Map<string, MarketData>();
  private lastItemCount = 0;
  private visibilityHandler: (() => void) | null = null;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'spark-kpi-bar';
    this.element.innerHTML = '<span style="color:var(--text-dim);font-size:11px;padding:0 8px">Loading market data...</span>';

    // Pause animation when tab is hidden (save GPU/CPU)
    this.visibilityHandler = () => {
      const track = this.element.querySelector('.spark-kpi-track') as HTMLElement | null;
      if (track) {
        track.style.animationPlayState = document.hidden ? 'paused' : 'running';
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  getElement(): HTMLElement {
    return this.element;
  }

  /** Merge new market data into the pool and re-render */
  update(markets: MarketData[]): void {
    if (!markets || markets.length === 0) return;

    for (const m of markets) {
      if (KPI_SYMBOLS.has(m.symbol) || KPI_SYMBOLS.has(m.display)) {
        this.dataPool.set(m.symbol, m);
      }
    }

    this.render();
  }

  private render(): void {
    // Build ordered list from pool
    const kpiData: MarketData[] = [];
    for (const sym of KPI_SYMBOL_ORDER) {
      const found = this.dataPool.get(sym);
      if (found) kpiData.push(found);
    }

    if (kpiData.length === 0) return;

    // Diff update: if item count unchanged, patch text instead of rebuilding DOM
    const track = this.element.querySelector('.spark-kpi-track') as HTMLElement | null;
    if (track && kpiData.length === this.lastItemCount) {
      const itemEls = track.querySelectorAll('.spark-kpi-item');
      // Items are duplicated (2x), update both halves
      const half = kpiData.length;
      for (let i = 0; i < kpiData.length; i++) {
        const item = kpiData[i]!;
        const price = item.price != null ? formatPrice(item.price) : '--';
        const change = item.change != null ? item.change : 0;
        const changeStr = item.change != null ? formatChange(item.change) : '--';
        const changeClass = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';

        for (const offset of [i, i + half]) {
          const el = itemEls[offset];
          if (!el) continue;
          const valEl = el.querySelector('.spark-kpi-value');
          const chgEl = el.querySelector('.spark-kpi-change');
          if (valEl) valEl.textContent = price;
          if (chgEl) {
            chgEl.textContent = changeStr;
            chgEl.className = `spark-kpi-change ${changeClass}`;
          }
        }
      }
      return;
    }

    // Full rebuild when item count changes
    this.lastItemCount = kpiData.length;

    const items = kpiData.map(item => {
      const label = KPI_LABELS[item.symbol] || KPI_LABELS[item.display] || escapeHtml(item.name);
      const price = item.price != null ? formatPrice(item.price) : '--';
      const change = item.change != null ? item.change : 0;
      const changeStr = item.change != null ? formatChange(item.change) : '--';
      const changeClass = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';

      return `<div class="spark-kpi-item">
        <span class="spark-kpi-label">${label}</span>
        <span class="spark-kpi-value">${price}</span>
        <span class="spark-kpi-change ${changeClass}">${changeStr}</span>
      </div>`;
    }).join('');

    // Duplicate items for seamless loop scrolling
    this.element.innerHTML = `<div class="spark-kpi-track">${items}${items}</div>`;
  }

  destroy(): void {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }
}

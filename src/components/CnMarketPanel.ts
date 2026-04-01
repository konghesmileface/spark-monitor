import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';
const POLL_INTERVAL = 120_000; // 120s

interface CnIndex {
  name: string;
  code: string;
  price: number;
  change: number;
  changePercent: number;
  volume?: number;
  turnover?: number;
}

interface CnSector {
  name: string;
  changePercent: number;
  leadingStock?: string;
}

interface NorthboundFlow {
  total: number;
  shConnect: number;
  szConnect: number;
  direction: 'inflow' | 'outflow' | 'neutral';
  type?: string;
  dataNote?: string;
  upStocks?: number;
  downStocks?: number;
}

interface LimitStats {
  limitUp: number;
  limitDown: number;
  up: number;
  down: number;
  flat: number;
}

interface StockMover {
  code: string;
  name: string;
  price: number;
  changePercent: number;
}

interface CnMarketData {
  indices: CnIndex[];
  sectors: CnSector[];
  northbound: NorthboundFlow;
  limitStats: LimitStats;
  topGainers?: StockMover[];
  topLosers?: StockMover[];
  timestamp: string;
}

function cnChangeClass(val: number): string {
  if (val > 0) return 'cn-up';
  if (val < 0) return 'cn-down';
  return 'cn-flat';
}

function formatPercent(val: number): string {
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}

function formatChange(val: number): string {
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}`;
}

function formatMoney(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1e8) return `${(val / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(val / 1e4).toFixed(2)}万`;
  return val.toFixed(2);
}

function sectorHeatColor(pct: number): string {
  if (pct > 3) return '#c62828';
  if (pct > 2) return '#d32f2f';
  if (pct > 1) return '#e53935';
  if (pct > 0.5) return '#ef5350';
  if (pct > 0) return '#ef9a9a';
  if (pct === 0) return '#616161';
  if (pct > -0.5) return '#a5d6a7';
  if (pct > -1) return '#66bb6a';
  if (pct > -2) return '#43a047';
  if (pct > -3) return '#2e7d32';
  return '#1b5e20';
}

const STYLE = `
<style>
@layer base {
.cn-market-indices {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.cn-index-card {
  background: rgba(255,255,255,0.03);
  border-radius: 8px;
  padding: 8px 10px;
  border-left: 3px solid var(--border);
  transition: border-color 0.2s;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
}
.cn-index-card.cn-up { border-left-color: #e53935; }
.cn-index-card.cn-down { border-left-color: #43a047; }
.cn-index-left {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.cn-index-card .cn-index-name {
  font-size: 10px;
  color: var(--text-dim);
}
.cn-index-card .cn-index-price {
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.cn-index-right {
  text-align: right;
}
.cn-index-micro-bar {
  flex-basis: 100%;
  height: 2px;
  border-radius: 1px;
  margin-top: 4px;
  transition: width 0.3s ease;
}
.cn-index-card .cn-index-change {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.cn-up { color: #e53935; }
.cn-down { color: #43a047; }
.cn-flat { color: var(--text-dim); }
.cn-section-title {
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 10px 0 4px;
  padding-bottom: 3px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.cn-sectors {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 3px;
  margin-bottom: 10px;
}
.cn-sector-cell {
  border-radius: 4px;
  padding: 5px 4px;
  text-align: center;
  font-size: 10px;
  line-height: 1.3;
  color: #fff;
  min-height: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.cn-sector-cell .cn-sector-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.cn-sector-cell .cn-sector-pct {
  font-variant-numeric: tabular-nums;
  opacity: 0.9;
  margin-top: 1px;
}
.cn-northbound {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255,255,255,0.03);
  border-radius: 8px;
  padding: 6px 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.cn-northbound .cn-nb-label {
  font-size: 10px;
  color: var(--text-dim);
  white-space: nowrap;
}
.cn-northbound .cn-nb-total {
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.cn-northbound .cn-nb-detail {
  font-size: 10px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.cn-limit-stats {
  display: flex;
  gap: 4px;
  justify-content: center;
}
.cn-limit-stat {
  text-align: center;
  flex: 1;
  padding: 4px 2px;
  background: rgba(255,255,255,0.03);
  border-radius: 6px;
}
.cn-limit-stat .cn-ls-val {
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.cn-limit-stat .cn-ls-lbl {
  font-size: 9px;
  color: var(--text-dim);
  margin-top: 1px;
}
.cn-movers {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 4px;
}
.cn-mover-col-title {
  font-size: 10px;
  font-weight: 600;
  margin-bottom: 3px;
  padding-bottom: 2px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.cn-mover-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  padding: 2px 0;
  line-height: 1.4;
}
.cn-mover-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}
.cn-mover-pct {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  flex-shrink: 0;
}
.cn-index-card:hover {
  background: rgba(255,255,255,0.06);
}
.cn-sector-cell:hover {
  opacity: 0.85;
  transform: scale(1.03);
  transition: all 0.15s;
}
.cn-mkt-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0;
}
.cn-mkt-skel-line {
  height: 38px;
  border-radius: 8px;
  background: linear-gradient(90deg, rgba(255,255,255,0.03) 25%, rgba(255,255,255,0.07) 50%, rgba(255,255,255,0.03) 75%);
  background-size: 200% 100%;
  animation: cn-mkt-shimmer 1.5s ease infinite;
}
.cn-mkt-skel-sm {
  height: 14px;
  border-radius: 4px;
  background: linear-gradient(90deg, rgba(255,255,255,0.03) 25%, rgba(255,255,255,0.07) 50%, rgba(255,255,255,0.03) 75%);
  background-size: 200% 100%;
  animation: cn-mkt-shimmer 1.5s ease infinite;
}
.cn-mkt-skel-line:nth-child(2) { width: 85%; }
.cn-mkt-skel-line:nth-child(3) { width: 90%; }
@keyframes cn-mkt-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
} /* @layer base */
</style>
`;

export class CnMarketPanel extends Panel {
  private timer: ReturnType<typeof setInterval> | null = null;
  private data: CnMarketData | null = null;
  private lastFetchTime = 0;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super({ id: 'cn-market', title: 'A股行情 <span class="spark-subtitle">CN MARKET</span>' });
    this.showSkeleton();
    void this.fetchData();
    this.timer = setInterval(() => void this.fetchData(), POLL_INTERVAL);
    this.freshnessTimer = setInterval(() => this.updateFreshness(), 30_000);
  }

  private showSkeleton(): void {
    this.setContent(`${STYLE}
      <div class="cn-mkt-skeleton">
        <div class="cn-mkt-skel-line"></div>
        <div class="cn-mkt-skel-line"></div>
        <div class="cn-mkt-skel-line"></div>
        <div class="cn-mkt-skel-sm" style="width:40%;margin-top:6px"></div>
        <div class="cn-mkt-skel-sm" style="width:70%"></div>
        <div class="cn-mkt-skel-sm" style="width:55%"></div>
      </div>
    `);
  }

  public async fetchData(): Promise<void> {
    if (!this.data) this.showLoading('加载行情数据...');
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/market`, { signal: this.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json();
      this.lastFetchTime = Date.now();
      if ((this.data as any)?._stale) {
        this.setDataBadge('cached', '数据可能过时');
      } else {
        this.updateFreshness();
      }
      this.renderPanel();
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.showError('A股行情数据加载失败');
    }
  }

  private renderPanel(): void {
    if (!this.data) {
      this.showError('暂无数据');
      return;
    }

    const d = this.data;

    // Indices — single column compact layout for sidebar
    const indicesHtml = (d.indices || []).map(idx => {
      const barWidth = Math.min(100, Math.abs(idx.changePercent) * 10);
      const barColor = idx.changePercent > 0 ? '#e53935' : idx.changePercent < 0 ? '#43a047' : 'transparent';
      return `
      <div class="cn-index-card ${cnChangeClass(idx.change)}">
        <div class="cn-index-left">
          <div class="cn-index-name">${escapeHtml(idx.name)}</div>
          <div class="cn-index-price ${cnChangeClass(idx.change)}">${idx.price.toFixed(2)}</div>
        </div>
        <div class="cn-index-right">
          <div class="cn-index-change ${cnChangeClass(idx.change)}">
            ${formatChange(idx.change)} / ${formatPercent(idx.changePercent)}
          </div>
        </div>
        <div class="cn-index-micro-bar" style="width:${barWidth.toFixed(0)}%;background:${barColor}"></div>
      </div>
    `;
    }).join('');

    // Sectors top 10 — 2 columns for sidebar
    const sectors = (d.sectors || []).slice(0, 10);
    const sectorsHtml = sectors.map(s => `
      <div class="cn-sector-cell" style="background:${sectorHeatColor(s.changePercent)}">
        <span class="cn-sector-name">${escapeHtml(s.name)}</span>
        <span class="cn-sector-pct">${formatPercent(s.changePercent)}</span>
      </div>
    `).join('');

    // Northbound
    const nb = d.northbound;
    const isDealAmt = nb.type === 'deal_amt';
    const hasFlowData = nb.total !== 0 || (!nb.dataNote);
    const nbLabel = isDealAmt ? '成交额' : (hasFlowData ? '净流入' : '持仓');
    const nbDir = isDealAmt ? '' : (hasFlowData ? (nb.total >= 0 ? 'cn-up' : 'cn-down') : '');
    const nbSign = isDealAmt ? '' : (hasFlowData ? (nb.total >= 0 ? '+' : '') : '');

    // Limit stats
    const ls = d.limitStats;

    const html = `${STYLE}
      <div class="cn-market-indices">${indicesHtml}</div>

      <div class="cn-section-title">板块热度 TOP10</div>
      <div class="cn-sectors">${sectorsHtml}</div>

      <div class="cn-section-title">北向资金</div>
      <div class="cn-northbound">
        ${hasFlowData ? `
          <span class="cn-nb-label">${nbLabel}</span>
          <span class="cn-nb-total ${nbDir}">${nbSign}${formatMoney(nb.total)}</span>
          <span class="cn-nb-detail">沪 ${formatMoney(nb.shConnect)} | 深 ${formatMoney(nb.szConnect)}</span>
        ` : `
          <span class="cn-nb-label">持仓股</span>
          <span class="cn-nb-total">
            <span class="cn-up">涨${nb.upStocks || 0}</span>
            <span style="margin:0 4px;opacity:.5">/</span>
            <span class="cn-down">跌${nb.downStocks || 0}</span>
          </span>
          <span class="cn-nb-detail" style="opacity:.6">${nb.dataNote || '暂无流向数据'}</span>
        `}
      </div>

      <div class="cn-section-title">涨跌统计</div>
      <div class="cn-limit-stats">
        <div class="cn-limit-stat">
          <div class="cn-ls-val cn-up">${ls.limitUp}</div>
          <div class="cn-ls-lbl">涨停</div>
        </div>
        <div class="cn-limit-stat">
          <div class="cn-ls-val cn-up">${ls.up}</div>
          <div class="cn-ls-lbl">上涨</div>
        </div>
        <div class="cn-limit-stat">
          <div class="cn-ls-val cn-flat">${ls.flat}</div>
          <div class="cn-ls-lbl">平盘</div>
        </div>
        <div class="cn-limit-stat">
          <div class="cn-ls-val cn-down">${ls.down}</div>
          <div class="cn-ls-lbl">下跌</div>
        </div>
        <div class="cn-limit-stat">
          <div class="cn-ls-val cn-down">${ls.limitDown}</div>
          <div class="cn-ls-lbl">跌停</div>
        </div>
      </div>

      ${this.renderMovers(d)}
    `;

    this.setContent(html);
  }

  private renderMovers(d: CnMarketData): string {
    const gainers = d.topGainers || [];
    const losers = d.topLosers || [];
    if (gainers.length === 0 && losers.length === 0) return '';

    const renderCol = (items: StockMover[], isGainer: boolean) => {
      return items.map(m => {
        const cls = isGainer ? 'cn-up' : 'cn-down';
        const sign = m.changePercent > 0 ? '+' : '';
        return `<div class="cn-mover-item">
          <span class="cn-mover-name">${escapeHtml(m.name)}</span>
          <span class="cn-mover-pct ${cls}">${sign}${m.changePercent.toFixed(2)}%</span>
        </div>`;
      }).join('');
    };

    return `
      <div class="cn-section-title">涨跌幅排行</div>
      <div class="cn-movers">
        <div>
          <div class="cn-mover-col-title cn-up">涨幅 TOP5</div>
          ${renderCol(gainers, true)}
        </div>
        <div>
          <div class="cn-mover-col-title cn-down">跌幅 TOP5</div>
          ${renderCol(losers, false)}
        </div>
      </div>
    `;
  }

  private updateFreshness(): void {
    if (!this.lastFetchTime) return;
    const age = Date.now() - this.lastFetchTime;
    if (age < 60_000) {
      this.setDataBadge('live', '刚刚更新');
    } else if (age < 300_000) {
      this.setDataBadge('cached', `${Math.floor(age / 60_000)}分钟前`);
    } else {
      this.setDataBadge('unavailable', `${Math.floor(age / 60_000)}分钟前`);
    }
  }

  public destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.freshnessTimer) {
      clearInterval(this.freshnessTimer);
      this.freshnessTimer = null;
    }
    super.destroy();
  }
}

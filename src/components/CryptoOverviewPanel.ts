import { Panel } from './Panel';
import type { CryptoData } from '@/types';
import { formatPrice, formatChange, getChangeClass } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import { miniSparkline } from '@/utils/sparkline';
import { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import type {
  ListStablecoinMarketsResponse,
  ListEtfFlowsResponse,
} from '@/generated/client/worldmonitor/market/v1/service_client';
import { getHydratedData } from '@/services/bootstrap';
import { MacroSignalsPanel } from './MacroSignalsPanel';

type CryptoTab = 'crypto' | 'stablecoins' | 'etf' | 'signals';

// ---- helpers ----
function fmtLarge(v: number): string {
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toLocaleString()}`;
}
function fmtVol(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return v.toLocaleString();
}
function pegCls(s: string): string {
  return s === 'ON PEG' ? 'peg-on' : s === 'SLIGHT DEPEG' ? 'peg-slight' : 'peg-off';
}
function healthCls(s: string): string {
  return s === 'HEALTHY' ? 'health-good' : s === 'CAUTION' ? 'health-caution' : 'health-warning';
}
function flowCls(d: string): string {
  return d === 'inflow' ? 'flow-inflow' : d === 'outflow' ? 'flow-outflow' : 'flow-neutral';
}
function chgCls(v: number): string {
  return v > 0.1 ? 'change-positive' : v < -0.1 ? 'change-negative' : 'change-neutral';
}

export class CryptoOverviewPanel extends Panel {
  private activeTab: CryptoTab = 'crypto';
  private cryptoData: CryptoData[] = [];
  private stablecoinData: ListStablecoinMarketsResponse | null = null;
  private etfData: ListEtfFlowsResponse | null = null;
  private signalsPanel: MacroSignalsPanel;
  private tabBar: HTMLElement;
  private htmlContent: HTMLElement;
  private signalsContainer: HTMLElement;

  constructor() {
    super({ id: 'crypto-overview', title: '数字资产' });

    this.signalsPanel = new MacroSignalsPanel();

    // Persistent tab bar
    this.tabBar = document.createElement('div');
    this.tabBar.className = 'economic-tabs';
    this.updateTabBar();

    // HTML content area for crypto/stablecoins/etf
    this.htmlContent = document.createElement('div');
    this.htmlContent.className = 'intel-tab-content';

    // Signals container (hidden by default, stays connected for data fetch)
    this.signalsContainer = document.createElement('div');
    this.signalsContainer.className = 'intel-tab-content';
    this.signalsContainer.style.display = 'none';
    this.signalsContainer.appendChild(this.signalsPanel.getElement());

    // Assemble
    this.content.innerHTML = '';
    this.content.style.padding = '0';
    this.content.style.display = 'flex';
    this.content.style.flexDirection = 'column';
    this.content.appendChild(this.tabBar);
    this.content.appendChild(this.htmlContent);
    this.content.appendChild(this.signalsContainer);

    // Tab click handler
    this.tabBar.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest('.economic-tab') as HTMLElement | null;
      if (!tab?.dataset.tab) return;
      this.activeTab = tab.dataset.tab as CryptoTab;
      this.render();
    });

    this.renderHtmlContent();

    // Delayed fetch for stablecoins + ETF (avoid Yahoo contention on cold start)
    setTimeout(() => {
      void this.fetchStablecoins();
      void this.fetchEtfFlows();
    }, 8_000);
  }

  // ---- public data push (called from data-loader / refresh) ----

  public updateCrypto(data: CryptoData[]): void {
    this.cryptoData = data;
    this.render();
  }

  public async fetchStablecoins(): Promise<void> {
    const hydrated = getHydratedData('stablecoinMarkets') as ListStablecoinMarketsResponse | undefined;
    if (hydrated?.stablecoins?.length) {
      this.stablecoinData = hydrated;
      this.render();
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const client = new MarketServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
        this.stablecoinData = await client.listStablecoinMarkets({ coins: [] });
        if (!this.element?.isConnected) return;
        if (this.stablecoinData.stablecoins.length === 0 && attempt < 2) {
          await new Promise(r => setTimeout(r, 20_000));
          if (!this.element?.isConnected) return;
          continue;
        }
        break;
      } catch (err) {
        if (this.isAbortError(err)) return;
        if (!this.element?.isConnected) return;
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 20_000));
          if (!this.element?.isConnected) return;
        }
      }
    }
    this.render();
  }

  public async fetchEtfFlows(): Promise<void> {
    const hydrated = getHydratedData('etfFlows') as ListEtfFlowsResponse | undefined;
    if (hydrated?.etfs?.length) {
      this.etfData = hydrated;
      this.render();
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const client = new MarketServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
        this.etfData = await client.listEtfFlows({});
        if (!this.element?.isConnected) return;
        if (this.etfData.etfs.length === 0 && !this.etfData.rateLimited && attempt < 2) {
          await new Promise(r => setTimeout(r, 20_000));
          if (!this.element?.isConnected) return;
          continue;
        }
        break;
      } catch (err) {
        if (this.isAbortError(err)) return;
        if (!this.element?.isConnected) return;
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 20_000));
          if (!this.element?.isConnected) return;
        }
      }
    }
    this.render();
  }

  // ---- render (bypass debounce) ----

  private updateTabBar(): void {
    this.tabBar.innerHTML = `
      <button class="economic-tab ${this.activeTab === 'crypto' ? 'active' : ''}" data-tab="crypto">
        <i class="bi bi-currency-bitcoin"></i> 加密货币
      </button>
      <button class="economic-tab ${this.activeTab === 'stablecoins' ? 'active' : ''}" data-tab="stablecoins">
        <i class="bi bi-coin"></i> 稳定币
      </button>
      <button class="economic-tab ${this.activeTab === 'etf' ? 'active' : ''}" data-tab="etf">
        <i class="bi bi-graph-up-arrow"></i> BTC ETF
      </button>
      <button class="economic-tab ${this.activeTab === 'signals' ? 'active' : ''}" data-tab="signals">
        <i class="bi bi-radar"></i> 市场雷达
      </button>
    `;
  }

  private renderHtmlContent(): void {
    let body = '';
    if (this.activeTab === 'crypto') body = this.renderCryptoBody();
    else if (this.activeTab === 'stablecoins') body = this.renderStablecoinsBody();
    else if (this.activeTab === 'etf') body = this.renderEtfBody();
    this.htmlContent.innerHTML = body;
  }

  private render(): void {
    this.updateTabBar();
    this.htmlContent.style.display = this.activeTab === 'signals' ? 'none' : '';
    this.signalsContainer.style.display = this.activeTab === 'signals' ? '' : 'none';
    if (this.activeTab !== 'signals') {
      this.renderHtmlContent();
    }
  }

  // ---- crypto tab ----
  private renderCryptoBody(): string {
    if (this.cryptoData.length === 0) {
      return '<div class="panel-empty" style="color:var(--text-dim);padding:20px;text-align:center">Loading crypto…</div>';
    }
    return this.cryptoData.map(coin => `
      <div class="market-item">
        <div class="market-info">
          <span class="market-name">${escapeHtml(coin.name)}</span>
          <span class="market-symbol">${escapeHtml(coin.symbol)}</span>
        </div>
        <div class="market-data">
          ${miniSparkline(coin.sparkline, coin.change)}
          <span class="market-price">${formatPrice(coin.price)}</span>
          <span class="market-change ${getChangeClass(coin.change)}">${formatChange(coin.change)}</span>
        </div>
      </div>
    `).join('');
  }

  // ---- stablecoins tab ----
  private renderStablecoinsBody(): string {
    const d = this.stablecoinData;
    if (!d?.stablecoins?.length) {
      return '<div class="panel-empty" style="color:var(--text-dim);padding:20px;text-align:center">Loading stablecoins…</div>';
    }
    const s = d.summary || { totalMarketCap: 0, totalVolume24h: 0, healthStatus: 'UNAVAILABLE' } as { totalMarketCap: number; totalVolume24h: number; healthStatus: string };
    const pegRows = d.stablecoins.map(c => `
      <div class="stable-row">
        <div class="stable-info">
          <span class="stable-symbol">${escapeHtml(c.symbol)}</span>
          <span class="stable-name">${escapeHtml(c.name)}</span>
        </div>
        <div class="stable-price">$${c.price.toFixed(4)}</div>
        <div class="stable-peg ${pegCls(c.pegStatus)}">
          <span class="peg-badge">${escapeHtml(c.pegStatus)}</span>
          <span class="peg-dev">${c.deviation.toFixed(2)}%</span>
        </div>
      </div>
    `).join('');
    return `
      <div class="stablecoin-container">
        <div class="stable-health ${healthCls(s.healthStatus)}">
          <span class="health-label">${escapeHtml(s.healthStatus)}</span>
          <span class="health-detail">MCap: ${fmtLarge(s.totalMarketCap)} | Vol: ${fmtLarge(s.totalVolume24h)}</span>
        </div>
        <div class="stable-peg-list">${pegRows}</div>
      </div>`;
  }

  // ---- ETF flows tab ----
  private renderEtfBody(): string {
    const d = this.etfData;
    if (!d?.etfs?.length) {
      const msg = d?.rateLimited ? 'Rate limited — retrying…' : 'Loading BTC ETF data…';
      return `<div class="panel-empty" style="color:var(--text-dim);padding:20px;text-align:center">${msg}</div>`;
    }
    const s = d.summary || { totalEstFlow: 0, totalVolume: 0, netDirection: 'NEUTRAL', inflowCount: 0, outflowCount: 0 } as {
      totalEstFlow: number; totalVolume: number; netDirection: string; inflowCount: number; outflowCount: number;
    };
    const dirCls = s.netDirection.includes('INFLOW') ? 'flow-inflow' : s.netDirection.includes('OUTFLOW') ? 'flow-outflow' : 'flow-neutral';
    const rows = d.etfs.map(etf => `
      <tr class="etf-row ${flowCls(etf.direction)}">
        <td class="etf-ticker">${escapeHtml(etf.ticker)}</td>
        <td class="etf-issuer">${escapeHtml(etf.issuer)}</td>
        <td class="etf-flow ${flowCls(etf.direction)}">${etf.direction === 'inflow' ? '+' : etf.direction === 'outflow' ? '-' : ''}$${fmtVol(Math.abs(etf.estFlow))}</td>
        <td class="etf-change ${chgCls(etf.priceChange)}">${etf.priceChange > 0 ? '+' : ''}${etf.priceChange.toFixed(2)}%</td>
      </tr>
    `).join('');
    return `
      <div class="etf-flows-container">
        <div class="etf-summary ${dirCls}">
          <div class="etf-summary-item">
            <span class="etf-summary-label">Net</span>
            <span class="etf-summary-value ${dirCls}">${s.netDirection.includes('INFLOW') ? 'INFLOW' : 'OUTFLOW'}</span>
          </div>
          <div class="etf-summary-item">
            <span class="etf-summary-label">Flow</span>
            <span class="etf-summary-value">$${fmtVol(Math.abs(s.totalEstFlow))}</span>
          </div>
          <div class="etf-summary-item">
            <span class="etf-summary-label">Vol</span>
            <span class="etf-summary-value">${fmtVol(s.totalVolume)}</span>
          </div>
          <div class="etf-summary-item">
            <span class="etf-summary-label">ETFs</span>
            <span class="etf-summary-value">${s.inflowCount}↑ ${s.outflowCount}↓</span>
          </div>
        </div>
        <div class="etf-table-wrap">
          <table class="etf-table">
            <thead><tr><th>Ticker</th><th>Issuer</th><th>Est. Flow</th><th>Chg%</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  /** Access embedded signals panel for external refresh registration */
  public getSignalsPanel(): MacroSignalsPanel {
    return this.signalsPanel;
  }

  destroy(): void {
    this.signalsPanel.destroy();
    super.destroy();
  }
}

import { Panel } from './Panel';
import { t } from '@/services/i18n';
import type { MarketData, CryptoData } from '@/types';
import { formatPrice, formatChange, getChangeClass, getHeatmapClass } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import { miniSparkline } from '@/utils/sparkline';
import {
  getMarketWatchlistEntries,
  parseMarketWatchlistInput,
  resetMarketWatchlist,
  setMarketWatchlistEntries,
} from '@/services/market-watchlist';
import { TreemapModal } from './TreemapModal';

export class MarketPanel extends Panel {
  private settingsBtn: HTMLButtonElement | null = null;
  private overlay: HTMLElement | null = null;

  constructor() {
    super({ id: 'markets', title: t('panels.markets') });
    this.createSettingsButton();
  }

  private createSettingsButton(): void {
    this.settingsBtn = document.createElement('button');
    this.settingsBtn.className = 'live-news-settings-btn';
    this.settingsBtn.title = 'Customize market watchlist';
    this.settingsBtn.textContent = 'Watchlist';
    this.settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openWatchlistModal();
    });
    this.header.appendChild(this.settingsBtn);
  }

  private openWatchlistModal(): void {
    if (this.overlay) return;

    const current = getMarketWatchlistEntries();
    const currentText = current.length
      ? current.map((e) => (e.name ? `${e.symbol}|${e.name}` : e.symbol)).join('\n')
      : '';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.id = 'marketWatchlistModal';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeWatchlistModal();
    });

    const modal = document.createElement('div');
    modal.className = 'modal unified-settings-modal';
    modal.style.maxWidth = '680px';

    modal.innerHTML = `
      <div class="modal-header">
        <span class="modal-title">Market watchlist</span>
        <button class="modal-close" aria-label="Close">×</button>
      </div>
      <div style="padding:14px 16px 16px 16px">
        <div style="color:var(--text-dim);font-size:12px;line-height:1.4;margin-bottom:10px">
          Add extra tickers (comma or newline separated). Friendly labels supported: SYMBOL|Label.
          Example: TSLA|Tesla, AAPL|Apple, ^GSPC|S&P 500
          <br/>
          Tip: keep it under ~30 unless you enjoy scrolling.
        </div>
        <textarea id="wmMarketWatchlistInput"
          style="width:100%;min-height:120px;resize:vertical;background:rgba(255,255,255,0.04);border:1px solid var(--border);color:var(--text);border-radius:10px;padding:10px;font-family:inherit;font-size:12px;outline:none"
          spellcheck="false"></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
          <button type="button" class="panels-reset-layout" id="wmMarketResetBtn">Reset</button>
          <button type="button" class="panels-reset-layout" id="wmMarketCancelBtn">Cancel</button>
          <button type="button" class="panels-reset-layout" id="wmMarketSaveBtn" style="border-color:var(--text-dim);color:var(--text)">Save</button>
        </div>
      </div>
    `;

    const closeBtn = modal.querySelector('.modal-close') as HTMLButtonElement | null;
    closeBtn?.addEventListener('click', () => this.closeWatchlistModal());

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this.overlay = overlay;

    const input = modal.querySelector<HTMLTextAreaElement>('#wmMarketWatchlistInput');
    if (input) input.value = currentText;

    modal.querySelector<HTMLButtonElement>('#wmMarketCancelBtn')?.addEventListener('click', () => this.closeWatchlistModal());
    modal.querySelector<HTMLButtonElement>('#wmMarketResetBtn')?.addEventListener('click', () => {
      resetMarketWatchlist();
      if (input) input.value = ''; // defaults are always included automatically
      this.closeWatchlistModal();
    });
    modal.querySelector<HTMLButtonElement>('#wmMarketSaveBtn')?.addEventListener('click', () => {
      const raw = input?.value || '';
      const parsed = parseMarketWatchlistInput(raw);
      if (parsed.length === 0) resetMarketWatchlist();
      else setMarketWatchlistEntries(parsed);
      this.closeWatchlistModal();
    });
  }

  private closeWatchlistModal(): void {
    if (!this.overlay) return;
    this.overlay.remove();
    this.overlay = null;
  }

  public renderMarkets(data: MarketData[], rateLimited?: boolean): void {
    if (data.length === 0) {
      this.showError(rateLimited ? t('common.rateLimitedMarket') : t('common.failedMarketData'));
      return;
    }

    const html = data
      .map(
        (stock) => `
      <div class="market-item">
        <div class="market-info">
          <span class="market-name">${escapeHtml(stock.name)}</span>
          <span class="market-symbol">${escapeHtml(stock.display)}</span>
        </div>
        <div class="market-data">
          ${miniSparkline(stock.sparkline, stock.change)}
          <span class="market-price">${formatPrice(stock.price!)}</span>
          <span class="market-change ${getChangeClass(stock.change!)}">${formatChange(stock.change!)}</span>
        </div>
      </div>
    `
      )
      .join('');

    this.setContent(html);
  }
}

export class HeatmapPanel extends Panel {
  constructor() {
    super({ id: 'heatmap', title: t('panels.heatmap') });
  }

  public renderHeatmap(data: Array<{ name: string; change: number | null }>): void {
    const validData = data.filter((d) => d.change !== null);

    if (validData.length === 0) {
      this.showError(t('common.failedSectorData'));
      return;
    }

    const html =
      '<div class="heatmap">' +
      validData
        .map(
          (sector) => `
        <div class="heatmap-cell ${getHeatmapClass(sector.change!)}">
          <div class="sector-name">${escapeHtml(sector.name)}</div>
          <div class="sector-change ${getChangeClass(sector.change!)}">${formatChange(sector.change!)}</div>
        </div>
      `
        )
        .join('') +
      '</div>';

    this.setContent(html);
  }
}

export class CommoditiesPanel extends Panel {
  constructor() {
    super({ id: 'commodities', title: t('panels.commodities') });
  }

  public renderCommodities(data: Array<{ display: string; price: number | null; change: number | null; sparkline?: number[] }>): void {
    const validData = data.filter((d) => d.price !== null);

    if (validData.length === 0) {
      this.showError(t('common.failedCommodities'));
      return;
    }

    const html =
      '<div class="commodities-grid">' +
      validData
        .map(
          (c) => `
        <div class="commodity-item">
          <div class="commodity-name">${escapeHtml(c.display)}</div>
          ${miniSparkline(c.sparkline, c.change, 60, 18)}
          <div class="commodity-price">${formatPrice(c.price!)}</div>
          <div class="commodity-change ${getChangeClass(c.change!)}">${formatChange(c.change!)}</div>
        </div>
      `
        )
        .join('') +
      '</div>';

    this.setContent(html);
  }
}

type MarketOverviewTab = 'commodities' | 'heatmap';

export class MarketOverviewPanel extends Panel {
  private activeTab: MarketOverviewTab = 'commodities';
  private commoditiesData: Array<{ display: string; price: number | null; change: number | null; sparkline?: number[] }> = [];
  private heatmapData: Array<{ name: string; change: number | null }> = [];
  private treemapModal: TreemapModal | null = null;

  constructor() {
    super({ id: 'market-overview', title: '市场概览' });
    this.content.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest('.economic-tab') as HTMLElement | null;
      if (tab?.dataset.tab) {
        this.activeTab = tab.dataset.tab as MarketOverviewTab;
        this.renderImmediate();
        return;
      }
      const fullscreenBtn = (e.target as HTMLElement).closest('.treemap-fullscreen-btn') as HTMLElement | null;
      if (fullscreenBtn) {
        this.openTreemap();
      }
    });
  }

  public updateCommodities(data: Array<{ display: string; price: number | null; change: number | null; sparkline?: number[] }>): void {
    this.commoditiesData = data;
    this.renderImmediate();
  }

  public updateHeatmap(data: Array<{ name: string; change: number | null }>): void {
    this.heatmapData = data;
    this.renderImmediate();
  }

  private openTreemap(): void {
    const validData = this.heatmapData.filter((d) => d.change !== null) as Array<{ name: string; change: number }>;
    if (validData.length === 0) return;
    this.treemapModal = new TreemapModal(validData);
    this.treemapModal.open();
  }

  /** Write directly to innerHTML, bypassing Panel's 150ms debounce */
  private renderImmediate(): void {
    const tabsHtml = `
      <div class="economic-tabs">
        <button class="economic-tab ${this.activeTab === 'commodities' ? 'active' : ''}" data-tab="commodities">
          <i class="bi bi-box-seam"></i> 大宗商品
        </button>
        <button class="economic-tab ${this.activeTab === 'heatmap' ? 'active' : ''}" data-tab="heatmap">
          <i class="bi bi-grid-3x3-gap-fill"></i> 板块热力图
        </button>
      </div>
    `;

    let bodyHtml = '';
    if (this.activeTab === 'commodities') {
      bodyHtml = this.renderCommoditiesBody();
    } else {
      bodyHtml = this.renderHeatmapBody();
    }

    this.content.innerHTML = tabsHtml + bodyHtml;

    // For heatmap tab: render inline treemap SVG after layout
    if (this.activeTab === 'heatmap') {
      const wrap = this.content.querySelector('.mo-treemap-wrap') as HTMLElement | null;
      if (wrap) {
        requestAnimationFrame(() => {
          const rect = wrap.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            this.renderInlineTreemap(wrap, rect.width, rect.height);
          } else {
            // Fallback: use parent dimensions
            setTimeout(() => {
              const r2 = wrap.getBoundingClientRect();
              if (r2.width > 0) this.renderInlineTreemap(wrap, r2.width, Math.max(r2.height, 300));
            }, 50);
          }
        });
      }
    }
  }

  private renderCommoditiesBody(): string {
    const validData = this.commoditiesData.filter((d) => d.price !== null);
    if (validData.length === 0) {
      return '<div class="panel-empty" style="color:var(--text-dim);padding:20px;text-align:center">Loading commodities…</div>';
    }
    return '<div class="commodities-grid">' +
      validData
        .map(
          (c) => `
        <div class="commodity-item">
          <div class="commodity-name">${escapeHtml(c.display)}</div>
          ${miniSparkline(c.sparkline, c.change, 60, 18)}
          <div class="commodity-price">${formatPrice(c.price!)}</div>
          <div class="commodity-change ${getChangeClass(c.change!)}">${formatChange(c.change!)}</div>
        </div>
      `
        )
        .join('') +
      '</div>';
  }

  private renderHeatmapBody(): string {
    const validData = this.heatmapData.filter((d) => d.change !== null);
    if (validData.length === 0) {
      return '<div class="panel-empty" style="color:var(--text-dim);padding:20px;text-align:center">Loading sectors…</div>';
    }
    const fullscreenBtn = `<div style="display:flex;justify-content:flex-end;padding:2px 4px 2px 0">
      <button class="treemap-fullscreen-btn" title="全屏热力图">
        <i class="bi bi-arrows-fullscreen"></i> 全屏
      </button>
    </div>`;
    // Container for inline SVG treemap
    return fullscreenBtn + '<div class="mo-treemap-wrap"></div>';
  }

  private renderInlineTreemap(container: HTMLElement, width: number, height: number): void {
    const validData = this.heatmapData.filter((d) => d.change !== null) as Array<{ name: string; change: number }>;
    if (validData.length === 0) return;

    const { squarify, getTreemapColor, getTextColor } = TreemapModal;
    const rects = squarify(validData, width, height);

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.display = 'block';

    const padding = 2;
    for (const r of rects) {
      const g = document.createElementNS(svgNS, 'g');
      g.classList.add('treemap-cell');

      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', String(r.x + padding / 2));
      rect.setAttribute('y', String(r.y + padding / 2));
      rect.setAttribute('width', String(Math.max(0, r.w - padding)));
      rect.setAttribute('height', String(Math.max(0, r.h - padding)));
      rect.setAttribute('rx', '3');
      rect.setAttribute('fill', getTreemapColor(r.item.change));
      g.appendChild(rect);

      const textColor = getTextColor(r.item.change);
      const cellW = r.w - padding;
      const cellH = r.h - padding;

      if (cellW > 30 && cellH > 20) {
        const fontSize = Math.max(8, Math.min(13, cellW / 7, cellH / 3.5));

        const nameText = document.createElementNS(svgNS, 'text');
        nameText.setAttribute('x', String(r.x + r.w / 2));
        nameText.setAttribute('y', String(r.y + r.h / 2 - fontSize * 0.2));
        nameText.setAttribute('text-anchor', 'middle');
        nameText.setAttribute('fill', textColor);
        nameText.setAttribute('font-size', String(fontSize));
        nameText.setAttribute('font-weight', '600');
        nameText.textContent = r.item.name;
        g.appendChild(nameText);

        const changeText = document.createElementNS(svgNS, 'text');
        changeText.setAttribute('x', String(r.x + r.w / 2));
        changeText.setAttribute('y', String(r.y + r.h / 2 + fontSize * 0.8));
        changeText.setAttribute('text-anchor', 'middle');
        changeText.setAttribute('fill', textColor);
        changeText.setAttribute('font-size', String(fontSize * 0.8));
        changeText.setAttribute('opacity', '0.9');
        changeText.textContent = formatChange(r.item.change);
        g.appendChild(changeText);
      }

      const title = document.createElementNS(svgNS, 'title');
      title.textContent = `${r.item.name}: ${formatChange(r.item.change)}`;
      g.appendChild(title);

      svg.appendChild(g);
    }

    container.innerHTML = '';
    container.appendChild(svg);
  }
}

export class CryptoPanel extends Panel {
  constructor() {
    super({ id: 'crypto', title: t('panels.crypto') });
  }

  public renderCrypto(data: CryptoData[]): void {
    if (data.length === 0) {
      this.showError(t('common.failedCryptoData'));
      return;
    }

    const html = data
      .map(
        (coin) => `
      <div class="market-item">
        <div class="market-info">
          <span class="market-name">${escapeHtml(coin.name)}</span>
          <span class="market-symbol">${escapeHtml(coin.symbol)}</span>
        </div>
        <div class="market-data">
          ${miniSparkline(coin.sparkline, coin.change)}
          <span class="market-price">$${coin.price.toLocaleString()}</span>
          <span class="market-change ${getChangeClass(coin.change)}">${formatChange(coin.change)}</span>
        </div>
      </div>
    `
      )
      .join('');

    this.setContent(html);
  }
}

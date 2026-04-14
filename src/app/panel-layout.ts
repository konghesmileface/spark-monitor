import type { AppContext, AppModule } from '@/app/app-context';
import type { RelatedAsset } from '@/types';
import type { TheaterPostureSummary } from '@/services/military-surge';
import {
  MapContainer,
  NewsPanel,
  MarketPanel,
  HeatmapPanel,
  CommoditiesPanel,
  MarketOverviewPanel,
  CryptoPanel,
  PredictionPanel,
  MonitorPanel,
  EconomicPanel,
  GdeltIntelPanel,
  LiveNewsPanel,
  LiveWebcamsPanel,
  CIIPanel,
  CascadePanel,
  StrategicRiskPanel,
  StrategicPosturePanel,
  TechEventsPanel,
  ServiceStatusPanel,
  RuntimeConfigPanel,
  InsightsPanel,
  TechReadinessPanel,
  MacroSignalsPanel,
  ETFFlowsPanel,
  StablecoinPanel,
  UcdpEventsPanel,
  DisplacementPanel,
  ClimateAnomalyPanel,
  PopulationExposurePanel,
  InvestmentsPanel,
  TradePolicyPanel,
  SupplyChainPanel,
  SecurityAdvisoriesPanel,
  OrefSirensPanel,
  TelegramIntelPanel,
  GulfEconomiesPanel,
  WorldClockPanel,
  AirlineIntelPanel,
  AviationCommandBar,
  TabbedNewsPanel,
  CryptoOverviewPanel,
  IntelOverviewPanel,
  AIOverviewPanel,
} from '@/components';
import { SatelliteFiresPanel } from '@/components/SatelliteFiresPanel';
// Happy variant panels lazy-loaded in createHappyPanels() — separate chunk (panels-happy)
import { GivingPanel } from '@/components';
import { focusInvestmentOnMap } from '@/services/investments-focus';
import { debounce, saveToStorage, loadFromStorage } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import {
  FEEDS,
  INTEL_SOURCES,
  DEFAULT_PANELS,
  STORAGE_KEYS,
  SITE_VARIANT,
} from '@/config';
import { BETA_MODE } from '@/config/beta';
import { t } from '@/services/i18n';
import { getCurrentTheme } from '@/utils';
import { trackCriticalBannerAction } from '@/services/analytics';
import { SparkKPIBar } from '@/components/SparkKPIBar';
import { SPARK_PANEL_TITLES } from '@/config/variants/spark';
// Cn* panels lazy-loaded in createCnIntelPanels() — separate chunk (panels-cn)

export interface PanelLayoutCallbacks {
  openCountryStory: (code: string, name: string) => void;
  openCountryBrief: (code: string) => void;
  loadAllData: () => Promise<void>;
  updateMonitorResults: () => void;
  loadSecurityAdvisories?: () => Promise<void>;
}

export class PanelLayoutManager implements AppModule {
  private ctx: AppContext;
  private callbacks: PanelLayoutCallbacks;
  private panelDragCleanupHandlers: Array<() => void> = [];
  private criticalBannerEl: HTMLElement | null = null;
  private aviationCommandBar: AviationCommandBar | null = null;
  private sparkKPIBar: SparkKPIBar | null = null;
  private readonly applyTimeRangeFilterDebounced: (() => void) & { cancel(): void };

  constructor(ctx: AppContext, callbacks: PanelLayoutCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.applyTimeRangeFilterDebounced = debounce(() => {
      this.applyTimeRangeFilterToNewsPanels();
    }, 120);
  }

  init(): void {
    this.renderLayout();
  }

  /** Update Spark KPI bar with latest market data */
  updateSparkKPI(markets: import('@/types').MarketData[]): void {
    this.sparkKPIBar?.update(markets);
  }

  destroy(): void {
    this.applyTimeRangeFilterDebounced.cancel();
    this.panelDragCleanupHandlers.forEach((cleanup) => cleanup());
    this.panelDragCleanupHandlers = [];
    if (this.criticalBannerEl) {
      this.criticalBannerEl.remove();
      this.criticalBannerEl = null;
    }
    // Clean up happy variant panels
    this.ctx.tvMode?.destroy();
    this.ctx.tvMode = null;
    this.ctx.countersPanel?.destroy();
    this.ctx.progressPanel?.destroy();
    this.ctx.breakthroughsPanel?.destroy();
    this.ctx.heroPanel?.destroy();
    this.ctx.digestPanel?.destroy();
    this.ctx.speciesPanel?.destroy();
    this.ctx.renewablePanel?.destroy();

    // Clean up aviation components
    this.aviationCommandBar?.destroy();
    this.aviationCommandBar = null;
    this.ctx.panels['airline-intel']?.destroy();

    window.removeEventListener('resize', this.ensureCorrectZones);
  }

  renderLayout(): void {
    const isCnMode = SITE_VARIANT === 'spark' && (sessionStorage.getItem(STORAGE_KEYS.intelMode) || 'cn') === 'cn';
    this.ctx.container.innerHTML = `
      <div class="header">
        <div class="header-left">
          <button class="hamburger-btn" id="hamburgerBtn" aria-label="Menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          ${SITE_VARIANT !== 'spark' ? `<div class="variant-switcher">${(() => {
        const local = this.ctx.isDesktopApp || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        const vHref = (v: string, prod: string) => local || SITE_VARIANT === v ? '#' : prod;
        const vTarget = (_v: string) => '';
        return `
            <a href="${vHref('full', 'https://worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'full' ? 'active' : ''}"
               data-variant="full"
               ${vTarget('full')}
               title="${t('header.world')}${SITE_VARIANT === 'full' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon"><i class="bi bi-globe2"></i></span>
              <span class="variant-label">${t('header.world')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${vHref('tech', 'https://tech.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'tech' ? 'active' : ''}"
               data-variant="tech"
               ${vTarget('tech')}
               title="${t('header.tech')}${SITE_VARIANT === 'tech' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon"><i class="bi bi-cpu"></i></span>
              <span class="variant-label">${t('header.tech')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${vHref('finance', 'https://finance.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'finance' ? 'active' : ''}"
               data-variant="finance"
               ${vTarget('finance')}
               title="${t('header.finance')}${SITE_VARIANT === 'finance' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon"><i class="bi bi-graph-up-arrow"></i></span>
              <span class="variant-label">${t('header.finance')}</span>
            </a>
            ${SITE_VARIANT === 'happy' ? `<span class="variant-divider"></span>
            <a href="${vHref('happy', 'https://happy.worldmonitor.app')}"
               class="variant-option active"
               data-variant="happy"
               ${vTarget('happy')}
               title="Good News ${t('common.currentVariant')}">
              <span class="variant-icon"><i class="bi bi-sun-fill"></i></span>
              <span class="variant-label">Good News</span>
            </a>` : ''}
            <span class="variant-divider"></span>
            <a href="${vHref('spark', 'https://spark.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'spark' ? 'active' : ''}"
               data-variant="spark"
               ${vTarget('spark')}
               title="Spark${SITE_VARIANT === 'spark' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon"><i class="bi bi-lightning-charge-fill"></i></span>
              <span class="variant-label">Spark</span>
            </a>`;
      })()}</div>` : ''}
          <span class="logo">${SITE_VARIANT === 'spark' ? '<i class="bi bi-lightning-charge-fill"></i> SPARK' : 'MONITOR'}</span><span class="logo-mobile">${SITE_VARIANT === 'spark' ? 'Spark Monitor' : 'World Monitor'}</span>${SITE_VARIANT !== 'spark' ? `<span class="version">v${__APP_VERSION__}</span>` : ''}${BETA_MODE ? '<span class="beta-badge">BETA</span>' : ''}
          ${SITE_VARIANT === 'spark' ? (() => {
            const currentMode = sessionStorage.getItem(STORAGE_KEYS.intelMode) || 'cn';
            return `<div class="intel-mode-switcher">
              <button class="intel-mode-btn ${currentMode === 'world' ? 'active' : ''}" data-intel-mode="world">世界情报</button>
              <button class="intel-mode-btn ${currentMode === 'cn' ? 'active' : ''}" data-intel-mode="cn">中文情报</button>
            </div>`;
          })() : ''}
          ${SITE_VARIANT !== 'spark' ? `<a href="https://x.com/eliehabib" target="_blank" rel="noopener" class="credit-link">
            <svg class="x-logo" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            <span class="credit-text">@eliehabib</span>
          </a>
          <a href="https://github.com/koala73/worldmonitor" target="_blank" rel="noopener" class="github-link" title="${t('header.viewOnGitHub')}">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          </a>` : ''}
          <button class="mobile-settings-btn" id="mobileSettingsBtn" title="${t('header.settings')}">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <div class="status-indicator">
            <span class="status-dot"></span>
            <span>${t('header.live')}</span>
          </div>
          ${SITE_VARIANT !== 'spark' ? `<div class="region-selector">
            <select id="regionSelect" class="region-select">
              <option value="global">${t('components.deckgl.views.global')}</option>
              <option value="america">${t('components.deckgl.views.americas')}</option>
              <option value="mena">${t('components.deckgl.views.mena')}</option>
              <option value="eu">${t('components.deckgl.views.europe')}</option>
              <option value="asia">${t('components.deckgl.views.asia')}</option>
              <option value="latam">${t('components.deckgl.views.latam')}</option>
              <option value="africa">${t('components.deckgl.views.africa')}</option>
              <option value="oceania">${t('components.deckgl.views.oceania')}</option>
            </select>
          </div>` : ''}
          <button class="mobile-search-btn" id="mobileSearchBtn" aria-label="${t('header.search')}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
        </div>
        <div class="header-right">
          ${isCnMode ? `<span class="cn-header-enterprise" id="cnHeaderEnterprise"><i class="bi bi-building"></i> <span id="cnEntName">加载中...</span></span>
          <div class="cn-hdr-actions" id="cnHdrActions">
            <button class="cn-hdr-btn" id="cnHdrAiEngine" title="AI引擎设置"><i class="bi bi-cpu"></i></button>
            <button class="cn-hdr-btn" id="cnHdrAlerts" title="智能告警"><i class="bi bi-bell"></i><span class="cn-hdr-alert-dot" id="cnHdrAlertDot"></span></button>
            <button class="cn-hdr-btn" id="cnHdrReport" title="企业周报"><i class="bi bi-journal-text"></i></button>
            <button class="cn-hdr-btn" id="cnHdrProfile" title="设置画像"><i class="bi bi-gear"></i></button>
            <button class="cn-hdr-btn cn-hdr-logout" id="cnHdrLogout" title="退出登录"><i class="bi bi-box-arrow-right"></i></button>
          </div>
` : ''}
          ${this.ctx.isDesktopApp || SITE_VARIANT === 'spark' ? '' : `<div class="download-wrapper" id="downloadWrapper">
            <button class="download-btn" id="downloadBtn" title="${t('header.downloadApp')}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span id="downloadBtnLabel">${t('header.downloadApp')}</span>
            </button>
            <div class="download-dropdown" id="downloadDropdown"></div>
          </div>`}
          ${isCnMode ? '' : `<button class="search-btn" id="searchBtn"><kbd>⌘K</kbd> ${t('header.search')}</button>`}
          ${this.ctx.isDesktopApp || SITE_VARIANT === 'spark' ? '' : `<button class="copy-link-btn" id="copyLinkBtn">${t('header.copyLink')}</button>`}
          ${SITE_VARIANT !== 'spark' ? `<button class="theme-toggle-btn" id="headerThemeToggle" title="${t('header.toggleTheme')}">
            ${getCurrentTheme() === 'dark'
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>'}
          </button>` : ''}
          ${''}<!-- fullscreen button removed -->
          ${SITE_VARIANT === 'happy' ? `<button class="tv-mode-btn" id="tvModeBtn" title="TV Mode (Shift+T)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></button>` : ''}
          ${!isCnMode && SITE_VARIANT === 'spark' ? '<button class="cn-hdr-btn cn-hdr-logout" id="cnHdrLogout" title="退出登录" style="margin-left:8px"><i class="bi bi-box-arrow-right"></i></button>' : ''}
          ${isCnMode ? '' : '<span id="unifiedSettingsMount"></span>'}
        </div>
      </div>
      <div class="mobile-menu-overlay" id="mobileMenuOverlay"></div>
      <nav class="mobile-menu" id="mobileMenu">
        <div class="mobile-menu-header">
          <span class="mobile-menu-title">WORLD MONITOR</span>
          <button class="mobile-menu-close" id="mobileMenuClose" aria-label="Close menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="mobile-menu-divider"></div>
        ${SITE_VARIANT !== 'spark' ? (() => {
        const variants = [
          { key: 'full', icon: '<i class="bi bi-globe2"></i>', label: t('header.world') },
          { key: 'tech', icon: '<i class="bi bi-cpu"></i>', label: t('header.tech') },
          { key: 'finance', icon: '<i class="bi bi-graph-up-arrow"></i>', label: t('header.finance') },
          { key: 'spark', icon: '<i class="bi bi-lightning-charge-fill"></i>', label: 'Spark' },
        ];
        if (SITE_VARIANT === 'happy') variants.push({ key: 'happy', icon: '<i class="bi bi-sun-fill"></i>', label: 'Good News' });
        return variants.map(v =>
          `<button class="mobile-menu-item mobile-menu-variant ${v.key === SITE_VARIANT ? 'active' : ''}" data-variant="${v.key}">
            <span class="mobile-menu-item-icon">${v.icon}</span>
            <span class="mobile-menu-item-label">${v.label}</span>
            ${v.key === SITE_VARIANT ? '<span class="mobile-menu-check"><i class="bi bi-check-lg"></i></span>' : ''}
          </button>`
        ).join('');
      })() : ''}
        <div class="mobile-menu-divider"></div>
        <button class="mobile-menu-item" id="mobileMenuRegion">
          <span class="mobile-menu-item-icon"><i class="bi bi-globe"></i></span>
          <span class="mobile-menu-item-label">${t('components.deckgl.views.global')}</span>
          <span class="mobile-menu-chevron">▸</span>
        </button>
        <div class="mobile-menu-divider"></div>
        <button class="mobile-menu-item" id="mobileMenuSettings">
          <span class="mobile-menu-item-icon"><i class="bi bi-gear-fill"></i></span>
          <span class="mobile-menu-item-label">${t('header.settings')}</span>
        </button>
        <button class="mobile-menu-item" id="mobileMenuTheme">
          <span class="mobile-menu-item-icon">${getCurrentTheme() === 'dark' ? '<i class="bi bi-sun-fill"></i>' : '<i class="bi bi-moon-fill"></i>'}</span>
          <span class="mobile-menu-item-label">${getCurrentTheme() === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
        </button>
        <a class="mobile-menu-item" href="https://x.com/eliehabib" target="_blank" rel="noopener">
          <span class="mobile-menu-item-icon"><svg class="x-logo" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></span>
          <span class="mobile-menu-item-label">@eliehabib</span>
        </a>
        <div class="mobile-menu-divider"></div>
        <div class="mobile-menu-version">v${__APP_VERSION__}</div>
      </nav>
      <div class="region-sheet-backdrop" id="regionSheetBackdrop"></div>
      <div class="region-bottom-sheet" id="regionBottomSheet">
        <div class="region-sheet-header">${t('header.selectRegion')}</div>
        <div class="region-sheet-divider"></div>
        ${[
        { value: 'global', label: t('components.deckgl.views.global') },
        { value: 'america', label: t('components.deckgl.views.americas') },
        { value: 'mena', label: t('components.deckgl.views.mena') },
        { value: 'eu', label: t('components.deckgl.views.europe') },
        { value: 'asia', label: t('components.deckgl.views.asia') },
        { value: 'latam', label: t('components.deckgl.views.latam') },
        { value: 'africa', label: t('components.deckgl.views.africa') },
        { value: 'oceania', label: t('components.deckgl.views.oceania') },
      ].map(r =>
        `<button class="region-sheet-option ${r.value === 'global' ? 'active' : ''}" data-region="${r.value}">
          <span>${r.label}</span>
          <span class="region-sheet-check">${r.value === 'global' ? '<i class="bi bi-check-lg"></i>' : ''}</span>
        </button>`
      ).join('')}
      </div>
      <div class="main-content">
        <div class="map-section" id="mapSection">
          <div class="panel-header">
            <div class="panel-header-left">
              <span class="panel-title">${SITE_VARIANT === 'tech' ? t('panels.techMap') : SITE_VARIANT === 'happy' ? 'Good News Map' : SITE_VARIANT === 'spark' ? '全球地图 <span class="spark-subtitle">GLOBAL MAP</span>' : t('panels.map')}</span>
            </div>
            <span class="header-clock" id="headerClock" translate="no"></span>
            <div style="display:flex;align-items:center;gap:2px">
              <button class="map-pin-btn" id="mapGlobeToggle" title="3D Globe">
                <i class="bi bi-globe2" style="font-size:14px"></i>
              </button>
              <button class="map-pin-btn" id="mapFullscreenBtn" title="Fullscreen">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
              </button>
              <button class="map-pin-btn" id="mapPinBtn" title="${t('header.pinMap')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 17v5M9 10.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V16a1 1 0 001 1h12a1 1 0 001-1v-.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V7a1 1 0 011-1 1 1 0 001-1V4a1 1 0 00-1-1H8a1 1 0 00-1 1v1a1 1 0 001 1 1 1 0 011 1v3.76z"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="map-container" id="mapContainer"></div>
          ${SITE_VARIANT === 'happy' ? '<button class="tv-exit-btn" id="tvExitBtn">Exit TV Mode</button>' : ''}
          <div class="map-resize-handle" id="mapResizeHandle"></div>
          <div class="map-bottom-grid" id="mapBottomGrid"></div>
        </div>
        <div class="panels-grid" id="panelsGrid"></div>
        <button class="search-mobile-fab" id="searchMobileFab" aria-label="Search">\u{1F50D}</button>
      </div>
    `;

    this.createPanels();

    // Bind logout button (exists in both CN mode and world mode for spark variant)
    if (SITE_VARIANT === 'spark') {
      const logoutBtn = document.getElementById('cnHdrLogout');
      logoutBtn?.addEventListener('click', () => this.showLogoutModal());
    }

    if (this.ctx.isMobile) {
      this.setupMobileMapToggle();
    }
  }

  private injectLayerTimeRow(mapContainer: HTMLElement): void {
    const inject = () => {
      const toggles = mapContainer.querySelector('.deckgl-layer-toggles, .layer-toggles');
      if (!toggles || toggles.querySelector('.layer-time-row')) return;
      const row = document.createElement('div');
      row.className = 'layer-time-row';
      const current = this.ctx.currentTimeRange || '7d';
      const ranges = [
        { v: '1h', l: '1h' }, { v: '6h', l: '6h' }, { v: '24h', l: '24h' },
        { v: '48h', l: '48h' }, { v: '7d', l: '7d' }, { v: 'all', l: t('components.deckgl.timeAll') },
      ];
      row.innerHTML = ranges.map(r =>
        `<button class="time-btn ${r.v === current ? 'active' : ''}" data-range="${r.v}">${r.l}</button>`
      ).join('');
      row.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('.time-btn') as HTMLElement | null;
        if (!btn?.dataset.range) return;
        const range = btn.dataset.range as import('@/components').TimeRange;
        this.ctx.map?.setTimeRange(range);
        this.ctx.currentTimeRange = range;
        row.querySelectorAll('.time-btn').forEach(b => b.classList.toggle('active', b === btn));
      });
      // Insert after the toggle-header (before toggle-list)
      const header = toggles.querySelector('.toggle-header');
      if (header?.nextSibling) {
        toggles.insertBefore(row, header.nextSibling);
      } else {
        toggles.prepend(row);
      }
    };
    // Layer toggles may be created asynchronously (globe mode loads lazily)
    inject();
    const obs = new MutationObserver(() => { inject(); });
    obs.observe(mapContainer, { childList: true, subtree: true });
    // Auto-disconnect after 30s to prevent leaks
    setTimeout(() => obs.disconnect(), 30_000);
  }

  private setupMobileMapToggle(): void {
    const mapSection = document.getElementById('mapSection');
    const headerLeft = mapSection?.querySelector('.panel-header-left');
    if (!mapSection || !headerLeft) return;

    const stored = localStorage.getItem('mobile-map-collapsed');
    const collapsed = stored === 'true';
    if (collapsed) mapSection.classList.add('collapsed');

    const updateBtn = (btn: HTMLButtonElement, isCollapsed: boolean) => {
      btn.textContent = isCollapsed ? `▶ ${t('components.map.showMap')}` : `▼ ${t('components.map.hideMap')}`;
    };

    const btn = document.createElement('button');
    btn.className = 'map-collapse-btn';
    updateBtn(btn, collapsed);
    headerLeft.after(btn);

    btn.addEventListener('click', () => {
      const isCollapsed = mapSection.classList.toggle('collapsed');
      updateBtn(btn, isCollapsed);
      localStorage.setItem('mobile-map-collapsed', String(isCollapsed));
      if (!isCollapsed) window.dispatchEvent(new Event('resize'));
    });
  }

  renderCriticalBanner(postures: TheaterPostureSummary[]): void {
    if (this.ctx.isMobile) {
      if (this.criticalBannerEl) {
        this.criticalBannerEl.remove();
        this.criticalBannerEl = null;
      }
      document.body.classList.remove('has-critical-banner');
      return;
    }

    const dismissedAt = sessionStorage.getItem('banner-dismissed');
    if (dismissedAt && Date.now() - parseInt(dismissedAt, 10) < 30 * 60 * 1000) {
      return;
    }

    const critical = postures.filter(
      (p) => p.postureLevel === 'critical' || (p.postureLevel === 'elevated' && p.strikeCapable)
    );

    if (critical.length === 0) {
      if (this.criticalBannerEl) {
        this.criticalBannerEl.remove();
        this.criticalBannerEl = null;
        document.body.classList.remove('has-critical-banner');
      }
      return;
    }

    const top = critical[0]!;
    const isCritical = top.postureLevel === 'critical';

    if (!this.criticalBannerEl) {
      this.criticalBannerEl = document.createElement('div');
      this.criticalBannerEl.className = 'critical-posture-banner';
      const header = document.querySelector('.header');
      if (header) header.insertAdjacentElement('afterend', this.criticalBannerEl);
    }

    document.body.classList.add('has-critical-banner');
    this.criticalBannerEl.className = `critical-posture-banner ${isCritical ? 'severity-critical' : 'severity-elevated'}`;
    this.criticalBannerEl.innerHTML = `
      <div class="banner-content">
        <span class="banner-icon">${isCritical ? '<i class="bi bi-exclamation-octagon-fill"></i>' : '<i class="bi bi-exclamation-triangle-fill"></i>'}</span>
        <span class="banner-headline">${escapeHtml(top.headline)}</span>
        <span class="banner-stats">${top.totalAircraft} aircraft • ${escapeHtml(top.summary)}</span>
        ${top.strikeCapable ? '<span class="banner-strike">STRIKE CAPABLE</span>' : ''}
      </div>
      <button class="banner-view" data-lat="${top.centerLat}" data-lon="${top.centerLon}">View Region</button>
      <button class="banner-dismiss">×</button>
    `;

    this.criticalBannerEl.querySelector('.banner-view')?.addEventListener('click', () => {
      console.log('[Banner] View Region clicked:', top.theaterId, 'lat:', top.centerLat, 'lon:', top.centerLon);
      trackCriticalBannerAction('view', top.theaterId);
      if (typeof top.centerLat === 'number' && typeof top.centerLon === 'number') {
        this.ctx.map?.setCenter(top.centerLat, top.centerLon, 4);
      } else {
        console.error('[Banner] Missing coordinates for', top.theaterId);
      }
    });

    this.criticalBannerEl.querySelector('.banner-dismiss')?.addEventListener('click', () => {
      trackCriticalBannerAction('dismiss', top.theaterId);
      this.criticalBannerEl?.classList.add('dismissed');
      document.body.classList.remove('has-critical-banner');
      sessionStorage.setItem('banner-dismissed', Date.now().toString());
    });
  }

  applyPanelSettings(): void {
    Object.entries(this.ctx.panelSettings).forEach(([key, config]) => {
      if (key === 'map') {
        const mapSection = document.getElementById('mapSection');
        if (mapSection) {
          mapSection.classList.toggle('hidden', !config.enabled);
        }
        return;
      }
      const panel = this.ctx.panels[key];
      panel?.toggle(config.enabled);
    });
  }

  private createPanels(): void {
    const panelsGrid = document.getElementById('panelsGrid')!;

    const mapContainer = document.getElementById('mapContainer') as HTMLElement;
    const preferGlobe = loadFromStorage<string>(STORAGE_KEYS.mapMode, 'flat') === 'globe';
    this.ctx.map = new MapContainer(mapContainer, {
      zoom: this.ctx.isMobile ? 2.5 : 1.0,
      pan: { x: 0, y: 0 },
      view: this.ctx.isMobile ? this.ctx.resolvedLocation : 'global',
      layers: this.ctx.mapLayers,
      timeRange: '7d',
    }, preferGlobe);

    this.ctx.map.initEscalationGetters();
    this.ctx.currentTimeRange = this.ctx.map.getTimeRange();

    // Spark: inject time-range row into the layer toggles panel
    if (SITE_VARIANT === 'spark') {
      this.injectLayerTimeRow(mapContainer);
    }

    // Spark: check intel mode — if 'cn', create Chinese panels instead of world panels
    if (SITE_VARIANT === 'spark') {
      const intelMode = sessionStorage.getItem(STORAGE_KEYS.intelMode) || 'cn';
      if (intelMode === 'cn') {
        void this.createCnIntelPanels(panelsGrid);
        return;
      }
    }

    const politicsPanel = new NewsPanel('politics', t('panels.politics'));
    this.attachRelatedAssetHandlers(politicsPanel);
    this.ctx.newsPanels['politics'] = politicsPanel;
    this.ctx.panels['politics'] = politicsPanel;

    const techPanel = new NewsPanel('tech', t('panels.tech'));
    this.attachRelatedAssetHandlers(techPanel);
    this.ctx.newsPanels['tech'] = techPanel;
    this.ctx.panels['tech'] = techPanel;

    const financePanel = new NewsPanel('finance', t('panels.finance'));
    this.attachRelatedAssetHandlers(financePanel);
    this.ctx.newsPanels['finance'] = financePanel;
    this.ctx.panels['finance'] = financePanel;

    if (SITE_VARIANT === 'spark') {
      const marketOverviewPanel = new MarketOverviewPanel();
      this.ctx.panels['market-overview'] = marketOverviewPanel;
    } else {
      const heatmapPanel = new HeatmapPanel();
      this.ctx.panels['heatmap'] = heatmapPanel;

      const commoditiesPanel = new CommoditiesPanel();
      this.ctx.panels['commodities'] = commoditiesPanel;
    }

    const marketsPanel = new MarketPanel();
    this.ctx.panels['markets'] = marketsPanel;

    if (SITE_VARIANT !== 'spark') {
      const monitorPanel = new MonitorPanel(this.ctx.monitors);
      this.ctx.panels['monitors'] = monitorPanel;
      monitorPanel.onChanged((monitors) => {
        this.ctx.monitors = monitors;
        saveToStorage(STORAGE_KEYS.monitors, monitors);
        this.callbacks.updateMonitorResults();
      });
    }

    const predictionPanel = new PredictionPanel();
    this.ctx.panels['polymarket'] = predictionPanel;

    // Regional Intel: news feeds in a single tabbed panel (includes US + Europe in spark variant)
    const regionalTabs = [
      ...(SITE_VARIANT === 'spark' ? [
        { feedKey: 'us', label: t('panels.us') || 'US', icon: 'bi-flag' },
        { feedKey: 'europe', label: t('panels.europe') || 'Europe', icon: 'bi-flag' },
      ] : []),
      { feedKey: 'middleeast', label: t('panels.middleeast'), icon: 'bi-geo-alt' },
      { feedKey: 'africa', label: t('panels.africa'), icon: 'bi-geo-alt' },
      { feedKey: 'latam', label: t('panels.latam'), icon: 'bi-geo-alt' },
      { feedKey: 'asia', label: t('panels.asia'), icon: 'bi-geo-alt' },
      { feedKey: 'energy', label: t('panels.energy'), icon: 'bi-fuel-pump' },
      { feedKey: 'gov', label: t('panels.gov'), icon: 'bi-bank' },
      { feedKey: 'thinktanks', label: t('panels.thinktanks'), icon: 'bi-lightbulb' },
    ];
    const regionalIntel = new TabbedNewsPanel('regional-intel', t('panels.regionalIntel') || 'Regional Intel', regionalTabs);
    regionalIntel.setRelatedAssetHandlersAll({
      onRelatedAssetClick: (asset) => this.handleRelatedAssetClick(asset),
      onRelatedAssetsFocus: (assets) => this.ctx.map?.highlightAssets(assets),
      onRelatedAssetsClear: () => this.ctx.map?.highlightAssets(null),
    });
    this.ctx.panels['regional-intel'] = regionalIntel;
    // Register sub-panels so data-loader can find them by feedKey
    const regionalFeedKeys = regionalTabs.map(t => t.feedKey);
    for (const feedKey of regionalFeedKeys) {
      const subPanel = regionalIntel.getNewsPanel(feedKey);
      if (subPanel) {
        this.ctx.newsPanels[feedKey] = subPanel;
      }
    }

    const intelPanel = new NewsPanel('intel', t('panels.intel'));
    this.attachRelatedAssetHandlers(intelPanel);
    this.ctx.newsPanels['intel'] = intelPanel;
    this.ctx.panels['intel'] = intelPanel;

    if (SITE_VARIANT === 'spark') {
      const cryptoOverview = new CryptoOverviewPanel();
      this.ctx.panels['crypto-overview'] = cryptoOverview;
      this.ctx.panels['macro-signals'] = cryptoOverview.getSignalsPanel();
    } else {
      const cryptoPanel = new CryptoPanel();
      this.ctx.panels['crypto'] = cryptoPanel;
    }

    // middleeast panel is now inside regional-intel TabbedNewsPanel

    const layoffsPanel = new NewsPanel('layoffs', t('panels.layoffs'));
    this.attachRelatedAssetHandlers(layoffsPanel);
    this.ctx.newsPanels['layoffs'] = layoffsPanel;
    this.ctx.panels['layoffs'] = layoffsPanel;

    const aiPanel = new NewsPanel('ai', t('panels.ai'));
    this.attachRelatedAssetHandlers(aiPanel);
    this.ctx.newsPanels['ai'] = aiPanel;
    this.ctx.panels['ai'] = aiPanel;

    const startupsPanel = new NewsPanel('startups', t('panels.startups'));
    this.attachRelatedAssetHandlers(startupsPanel);
    this.ctx.newsPanels['startups'] = startupsPanel;
    this.ctx.panels['startups'] = startupsPanel;

    const vcblogsPanel = new NewsPanel('vcblogs', t('panels.vcblogs'));
    this.attachRelatedAssetHandlers(vcblogsPanel);
    this.ctx.newsPanels['vcblogs'] = vcblogsPanel;
    this.ctx.panels['vcblogs'] = vcblogsPanel;

    const regionalStartupsPanel = new NewsPanel('regionalStartups', t('panels.regionalStartups'));
    this.attachRelatedAssetHandlers(regionalStartupsPanel);
    this.ctx.newsPanels['regionalStartups'] = regionalStartupsPanel;
    this.ctx.panels['regionalStartups'] = regionalStartupsPanel;

    const unicornsPanel = new NewsPanel('unicorns', t('panels.unicorns'));
    this.attachRelatedAssetHandlers(unicornsPanel);
    this.ctx.newsPanels['unicorns'] = unicornsPanel;
    this.ctx.panels['unicorns'] = unicornsPanel;

    const acceleratorsPanel = new NewsPanel('accelerators', t('panels.accelerators'));
    this.attachRelatedAssetHandlers(acceleratorsPanel);
    this.ctx.newsPanels['accelerators'] = acceleratorsPanel;
    this.ctx.panels['accelerators'] = acceleratorsPanel;

    const fundingPanel = new NewsPanel('funding', t('panels.funding'));
    this.attachRelatedAssetHandlers(fundingPanel);
    this.ctx.newsPanels['funding'] = fundingPanel;
    this.ctx.panels['funding'] = fundingPanel;

    const producthuntPanel = new NewsPanel('producthunt', t('panels.producthunt'));
    this.attachRelatedAssetHandlers(producthuntPanel);
    this.ctx.newsPanels['producthunt'] = producthuntPanel;
    this.ctx.panels['producthunt'] = producthuntPanel;

    const securityPanel = new NewsPanel('security', t('panels.security'));
    this.attachRelatedAssetHandlers(securityPanel);
    this.ctx.newsPanels['security'] = securityPanel;
    this.ctx.panels['security'] = securityPanel;

    const policyPanel = new NewsPanel('policy', t('panels.policy'));
    this.attachRelatedAssetHandlers(policyPanel);
    this.ctx.newsPanels['policy'] = policyPanel;
    this.ctx.panels['policy'] = policyPanel;

    const hardwarePanel = new NewsPanel('hardware', t('panels.hardware'));
    this.attachRelatedAssetHandlers(hardwarePanel);
    this.ctx.newsPanels['hardware'] = hardwarePanel;
    this.ctx.panels['hardware'] = hardwarePanel;

    const cloudPanel = new NewsPanel('cloud', t('panels.cloud'));
    this.attachRelatedAssetHandlers(cloudPanel);
    this.ctx.newsPanels['cloud'] = cloudPanel;
    this.ctx.panels['cloud'] = cloudPanel;

    const devPanel = new NewsPanel('dev', t('panels.dev'));
    this.attachRelatedAssetHandlers(devPanel);
    this.ctx.newsPanels['dev'] = devPanel;
    this.ctx.panels['dev'] = devPanel;

    const githubPanel = new NewsPanel('github', t('panels.github'));
    this.attachRelatedAssetHandlers(githubPanel);
    this.ctx.newsPanels['github'] = githubPanel;
    this.ctx.panels['github'] = githubPanel;

    const ipoPanel = new NewsPanel('ipo', t('panels.ipo'));
    this.attachRelatedAssetHandlers(ipoPanel);
    this.ctx.newsPanels['ipo'] = ipoPanel;
    this.ctx.panels['ipo'] = ipoPanel;

    // thinktanks panel is now inside regional-intel TabbedNewsPanel

    const economicPanel = new EconomicPanel();
    this.ctx.panels['economic'] = economicPanel;

    if (SITE_VARIANT === 'full' || SITE_VARIANT === 'finance' || SITE_VARIANT === 'spark') {
      const tradePolicyPanel = new TradePolicyPanel();
      this.ctx.panels['trade-policy'] = tradePolicyPanel;

      const supplyChainPanel = new SupplyChainPanel();
      this.ctx.panels['supply-chain'] = supplyChainPanel;
    }

    // africa, latam, asia, energy panels are now inside regional-intel TabbedNewsPanel

    for (const key of Object.keys(FEEDS)) {
      if (this.ctx.newsPanels[key]) continue;
      if (!Array.isArray((FEEDS as Record<string, unknown>)[key])) continue;
      const panelKey = this.ctx.panels[key] && !this.ctx.newsPanels[key] ? `${key}-news` : key;
      if (this.ctx.panels[panelKey]) continue;
      const panelConfig = DEFAULT_PANELS[panelKey] ?? DEFAULT_PANELS[key];
      const label = panelConfig?.name ?? key.charAt(0).toUpperCase() + key.slice(1);
      const panel = new NewsPanel(panelKey, label);
      this.attachRelatedAssetHandlers(panel);
      this.ctx.newsPanels[key] = panel;
      this.ctx.panels[panelKey] = panel;
    }

    if (SITE_VARIANT === 'full' || SITE_VARIANT === 'spark') {
      const gdeltIntelPanel = new GdeltIntelPanel();
      this.ctx.panels['gdelt-intel'] = gdeltIntelPanel;

      if (SITE_VARIANT !== 'spark') {
        import('@/components/DeductionPanel').then(({ DeductionPanel }) => {
          const deductionPanel = new DeductionPanel(() => this.ctx.allNews);
          this.ctx.panels['deduction'] = deductionPanel;
          const el = deductionPanel.getElement();
          this.makeDraggable(el, 'deduction');
          const grid = document.getElementById('panelsGrid');
          if (grid) {
            const gdeltEl = this.ctx.panels['gdelt-intel']?.getElement();
            if (gdeltEl?.nextSibling) {
              grid.insertBefore(el, gdeltEl.nextSibling);
            } else {
              grid.appendChild(el);
            }
          }
        });
      }

      // CII + Cascade: skip in spark variant (content consolidated into strategic-risk)
      if (SITE_VARIANT !== 'spark') {
        const ciiPanel = new CIIPanel();
        ciiPanel.setShareStoryHandler((code, name) => {
          this.callbacks.openCountryStory(code, name);
        });
        ciiPanel.setCountryClickHandler((code) => {
          this.callbacks.openCountryBrief(code);
        });
        this.ctx.panels['cii'] = ciiPanel;

        const cascadePanel = new CascadePanel();
        this.ctx.panels['cascade'] = cascadePanel;
      }

      // Satellite fires — only for full variant
      if (SITE_VARIANT === 'full') {
        const satelliteFiresPanel = new SatelliteFiresPanel();
        this.ctx.panels['satellite-fires'] = satelliteFiresPanel;
      }

      const strategicRiskPanel = new StrategicRiskPanel();
      strategicRiskPanel.setLocationClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 4);
      });
      this.ctx.panels['strategic-risk'] = strategicRiskPanel;

      // Spark: strategic-posture is embedded in AIOverviewPanel
      if (SITE_VARIANT !== 'spark') {
        const strategicPosturePanel = new StrategicPosturePanel(() => this.ctx.allNews);
        strategicPosturePanel.setLocationClickHandler((lat, lon) => {
          console.log('[App] StrategicPosture handler called:', { lat, lon, hasMap: !!this.ctx.map });
          this.ctx.map?.setCenter(lat, lon, 4);
        });
        this.ctx.panels['strategic-posture'] = strategicPosturePanel;
      }

      const ucdpEventsPanel = new UcdpEventsPanel();
      ucdpEventsPanel.setEventClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 5);
      });
      this.ctx.panels['ucdp-events'] = ucdpEventsPanel;

      const displacementPanel = new DisplacementPanel();
      displacementPanel.setCountryClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 4);
      });
      this.ctx.panels['displacement'] = displacementPanel;

      if (SITE_VARIANT !== 'spark') {
        const climatePanel = new ClimateAnomalyPanel();
        climatePanel.setZoneClickHandler((lat, lon) => {
          this.ctx.map?.setCenter(lat, lon, 4);
        });
        this.ctx.panels['climate'] = climatePanel;
      }

      const populationExposurePanel = new PopulationExposurePanel();
      this.ctx.panels['population-exposure'] = populationExposurePanel;

      // Spark: security-advisories is embedded inside IntelOverviewPanel (registered below)
      if (SITE_VARIANT !== 'spark') {
        const securityAdvisoriesPanel = new SecurityAdvisoriesPanel();
        securityAdvisoriesPanel.setRefreshHandler(() => {
          void this.callbacks.loadSecurityAdvisories?.();
        });
        this.ctx.panels['security-advisories'] = securityAdvisoriesPanel;
      }

      // Oref sirens — only for full variant
      if (SITE_VARIANT === 'full') {
        const orefSirensPanel = new OrefSirensPanel();
        this.ctx.panels['oref-sirens'] = orefSirensPanel;
      }

      // Spark: merge telegram + airline + security into IntelOverviewPanel
      if (SITE_VARIANT === 'spark') {
        const intelOverview = new IntelOverviewPanel();
        this.ctx.panels['intel-overview'] = intelOverview;
        // Register embedded security panel for data refresh
        const secPanel = intelOverview.getSecurityPanel();
        secPanel.setRefreshHandler(() => {
          void this.callbacks.loadSecurityAdvisories?.();
        });
        this.ctx.panels['security-advisories'] = secPanel;
      } else {
        const telegramIntelPanel = new TelegramIntelPanel();
        this.ctx.panels['telegram-intel'] = telegramIntelPanel;
      }
    }

    if (SITE_VARIANT === 'finance') {
      const investmentsPanel = new InvestmentsPanel((inv) => {
        focusInvestmentOnMap(this.ctx.map, this.ctx.mapLayers, inv.lat, inv.lon);
      });
      this.ctx.panels['gcc-investments'] = investmentsPanel;

      const gulfEconomiesPanel = new GulfEconomiesPanel();
      this.ctx.panels['gulf-economies'] = gulfEconomiesPanel;
    }

    this.ctx.panels['world-clock'] = new WorldClockPanel();

    // Airline Intelligence panel (non-happy, non-spark variants)
    // Spark uses IntelOverviewPanel which embeds AirlineIntelPanel
    if (SITE_VARIANT !== 'happy' && SITE_VARIANT !== 'spark') {
      this.ctx.panels['airline-intel'] = new AirlineIntelPanel();
      // Launch the Ctrl+J command bar (attaches global keydown listener)
      this.aviationCommandBar = new AviationCommandBar();
    } else if (SITE_VARIANT === 'spark') {
      this.aviationCommandBar = new AviationCommandBar();
    }

    if (SITE_VARIANT !== 'happy') {
      if (!this.ctx.panels['gulf-economies']) {
        const gulfEconomiesPanel = new GulfEconomiesPanel();
        this.ctx.panels['gulf-economies'] = gulfEconomiesPanel;
      }

      const liveNewsPanel = new LiveNewsPanel();
      this.ctx.panels['live-news'] = liveNewsPanel;

      const liveWebcamsPanel = new LiveWebcamsPanel();
      this.ctx.panels['live-webcams'] = liveWebcamsPanel;

      this.ctx.panels['events'] = new TechEventsPanel('events', () => this.ctx.allNews);

      const serviceStatusPanel = new ServiceStatusPanel();
      this.ctx.panels['service-status'] = serviceStatusPanel;

      const techReadinessPanel = new TechReadinessPanel();
      this.ctx.panels['tech-readiness'] = techReadinessPanel;

      // Spark: macro-signals is embedded inside CryptoOverviewPanel (registered above)
      if (SITE_VARIANT !== 'spark') {
        this.ctx.panels['macro-signals'] = new MacroSignalsPanel();
      }
      if (SITE_VARIANT !== 'spark') {
        this.ctx.panels['etf-flows'] = new ETFFlowsPanel();
        this.ctx.panels['stablecoins'] = new StablecoinPanel();
      }
    }

    if (this.ctx.isDesktopApp && SITE_VARIANT !== 'spark') {
      const runtimeConfigPanel = new RuntimeConfigPanel({ mode: 'alert' });
      this.ctx.panels['runtime-config'] = runtimeConfigPanel;
    }

    // Spark: merge insights + posture into AIOverviewPanel
    if (SITE_VARIANT === 'spark') {
      const aiOverview = new AIOverviewPanel(() => this.ctx.allNews);
      aiOverview.getPosturePanel().setLocationClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 4);
      });
      this.ctx.panels['ai-overview'] = aiOverview;
    } else {
      const insightsPanel = new InsightsPanel();
      this.ctx.panels['insights'] = insightsPanel;
    }

    // Global Giving panel (all variants)
    this.ctx.panels['giving'] = new GivingPanel();

    // Happy variant panels — lazy-loaded (separate chunk: panels-happy)
    if (SITE_VARIANT === 'happy') {
      void this.createHappyPanels();
    }

    const defaultOrder = Object.keys(DEFAULT_PANELS).filter(k => k !== 'map');
    const savedOrder = this.getSavedPanelOrder();
    const savedBottomOrder = this.getSavedBottomPanelOrder();
    const isUltraWide = window.innerWidth >= 1600;

    let panelOrder = defaultOrder;
    if (savedOrder.length > 0 || savedBottomOrder.length > 0) {
      const allSaved = [...savedOrder, ...savedBottomOrder];
      const missing = defaultOrder.filter(k => !allSaved.includes(k));
      const valid = savedOrder.filter(k => defaultOrder.includes(k));
      const validBottom = isUltraWide ? savedBottomOrder.filter(k => defaultOrder.includes(k)) : [];

      const monitorsIdx = valid.indexOf('monitors');
      if (monitorsIdx !== -1) valid.splice(monitorsIdx, 1);
      const insertIdx = valid.indexOf('politics') + 1 || 0;
      const newPanels = missing.filter(k => k !== 'monitors');
      valid.splice(insertIdx, 0, ...newPanels);
      if (SITE_VARIANT !== 'happy') {
        valid.push('monitors');
      }
      panelOrder = valid;

      // Handle bottom panels
      validBottom.forEach(key => {
        const panel = this.ctx.panels[key];
        if (panel) {
          const el = panel.getElement();
          this.makeDraggable(el, key);
          document.getElementById('mapBottomGrid')?.appendChild(el);
        }
      });
    }

    if (SITE_VARIANT !== 'happy') {
      const liveNewsIdx = panelOrder.indexOf('live-news');
      if (liveNewsIdx > 0) {
        panelOrder.splice(liveNewsIdx, 1);
        panelOrder.unshift('live-news');
      }

      if (SITE_VARIANT === 'spark') {
        // Spark: live-news → ai-overview → live-webcams (AI panel next to news)
        const aiIdx = panelOrder.indexOf('ai-overview');
        if (aiIdx > 1) {
          panelOrder.splice(aiIdx, 1);
          panelOrder.splice(1, 0, 'ai-overview');
        }
        const webcamsIdx = panelOrder.indexOf('live-webcams');
        if (webcamsIdx !== -1 && webcamsIdx !== 2) {
          panelOrder.splice(webcamsIdx, 1);
          panelOrder.splice(2, 0, 'live-webcams');
        }

      } else {
        const webcamsIdx = panelOrder.indexOf('live-webcams');
        if (webcamsIdx !== -1 && webcamsIdx !== panelOrder.indexOf('live-news') + 1) {
          panelOrder.splice(webcamsIdx, 1);
          const afterNews = panelOrder.indexOf('live-news') + 1;
          panelOrder.splice(afterNews, 0, 'live-webcams');
        }
      }
    }

    if (this.ctx.isDesktopApp) {
      const runtimeIdx = panelOrder.indexOf('runtime-config');
      if (runtimeIdx > 1) {
        panelOrder.splice(runtimeIdx, 1);
        panelOrder.splice(1, 0, 'runtime-config');
      } else if (runtimeIdx === -1) {
        panelOrder.splice(1, 0, 'runtime-config');
      }
    }

    panelOrder.forEach((key: string) => {
      const panel = this.ctx.panels[key];
      if (panel && !panel.getElement().parentElement) {
        const el = panel.getElement();
        this.makeDraggable(el, key);
        panelsGrid.appendChild(el);
      }
    });

    this.syncBottomGridVisibility();
    window.addEventListener('resize', () => this.ensureCorrectZones());

    this.ctx.map.onTimeRangeChanged((range) => {
      this.ctx.currentTimeRange = range;
      this.applyTimeRangeFilterDebounced();
    });

    // Spark variant: inject KPI bar and apply bilingual titles
    if (SITE_VARIANT === 'spark') {
      this.sparkKPIBar = new SparkKPIBar();
      this.ctx.sparkKPIBar = this.sparkKPIBar;
      const mapSection = document.getElementById('mapSection');
      if (mapSection) {
        mapSection.parentElement?.insertBefore(this.sparkKPIBar.getElement(), mapSection);
      }

      // Apply bilingual panel titles
      Object.entries(this.ctx.panels).forEach(([key, panel]) => {
        const titles = SPARK_PANEL_TITLES[key];
        if (titles && panel) {
          const el = panel.getElement();
          const titleEl = el.querySelector('.panel-title');
          if (titleEl) {
            titleEl.innerHTML = `${titles.zh} <span class="spark-subtitle">${titles.en}</span>`;
          }
        }
      });
    }

    this.applyPanelSettings();
    this.applyInitialUrlState();
  }

  /** Create Chinese Intelligence page (completely custom layout, no Panel grid) */
  /** Lazy-load Happy variant panels (separate chunk: panels-happy) */
  private async createHappyPanels(): Promise<void> {
    const [
      { PositiveNewsFeedPanel },
      { CountersPanel },
      { ProgressChartsPanel },
      { BreakthroughsTickerPanel },
      { HeroSpotlightPanel },
      { GoodThingsDigestPanel },
      { SpeciesComebackPanel },
      { RenewableEnergyPanel },
    ] = await Promise.all([
      import('@/components/PositiveNewsFeedPanel'),
      import('@/components/CountersPanel'),
      import('@/components/ProgressChartsPanel'),
      import('@/components/BreakthroughsTickerPanel'),
      import('@/components/HeroSpotlightPanel'),
      import('@/components/GoodThingsDigestPanel'),
      import('@/components/SpeciesComebackPanel'),
      import('@/components/RenewableEnergyPanel'),
    ]);

    this.ctx.positivePanel = new PositiveNewsFeedPanel();
    this.ctx.panels['positive-feed'] = this.ctx.positivePanel;

    this.ctx.countersPanel = new CountersPanel();
    this.ctx.panels['counters'] = this.ctx.countersPanel;
    this.ctx.countersPanel.startTicking();

    this.ctx.progressPanel = new ProgressChartsPanel();
    this.ctx.panels['progress'] = this.ctx.progressPanel;

    this.ctx.breakthroughsPanel = new BreakthroughsTickerPanel();
    this.ctx.panels['breakthroughs'] = this.ctx.breakthroughsPanel;

    this.ctx.heroPanel = new HeroSpotlightPanel();
    this.ctx.panels['spotlight'] = this.ctx.heroPanel;
    this.ctx.heroPanel.onLocationRequest = (lat: number, lon: number) => {
      this.ctx.map?.setCenter(lat, lon, 4);
      this.ctx.map?.flashLocation(lat, lon, 3000);
    };

    this.ctx.digestPanel = new GoodThingsDigestPanel();
    this.ctx.panels['digest'] = this.ctx.digestPanel;

    this.ctx.speciesPanel = new SpeciesComebackPanel();
    this.ctx.panels['species'] = this.ctx.speciesPanel;

    this.ctx.renewablePanel = new RenewableEnergyPanel();
    this.ctx.panels['renewable'] = this.ctx.renewablePanel;
  }

  private async createCnIntelPanels(panelsGrid: HTMLElement): Promise<void> {
    // Hide map and panels grid — CN mode uses its own page layout
    const mapSection = document.getElementById('mapSection');
    if (mapSection) mapSection.style.display = 'none';
    panelsGrid.style.display = 'none';

    // Lazy-load all 8 Chinese intel panels (separate chunk: panels-cn)
    const [
      { CnMarketPanel },
      { CnSentimentPanel },
      { CnHotEventsPanel },
      { CnBriefPanel },
      { CnResearchPanel },
      { CnMoodPanel },
      { CnPolicyPanel },
      { CnRagPanel },
    ] = await Promise.all([
      import('@/components/CnMarketPanel'),
      import('@/components/CnSentimentPanel'),
      import('@/components/CnHotEventsPanel'),
      import('@/components/CnBriefPanel'),
      import('@/components/CnResearchPanel'),
      import('@/components/CnMoodPanel'),
      import('@/components/CnPolicyPanel'),
      import('@/components/CnRagPanel'),
    ]);

    const cnMarket = new CnMarketPanel();
    const cnSentiment = new CnSentimentPanel();
    const cnHotEvents = new CnHotEventsPanel();
    const cnBrief = new CnBriefPanel();
    const cnResearch = new CnResearchPanel();
    const cnMood = new CnMoodPanel();
    const cnPolicy = new CnPolicyPanel();
    const cnRag = new CnRagPanel();

    this.ctx.panels['cn-market'] = cnMarket;
    this.ctx.panels['cn-sentiment'] = cnSentiment;
    this.ctx.panels['cn-hot-events'] = cnHotEvents;
    this.ctx.panels['cn-brief'] = cnBrief;
    this.ctx.panels['cn-research'] = cnResearch;
    this.ctx.panels['cn-mood'] = cnMood;
    this.ctx.panels['cn-policy'] = cnPolicy;
    this.ctx.panels['cn-rag'] = cnRag;

    // Create the CN-Intel page container (sibling of panelsGrid)
    const page = document.createElement('div');
    page.className = 'cn-page';
    page.id = 'cnIntelPage';
    panelsGrid.parentElement!.appendChild(page);

    // Build page structure
    const body = document.createElement('div');
    body.className = 'cn-page-body';

    const sidebar = document.createElement('aside');
    sidebar.className = 'cn-page-sidebar';

    const main = document.createElement('main');
    main.className = 'cn-page-main';

    // Mount panels into slots — strip chrome via CSS class
    const mount = (container: HTMLElement, panel: import('@/components').Panel, sectionTitle?: string) => {
      const wrapper = document.createElement('section');
      wrapper.className = 'cn-section';
      if (sectionTitle) {
        const h = document.createElement('h3');
        h.className = 'cn-section-title';
        h.textContent = sectionTitle;
        wrapper.appendChild(h);
      }
      const el = panel.getElement();
      el.classList.add('cn-chromeless');
      wrapper.appendChild(el);
      container.appendChild(wrapper);
    };

    // Sidebar tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'cn-sidebar-tabs';
    const sidebarTabs = [
      { key: 'market', label: '行情' },
      { key: 'sentiment', label: '情绪' },
      { key: 'hotevents', label: '热点' },
    ];
    sidebarTabs.forEach((t, i) => {
      const btn = document.createElement('button');
      btn.className = 'cn-sidebar-tab' + (i === 0 ? ' active' : '');
      btn.dataset.sidebarTab = t.key;
      btn.textContent = t.label;
      tabBar.appendChild(btn);
    });
    sidebar.appendChild(tabBar);

    // Create tab panel containers
    const marketPanel = document.createElement('div');
    marketPanel.className = 'cn-tab-panel active';
    marketPanel.dataset.tabPanel = 'market';
    const sentimentPanel = document.createElement('div');
    sentimentPanel.className = 'cn-tab-panel';
    sentimentPanel.dataset.tabPanel = 'sentiment';
    const hotEventsPanel = document.createElement('div');
    hotEventsPanel.className = 'cn-tab-panel';
    hotEventsPanel.dataset.tabPanel = 'hotevents';

    // Mount each panel into its tab container
    mount(marketPanel, cnMarket, 'A股行情');
    mount(sentimentPanel, cnSentiment, '市场情绪');
    mount(hotEventsPanel, cnHotEvents, '热点事件');

    sidebar.appendChild(marketPanel);
    sidebar.appendChild(sentimentPanel);
    sidebar.appendChild(hotEventsPanel);

    // Tab switching via event delegation
    tabBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.cn-sidebar-tab') as HTMLElement | null;
      if (!btn?.dataset.sidebarTab) return;
      const key = btn.dataset.sidebarTab;
      // Toggle active tab
      tabBar.querySelectorAll('.cn-sidebar-tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      // Toggle active panel
      sidebar.querySelectorAll('.cn-tab-panel').forEach(p => p.classList.remove('active'));
      const target = sidebar.querySelector(`.cn-tab-panel[data-tab-panel="${key}"]`);
      if (target) target.classList.add('active');
    });

    // Main: RAG drawer (collapsible) + Brief + Research + Mood
    // RAG toggle button in a toolbar row
    const ragToolbar = document.createElement('div');
    ragToolbar.className = 'cn-rag-toolbar';
    const ragToggle = document.createElement('button');
    ragToggle.className = 'cn-rag-toggle';
    ragToggle.innerHTML = '<i class="bi bi-chat-dots"></i> AI助手';
    ragToolbar.appendChild(ragToggle);
    main.appendChild(ragToolbar);

    // RAG drawer (collapsed by default)
    const ragDrawer = document.createElement('div');
    ragDrawer.className = 'cn-rag-drawer';
    const ragEl = cnRag.getElement();
    ragEl.classList.add('cn-chromeless');
    ragDrawer.appendChild(ragEl);
    main.appendChild(ragDrawer);

    // Toggle RAG drawer
    ragToggle.addEventListener('click', () => {
      const isOpen = ragDrawer.classList.toggle('open');
      ragToggle.classList.toggle('active', isOpen);
    });

    // Main content tabs: 简报 / 研报 / 舆情 / 政策
    const mainTabBar = document.createElement('div');
    mainTabBar.className = 'cn-main-tabs';
    const mainTabData = [
      { key: 'brief', label: '<i class="bi bi-journal-text"></i> 简报' },
      { key: 'research', label: '<i class="bi bi-file-earmark-bar-graph"></i> 研报' },
      { key: 'mood', label: '<i class="bi bi-chat-square-heart"></i> 舆情' },
      { key: 'policy', label: '<i class="bi bi-bank"></i> 政策' },
    ];
    mainTabData.forEach((t, i) => {
      const btn = document.createElement('button');
      btn.className = 'cn-main-tab' + (i === 0 ? ' active' : '');
      btn.dataset.mainTab = t.key;
      btn.innerHTML = t.label;
      mainTabBar.appendChild(btn);
    });
    main.appendChild(mainTabBar);

    // Tab panels
    const briefPanel = document.createElement('div');
    briefPanel.className = 'cn-main-tab-panel active';
    briefPanel.dataset.mainTabPanel = 'brief';

    const researchPanel = document.createElement('div');
    researchPanel.className = 'cn-main-tab-panel';
    researchPanel.dataset.mainTabPanel = 'research';

    const moodPanel = document.createElement('div');
    moodPanel.className = 'cn-main-tab-panel';
    moodPanel.dataset.mainTabPanel = 'mood';

    const policyPanel = document.createElement('div');
    policyPanel.className = 'cn-main-tab-panel';
    policyPanel.dataset.mainTabPanel = 'policy';

    mount(briefPanel, cnBrief);
    mount(researchPanel, cnResearch);
    mount(moodPanel, cnMood);
    mount(policyPanel, cnPolicy);

    main.appendChild(briefPanel);
    main.appendChild(researchPanel);
    main.appendChild(moodPanel);
    main.appendChild(policyPanel);

    // Main tab switching via event delegation
    mainTabBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.cn-main-tab') as HTMLElement | null;
      if (!btn?.dataset.mainTab) return;
      const key = btn.dataset.mainTab;
      mainTabBar.querySelectorAll('.cn-main-tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      main.querySelectorAll('.cn-main-tab-panel').forEach(p => p.classList.remove('active'));
      const target = main.querySelector(`.cn-main-tab-panel[data-main-tab-panel="${key}"]`);
      if (target) target.classList.add('active');
    });

    // Sidebar collapse toggle — thin handle between sidebar and main
    const sidebarToggle = document.createElement('button');
    sidebarToggle.className = 'cn-sidebar-toggle';
    sidebarToggle.title = '折叠侧边栏';

    // Restore collapsed state
    const sidebarWasCollapsed = localStorage.getItem('cn-sidebar-collapsed') === 'true';
    if (sidebarWasCollapsed) {
      sidebar.classList.add('collapsed');
      sidebarToggle.title = '展开侧边栏';
    }

    sidebarToggle.addEventListener('click', () => {
      const isCollapsed = sidebar.classList.toggle('collapsed');
      sidebarToggle.title = isCollapsed ? '展开侧边栏' : '折叠侧边栏';
      localStorage.setItem('cn-sidebar-collapsed', String(isCollapsed));
    });

    body.appendChild(sidebar);
    body.appendChild(sidebarToggle);
    body.appendChild(main);
    page.appendChild(body);

    // Load enterprise name into global header
    this.loadCnHeaderEnterpriseName();

    // Set up header quick-action buttons
    this.setupCnHeaderActions();
  }

  private async loadCnHeaderEnterpriseName(): Promise<void> {
    const nameEl = document.getElementById('cnEntName');
    if (!nameEl) return;

    // Fallback: use company_name from auth system (wm_user in localStorage)
    const wmUser = (() => {
      try { return JSON.parse(localStorage.getItem('wm_user') || '{}'); } catch { return {}; }
    })();
    const authName = wmUser.company_name || '';

    try {
      const { loadProfile } = await import('@/services/cn-profile');
      const { profile } = await loadProfile();
      nameEl.textContent = profile?.company_name || authName || '未设置企业';
    } catch {
      nameEl.textContent = authName || '未设置企业';
    }
  }

  private setupCnHeaderActions(): void {
    const alertBtn = document.getElementById('cnHdrAlerts');
    const reportBtn = document.getElementById('cnHdrReport');
    const profileBtn = document.getElementById('cnHdrProfile');
    const aiEngineBtn = document.getElementById('cnHdrAiEngine');

    // AI engine selector → open settings modal
    aiEngineBtn?.addEventListener('click', async () => {
      const { openAiSettingsModal } = await import('@/components/CnAiSettingsModal');
      openAiSettingsModal();
    });

    // Alert bell → toggle alert panel (anchored to header)
    let headerAlertPanel: any = null;
    const ensureAlertPanel = async () => {
      if (!headerAlertPanel) {
        const { CnAlertPanel } = await import('@/components/CnAlertPanel');
        const anchor = document.getElementById('cnHdrActions');
        if (anchor) {
          anchor.style.position = 'relative';
          headerAlertPanel = new CnAlertPanel(anchor);
        }
      }
      return headerAlertPanel;
    };

    alertBtn?.addEventListener('click', async () => {
      const panel = await ensureAlertPanel();
      if (panel) {
        await panel.toggle();
        this.updateCnAlertBadge();
      }
    });

    // Pre-load alert data after 5s so clicking bell shows data instantly
    setTimeout(async () => {
      const panel = await ensureAlertPanel();
      if (panel) await panel.loadAlerts();
    }, 5000);

    // Weekly report → open report viewer
    reportBtn?.addEventListener('click', async () => {
      const { openReportViewer } = await import('@/components/CnReportViewer');
      openReportViewer('weekly');
    });

    // Profile settings → open profile modal with refresh callback
    profileBtn?.addEventListener('click', async () => {
      const { openProfileModal } = await import('@/components/CnProfileModal');
      openProfileModal((saved) => {
        this.loadCnHeaderEnterpriseName();
        // Refresh CnPolicyPanel data — reset caches and re-fetch current view
        const cp = this.ctx.panels['cn-policy'] as any;
        if (cp) {
          if (saved) cp.profileData = saved;
          cp.dashboardFetched = false;
          cp.dashboardData = null;
          cp.industryFetched = false;
          cp.industryBrief = null;
          // switchToView is public and handles fetch + render
          if (cp.switchToView) cp.switchToView(cp.viewMode || 'live');
        }
      });
    });

    // Load initial alert badge — retry after delay to handle race condition on
    // slower machines (Windows) where SSE stream may not be connected yet.
    this.updateCnAlertBadge();
    setTimeout(() => this.updateCnAlertBadge(), 3000);
    setTimeout(() => this.updateCnAlertBadge(), 10000);
  }

  private showLogoutModal(): void {
    // Remove any existing modal
    document.getElementById('logoutModal')?.remove();

    const user = JSON.parse(localStorage.getItem('wm_user') || '{}');
    const email = user.email || '';
    const initial = (user.company_name || email || '?').charAt(0).toUpperCase();

    const overlay = document.createElement('div');
    overlay.id = 'logoutModal';
    overlay.innerHTML = `
      <style>
        #logoutModal {
          position: fixed; inset: 0; z-index: 99999;
          background: rgba(0,0,0,0.55); backdrop-filter: blur(6px);
          display: flex; align-items: center; justify-content: center;
          animation: lm-fadeIn .2s ease;
        }
        @keyframes lm-fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes lm-slideUp { from { opacity: 0; transform: translateY(16px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .lm-card {
          background: #111827; border: 1px solid rgba(0,212,255,0.12);
          border-radius: 16px; padding: 32px; width: 380px; max-width: 90vw;
          text-align: center; animation: lm-slideUp .25s ease;
          box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        }
        .lm-avatar {
          width: 56px; height: 56px; border-radius: 50%; margin: 0 auto 16px;
          background: linear-gradient(135deg, rgba(0,212,255,0.15), rgba(0,232,143,0.15));
          border: 2px solid rgba(0,212,255,0.2);
          display: flex; align-items: center; justify-content: center;
          font-size: 22px; font-weight: 700; color: #00d4ff;
        }
        .lm-title { font-size: 17px; font-weight: 700; color: #e8eef5; margin-bottom: 6px; }
        .lm-email { font-size: 13px; color: #8b96b1; margin-bottom: 20px; }
        .lm-desc { font-size: 13px; color: #6b7280; margin-bottom: 24px; line-height: 1.6; }
        .lm-actions { display: flex; gap: 10px; }
        .lm-btn {
          flex: 1; padding: 10px 0; border-radius: 10px; font-size: 14px;
          font-weight: 600; cursor: pointer; transition: all .2s; border: none;
          font-family: inherit;
        }
        .lm-btn-cancel {
          background: rgba(255,255,255,0.06); color: #8b96b1;
          border: 1px solid rgba(255,255,255,0.1);
        }
        .lm-btn-cancel:hover { background: rgba(255,255,255,0.1); color: #e8eef5; }
        .lm-btn-confirm {
          background: linear-gradient(135deg, #ef4444, #dc2626); color: #fff;
        }
        .lm-btn-confirm:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(239,68,68,0.35); }
        .lm-btn-confirm:disabled { opacity: 0.6; cursor: not-allowed; transform: none; box-shadow: none; }
      </style>
      <div class="lm-card">
        <div class="lm-avatar">${initial}</div>
        <div class="lm-title">退出登录</div>
        <div class="lm-email">${email}</div>
        <div class="lm-desc">退出后需要重新登录才能查看情报数据，确认退出当前账号？</div>
        <div class="lm-actions">
          <button class="lm-btn lm-btn-cancel" id="lmCancel">取消</button>
          <button class="lm-btn lm-btn-confirm" id="lmConfirm">确认退出</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Cancel
    const cancel = () => overlay.remove();
    document.getElementById('lmCancel')!.addEventListener('click', cancel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });

    // Confirm
    document.getElementById('lmConfirm')!.addEventListener('click', async () => {
      const btn = document.getElementById('lmConfirm') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = '退出中...';

      const token = localStorage.getItem('wm_token');
      try {
        if (token) {
          await fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
          });
        }
      } catch { /* ignore */ }

      localStorage.removeItem('wm_token');
      localStorage.removeItem('wm_user');
      localStorage.removeItem('cn_user_profile_id');
      localStorage.removeItem('cn_onboarding_done');
      window.location.href = 'home.html';
    });
  }

  private async updateCnAlertBadge(): Promise<void> {
    const dot = document.getElementById('cnHdrAlertDot');
    if (!dot) return;
    try {
      const { getAlertStats } = await import('@/services/cn-alerts');
      const stats = await getAlertStats();
      const unread = (stats as any).unread || 0;
      dot.classList.toggle('visible', unread > 0);
    } catch {
      dot.classList.remove('visible');
    }
  }

  private applyTimeRangeFilterToNewsPanels(): void {
    Object.entries(this.ctx.newsByCategory).forEach(([category, items]) => {
      const panel = this.ctx.newsPanels[category];
      if (!panel) return;
      const filtered = this.filterItemsByTimeRange(items);
      if (filtered.length === 0 && items.length > 0) {
        panel.renderFilteredEmpty(`No items in ${this.getTimeRangeLabel()}`);
        return;
      }
      panel.renderNews(filtered);
    });
  }

  private filterItemsByTimeRange(items: import('@/types').NewsItem[], range: import('@/components').TimeRange = this.ctx.currentTimeRange): import('@/types').NewsItem[] {
    if (range === 'all') return items;
    const ranges: Record<string, number> = {
      '1h': 60 * 60 * 1000, '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000, '48h': 48 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000, 'all': Infinity,
    };
    const cutoff = Date.now() - (ranges[range] ?? Infinity);
    return items.filter((item) => {
      const ts = item.pubDate instanceof Date ? item.pubDate.getTime() : new Date(item.pubDate).getTime();
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
  }

  private getTimeRangeLabel(): string {
    const labels: Record<string, string> = {
      '1h': 'the last hour', '6h': 'the last 6 hours',
      '24h': 'the last 24 hours', '48h': 'the last 48 hours',
      '7d': 'the last 7 days', 'all': 'all time',
    };
    return labels[this.ctx.currentTimeRange] ?? 'the last 7 days';
  }

  private applyInitialUrlState(): void {
    if (!this.ctx.initialUrlState || !this.ctx.map) return;

    const { view, zoom, lat, lon, timeRange, layers } = this.ctx.initialUrlState;

    if (view) {
      this.ctx.map.setView(view);
    }

    if (timeRange) {
      this.ctx.map.setTimeRange(timeRange);
    }

    if (layers) {
      this.ctx.mapLayers = layers;
      saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
      this.ctx.map.setLayers(layers);
    }

    if (lat !== undefined && lon !== undefined) {
      const effectiveZoom = zoom ?? this.ctx.map.getState().zoom;
      if (effectiveZoom > 2) this.ctx.map.setCenter(lat, lon, zoom);
    } else if (!view && zoom !== undefined) {
      this.ctx.map.setZoom(zoom);
    }

    const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
    const currentView = this.ctx.map.getState().view;
    if (regionSelect && currentView) {
      regionSelect.value = currentView;
    }
  }

  private getSavedPanelOrder(): string[] {
    try {
      const saved = localStorage.getItem(this.ctx.PANEL_ORDER_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  savePanelOrder(): void {
    const grid = document.getElementById('panelsGrid');
    const bottomGrid = document.getElementById('mapBottomGrid');
    if (!grid || !bottomGrid) return;

    const order = Array.from(grid.children)
      .map((el) => (el as HTMLElement).dataset.panel)
      .filter((key): key is string => !!key);

    const bottomOrder = Array.from(bottomGrid.children)
      .map((el) => (el as HTMLElement).dataset.panel)
      .filter((key): key is string => !!key);

    localStorage.setItem(this.ctx.PANEL_ORDER_KEY, JSON.stringify(order));
    localStorage.setItem(this.ctx.PANEL_ORDER_KEY + '-bottom', JSON.stringify(bottomOrder));
    this.syncBottomGridVisibility();
  }

  private getSavedBottomPanelOrder(): string[] {
    try {
      const saved = localStorage.getItem(this.ctx.PANEL_ORDER_KEY + '-bottom');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  /** Toggle .has-panels on the bottom grid so CSS can show/hide it */
  private syncBottomGridVisibility(): void {
    const bg = document.getElementById('mapBottomGrid');
    if (!bg) return;
    bg.classList.toggle('has-panels', bg.querySelectorAll('.panel').length > 0);
  }

  private wasUltraWide = window.innerWidth >= 1600;

  public ensureCorrectZones(): void {
    const isUltraWide = window.innerWidth >= 1600;
    const mapSection = document.getElementById('mapSection');
    const mapEnabled = !mapSection?.classList.contains('hidden');
    const effectiveUltraWide = isUltraWide && mapEnabled;

    if (effectiveUltraWide === this.wasUltraWide) return;
    this.wasUltraWide = effectiveUltraWide;

    const grid = document.getElementById('panelsGrid');
    const bottomGrid = document.getElementById('mapBottomGrid');
    if (!grid || !bottomGrid) return;

    if (!effectiveUltraWide) {
      // Move everything from bottom grid back to panels grid in correct order
      const panelsInBottom = Array.from(bottomGrid.querySelectorAll('.panel')) as HTMLElement[];
      const savedOrder = this.getSavedPanelOrder();
      const defaultOrder = Object.keys(DEFAULT_PANELS).filter(k => k !== 'map');

      panelsInBottom.forEach(panelEl => {
        const id = panelEl.dataset.panel;
        if (!id) return;

        // Use saved sidebar order if present, otherwise default order
        const searchOrder = savedOrder.includes(id) ? savedOrder : defaultOrder;
        const pos = searchOrder.indexOf(id);

        if (pos === -1) {
          grid.appendChild(panelEl);
          return;
        }

        // Find the first panel in searchOrder AFTER this one that is currently in the sidebar grid
        let inserted = false;
        for (let i = pos + 1; i < searchOrder.length; i++) {
          const nextId = searchOrder[i];
          const nextEl = grid.querySelector(`[data-panel="${nextId}"]`);
          if (nextEl) {
            grid.insertBefore(panelEl, nextEl);
            inserted = true;
            break;
          }
        }

        if (!inserted) {
          grid.appendChild(panelEl);
        }
      });
    } else {
      // Move panels that belong to bottom zone from sidebar to bottom grid
      const savedBottomOrder = this.getSavedBottomPanelOrder();
      savedBottomOrder.forEach(id => {
        const el = grid.querySelector(`[data-panel="${id}"]`);
        if (el) {
          bottomGrid.appendChild(el);
        }
      });
    }
    this.syncBottomGridVisibility();
  }

  private attachRelatedAssetHandlers(panel: NewsPanel): void {
    panel.setRelatedAssetHandlers({
      onRelatedAssetClick: (asset) => this.handleRelatedAssetClick(asset),
      onRelatedAssetsFocus: (assets) => this.ctx.map?.highlightAssets(assets),
      onRelatedAssetsClear: () => this.ctx.map?.highlightAssets(null),
    });
  }

  private handleRelatedAssetClick(asset: RelatedAsset): void {
    if (!this.ctx.map) return;

    switch (asset.type) {
      case 'pipeline':
        this.ctx.map.enableLayer('pipelines');
        this.ctx.mapLayers.pipelines = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerPipelineClick(asset.id);
        break;
      case 'cable':
        this.ctx.map.enableLayer('cables');
        this.ctx.mapLayers.cables = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerCableClick(asset.id);
        break;
      case 'datacenter':
        this.ctx.map.enableLayer('datacenters');
        this.ctx.mapLayers.datacenters = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerDatacenterClick(asset.id);
        break;
      case 'base':
        this.ctx.map.enableLayer('bases');
        this.ctx.mapLayers.bases = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerBaseClick(asset.id);
        break;
      case 'nuclear':
        this.ctx.map.enableLayer('nuclear');
        this.ctx.mapLayers.nuclear = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerNuclearClick(asset.id);
        break;
    }
  }

  private makeDraggable(el: HTMLElement, key: string): void {
    el.dataset.panel = key;
    let isDragging = false;
    let dragStarted = false;
    let startX = 0;
    let startY = 0;
    let rafId = 0;
    const DRAG_THRESHOLD = 8;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (el.dataset.resizing === 'true') return;
      if (
        target.classList?.contains('panel-resize-handle') ||
        target.closest?.('.panel-resize-handle') ||
        target.classList?.contains('panel-col-resize-handle') ||
        target.closest?.('.panel-col-resize-handle')
      ) return;
      if (target.closest('button, a, input, select, textarea, .panel-content')) return;

      isDragging = true;
      dragStarted = false;
      startX = e.clientX;
      startY = e.clientY;
      e.preventDefault();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      if (!dragStarted) {
        const dx = Math.abs(e.clientX - startX);
        const dy = Math.abs(e.clientY - startY);
        if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
        dragStarted = true;
        el.classList.add('dragging');
        document.getElementById('mapBottomGrid')?.classList.add('drag-target-active');
      }
      const cx = e.clientX;
      const cy = e.clientY;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        this.handlePanelDragMove(el, cx, cy);
        rafId = 0;
      });
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (dragStarted) {
        el.classList.remove('dragging');
        document.getElementById('mapBottomGrid')?.classList.remove('drag-target-active');
        this.savePanelOrder();
      }
      dragStarted = false;
    };

    el.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    this.panelDragCleanupHandlers.push(() => {
      el.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      isDragging = false;
      dragStarted = false;
      el.classList.remove('dragging');
      document.getElementById('mapBottomGrid')?.classList.remove('drag-target-active');
    });
  }

  private handlePanelDragMove(dragging: HTMLElement, clientX: number, clientY: number): void {
    const grid = document.getElementById('panelsGrid');
    const bottomGrid = document.getElementById('mapBottomGrid');
    if (!grid || !bottomGrid) return;

    dragging.style.pointerEvents = 'none';
    const target = document.elementFromPoint(clientX, clientY);
    dragging.style.pointerEvents = '';

    if (!target) return;

    // Check if we are over a grid or a panel inside a grid
    const targetGrid = (target.closest('.panels-grid') || target.closest('.map-bottom-grid')) as HTMLElement | null;
    const targetPanel = target.closest('.panel') as HTMLElement | null;

    if (!targetGrid && !targetPanel) return;

    const currentTargetGrid = targetGrid || (targetPanel ? targetPanel.parentElement as HTMLElement : null);
    if (!currentTargetGrid || (currentTargetGrid !== grid && currentTargetGrid !== bottomGrid)) return;

    if (targetPanel && targetPanel !== dragging && !targetPanel.classList.contains('hidden')) {
      const targetRect = targetPanel.getBoundingClientRect();
      const draggingRect = dragging.getBoundingClientRect();

      const children = Array.from(currentTargetGrid.children);
      const dragIdx = children.indexOf(dragging);
      const targetIdx = children.indexOf(targetPanel);

      const sameRow = Math.abs(draggingRect.top - targetRect.top) < 30;
      const targetMid = sameRow
        ? targetRect.left + targetRect.width / 2
        : targetRect.top + targetRect.height / 2;
      const cursorPos = sameRow ? clientX : clientY;

      if (dragIdx === -1) {
        // Moving from one grid to another
        if (cursorPos < targetMid) {
          currentTargetGrid.insertBefore(dragging, targetPanel);
        } else {
          currentTargetGrid.insertBefore(dragging, targetPanel.nextSibling);
        }
      } else {
        // Reordering within same grid
        if (dragIdx < targetIdx) {
          if (cursorPos > targetMid) {
            currentTargetGrid.insertBefore(dragging, targetPanel.nextSibling);
          }
        } else {
          if (cursorPos < targetMid) {
            currentTargetGrid.insertBefore(dragging, targetPanel);
          }
        }
      }
    } else if (currentTargetGrid !== dragging.parentElement) {
      // Dragging over an empty or near-empty grid zone
      currentTargetGrid.appendChild(dragging);
    }
  }

  getLocalizedPanelName(panelKey: string, fallback: string): string {
    if (panelKey === 'runtime-config') {
      return t('modals.runtimeConfig.title');
    }
    const key = panelKey.replace(/-([a-z])/g, (_match, group: string) => group.toUpperCase());
    const lookup = `panels.${key}`;
    const localized = t(lookup);
    return localized === lookup ? fallback : localized;
  }

  getAllSourceNames(): string[] {
    const sources = new Set<string>();
    Object.values(FEEDS).forEach(feeds => {
      if (feeds) feeds.forEach(f => sources.add(f.name));
    });
    INTEL_SOURCES.forEach(f => sources.add(f.name));
    return Array.from(sources).sort((a, b) => a.localeCompare(b));
  }
}

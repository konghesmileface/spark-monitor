import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { openPolicyDrawer } from './PolicyDetailDrawer';
import { cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';
const POLL_INTERVAL = 600_000; // 600s = 10min

interface RelatedStock {
  code: string;
  name: string;
  change?: number;
}

interface HotEvent {
  id: string;
  title: string;
  keywords: string[];
  impact: 'high' | 'medium' | 'low';
  relatedStocks: RelatedStock[];
  summary?: string;
  timeline?: string[];
  source?: string;
  timestamp: string;
  type?: 'market' | 'social' | 'system' | 'db-news';
  url?: string;
  engagement?: number;
  emotion?: string;
}

interface CnHotEventsData {
  events: HotEvent[];
  timestamp: string;
}

function impactColor(impact: string): string {
  switch (impact) {
    case 'high': return '#e53935';
    case 'medium': return '#ff9800';
    case 'low': return '#2196f3';
    default: return '#9e9e9e';
  }
}

function impactLabel(impact: string): string {
  switch (impact) {
    case 'high': return '高影响';
    case 'medium': return '中影响';
    case 'low': return '低影响';
    default: return '未知';
  }
}

function typeIcon(type?: string): string {
  switch (type) {
    case 'market': return '<i class="bi bi-graph-up" style="color:#ff9800"></i>';
    case 'social': return '<i class="bi bi-chat-dots" style="color:#2196f3"></i>';
    case 'db-news': return '<i class="bi bi-newspaper" style="color:#64B5F6"></i>';
    default: return '<i class="bi bi-lightning" style="color:#9e9e9e"></i>';
  }
}

function formatEngagement(n?: number): string {
  if (!n) return '';
  if (n >= 10000000) return `${(n / 10000000).toFixed(1)}千万`;
  if (n >= 10000) return `${(n / 10000).toFixed(0)}万`;
  return n.toLocaleString();
}

function cnChangeClass(val: number): string {
  if (val > 0) return 'cn-evt-up';
  if (val < 0) return 'cn-evt-down';
  return 'cn-evt-flat';
}

function formatPercent(val: number): string {
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}

const STYLE = `
<style>
@layer base {
.cn-hot-events-container {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cn-event-card {
  background: rgba(255,255,255,0.02);
  border-radius: 8px;
  padding: 10px 12px;
  border-left: 3px solid var(--border);
  transition: border-color 0.2s;
}
.cn-event-card.impact-high { border-left-color: #e53935; }
.cn-event-card.impact-medium { border-left-color: #ff9800; }
.cn-event-card.impact-low { border-left-color: #2196f3; }
.cn-event-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.cn-event-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.4;
  flex: 1;
}
.cn-event-impact-badge {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}
.cn-event-keywords {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.cn-event-keyword {
  padding: 1px 8px;
  font-size: 10px;
  border-radius: 10px;
  background: rgba(255,255,255,0.06);
  color: var(--text-dim);
  white-space: nowrap;
}
.cn-event-summary {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.5;
  margin-bottom: 6px;
}
.cn-event-stocks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
}
.cn-event-stock {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 4px;
  background: rgba(255,255,255,0.04);
  font-variant-numeric: tabular-nums;
}
.cn-event-stock-name {
  font-weight: 500;
  color: var(--text);
}
.cn-event-stock-code {
  color: var(--text-dim);
  opacity: 0.7;
}
.cn-evt-up { color: #e53935; }
.cn-evt-down { color: #43a047; }
.cn-evt-flat { color: var(--text-dim); }
.cn-event-timeline {
  margin-top: 6px;
  padding-left: 12px;
  border-left: 2px solid rgba(255,255,255,0.06);
}
.cn-event-timeline-item {
  font-size: 11px;
  color: var(--text-dim);
  padding: 2px 0;
  position: relative;
}
.cn-event-timeline-item::before {
  content: '';
  position: absolute;
  left: -16px;
  top: 7px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255,255,255,0.15);
}
.cn-event-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 10px;
  color: var(--text-dim);
  opacity: 0.6;
}
.cn-events-empty {
  text-align: center;
  padding: 24px;
  color: var(--text-dim);
  font-size: 13px;
}
.cn-event-type-icon {
  margin-right: 4px;
  font-size: 12px;
}
.cn-event-title a {
  color: inherit;
  text-decoration: none;
}
.cn-event-title a:hover {
  text-decoration: underline;
  color: var(--accent, #E8A838);
}
.cn-event-engagement {
  font-size: 10px;
  color: var(--text-dim);
  opacity: 0.7;
  margin-left: 4px;
}
.cn-event-card.type-social {
  background: rgba(33,150,243,0.03);
}
.cn-event-card.type-market {
  background: rgba(255,255,255,0.02);
}
.cn-events-section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 4px 0 2px;
  margin-top: 4px;
}
.cn-event-card.type-db-news {
  background: rgba(100,181,246,0.03);
}
.cn-events-filter-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  margin-bottom: 10px;
}
.cn-events-filter-tab {
  padding: 6px 14px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-dim);
  cursor: pointer;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  transition: all 0.15s;
}
.cn-events-filter-tab:hover { color: var(--text); }
.cn-events-filter-tab.active {
  color: #e8a838;
  border-bottom-color: #e8a838;
}
.cn-events-stale-notice {
  font-size: 11px;
  color: var(--text-dim);
  background: rgba(255,152,0,0.08);
  border: 1px solid rgba(255,152,0,0.15);
  border-radius: 6px;
  padding: 4px 10px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.cn-events-stale-notice i { color: #ff9800; font-size: 12px; }
} /* @layer base */
</style>
`;

export class CnHotEventsPanel extends Panel {
  private timer: ReturnType<typeof setInterval> | null = null;
  private data: CnHotEventsData | null = null;
  private activeFilter: 'news' | 'market' = 'news';
  private seenEventIds = new Set<string>();
  private lastFetchTime = 0;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;
  private retryAttempt = 0;

  constructor() {
    super({ id: 'cn-hot-events', title: '热点事件 <span class="spark-subtitle">HOT EVENTS</span>' });
    this.content.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest('.cn-events-filter-tab') as HTMLElement | null;
      if (tab?.dataset.filter) {
        this.activeFilter = tab.dataset.filter as 'news' | 'market';
        this.renderPanel();
        return;
      }
      // New items badge click → clear and re-render
      const badge = (e.target as HTMLElement).closest('.cn-new-items-badge') as HTMLElement | null;
      if (badge) {
        this.seenEventIds = new Set((this.data?.events || []).map(ev => ev.id));
        this.renderPanel();
        return;
      }
      // Event card click → open drawer
      const card = (e.target as HTMLElement).closest('.cn-event-card[data-event-clickable]') as HTMLElement | null;
      if (card) {
        // Don't intercept if clicking a link directly
        if ((e.target as HTMLElement).closest('a')) return;
        openPolicyDrawer({
          title: card.dataset.eventTitle || '',
          url: card.dataset.eventUrl || '',
          date: card.dataset.eventTimestamp || '',
          source: card.dataset.eventSource || '',
          category: '热点',
          icon: 'bi-fire',
          dbNewsId: card.dataset.eventDbid || undefined,
        });
      }
    });
    void this.fetchData();
    this.timer = setInterval(() => void this.fetchData(), POLL_INTERVAL);
    this.freshnessTimer = setInterval(() => this.updateFreshness(), 30_000);
  }

  public async fetchData(): Promise<void> {
    if (!this.data) this.showLoading('加载热点事件...');
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/hot-events`, { signal: this.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json();
      this.retryAttempt = 0;
      this.lastFetchTime = Date.now();
      if ((this.data as any)?._stale) {
        this.setDataBadge('cached', '数据可能过时');
      } else {
        this.updateFreshness();
      }
      this.renderPanel();
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      if (this.retryAttempt < 3) {
        this.retryAttempt++;
        this.showRetrying(`加载热点事件...重试 ${this.retryAttempt}/3`);
        setTimeout(() => void this.fetchData(), 15_000);
        return;
      }
      this.showError('热点事件数据加载失败');
    }
  }

  private renderPanel(): void {
    if (!this.data) {
      this.showError('暂无数据');
      return;
    }

    const events = this.data.events || [];

    if (events.length === 0) {
      this.setContent(`${STYLE}<div class="cn-events-empty">暂无热点事件</div>`);
      return;
    }

    // Track new events
    const allIds = new Set(events.map(e => e.id));
    const newEventIds = this.seenEventIds.size > 0
      ? new Set(events.filter(e => !this.seenEventIds.has(e.id)).map(e => e.id))
      : new Set<string>();
    const newCount = newEventIds.size;
    this.seenEventIds = allIds;

    // Separate by type
    const dbNewsEvents = events.filter(e => e.type === 'db-news');
    const socialEvents = events.filter(e => e.type === 'social');
    const marketEvents = events.filter(e => e.type === 'market');

    // Filter tabs
    const newsCount = dbNewsEvents.length + socialEvents.length;
    const marketCount = marketEvents.length;
    const filterTabsHtml = `<div class="cn-events-filter-tabs">
      <button class="cn-events-filter-tab ${this.activeFilter === 'news' ? 'active' : ''}" data-filter="news">新闻热点 (${newsCount})</button>
      <button class="cn-events-filter-tab ${this.activeFilter === 'market' ? 'active' : ''}" data-filter="market">市场概念 (${marketCount})</button>
    </div>`;

    const renderEvent = (evt: HotEvent) => {
      const color = impactColor(evt.impact);
      const label = impactLabel(evt.impact);
      const icon = typeIcon(evt.type);
      const typeClass = evt.type ? `type-${evt.type}` : '';

      const keywordsHtml = (evt.keywords || []).map(kw =>
        `<span class="cn-event-keyword">${escapeHtml(kw)}</span>`
      ).join('');

      const summaryHtml = evt.summary
        ? `<div class="cn-event-summary">${escapeHtml(evt.summary)}</div>`
        : '';

      const stocksHtml = (evt.relatedStocks || []).map(s => {
        const changeHtml = s.change !== undefined && s.change !== null
          ? `<span class="${cnChangeClass(s.change)}">${formatPercent(s.change)}</span>`
          : '';
        return `
          <span class="cn-event-stock">
            <span class="cn-event-stock-name">${escapeHtml(s.name)}</span>
            <span class="cn-event-stock-code">${escapeHtml(s.code)}</span>
            ${changeHtml}
          </span>
        `;
      }).join('');

      const timelineHtml = evt.timeline && evt.timeline.length > 0
        ? `<div class="cn-event-timeline">
            ${evt.timeline.map(t => `<div class="cn-event-timeline-item">${escapeHtml(t)}</div>`).join('')}
          </div>`
        : '';

      // Title: clickable for social events with URL
      const titleContent = evt.url
        ? `<a href="${escapeHtml(evt.url)}" target="_blank" rel="noopener">${escapeHtml(evt.title)}</a>`
        : escapeHtml(evt.title);

      const engagementHtml = evt.engagement
        ? `<span class="cn-event-engagement">${formatEngagement(evt.engagement)}热度</span>`
        : '';

      const metaHtml = evt.source || evt.timestamp
        ? `<div class="cn-event-meta">
            ${evt.source ? `<span>${escapeHtml(evt.source)}</span>` : ''}
            ${engagementHtml}
            ${evt.timestamp ? `<span>${escapeHtml(evt.timestamp)}</span>` : ''}
          </div>`
        : '';

      // Make card clickable if it has a URL or is a db-news item
      const isDbNews = evt.type === 'db-news';
      const dbId = isDbNews && evt.id ? evt.id.replace('dbnews_', '') : '';
      const isClickable = evt.url || isDbNews;
      const cardAttrs = isClickable
        ? ` data-event-clickable="1" data-event-url="${escapeHtml(evt.url || '')}" data-event-title="${escapeHtml(evt.title)}" data-event-source="${escapeHtml(evt.source || '')}" data-event-timestamp="${escapeHtml(evt.timestamp || '')}"${dbId ? ` data-event-dbid="${escapeHtml(dbId)}"` : ''} style="cursor:pointer"`
        : '';

      const isNewItem = newEventIds.has(evt.id);
      return `
        <div class="cn-event-card impact-${evt.impact} ${typeClass}${isNewItem ? ' spark-new-item' : ''}"${cardAttrs}>
          <div class="cn-event-header">
            <span class="cn-event-title"><span class="cn-event-type-icon">${icon}</span>${titleContent}</span>
            <span class="cn-event-impact-badge" style="background:${color}15;color:${color}">${label}</span>
          </div>
          ${keywordsHtml ? `<div class="cn-event-keywords">${keywordsHtml}</div>` : ''}
          ${summaryHtml}
          ${stocksHtml ? `<div class="cn-event-stocks">${stocksHtml}</div>` : ''}
          ${timelineHtml}
          ${metaHtml}
        </div>
      `;
    };

    // Show stale notice if social events came from Redis snapshot
    const hasStaleSocial = socialEvents.some(e => (e as any)._stale);

    const parts: string[] = [];
    if (this.activeFilter === 'news') {
      if (hasStaleSocial) {
        parts.push('<div class="cn-events-stale-notice"><i class="bi bi-clock-history"></i> 社交热搜为缓存数据，可能不是最新</div>');
      }
      // Show DB news + social hot search
      if (dbNewsEvents.length > 0) {
        parts.push('<div class="cn-events-section-label"><i class="bi bi-newspaper"></i> 要闻快讯</div>');
        parts.push(...dbNewsEvents.map(renderEvent));
      }
      if (socialEvents.length > 0) {
        parts.push('<div class="cn-events-section-label"><i class="bi bi-chat-dots"></i> 社会热搜</div>');
        parts.push(...socialEvents.map(renderEvent));
      }
      if (dbNewsEvents.length === 0 && socialEvents.length === 0) {
        parts.push('<div class="cn-events-empty">暂无新闻热点</div>');
      }
    } else {
      // Show market concept events
      if (marketEvents.length > 0) {
        parts.push('<div class="cn-events-section-label"><i class="bi bi-graph-up"></i> 市场概念</div>');
        parts.push(...marketEvents.map(renderEvent));
      } else {
        parts.push('<div class="cn-events-empty"><i class="bi bi-graph-up" style="font-size:20px;display:block;margin-bottom:6px;color:#444"></i>暂无市场概念数据<div style="font-size:10px;color:#555;margin-top:4px">概念板块数据来自东方财富，交易时段(9:30-15:00)更新</div></div>');
      }
    }
    const eventsHtml = parts.join('');
    const badgeHtml = newCount > 0
      ? `<div class="cn-new-items-badge"><i class="bi bi-bell"></i> ${newCount}条新事件</div>`
      : '';

    this.setContent(`${STYLE}
      <div class="cn-hot-events-container">${filterTabsHtml}${badgeHtml}${eventsHtml}</div>
    `);
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

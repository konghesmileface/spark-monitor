import { Panel } from './Panel';
import { sanitizeUrl } from '@/utils/sanitize';
import { t } from '@/services/i18n';
import { h } from '@/utils/dom-utils';
import {
  getIntelTopics,
  fetchTopicIntelligence,
  formatArticleDate,
  extractDomain,
  type GdeltArticle,
  type IntelTopic,
  type TopicIntelligence,
} from '@/services/gdelt-intel';

export class GdeltIntelPanel extends Panel {
  private activeTopic: IntelTopic = getIntelTopics()[0]!;
  private topicData = new Map<string, TopicIntelligence>();
  private loadGen = 0; // cancellation token: incremented on each tab switch

  constructor() {
    super({
      id: 'gdelt-intel',
      title: t('panels.gdeltIntel'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.gdeltIntel.infoTooltip'),
    });

    // Event delegation on content — same pattern as EconomicPanel / CryptoOverviewPanel
    this.content.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest('.gdelt-intel-tab') as HTMLElement | null;
      if (tab?.dataset.topicId) {
        const topicId = tab.dataset.topicId;
        if (topicId === this.activeTopic.id) return;
        const topic = getIntelTopics().find(t => t.id === topicId);
        if (topic) {
          this.activeTopic = topic;
          // Use cached data if available for instant switch
          const cached = this.topicData.get(topic.id);
          if (cached && cached.articles.length > 0) {
            this.loadGen++;
            this.renderArticles(cached.articles);
            this.setCount(cached.articles.length);
          } else {
            this.loadActiveTopic();
          }
        }
      }
    });

    this.loadActiveTopic();
  }

  private buildTabsHtml(): string {
    const topics = getIntelTopics();
    const tabs = topics.map(topic => {
      const active = topic.id === this.activeTopic.id ? 'active' : '';
      return `<button class="gdelt-intel-tab ${active}" data-topic-id="${topic.id}" title="${topic.description}">
        <span class="tab-icon">${topic.icon}</span>
        <span class="tab-label">${topic.name}</span>
      </button>`;
    }).join('');

    return `<div class="gdelt-intel-tabs">${tabs}</div>`;
  }

  private async loadActiveTopic(): Promise<void> {
    const gen = ++this.loadGen; // cancel any previous in-flight load
    const topic = this.activeTopic;

    // Show tabs + loading state
    this.content.innerHTML = this.buildTabsHtml() +
      `<div class="panel-loading"><div class="panel-loading-radar"><div class="panel-radar-sweep"></div><div class="panel-radar-dot"></div></div><div class="panel-loading-text">${t('common.loading')}</div></div>`;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await fetchTopicIntelligence(topic);
        if (gen !== this.loadGen) return; // stale — user switched tab
        if (!this.element?.isConnected) return;
        this.topicData.set(topic.id, data);

        if (data.articles.length === 0 && attempt < 2) {
          this.content.innerHTML = this.buildTabsHtml() +
            `<div class="panel-loading"><div class="panel-loading-radar"><div class="panel-radar-sweep"></div><div class="panel-radar-dot"></div></div><div class="panel-loading-text">${t('common.retrying')}</div></div>`;
          await new Promise(r => setTimeout(r, 15_000));
          if (gen !== this.loadGen) return; // stale
          if (!this.element?.isConnected) return;
          continue;
        }

        this.renderArticles(data.articles);
        this.setCount(data.articles.length);
        return;
      } catch (error) {
        if (this.isAbortError(error)) return;
        if (gen !== this.loadGen) return; // stale
        if (!this.element?.isConnected) return;
        console.error(`[GdeltIntelPanel] Load error (attempt ${attempt + 1}):`, error);
        if (attempt < 2) {
          this.content.innerHTML = this.buildTabsHtml() +
            `<div class="panel-loading"><div class="panel-loading-radar"><div class="panel-radar-sweep"></div><div class="panel-radar-dot"></div></div><div class="panel-loading-text">${t('common.retrying')}</div></div>`;
          await new Promise(r => setTimeout(r, 15_000));
          if (gen !== this.loadGen) return; // stale
          if (!this.element?.isConnected) return;
          continue;
        }
        this.content.innerHTML = this.buildTabsHtml() +
          `<div class="error-message">${t('common.failedIntelFeed')}</div>`;
      }
    }
  }

  private renderArticles(articles: GdeltArticle[]): void {
    const tabsHtml = this.buildTabsHtml();

    if (articles.length === 0) {
      this.content.innerHTML = tabsHtml +
        `<div class="empty-state">${t('components.gdelt.empty')}</div>`;
      return;
    }

    // Build articles with h() for proper sanitization
    const articlesContainer = h('div', { className: 'gdelt-intel-articles' },
      ...articles.map(article => this.buildArticle(article)),
    );

    // Set tabs HTML first, then append articles DOM
    this.content.innerHTML = tabsHtml;
    this.content.appendChild(articlesContainer);
  }

  private buildArticle(article: GdeltArticle): HTMLElement {
    const domain = article.source || extractDomain(article.url);
    const timeAgo = formatArticleDate(article.date);
    const toneClass = article.tone ? (article.tone < -2 ? 'tone-negative' : article.tone > 2 ? 'tone-positive' : '') : '';

    return h('a', {
      href: sanitizeUrl(article.url),
      target: '_blank',
      rel: 'noopener',
      className: `gdelt-intel-article ${toneClass}`.trim(),
    },
      h('div', { className: 'article-header' },
        h('span', { className: 'article-source' }, domain),
        h('span', { className: 'article-time' }, timeAgo),
      ),
      h('div', { className: 'article-title' }, article.title),
    );
  }

  public async refresh(): Promise<void> {
    await this.loadActiveTopic();
  }

  public async refreshAll(): Promise<void> {
    this.topicData.clear(); // force re-fetch on next tab switch too
    await this.loadActiveTopic();
  }
}

import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';
const POLL_INTERVAL = 21_600_000; // 21600s = 6h

interface BriefEntity {
  id: string;
  name: string;
  type: 'stock' | 'index' | 'sector' | 'policy_body';
  code: string;
  sector: string;
}

interface CnBriefData {
  sections: BriefSection[];
  generatedAt: string;
  timestamp: string;
  mentionedEntities?: BriefEntity[];
}

interface BriefSection {
  title: string;
  content: string;
  entities?: BriefEntity[];
}

/** Convert markdown to sanitized HTML using marked library. */
function markdownToHtml(md: string): string {
  if (!md) return '';
  // Pre-process: unescape \* (AI sometimes escapes asterisks) and strip stray ## headers inside content
  let cleaned = md.replace(/\\([*_~`])/g, '$1');
  const raw = marked.parse(cleaned, { async: false }) as string;
  let html = DOMPurify.sanitize(raw);
  // Post-process: catch any surviving **text** that marked didn't convert
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return html;
}

/** Titles that indicate a preamble section (should not be displayed) */
const PREAMBLE_TITLES = ['投资简报', '每日投资简报', '每日简报', '简报'];

function formatTimestamp(ts: string): string {
  if (!ts) return '';
  try {
    const date = new Date(ts);
    if (isNaN(date.getTime())) return ts;
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${month}-${day} ${hours}:${minutes}`;
  } catch {
    return ts;
  }
}

const ENTITY_TYPE_ICONS: Record<string, string> = {
  stock: 'bi-graph-up',
  index: 'bi-bar-chart-line',
  sector: 'bi-diagram-3',
  policy_body: 'bi-bank',
};

const SECTION_ICONS: Record<string, string> = {
  // New 3-perspective layout
  '一、市场行情': '<i class="bi bi-graph-up" style="color:#e53935"></i>',
  '二、热点聚焦': '<i class="bi bi-fire" style="color:#FF9800"></i>',
  '三、政策风向': '<i class="bi bi-bank" style="color:#5C6BC0"></i>',
  '综合研判': '<i class="bi bi-bullseye" style="color:#e8a838"></i>',
  // Legacy fallback
  '市场回顾': '<i class="bi bi-graph-up"></i>',
  '热点解读': '<i class="bi bi-fire"></i>',
  '风险提示': '<i class="bi bi-exclamation-triangle"></i>',
  '明日展望': '<i class="bi bi-binoculars"></i>',
};

const STYLE = `
<style>
@layer base {
.cn-brief-container {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.cn-brief-header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0 10px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  margin-bottom: 10px;
}
.cn-brief-timestamp {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.cn-brief-refresh-btn {
  padding: 4px 12px;
  font-size: 11px;
  border-radius: 6px;
  background: rgba(229,57,53,0.1);
  color: #e53935;
  border: 1px solid rgba(229,57,53,0.2);
  cursor: pointer;
  transition: all 0.15s;
  font-weight: 500;
}
.cn-brief-refresh-btn:hover {
  background: rgba(229,57,53,0.2);
}
.cn-brief-refresh-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.cn-pdf-export-btn {
  padding: 4px 12px;
  font-size: 11px;
  border-radius: 6px;
  background: rgba(255,255,255,0.05);
  color: var(--text-dim);
  border: 1px solid rgba(255,255,255,0.08);
  cursor: pointer;
  transition: all 0.15s;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.cn-pdf-export-btn:hover {
  background: rgba(255,255,255,0.1);
  color: var(--text);
}
.cn-brief-copy-btn {
  padding: 4px 12px;
  font-size: 11px;
  border-radius: 6px;
  background: rgba(255,255,255,0.05);
  color: var(--text-dim);
  border: 1px solid rgba(255,255,255,0.08);
  cursor: pointer;
  transition: all 0.15s;
  font-weight: 500;
}
.cn-brief-copy-btn:hover {
  background: rgba(255,255,255,0.1);
  color: var(--text);
}
.cn-brief-copy-btn.copied {
  background: rgba(67,160,71,0.15);
  color: #43a047;
  border-color: rgba(67,160,71,0.3);
}
.cn-brief-section {
  margin-bottom: 18px;
  padding-left: 10px;
  border-left: 2px solid rgba(255,255,255,0.06);
}
.cn-brief-section[data-dim="market"] { border-left-color: rgba(229,57,53,0.4); }
.cn-brief-section[data-dim="hot"] { border-left-color: rgba(255,152,0,0.4); }
.cn-brief-section[data-dim="policy"] { border-left-color: rgba(92,107,192,0.4); }
.cn-brief-section[data-dim="summary"] { border-left-color: rgba(232,168,56,0.4); }
.cn-brief-section-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  display: flex;
  align-items: center;
  gap: 6px;
}
.cn-brief-section-icon {
  font-size: 14px;
}
.cn-brief-section-body {
  font-size: 13px;
  color: var(--text);
  line-height: 1.8;
  opacity: 0.9;
}
.cn-brief-section-body h1,
.cn-brief-section-body h2 {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin: 10px 0 4px;
}
.cn-brief-section-body h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 8px 0 4px;
}
.cn-brief-section-body h4 {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  margin: 6px 0 3px;
}
.cn-brief-section-body p {
  margin: 4px 0;
}
.cn-brief-section-body ul,
.cn-brief-section-body ol {
  margin: 4px 0;
  padding-left: 20px;
}
.cn-brief-section-body li {
  margin: 2px 0;
  line-height: 1.6;
}
.cn-brief-section-body hr {
  border: none;
  border-top: 1px solid rgba(255,255,255,0.08);
  margin: 10px 0;
}
.cn-brief-section-body strong {
  color: var(--text);
  font-weight: 600;
}
.cn-brief-section-body em {
  opacity: 0.85;
}
.cn-brief-empty {
  text-align: center;
  padding: 24px;
  color: var(--text-dim);
  font-size: 13px;
}
.cn-brief-skeleton {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 0;
}
.cn-brief-skel-line {
  height: 12px;
  border-radius: 4px;
  background: linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%);
  background-size: 200% 100%;
  animation: skel-shimmer 1.5s ease infinite;
}
.cn-brief-skel-line:nth-child(1) { width: 60%; }
.cn-brief-skel-line:nth-child(2) { width: 90%; }
.cn-brief-skel-line:nth-child(3) { width: 75%; }
.cn-brief-skel-line:nth-child(4) { width: 85%; }
.cn-brief-skel-line:nth-child(5) { width: 50%; }
@keyframes skel-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
/* ---- Entity chips ---- */
.cn-brief-entities {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255,255,255,0.04);
}
.cn-brief-entity-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  font-size: 10px;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  border: 1px solid transparent;
}
.cn-brief-entity-chip:hover { filter: brightness(1.3); }
.cn-brief-entity-chip i { font-size: 9px; }
.cn-brief-entity-chip[data-etype="stock"] { background: rgba(229,57,53,0.1); color: #ef5350; border-color: rgba(229,57,53,0.15); }
.cn-brief-entity-chip[data-etype="index"] { background: rgba(232,168,56,0.1); color: #e8a838; border-color: rgba(232,168,56,0.15); }
.cn-brief-entity-chip[data-etype="sector"] { background: rgba(33,150,243,0.1); color: #64B5F6; border-color: rgba(33,150,243,0.15); }
.cn-brief-entity-chip[data-etype="policy_body"] { background: rgba(171,71,188,0.1); color: #CE93D8; border-color: rgba(171,71,188,0.15); }
/* ---- Mentioned entities bar (top) ---- */
.cn-brief-mentioned-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 0 8px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  margin-bottom: 10px;
}
.cn-brief-mentioned-bar .cn-brief-mentioned-label {
  font-size: 10px;
  color: var(--text-dim);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 3px;
  margin-right: 4px;
}
.cn-brief-mentioned-bar .cn-brief-mentioned-label i { font-size: 11px; }
} /* @layer base */
</style>
`;

export class CnBriefPanel extends Panel {
  private timer: ReturnType<typeof setInterval> | null = null;
  private data: CnBriefData | null = null;
  private refreshing = false;
  private lastFetchTime = 0;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;
  private retryAttempt = 0;

  constructor() {
    super({ id: 'cn-brief', title: 'AI投资简报 <span class="spark-subtitle">DAILY BRIEF</span>' });
    this.content.addEventListener('click', (e) => {
      const refreshBtn = (e.target as HTMLElement).closest('.cn-brief-refresh-btn') as HTMLElement | null;
      if (refreshBtn && !this.refreshing) {
        void this.refreshBrief();
      }
      const copyBtn = (e.target as HTMLElement).closest('.cn-brief-copy-btn') as HTMLElement | null;
      if (copyBtn) {
        void this.copyBrief(copyBtn);
      }
      const entityChip = (e.target as HTMLElement).closest('.cn-brief-entity-chip') as HTMLElement | null;
      if (entityChip?.dataset.entityName) {
        window.dispatchEvent(new CustomEvent('cn-entity-click', {
          detail: { name: entityChip.dataset.entityName, type: entityChip.dataset.entityType || 'stock' },
        }));
      }
    });
    this.showSkeleton();
    void this.fetchData();
    this.timer = setInterval(() => void this.fetchData(), POLL_INTERVAL);
    this.freshnessTimer = setInterval(() => this.updateFreshness(), 30_000);
  }

  private showSkeleton(): void {
    this.setContent(`${STYLE}
      <div class="cn-brief-skeleton">
        <div class="cn-brief-skel-line"></div>
        <div class="cn-brief-skel-line"></div>
        <div class="cn-brief-skel-line"></div>
        <div class="cn-brief-skel-line"></div>
        <div class="cn-brief-skel-line"></div>
      </div>
    `);
  }

  public async fetchData(): Promise<void> {
    this.showLoading('加载AI投资简报...');
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/brief`, { signal: this.signal });
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
        this.showRetrying(`加载AI投资简报...重试 ${this.retryAttempt}/3`);
        setTimeout(() => void this.fetchData(), 8_000);
        return;
      }
      this.showError('AI投资简报加载失败');
    }
  }

  private async refreshBrief(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.renderPanel(); // Update button state

    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/brief`, {
        method: 'GET',
        headers: { 'X-Force-Refresh': 'true' },
        signal: this.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json();
    } catch (err) {
      if (this.isAbortError(err)) return;
      // Keep old data, just show the panel
    } finally {
      this.refreshing = false;
      this.renderPanel();
    }
  }

  private renderPanel(): void {
    if (!this.data) {
      this.showError('暂无数据');
      return;
    }

    const d = this.data;
    const sections = d.sections || [];

    if (sections.length === 0) {
      this.setContent(`${STYLE}<div class="cn-brief-empty">简报尚未生成</div>`);
      return;
    }

    // Support both new 3-perspective and legacy 4-section format
    const newSections = ['一、市场行情', '二、热点聚焦', '三、政策风向', '综合研判'];
    const legacySections = ['市场回顾', '热点解读', '风险提示', '明日展望'];
    const isNewFormat = sections.some(s => s.title.startsWith('一、') || s.title.startsWith('二、'));
    const preferredOrder = isNewFormat ? newSections : legacySections;
    const orderedSections = preferredOrder
      .map(title => sections.find(s => s.title === title))
      .filter((s): s is BriefSection => !!s);
    // Include any sections not in default order, filtering out preamble sections
    const remaining = sections.filter(s => {
      if (preferredOrder.includes(s.title)) return false;
      // Filter out preamble sections (AI sometimes adds **每日投资简报** as a section)
      const cleanTitle = s.title.replace(/\*+/g, '').trim();
      if (PREAMBLE_TITLES.includes(cleanTitle)) return false;
      return true;
    });
    const allSections = [...orderedSections, ...remaining];

    const sectionsHtml = allSections.map(sec => {
      // Clean title: strip markdown bold markers
      const cleanTitle = sec.title.replace(/\*+/g, '').trim();
      const icon = SECTION_ICONS[cleanTitle] || SECTION_ICONS[sec.title] || '';
      // Strip preamble lines from section content (AI sometimes puts "每日投资简报" + date inside first section)
      let content = sec.content;
      content = content.replace(/^\*{1,2}每日投资简报\*{0,2}\s*/i, '');
      content = content.replace(/^日期[：:]\s*\d{4}年\d{1,2}月\d{1,2}日[^\n]*\n*/i, '');
      content = content.replace(/^核心观点[：:][^\n]*\n*/i, '');
      const bodyHtml = markdownToHtml(content);
      // Determine dimension for color accent
      let dim = '';
      if (cleanTitle.includes('市场')) dim = 'market';
      else if (cleanTitle.includes('热点')) dim = 'hot';
      else if (cleanTitle.includes('政策')) dim = 'policy';
      else if (cleanTitle.includes('研判')) dim = 'summary';
      // Entity chips for this section
      let entitiesHtml = '';
      if (sec.entities && sec.entities.length > 0) {
        const chips = sec.entities.map(ent => {
          const iconCls = ENTITY_TYPE_ICONS[ent.type] || 'bi-tag';
          return `<span class="cn-brief-entity-chip" data-etype="${ent.type}" data-entity-name="${escapeHtml(ent.name)}" data-entity-type="${ent.type}"><i class="bi ${iconCls}"></i>${escapeHtml(ent.name)}</span>`;
        }).join('');
        entitiesHtml = `<div class="cn-brief-entities">${chips}</div>`;
      }
      return `
        <div class="cn-brief-section"${dim ? ` data-dim="${dim}"` : ''}>
          <div class="cn-brief-section-title">
            ${icon ? `<span class="cn-brief-section-icon">${icon}</span>` : ''}
            ${escapeHtml(cleanTitle)}
          </div>
          <div class="cn-brief-section-body">${bodyHtml}</div>
          ${entitiesHtml}
        </div>
      `;
    }).join('');

    const ts = formatTimestamp(d.generatedAt || d.timestamp);

    // Mentioned entities bar (top summary, max 12)
    let mentionedBarHtml = '';
    if (d.mentionedEntities && d.mentionedEntities.length > 0) {
      const topEntities = d.mentionedEntities.slice(0, 12);
      const chips = topEntities.map(ent => {
        const iconCls = ENTITY_TYPE_ICONS[ent.type] || 'bi-tag';
        return `<span class="cn-brief-entity-chip" data-etype="${ent.type}" data-entity-name="${escapeHtml(ent.name)}" data-entity-type="${ent.type}"><i class="bi ${iconCls}"></i>${escapeHtml(ent.name)}</span>`;
      }).join('');
      mentionedBarHtml = `<div class="cn-brief-mentioned-bar"><span class="cn-brief-mentioned-label"><i class="bi bi-tags"></i>提及实体</span>${chips}</div>`;
    }

    this.setContent(`${STYLE}
      <div class="cn-brief-container">
        <div class="cn-brief-header-bar">
          <span class="cn-brief-timestamp">${ts ? `生成时间: ${ts}` : ''}</span>
          <span style="display:flex;gap:6px">
            <button class="cn-brief-copy-btn">复制</button>
            <button class="cn-brief-refresh-btn" ${this.refreshing ? 'disabled' : ''}>
              ${this.refreshing ? '刷新中...' : '刷新'}
            </button>
          </span>
        </div>
        ${mentionedBarHtml}
        ${sectionsHtml}
      </div>
    `);
  }

  private async copyBrief(btn: HTMLElement): Promise<void> {
    if (!this.data?.sections) return;
    const text = this.data.sections.map(s => `${s.title}\n${s.content}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '已复制';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '复制';
        btn.classList.remove('copied');
      }, 2000);
    } catch {
      // Fallback for non-HTTPS
      btn.textContent = '复制失败';
      setTimeout(() => { btn.textContent = '复制'; }, 2000);
    }
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

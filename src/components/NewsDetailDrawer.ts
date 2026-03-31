/**
 * NewsDetailDrawer — right-side sliding drawer for news article detail.
 * Supports DB news types 0/01/02/03 with full content display.
 */

import { escapeHtml } from '@/utils/sanitize';
import { cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';

interface NewsArticle {
  id: string;
  title: string;
  source: string;
  date: string;
  summary: string;
  link?: string;
  emotion?: string | null;
  type: string;
  typeLabel: string;
  hasContent?: boolean;
}

interface NewsDetail {
  id: string;
  title: string;
  source: string;
  date: string;
  summary: string;
  content: string;
  plainText: string;
  link: string;
  emotion: string | null;
  type: string;
  typeLabel: string;
}

const DRAWER_STYLE = `
<style>
.news-drawer-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.35);
  z-index: 9000;
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
}
.news-drawer-overlay.open {
  opacity: 1;
  pointer-events: auto;
}
.news-drawer {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: 520px;
  max-width: 100vw;
  background: var(--bg-primary, #0C1222);
  border-left: 1px solid rgba(255,255,255,0.08);
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.3s ease;
  z-index: 9001;
  box-shadow: -4px 0 24px rgba(0,0,0,0.4);
}
.news-drawer-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.news-drawer-overlay.open .news-drawer {
  transform: translateX(0);
}
@media (max-width: 768px) {
  .news-drawer { width: 100vw; }
}
.news-drawer-header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
  position: relative;
}
.news-drawer-header h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text, #E0E6EF);
  margin: 0 0 6px;
  line-height: 1.4;
  padding-right: 32px;
}
.news-drawer-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim, #6B7A8D);
  flex-wrap: wrap;
}
.news-drawer-meta .drawer-source {
  color: #e8a838;
  font-weight: 500;
}
.news-drawer-meta .drawer-type-badge {
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 500;
  font-size: 10px;
  background: rgba(33,150,243,0.12);
  color: #64B5F6;
}
.news-drawer-meta .drawer-emotion {
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 500;
  font-size: 10px;
}
.drawer-emotion-pos { background: rgba(229,57,53,0.12); color: #e53935; }
.drawer-emotion-neg { background: rgba(67,160,71,0.12); color: #43a047; }
.drawer-emotion-neu { background: rgba(158,158,158,0.12); color: #9e9e9e; }
.news-drawer-close {
  position: absolute;
  top: 14px; right: 16px;
  width: 28px; height: 28px;
  border-radius: 6px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  color: var(--text-dim, #6B7A8D);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.news-drawer-close:hover {
  background: rgba(255,255,255,0.12);
  color: var(--text, #E0E6EF);
}
.news-drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}
.news-drawer-body::-webkit-scrollbar { width: 4px; }
.news-drawer-body::-webkit-scrollbar-thumb { background: rgba(232,168,56,0.2); border-radius: 2px; }
.news-drawer-body::-webkit-scrollbar-track { background: transparent; }
/* Content area */
.news-content-area {
  font-size: 13px;
  color: var(--text, #E0E6EF);
  line-height: 1.8;
  word-break: break-word;
}
.news-content-area p { margin: 8px 0; }
.news-content-area h1, .news-content-area h2, .news-content-area h3, .news-content-area h4 {
  color: var(--text, #E0E6EF);
  margin: 16px 0 8px;
  font-weight: 600;
}
.news-content-area h1 { font-size: 18px; }
.news-content-area h2 { font-size: 16px; }
.news-content-area h3 { font-size: 14px; }
.news-content-area table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin: 8px 0;
}
.news-content-area th, .news-content-area td {
  padding: 6px 8px;
  border: 1px solid rgba(255,255,255,0.08);
  text-align: left;
}
.news-content-area th {
  background: rgba(255,255,255,0.04);
  font-weight: 600;
}
.news-content-area img {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  margin: 6px 0;
}
.news-content-area img[data-failed] {
  display: none !important;
}
.news-content-area select,
.news-content-area form,
.news-content-area input {
  display: none !important;
}
.news-content-area a {
  color: #e8a838;
  text-decoration: none;
}
.news-content-area a:hover { text-decoration: underline; }
.news-content-area ul, .news-content-area ol {
  padding-left: 20px;
  margin: 6px 0;
}
.news-content-area li { margin: 3px 0; }
.news-content-area strong { color: var(--text, #E0E6EF); font-weight: 600; }
/* Force dark theme on injected content */
.news-content-area * {
  color: inherit;
  background-color: transparent !important;
  font-family: inherit !important;
}
.news-content-area p, .news-content-area span, .news-content-area div {
  color: var(--text, #E0E6EF) !important;
}
.news-content-area strong, .news-content-area b {
  color: var(--text, #E0E6EF) !important;
}
/* Table responsive wrapper */
.news-content-area table {
  display: block;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  max-width: 100%;
}
.news-content-area table * { color: var(--text, #E0E6EF) !important; }
.news-content-area table th { color: #e8a838 !important; }
.news-summary-section {
  padding: 12px;
  margin-bottom: 12px;
  border-radius: 8px;
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.06);
}
.news-summary-label {
  font-size: 10px;
  color: var(--text-dim, #6B7A8D);
  font-weight: 600;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.news-summary-text {
  font-size: 12px;
  color: var(--text, #E0E6EF);
  line-height: 1.7;
}
.news-loading {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-dim, #6B7A8D);
  font-size: 12px;
}
.news-loading i {
  font-size: 20px;
  display: block;
  margin-bottom: 8px;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
`;

let drawerEl: HTMLDivElement | null = null;
let currentDetail: NewsDetail | null = null;
let loading = false;

function ensureDrawer(): HTMLDivElement {
  if (drawerEl) return drawerEl;
  drawerEl = document.createElement('div');
  drawerEl.className = 'news-drawer-overlay';
  drawerEl.innerHTML = `${DRAWER_STYLE}<div class="news-drawer"><div class="news-drawer-inner"></div></div>`;
  document.body.appendChild(drawerEl);

  // Close on overlay click
  drawerEl.addEventListener('click', (e) => {
    if (e.target === drawerEl) closeNewsDrawer();
  });
  // Close on Escape
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && drawerEl?.classList.contains('open')) closeNewsDrawer();
  };
  document.addEventListener('keydown', escHandler);

  return drawerEl;
}

function renderDrawer(article: NewsArticle): void {
  const el = ensureDrawer();
  const inner = el.querySelector('.news-drawer-inner') as HTMLElement;
  if (!inner) return;

  // Emotion class
  const emotionClass = article.emotion === '正面' ? 'drawer-emotion-pos' :
    article.emotion === '负面' ? 'drawer-emotion-neg' : 'drawer-emotion-neu';
  const emotionLabel = article.emotion || '中性';

  let bodyHtml: string;
  if (loading) {
    bodyHtml = `<div class="news-loading"><i class="bi bi-arrow-repeat"></i>加载正文中...</div>`;
  } else if (currentDetail && currentDetail.content) {
    // Show full content from macro_array (types 0/01/02/03 have ~95-100% coverage)
    // Hide summary if it's identical or nearly identical to plainText content
    const showSummary = article.summary && currentDetail.plainText &&
      article.summary.trim() !== currentDetail.plainText.trim() &&
      !currentDetail.plainText.trim().startsWith(article.summary.trim());
    bodyHtml = `
      ${showSummary ? `<div class="news-summary-section"><div class="news-summary-label">摘要</div><div class="news-summary-text">${escapeHtml(article.summary)}</div></div>` : ''}
      <div class="news-content-area">${currentDetail.content}</div>
    `;
  } else if (article.summary) {
    bodyHtml = `
      <div class="news-summary-section"><div class="news-summary-label">摘要</div><div class="news-summary-text">${escapeHtml(article.summary)}</div></div>
      <div class="news-content-area" style="color:var(--text-dim);font-size:12px;text-align:center;padding:20px;">该新闻暂无正文内容</div>
    `;
  } else {
    bodyHtml = `<div class="news-content-area" style="color:var(--text-dim);font-size:12px;text-align:center;padding:20px;">暂无内容</div>`;
  }

  inner.innerHTML = `
    <div class="news-drawer-header">
      <h3>${escapeHtml(article.title)}</h3>
      <div class="news-drawer-meta">
        ${article.source ? `<span class="drawer-source">${escapeHtml(article.source)}</span>` : ''}
        ${article.date ? `<span>${escapeHtml(article.date)}</span>` : ''}
        <span class="drawer-type-badge">${escapeHtml(article.typeLabel)}</span>
        <span class="drawer-emotion ${emotionClass}">${escapeHtml(emotionLabel)}</span>
      </div>
      <button class="news-drawer-close" data-action="close"><i class="bi bi-x"></i></button>
    </div>
    <div class="news-drawer-body">
      ${bodyHtml}
    </div>
  `;

  // Close button handler
  inner.querySelector('[data-action="close"]')?.addEventListener('click', closeNewsDrawer);

  // Hide broken images
  inner.querySelectorAll('.news-content-area img').forEach((img) => {
    (img as HTMLImageElement).onerror = () => { (img as HTMLElement).setAttribute('data-failed', '1'); };
  });
}

async function fetchDetail(articleId: string): Promise<void> {
  loading = true;
  try {
    const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/news/db/detail?id=${encodeURIComponent(articleId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    currentDetail = await res.json();
  } catch (err) {
    console.warn('Failed to load news detail:', err);
    currentDetail = null;
  } finally {
    loading = false;
  }
}

export function openNewsDrawer(article: NewsArticle): void {
  currentDetail = null;
  loading = false;

  const el = ensureDrawer();
  renderDrawer(article);

  // Open with animation
  requestAnimationFrame(() => {
    el.classList.add('open');
  });

  // Lazy-load full content if article has content
  if (article.hasContent) {
    loading = true;
    renderDrawer(article);
    fetchDetail(article.id).then(() => {
      // Re-render with loaded content
      renderDrawer(article);
    });
  }
}

export function closeNewsDrawer(): void {
  if (drawerEl) {
    drawerEl.classList.remove('open');
  }
}

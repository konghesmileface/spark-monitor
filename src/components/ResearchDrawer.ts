/**
 * ResearchDrawer — right-side sliding drawer for research report detail.
 * 3 tabs: 正文 (full content) / AI分析 (structured analysis) / AI问答 (chat with tools)
 */

import { escapeHtml } from '@/utils/sanitize';
import { cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';

interface DrawerReport {
  id: string;
  title: string;
  institution: string;
  date: string;
  summary?: string;
  content?: string;
  link?: string;
  industry?: string;
  stocks?: string;
  emotion?: string | null;
  type?: string;       // '04'=研报, '05'=自媒体
  typeLabel?: string;   // 研报/自媒体
}

interface AnalysisResult {
  title?: string;
  institution?: string;
  coreViews?: string[];
  rating?: string;
  riskFactors?: string[];
  relatedStocks?: string[];
  summary?: string;
  investmentLogic?: string;
  marketImpact?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: string[];
  timestamp: number;
}

const SUGGESTED_QUESTIONS = [
  '这篇研报的核心观点是什么？',
  '相关股票的估值如何？',
  '有什么投资风险？',
  '当前市场情绪如何？',
];

const DRAWER_STYLE = `
<style>
.research-drawer-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.35);
  z-index: 9000;
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
}
.research-drawer-overlay.open {
  opacity: 1;
  pointer-events: auto;
}
.research-drawer {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: 780px;
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
.research-drawer-overlay.open .research-drawer {
  transform: translateX(0);
}
@media (max-width: 768px) {
  .research-drawer { width: 100vw; }
}
.research-drawer-header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.research-drawer-header h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text, #E0E6EF);
  margin: 0 0 6px;
  line-height: 1.4;
  padding-right: 32px;
}
.research-drawer-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim, #6B7A8D);
  flex-wrap: wrap;
}
.research-drawer-meta .drawer-source {
  color: #e8a838;
  font-weight: 500;
}
.research-drawer-meta .drawer-emotion {
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 500;
  font-size: 10px;
}
.drawer-emotion-pos { background: rgba(229,57,53,0.12); color: #e53935; }
.drawer-emotion-neg { background: rgba(67,160,71,0.12); color: #43a047; }
.drawer-emotion-neu { background: rgba(158,158,158,0.12); color: #9e9e9e; }
.research-drawer-close {
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
.research-drawer-close:hover {
  background: rgba(255,255,255,0.12);
  color: var(--text, #E0E6EF);
}
.research-drawer-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
  padding: 0 20px;
}
.research-drawer-tab {
  padding: 8px 16px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-dim, #6B7A8D);
  cursor: pointer;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  transition: all 0.15s;
}
.research-drawer-tab:hover { color: var(--text, #E0E6EF); }
.research-drawer-tab.active {
  color: #e8a838;
  border-bottom-color: #e8a838;
}
.research-drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}
.research-drawer-body::-webkit-scrollbar { width: 4px; }
.research-drawer-body::-webkit-scrollbar-thumb { background: rgba(232,168,56,0.2); border-radius: 2px; }
.research-drawer-body::-webkit-scrollbar-track { background: transparent; }

/* Tab 1: 正文 */
.drawer-content-area {
  font-size: 13px;
  color: var(--text, #E0E6EF);
  line-height: 1.8;
  word-break: break-word;
}
.drawer-content-area p { margin: 8px 0; }
.drawer-content-area h1, .drawer-content-area h2, .drawer-content-area h3, .drawer-content-area h4 {
  color: var(--text, #E0E6EF);
  margin: 16px 0 8px;
  font-weight: 600;
}
.drawer-content-area h1 { font-size: 18px; }
.drawer-content-area h2 { font-size: 16px; }
.drawer-content-area h3 { font-size: 14px; }
.drawer-content-area table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin: 8px 0;
}
.drawer-content-area th, .drawer-content-area td {
  padding: 6px 8px;
  border: 1px solid rgba(255,255,255,0.08);
  text-align: left;
}
.drawer-content-area th {
  background: rgba(255,255,255,0.04);
  font-weight: 600;
}
.drawer-content-area img {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  margin: 6px 0;
}
.drawer-content-area a {
  color: #e8a838;
  text-decoration: none;
}
.drawer-content-area a:hover { text-decoration: underline; }
.drawer-content-area ul, .drawer-content-area ol {
  padding-left: 20px;
  margin: 6px 0;
}
.drawer-content-area li { margin: 3px 0; }
.drawer-content-area strong { color: var(--text, #E0E6EF); font-weight: 600; }
.drawer-link-bar {
  margin-bottom: 12px;
}
.drawer-link-bar a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #e8a838;
  text-decoration: none;
  padding: 4px 10px;
  border-radius: 4px;
  background: rgba(232,168,56,0.08);
  border: 1px solid rgba(232,168,56,0.2);
  transition: all 0.15s;
}
.drawer-link-bar a:hover {
  background: rgba(232,168,56,0.15);
}

/* Tab 2: AI分析 */
.drawer-analysis-card {
  padding: 12px;
  margin-bottom: 10px;
  border-radius: 8px;
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.06);
}
.drawer-analysis-label {
  font-size: 10px;
  color: var(--text-dim, #6B7A8D);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
  font-weight: 600;
}
.drawer-analysis-text {
  font-size: 13px;
  color: var(--text, #E0E6EF);
  line-height: 1.6;
}
.drawer-analysis-list {
  list-style: disc;
  padding-left: 18px;
  margin: 0;
}
.drawer-analysis-list li {
  font-size: 12px;
  color: var(--text, #E0E6EF);
  line-height: 1.5;
  margin: 3px 0;
}
.drawer-analysis-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.drawer-analysis-tag {
  padding: 2px 8px;
  font-size: 10px;
  border-radius: 4px;
  background: rgba(255,255,255,0.06);
  color: var(--text-dim, #6B7A8D);
}
.drawer-analysis-tag.stock { background: rgba(229,57,53,0.1); color: #ef5350; }
.drawer-analysis-tag.risk { background: rgba(255,152,0,0.1); color: #ff9800; }
.drawer-rating-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}
.drawer-rating-buy { background: rgba(229,57,53,0.15); color: #e53935; }
.drawer-rating-overweight { background: rgba(255,152,0,0.15); color: #ff9800; }
.drawer-rating-neutral { background: rgba(158,158,158,0.15); color: #9e9e9e; }
.drawer-rating-underweight { background: rgba(33,150,243,0.15); color: #2196f3; }
.drawer-rating-sell { background: rgba(67,160,71,0.15); color: #43a047; }
.drawer-analyze-btn {
  display: block;
  width: 100%;
  padding: 10px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 8px;
  background: rgba(232,168,56,0.12);
  color: #e8a838;
  border: 1px solid rgba(232,168,56,0.3);
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
}
.drawer-analyze-btn:hover { background: rgba(232,168,56,0.2); }
.drawer-analyze-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Tab 3: AI问答 */
.drawer-chat-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 300px;
}
.drawer-chat-messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 8px;
}
.drawer-chat-msg {
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
  max-width: 90%;
  word-wrap: break-word;
  white-space: pre-wrap;
}
.drawer-chat-msg.user {
  background: rgba(229,57,53,0.12);
  color: var(--text, #E0E6EF);
  align-self: flex-end;
  border-bottom-right-radius: 4px;
}
.drawer-chat-msg.assistant {
  background: rgba(255,255,255,0.04);
  color: var(--text, #E0E6EF);
  align-self: flex-start;
  border-bottom-left-radius: 4px;
  border-left: 2px solid rgba(232,168,56,0.4);
}
.drawer-chat-tools-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding: 2px 8px;
  font-size: 10px;
  border-radius: 4px;
  background: rgba(232,168,56,0.1);
  color: #e8a838;
}
.drawer-chat-tools-badge i { font-size: 10px; }
.drawer-chat-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.drawer-chat-suggest-btn {
  padding: 5px 12px;
  font-size: 11px;
  border-radius: 14px;
  background: rgba(255,255,255,0.05);
  color: var(--text-dim, #6B7A8D);
  border: 1px solid rgba(255,255,255,0.08);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.drawer-chat-suggest-btn:hover {
  background: rgba(232,168,56,0.1);
  color: #e8a838;
  border-color: rgba(232,168,56,0.3);
}
.drawer-chat-input-area {
  display: flex;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid rgba(255,255,255,0.06);
  margin-top: auto;
  flex-shrink: 0;
}
.drawer-chat-input {
  flex: 1;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  color: var(--text, #E0E6EF);
  padding: 8px 12px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  resize: none;
  min-height: 36px;
  max-height: 80px;
}
.drawer-chat-input:focus { border-color: rgba(232,168,56,0.5); }
.drawer-chat-input::placeholder { color: var(--text-dim, #6B7A8D); opacity: 0.6; }
.drawer-chat-send {
  background: #e8a838;
  color: #0C1222;
  border: none;
  border-radius: 8px;
  padding: 0 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.15s;
}
.drawer-chat-send:hover { opacity: 0.85; }
.drawer-chat-send:disabled { opacity: 0.4; cursor: not-allowed; }
.drawer-typing-dots {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 8px 12px;
  align-self: flex-start;
}
.drawer-typing-dot {
  width: 6px; height: 6px;
  background: var(--text-dim, #6B7A8D);
  border-radius: 50%;
  animation: drawer-blink 1.4s infinite both;
}
.drawer-typing-dot:nth-child(2) { animation-delay: 0.2s; }
.drawer-typing-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes drawer-blink {
  0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

/* ── Timeline ── */
.drawer-tl-wrap { position: relative; padding-left: 20px; }
.drawer-tl-line {
  position: absolute; left: 8px; top: 0; bottom: 0; width: 2px;
  background: rgba(255,255,255,0.08);
}
.drawer-tl-node {
  position: relative; margin-bottom: 16px; padding: 8px 12px;
  border-radius: 8px; background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.05);
}
.drawer-tl-node::before {
  content: ''; position: absolute; left: -16px; top: 14px;
  width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid #888; background: var(--bg-primary, #0C1222);
}
.drawer-tl-node.dir-松::before { border-color: #ef5350; background: rgba(244,67,54,0.15); }
.drawer-tl-node.dir-紧::before { border-color: #43a047; background: rgba(67,160,71,0.15); }
.drawer-tl-node.dir-中性::before { border-color: #888; }
.drawer-tl-node.inflection::before {
  width: 14px; height: 14px; left: -18px; top: 12px;
  transform: rotate(45deg); border-radius: 2px;
}
.drawer-tl-date { font-size: 10px; color: #888; margin-bottom: 2px; }
.drawer-tl-title { font-size: 12px; color: #ddd; font-weight: 500; line-height: 1.5; }
.drawer-tl-dir-tag {
  display: inline-block; font-size: 10px; padding: 0 6px; border-radius: 3px;
  margin-left: 6px; font-weight: 600;
}
.drawer-tl-dir-松 { background: rgba(244,67,54,0.15); color: #ef5350; }
.drawer-tl-dir-紧 { background: rgba(67,160,71,0.15); color: #43a047; }
.drawer-tl-dir-中性 { background: rgba(255,255,255,0.06); color: #888; }
.drawer-tl-summary { font-size: 10px; color: #999; margin-top: 2px; }
.drawer-tl-phase {
  padding: 10px; border-radius: 8px; margin-bottom: 12px;
  background: rgba(232,168,56,0.06); border: 1px solid rgba(232,168,56,0.15);
  font-size: 12px; color: #ccc;
}
.drawer-tl-phase-label { color: #e8a838; font-weight: 600; margin-bottom: 4px; font-size: 11px; }

/* ── Transmission Chain ── */
.drawer-chain-summary {
  padding: 10px 12px; border-radius: 8px; margin-bottom: 12px;
  background: rgba(232,168,56,0.06); border: 1px solid rgba(232,168,56,0.15);
  font-size: 12px; color: #ccc; line-height: 1.5;
}
.drawer-chain-summary-label { color: #e8a838; font-weight: 600; font-size: 11px; margin-bottom: 4px; }
.drawer-chain-svg-wrap {
  overflow-x: auto; overflow-y: visible; padding: 8px 0;
  -webkit-overflow-scrolling: touch;
}
.drawer-chain-svg-wrap::-webkit-scrollbar { height: 4px; }
.drawer-chain-svg-wrap::-webkit-scrollbar-thumb { background: rgba(232,168,56,0.2); border-radius: 2px; }
.drawer-chain-legend {
  display: flex; gap: 12px; justify-content: center; margin-top: 8px; font-size: 10px; color: #888;
}
.drawer-chain-legend-item { display: flex; align-items: center; gap: 4px; }
.drawer-chain-legend-dot { width: 10px; height: 10px; border-radius: 2px; }
.drawer-chain-tooltip {
  position: absolute; padding: 6px 10px; border-radius: 6px;
  background: rgba(20,28,44,0.95); border: 1px solid rgba(255,255,255,0.15);
  font-size: 11px; color: #ddd; pointer-events: none; z-index: 10;
  max-width: 200px; white-space: normal;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

/* ── Compare ── */
.drawer-compare-year-group { margin-bottom: 14px; }
.drawer-compare-year-label {
  font-size: 12px; font-weight: 700; color: #e8a838;
  margin-bottom: 6px; display: flex; align-items: center; gap: 6px;
}
.drawer-compare-year-badge {
  background: rgba(232,168,56,0.15); padding: 1px 8px; border-radius: 4px; font-size: 11px;
}
.drawer-compare-item {
  display: flex; align-items: flex-start; gap: 8px; padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px; color: #ccc;
  cursor: pointer; transition: background 0.15s; border-radius: 4px;
}
.drawer-compare-item:hover { background: rgba(255,255,255,0.03); padding: 6px 4px; margin: 0 -4px; }
.drawer-compare-check {
  width: 16px; height: 16px; border-radius: 3px; flex-shrink: 0; margin-top: 1px;
  border: 1.5px solid rgba(255,255,255,0.2); background: transparent; cursor: pointer;
  display: flex; align-items: center; justify-content: center; font-size: 10px; color: transparent;
  transition: all 0.15s;
}
.drawer-compare-check.checked {
  background: rgba(232,168,56,0.2); border-color: #e8a838; color: #e8a838;
}
.drawer-compare-item-title { flex: 1; line-height: 1.4; }
.drawer-compare-item-date { color: #666; font-size: 11px; white-space: nowrap; }
.drawer-compare-btn {
  display: block; width: 100%; padding: 10px; margin-top: 12px;
  font-size: 13px; font-weight: 600; border-radius: 8px;
  background: rgba(232,168,56,0.12); color: #e8a838;
  border: 1px solid rgba(232,168,56,0.3); cursor: pointer;
  transition: all 0.15s; text-align: center;
}
.drawer-compare-btn:hover { background: rgba(232,168,56,0.2); }
.drawer-compare-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.drawer-compare-dim-card {
  margin-bottom: 8px; padding: 10px; border-radius: 8px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
}
.drawer-compare-dim-name {
  font-size: 12px; font-weight: 600; color: #e8a838; margin-bottom: 6px;
  display: flex; align-items: center; gap: 6px;
}
.drawer-compare-change-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 500;
}
.drawer-change-add { background: rgba(229,57,53,0.12); color: #ef5350; }
.drawer-change-remove { background: rgba(67,160,71,0.12); color: #43a047; }
.drawer-change-adjust { background: rgba(33,150,243,0.12); color: #64B5F6; }
.drawer-change-same { background: rgba(158,158,158,0.12); color: #9e9e9e; }
.drawer-compare-dim-row {
  display: flex; gap: 8px; font-size: 11px; margin-bottom: 4px; line-height: 1.5;
}
.drawer-compare-dim-label { color: #888; min-width: 50px; flex-shrink: 0; }
.drawer-compare-dim-val { color: #ccc; flex: 1; }
.drawer-compare-analysis { font-size: 11px; color: #999; margin-top: 4px; font-style: italic; }
.drawer-compare-section {
  margin-bottom: 12px; padding: 10px; border-radius: 8px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
}
.drawer-compare-section-title {
  font-size: 11px; font-weight: 600; color: #888; text-transform: uppercase;
  letter-spacing: 0.5px; margin-bottom: 6px;
}
.drawer-compare-section-text { font-size: 13px; color: #ddd; line-height: 1.6; }
.drawer-compare-list { list-style: none; padding: 0; margin: 0; }
.drawer-compare-list li {
  font-size: 12px; color: #ccc; line-height: 1.5; padding: 2px 0 2px 14px;
  position: relative;
}
.drawer-compare-list li::before {
  content: ''; position: absolute; left: 0; top: 8px;
  width: 6px; height: 6px; border-radius: 50%;
}
.drawer-compare-list.additions li::before { background: #ef5350; }
.drawer-compare-list.removals li::before { background: #43a047; }

/* Loading skeleton */
.drawer-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.drawer-skeleton-line {
  height: 14px;
  border-radius: 4px;
  background: rgba(255,255,255,0.06);
  animation: drawer-skeleton-pulse 1.5s ease-in-out infinite;
}
.drawer-skeleton-line:nth-child(1) { width: 90%; }
.drawer-skeleton-line:nth-child(2) { width: 75%; }
.drawer-skeleton-line:nth-child(3) { width: 85%; }
.drawer-skeleton-line:nth-child(4) { width: 60%; }
.drawer-skeleton-line:nth-child(5) { width: 80%; }
@keyframes drawer-skeleton-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.8; }
}
</style>
`;

function ratingClass(rating: string): string {
  switch (rating) {
    case '买入': return 'drawer-rating-buy';
    case '增持': return 'drawer-rating-overweight';
    case '中性': return 'drawer-rating-neutral';
    case '减持': return 'drawer-rating-underweight';
    case '卖出': return 'drawer-rating-sell';
    default: return 'drawer-rating-neutral';
  }
}

export class ResearchDrawer {
  private overlay: HTMLElement;
  private drawerEl: HTMLElement;
  private bodyEl: HTMLElement;
  private report: DrawerReport | null = null;
  private activeTab: 'content' | 'analysis' | 'chat' | 'compare' | 'timeline' | 'chain' = 'content';
  private fullContent: string | null = null;
  private loadingContent = false;
  private analysis: AnalysisResult | null = null;
  private analyzingLoading = false;
  private chatMessages: ChatMessage[] = [];
  private chatLoading = false;
  private abortController: AbortController | null = null;
  // Cache per report
  private analysisCache = new Map<string, AnalysisResult>();
  private contentCache = new Map<string, string>();
  // New tabs state
  private timelineData: any = null;
  private timelineLoading = false;
  private chainData: any = null;
  private chainLoading = false;
  private relatedReports: any = null;
  private relatedLoading = false;
  private selectedCompareIds = new Set<string>();
  private compareResult: any = null;
  private compareLoading = false;

  /** Convert markdown-like AI output to styled HTML */
  private formatMarkdown(text: string): string {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,3}\s+(.+)$/gm, '<div style="font-weight:700;margin:8px 0 4px;color:var(--text)">$1</div>')
      .replace(/^\d+\.\s+(.+)$/gm, '<div style="padding-left:18px;text-indent:-16px;margin:3px 0;line-height:1.7"><span style="color:#e8a838;font-weight:600;margin-right:4px">•</span>$1</div>')
      .replace(/^[-•]\s+(.+)$/gm, '<div style="padding-left:18px;text-indent:-16px;margin:3px 0;line-height:1.7"><span style="color:#e8a838;font-weight:600;margin-right:4px">•</span>$1</div>')
      .replace(/\[来源[:：](.+?)\]/g, '<span style="display:inline-block;font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(232,168,56,0.12);color:#e8a838;margin-left:4px;vertical-align:middle">$1</span>')
      .replace(/\n/g, '<br>');
  }

  constructor() {
    // Create overlay
    this.overlay = document.createElement('div');
    this.overlay.className = 'research-drawer-overlay';
    this.overlay.innerHTML = DRAWER_STYLE;

    this.drawerEl = document.createElement('div');
    this.drawerEl.className = 'research-drawer';

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'research-drawer-body';

    this.overlay.appendChild(this.drawerEl);
    document.body.appendChild(this.overlay);

    // Close on overlay click
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    // Close on Escape
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.close();
  }

  public open(report: DrawerReport): void {
    this.report = report;
    this.activeTab = 'content';
    this.fullContent = this.contentCache.get(report.id) || null;
    this.analysis = this.analysisCache.get(report.id) || null;
    this.chatMessages = [];
    this.chatLoading = false;
    this.analyzingLoading = false;
    this.timelineData = null;
    this.timelineLoading = false;
    this.chainData = null;
    this.chainLoading = false;
    this.relatedReports = null;
    this.relatedLoading = false;
    this.selectedCompareIds.clear();
    this.compareResult = null;
    this.compareLoading = false;

    this.abortController = new AbortController();
    this.render();
    this.overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', this._onKeyDown);

    // Fetch full content if not cached
    if (!this.fullContent) {
      void this.fetchFullContent();
    }
  }

  public close(): void {
    this.overlay.classList.remove('open');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', this._onKeyDown);
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  public isOpen(): boolean {
    return this.overlay.classList.contains('open');
  }

  private async fetchFullContent(): Promise<void> {
    if (!this.report) return;

    // Upload reports — use content (extracted PDF text) or fallback to summary
    const isUpload = this.report.id.startsWith('upload_');
    if (isUpload) {
      this.fullContent = this.report.content || this.report.summary || '';
      if (this.fullContent) {
        this.contentCache.set(this.report.id, this.fullContent);
      }
      this.renderBody();
      return;
    }

    // External reports (eastmoney rpt_*) — no DB detail endpoint, use summary directly
    const isDbReport = this.report.id.startsWith('db_');
    if (!isDbReport) {
      this.fullContent = this.report.content || this.report.summary || '';
      if (this.fullContent) {
        this.contentCache.set(this.report.id, this.fullContent);
      }
      this.renderBody();
      return;
    }

    this.loadingContent = true;
    this.renderBody();

    try {
      const res = await cnFetch(
        `${CN_INTEL_BASE}/api/cn/research/db/detail?id=${encodeURIComponent(this.report.id)}`,
        { signal: this.abortController?.signal },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.fullContent = data.content || '';
      this.contentCache.set(this.report.id, this.fullContent!);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Fallback to summary or content from list
      this.fullContent = this.report.content || this.report.summary || '';
    } finally {
      this.loadingContent = false;
      this.renderBody();
    }
  }

  private async fetchExternalContent(url: string): Promise<void> {
    if (!this.report) return;

    // Show loading state
    const btn = this.bodyEl.querySelector('.drawer-fetch-content-btn') as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="bi bi-hourglass-split"></i> 正在获取...';
    }

    try {
      const params = new URLSearchParams({ url });
      if (this.report.title) params.set('title', this.report.title);
      const res = await cnFetch(
        `${CN_INTEL_BASE}/api/cn/gov-news/content?${params}`,
        { signal: this.abortController?.signal },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { message?: string }).message || `HTTP ${res.status}`);
      }
      const data = await res.json() as { content?: string };
      if (data.content) {
        this.fullContent = data.content;
        this.contentCache.set(this.report.id, data.content);
        this.renderBody(); // re-render; content !== summary → normal render path
      } else {
        throw new Error('返回内容为空');
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Restore button + show hint
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-download"></i> 获取全文';
      }
      const hint = this.bodyEl.querySelector('.drawer-fetch-hint');
      if (hint) {
        hint.textContent = '获取失败，请尝试点击原文链接直接访问';
        (hint as HTMLElement).style.color = '#ef5350';
      }
    }
  }

  private async fetchAnalysis(): Promise<void> {
    if (!this.report) return;
    if (this.analysisCache.has(this.report.id)) {
      this.analysis = this.analysisCache.get(this.report.id)!;
      this.renderBody();
      return;
    }

    this.analyzingLoading = true;
    this.renderBody();

    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/research/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: this.report.id,
          title: this.report.title,
          institution: this.report.institution,
          summary: this.report.summary || '',
          date: this.report.date,
        }),
        signal: this.abortController?.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.analysis = await res.json();
      if (this.analysis) {
        this.analysisCache.set(this.report.id, this.analysis);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.analysis = { summary: '分析失败，请稍后重试' };
    } finally {
      this.analyzingLoading = false;
      this.renderBody();
    }
  }

  private async sendChat(question: string): Promise<void> {
    if (!this.report || this.chatLoading) return;

    this.chatMessages.push({ role: 'user', content: question, timestamp: Date.now() });
    this.chatLoading = true;
    this.renderBody();

    try {
      const history = this.chatMessages
        .filter((m) => m.role !== 'user' || m.content !== question)
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/research/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportId: this.report.id,
          question,
          history,
          title: this.report.title,
          institution: this.report.institution,
          summary: this.report.summary || '',
        }),
        signal: this.abortController?.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      this.chatMessages.push({
        role: 'assistant',
        content: data.answer || '抱歉，暂时无法回答。',
        toolsUsed: data.toolsUsed,
        timestamp: Date.now(),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.chatMessages.push({
        role: 'assistant',
        content: '请求失败，请稍后重试。',
        timestamp: Date.now(),
      });
    } finally {
      this.chatLoading = false;
      this.renderBody();
    }
  }

  private render(): void {
    if (!this.report) return;

    const r = this.report;
    let emotionHtml = '';
    if (r.emotion) {
      const cls = r.emotion === '负面' ? 'drawer-emotion-neg' : r.emotion === '正面' ? 'drawer-emotion-pos' : 'drawer-emotion-neu';
      emotionHtml = `<span class="drawer-emotion ${cls}">${escapeHtml(r.emotion)}</span>`;
    }

    const typeLabelHtml = r.typeLabel
      ? `<span class="drawer-emotion ${r.type === '05' ? 'drawer-emotion-pos' : 'drawer-emotion-neu'}" style="${r.type === '05' ? 'background:rgba(232,168,56,0.12);color:#e8a838' : 'background:rgba(33,150,243,0.12);color:#64B5F6'}">${escapeHtml(r.typeLabel)}</span>`
      : '';

    // Show extended tabs (对比/脉络/传导链) only for upload_* and db_* reports, not rpt_*
    const showExtended = r.id.startsWith('upload_') || r.id.startsWith('db_');

    let tabsHtml = `
        <button class="research-drawer-tab ${this.activeTab === 'content' ? 'active' : ''}" data-dtab="content">正文</button>
        <button class="research-drawer-tab ${this.activeTab === 'analysis' ? 'active' : ''}" data-dtab="analysis">AI分析</button>
        <button class="research-drawer-tab ${this.activeTab === 'chat' ? 'active' : ''}" data-dtab="chat">AI问答</button>`;
    if (showExtended) {
      tabsHtml += `
        <button class="research-drawer-tab ${this.activeTab === 'compare' ? 'active' : ''}" data-dtab="compare">对比</button>
        <button class="research-drawer-tab ${this.activeTab === 'timeline' ? 'active' : ''}" data-dtab="timeline">脉络</button>
        <button class="research-drawer-tab ${this.activeTab === 'chain' ? 'active' : ''}" data-dtab="chain">传导链</button>`;
    }

    this.drawerEl.innerHTML = `
      <div class="research-drawer-header">
        <h3>${escapeHtml(r.title)}</h3>
        <div class="research-drawer-meta">
          <span class="drawer-source">${escapeHtml(r.institution)}</span>
          <span>${escapeHtml(r.date)}</span>
          ${typeLabelHtml}
          ${r.industry ? `<span>${escapeHtml(r.industry)}</span>` : ''}
          ${emotionHtml}
        </div>
        <button class="research-drawer-close" id="drawerClose">&times;</button>
      </div>
      <div class="research-drawer-tabs">
        ${tabsHtml}
      </div>
    `;

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'research-drawer-body';
    this.drawerEl.appendChild(this.bodyEl);
    this.renderBody();

    // Event listeners
    this.drawerEl.querySelector('#drawerClose')?.addEventListener('click', () => this.close());

    this.drawerEl.querySelectorAll('.research-drawer-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const t = (tab as HTMLElement).dataset.dtab as typeof this.activeTab;
        if (t) {
          this.activeTab = t;
          this.drawerEl.querySelectorAll('.research-drawer-tab').forEach((el) => el.classList.remove('active'));
          tab.classList.add('active');

          if (t === 'analysis' && !this.analysis && !this.analyzingLoading) {
            void this.fetchAnalysis();
          }

          this.renderBody();
        }
      });
    });
  }

  private renderBody(): void {
    if (!this.report) return;

    if (this.activeTab === 'content') {
      this.renderContentTab();
    } else if (this.activeTab === 'analysis') {
      this.renderAnalysisTab();
    } else if (this.activeTab === 'chat') {
      this.renderChatTab();
    } else if (this.activeTab === 'compare') {
      this.renderCompareTab();
    } else if (this.activeTab === 'timeline') {
      this.renderTimelineTab();
    } else if (this.activeTab === 'chain') {
      this.renderChainTab();
    }
  }

  private renderContentTab(): void {
    const r = this.report!;
    const isMedia = r.type === '05';
    const isUpload = r.id.startsWith('upload_');
    const isDbReport = r.id.startsWith('db_');
    const isExternal = !isUpload && !isDbReport;

    if (this.loadingContent) {
      this.bodyEl.innerHTML = `
        <div class="drawer-skeleton">
          <div class="drawer-skeleton-line"></div>
          <div class="drawer-skeleton-line"></div>
          <div class="drawer-skeleton-line"></div>
          <div class="drawer-skeleton-line"></div>
          <div class="drawer-skeleton-line"></div>
        </div>
      `;
      return;
    }

    const content = this.fullContent || r.content || '';

    // Upload PDF — show PDF link + full extracted text or embedded PDF
    if (isUpload) {
      // content is now the full extracted text from pdfplumber
      const hasFullText = content && content !== r.summary;
      if (hasFullText) {
        const pdfLinkHtml = r.link
          ? `<div class="drawer-link-bar"><a href="${escapeHtml(r.link)}" target="_blank" rel="noopener noreferrer"><i class="bi bi-file-earmark-pdf"></i> 查看PDF原文</a></div>`
          : '';
        this.bodyEl.innerHTML = `${pdfLinkHtml}<div class="drawer-content-area" style="white-space:pre-line">${escapeHtml(content)}</div>`;
      } else if (content) {
        const pdfLinkHtml = r.link
          ? `<div class="drawer-link-bar"><a href="${escapeHtml(r.link)}" target="_blank" rel="noopener noreferrer"><i class="bi bi-file-earmark-pdf"></i> 查看PDF原文</a></div>`
          : '';
        this.bodyEl.innerHTML = `${pdfLinkHtml}<div class="drawer-analysis-card"><div class="drawer-analysis-label">AI摘要</div><div class="drawer-analysis-text" style="white-space:pre-line">${escapeHtml(content)}</div></div>
          <p style="color:var(--text-dim);font-size:11px;text-align:center;margin-top:12px">可使用 AI分析 和 AI问答 获取深度解读</p>`;
      } else if (r.link) {
        // No text extracted (scanned/image PDF) — embed PDF inline
        this.bodyEl.innerHTML = `<iframe src="${escapeHtml(r.link)}" style="width:100%;height:calc(100vh - 120px);border:none;border-radius:6px;background:#f5f5f5"></iframe>`;
      } else {
        this.bodyEl.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:20px 0">无法提取PDF文本内容</p>';
      }
      return;
    }

    // 研报 (type 04): already has full content, no need for "查看原文"
    // 自媒体 (type 05): handled separately below with "查看微信原文"
    // Only show link for external URLs (http/https), not internal routes
    const isExternalLink = r.link && /^https?:\/\//.test(r.link) && !r.link.includes('localhost');
    const showLink = isExternalLink && !isMedia && isExternal;
    const linkHtml = showLink
      ? `<div class="drawer-link-bar"><a href="${escapeHtml(r.link!)}" target="_blank" rel="noopener noreferrer"><i class="bi bi-box-arrow-up-right"></i> 查看原文</a></div>`
      : '';

    // 自媒体 (type 05): show summary + guide user to AI tabs for deep analysis
    if (isMedia && !content.trim()) {
      const summaryHtml = r.summary
        ? `<div class="drawer-analysis-card"><div class="drawer-analysis-label">文章摘要</div><div class="drawer-analysis-text" style="white-space:pre-line;line-height:1.8">${escapeHtml(r.summary)}</div></div>`
        : '';
      const linkHint = r.link
        ? `<div style="text-align:center;margin-top:6px"><a href="${escapeHtml(r.link)}" target="_blank" rel="noopener noreferrer" style="color:#66BB6A;font-size:11px;text-decoration:none;opacity:0.8"><i class="bi bi-box-arrow-up-right"></i> 查看微信原文</a></div>`
        : '';
      this.bodyEl.innerHTML = `
        ${summaryHtml}
        <div style="text-align:center;padding:16px 0;margin-top:4px">
          <div style="color:var(--text-dim);font-size:11px;margin-bottom:10px">微信公众号文章暂无法获取全文，可基于摘要进行AI解读</div>
          <button class="drawer-analyze-btn drawer-media-ai-btn" style="font-size:13px;padding:8px 24px"><i class="bi bi-stars"></i> AI深度解读</button>
        </div>
        ${linkHint}
      `;
      // Click "AI深度解读" → switch to AI分析 tab and auto-trigger
      this.bodyEl.querySelector('.drawer-media-ai-btn')?.addEventListener('click', () => {
        this.activeTab = 'analysis';
        this.drawerEl.querySelectorAll('.research-drawer-tab').forEach((el) => {
          el.classList.toggle('active', (el as HTMLElement).dataset.dtab === 'analysis');
        });
        this.renderBody();
        if (!this.analysis && !this.analyzingLoading) {
          void this.fetchAnalysis();
        }
      });
      return;
    }

    // External reports (eastmoney) — show summary + PDF embed/link
    if (isExternal && content === r.summary) {
      const isPdf = r.link && r.link.endsWith('.pdf');
      const summaryHtml = `
        <div class="drawer-analysis-card">
          <div class="drawer-analysis-label">研报摘要</div>
          <div class="drawer-analysis-text" style="white-space:pre-line">${escapeHtml(content)}</div>
        </div>`;

      if (isPdf && r.link) {
        // PDF report — embed directly + open link
        this.bodyEl.innerHTML = `
          ${summaryHtml}
          <div style="text-align:center;margin-top:12px">
            <button class="drawer-analyze-btn drawer-pdf-embed-btn" style="font-size:13px;padding:8px 24px">
              <i class="bi bi-file-earmark-pdf"></i> 在线阅读PDF
            </button>
            <a href="${escapeHtml(r.link)}" target="_blank" rel="noopener noreferrer" style="color:var(--text-dim);font-size:11px;text-decoration:none;margin-left:8px"><i class="bi bi-box-arrow-up-right"></i> 新窗口打开</a>
          </div>
          <div class="drawer-pdf-container" style="display:none;margin-top:12px"></div>`;

        this.bodyEl.querySelector('.drawer-pdf-embed-btn')?.addEventListener('click', () => {
          const container = this.bodyEl.querySelector('.drawer-pdf-container') as HTMLElement;
          if (container && r.link) {
            container.style.display = 'block';
            container.innerHTML = `<iframe src="${escapeHtml(r.link)}" style="width:100%;height:calc(100vh - 240px);border:1px solid rgba(232,168,56,0.15);border-radius:6px;background:#f5f5f5"></iframe>`;
            (this.bodyEl.querySelector('.drawer-pdf-embed-btn') as HTMLElement).style.display = 'none';
          }
        });
      } else if (r.link) {
        // Non-PDF external link — try article fetcher
        this.bodyEl.innerHTML = `
          ${summaryHtml}
          <div style="text-align:center;margin-top:12px">
            <button class="drawer-analyze-btn drawer-fetch-content-btn" style="font-size:13px;padding:8px 24px">
              <i class="bi bi-download"></i> 获取全文
            </button>
            <a href="${escapeHtml(r.link)}" target="_blank" rel="noopener noreferrer" style="color:var(--text-dim);font-size:11px;text-decoration:none;margin-left:8px"><i class="bi bi-box-arrow-up-right"></i> 原文链接</a>
          </div>
          <p class="drawer-fetch-hint" style="color:var(--text-dim);font-size:11px;text-align:center;margin-top:8px">
            该研报为外部数据源，点击获取全文以在线阅读
          </p>`;
        this.bodyEl.querySelector('.drawer-fetch-content-btn')?.addEventListener('click', () => {
          if (r.link) void this.fetchExternalContent(r.link);
        });
      } else {
        // No link at all — just show summary
        this.bodyEl.innerHTML = `
          ${summaryHtml}
          <p style="color:var(--text-dim);font-size:11px;text-align:center;margin-top:12px">
            该研报暂无全文链接，可使用AI分析功能基于摘要进行解读
          </p>`;
      }
      return;
    }

    this.bodyEl.innerHTML = `
      ${linkHtml}
      <div class="drawer-content-area">${content || '<p style="color:var(--text-dim)">暂无正文内容</p>'}</div>
    `;
  }

  private renderAnalysisTab(): void {
    if (this.analyzingLoading) {
      this.bodyEl.innerHTML = `
        <div style="text-align:center;padding:40px 0">
          <div class="drawer-typing-dots" style="justify-content:center">
            <div class="drawer-typing-dot"></div>
            <div class="drawer-typing-dot"></div>
            <div class="drawer-typing-dot"></div>
          </div>
          <div style="color:var(--text-dim);font-size:12px;margin-top:12px">AI正在分析研报...</div>
        </div>
      `;
      return;
    }

    if (!this.analysis) {
      this.bodyEl.innerHTML = `
        <div style="text-align:center;padding:40px 0">
          <div style="color:var(--text-dim);font-size:13px;margin-bottom:16px">点击下方按钮，AI将为你生成结构化分析</div>
          <button class="drawer-analyze-btn" id="drawerAnalyzeBtn">生成AI分析</button>
        </div>
      `;
      this.bodyEl.querySelector('#drawerAnalyzeBtn')?.addEventListener('click', () => {
        void this.fetchAnalysis();
      });
      return;
    }

    const a = this.analysis;
    const cards: string[] = [];

    if (a.summary) {
      cards.push(`
        <div class="drawer-analysis-card">
          <div class="drawer-analysis-label">摘要</div>
          <div class="drawer-analysis-text">${this.formatMarkdown(a.summary)}</div>
        </div>
      `);
    }

    if (a.coreViews && a.coreViews.length > 0) {
      const items = a.coreViews.map((v) => `<li>${escapeHtml(v)}</li>`).join('');
      cards.push(`
        <div class="drawer-analysis-card">
          <div class="drawer-analysis-label">核心观点</div>
          <ul class="drawer-analysis-list">${items}</ul>
        </div>
      `);
    }

    if (a.rating && a.rating !== '无评级') {
      cards.push(`
        <div class="drawer-analysis-card">
          <div class="drawer-analysis-label">投资评级</div>
          <span class="drawer-rating-badge ${ratingClass(a.rating)}">${escapeHtml(a.rating)}</span>
        </div>
      `);
    }

    if (a.investmentLogic) {
      cards.push(`
        <div class="drawer-analysis-card">
          <div class="drawer-analysis-label">投资逻辑</div>
          <div class="drawer-analysis-text">${this.formatMarkdown(a.investmentLogic)}</div>
        </div>
      `);
    }

    if (a.marketImpact) {
      cards.push(`
        <div class="drawer-analysis-card">
          <div class="drawer-analysis-label">市场影响</div>
          <div class="drawer-analysis-text">${this.formatMarkdown(a.marketImpact)}</div>
        </div>
      `);
    }

    if (a.riskFactors && a.riskFactors.length > 0) {
      const tags = a.riskFactors.map((f) => `<span class="drawer-analysis-tag risk">${escapeHtml(f)}</span>`).join('');
      cards.push(`
        <div class="drawer-analysis-card">
          <div class="drawer-analysis-label">风险因素</div>
          <div class="drawer-analysis-tags">${tags}</div>
        </div>
      `);
    }

    if (a.relatedStocks && a.relatedStocks.length > 0) {
      const tags = a.relatedStocks.map((s) => `<span class="drawer-analysis-tag stock">${escapeHtml(s)}</span>`).join('');
      cards.push(`
        <div class="drawer-analysis-card">
          <div class="drawer-analysis-label">相关标的</div>
          <div class="drawer-analysis-tags">${tags}</div>
        </div>
      `);
    }

    this.bodyEl.innerHTML = cards.join('');
  }

  private renderChatTab(): void {
    const hasMessages = this.chatMessages.length > 0;

    let messagesHtml = '';
    if (!hasMessages && !this.chatLoading) {
      // Suggestions
      const suggestionsHtml = SUGGESTED_QUESTIONS.map(
        (q) => `<button class="drawer-chat-suggest-btn" data-question="${escapeHtml(q)}">${escapeHtml(q)}</button>`,
      ).join('');
      messagesHtml = `
        <div style="text-align:center;padding:20px 0;color:var(--text-dim);font-size:12px;margin-bottom:8px">
          基于研报内容 + 实时市场数据，回答你的投资问题
        </div>
        <div class="drawer-chat-suggestions">${suggestionsHtml}</div>
      `;
    } else {
      messagesHtml = this.chatMessages.map((msg) => {
        const toolsBadge =
          msg.toolsUsed && msg.toolsUsed.length > 0
            ? `<div class="drawer-chat-tools-badge"><i class="bi bi-gear"></i> 调用了: ${msg.toolsUsed.map((t) => escapeHtml(t)).join(', ')}</div>`
            : '';
        const contentHtml = msg.role === 'assistant'
          ? this.formatMarkdown(msg.content)
          : escapeHtml(msg.content);
        return `
          <div class="drawer-chat-msg ${msg.role}">
            ${contentHtml}
            ${msg.role === 'assistant' ? toolsBadge : ''}
          </div>
        `;
      }).join('');

      if (this.chatLoading) {
        messagesHtml += `
          <div class="drawer-typing-dots">
            <div class="drawer-typing-dot"></div>
            <div class="drawer-typing-dot"></div>
            <div class="drawer-typing-dot"></div>
          </div>
        `;
      }
    }

    this.bodyEl.innerHTML = `
      <div class="drawer-chat-container">
        <div class="drawer-chat-messages" id="drawerChatMessages">
          ${messagesHtml}
        </div>
        <div class="drawer-chat-input-area">
          <input type="text"
            class="drawer-chat-input"
            id="drawerChatInput"
            placeholder="输入你的问题..."
            ${this.chatLoading ? 'disabled' : ''}
            autocomplete="off"
          />
          <button class="drawer-chat-send" id="drawerChatSend" ${this.chatLoading ? 'disabled' : ''}>发送</button>
        </div>
      </div>
    `;

    // Scroll to bottom
    const msgContainer = this.bodyEl.querySelector('#drawerChatMessages') as HTMLElement;
    if (msgContainer) {
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }

    // Attach listeners
    const input = this.bodyEl.querySelector('#drawerChatInput') as HTMLInputElement;
    const sendBtn = this.bodyEl.querySelector('#drawerChatSend') as HTMLButtonElement;

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !this.chatLoading) {
          e.preventDefault();
          const q = input.value.trim();
          if (q) void this.sendChat(q);
        }
      });
      // Auto-focus
      requestAnimationFrame(() => input.focus());
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        if (this.chatLoading) return;
        const q = input?.value.trim();
        if (q) void this.sendChat(q);
      });
    }

    // Suggestion buttons
    this.bodyEl.querySelectorAll('.drawer-chat-suggest-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const q = (btn as HTMLElement).dataset.question;
        if (q) void this.sendChat(q);
      });
    });
  }

  // ── Timeline Tab ─────────────────────────────────────────────────────────────

  private renderTimelineTab(): void {
    if (!this.timelineData && !this.timelineLoading) {
      void this.fetchTimeline();
    }

    if (this.timelineLoading) {
      this.bodyEl.innerHTML = `<div style="text-align:center;padding:40px 0">
        <div class="drawer-typing-dots" style="justify-content:center">
          <div class="drawer-typing-dot"></div><div class="drawer-typing-dot"></div><div class="drawer-typing-dot"></div>
        </div>
        <div style="color:var(--text-dim);font-size:12px;margin-top:12px">AI正在分析研报演变脉络...</div>
      </div>`;
      return;
    }

    if (!this.timelineData || !this.timelineData.events || this.timelineData.events.length === 0) {
      this.bodyEl.innerHTML = `<div style="text-align:center;padding:40px 0;color:#888;font-size:12px">
        数据库中未找到相关历史研报记录
      </div>`;
      return;
    }

    const tl = this.timelineData;
    const inflectionDates = new Set((tl.inflection_points || []).map((ip: any) => ip.date));

    let phaseHtml = '';
    if (tl.current_phase || tl.overall_trend) {
      phaseHtml = `<div class="drawer-tl-phase">
        ${tl.current_phase ? `<div class="drawer-tl-phase-label">当前阶段</div><div>${escapeHtml(tl.current_phase)}</div>` : ''}
        ${tl.overall_trend ? `<div class="drawer-tl-phase-label" style="margin-top:6px">总体趋势</div><div>${escapeHtml(tl.overall_trend)}</div>` : ''}
      </div>`;
    }

    const nodesHtml = tl.events.map((evt: any) => {
      const dir = evt.direction || '中性';
      const isInflection = inflectionDates.has(evt.date);
      const nodeClass = `drawer-tl-node dir-${dir}${isInflection ? ' inflection' : ''}`;
      return `<div class="${nodeClass}">
        <div class="drawer-tl-date">${escapeHtml(evt.date || '')}</div>
        <div class="drawer-tl-title">${escapeHtml(evt.title || '')}
          <span class="drawer-tl-dir-tag drawer-tl-dir-${dir}">${dir}</span>
          ${isInflection ? '<span class="drawer-tl-dir-tag" style="background:rgba(232,168,56,0.2);color:#e8a838">转折</span>' : ''}
        </div>
        ${evt.summary ? `<div class="drawer-tl-summary">${escapeHtml(evt.summary)}</div>` : ''}
      </div>`;
    }).join('');

    this.bodyEl.innerHTML = `${phaseHtml}
      <div class="drawer-tl-wrap">
        <div class="drawer-tl-line"></div>
        ${nodesHtml}
      </div>`;
  }

  private async fetchTimeline(): Promise<void> {
    if (!this.report || this.timelineLoading) return;
    this.timelineLoading = true;
    this.renderBody();
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60000);
      this.abortController?.signal.addEventListener('abort', () => ac.abort());
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/research/timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: this.report.title, topic: this.report.title }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        this.timelineData = await res.json();
      }
    } catch {
      // ignore abort / timeout
    } finally {
      this.timelineLoading = false;
      if (this.activeTab === 'timeline') this.renderBody();
    }
  }

  // ── Transmission Chain Tab ──────────────────────────────────────────────────

  private renderChainTab(): void {
    if (!this.chainData && !this.chainLoading) {
      void this.fetchChain();
    }

    if (this.chainLoading) {
      this.bodyEl.innerHTML = `<div style="text-align:center;padding:40px 0">
        <div class="drawer-typing-dots" style="justify-content:center">
          <div class="drawer-typing-dot"></div><div class="drawer-typing-dot"></div><div class="drawer-typing-dot"></div>
        </div>
        <div style="color:var(--text-dim);font-size:12px;margin-top:12px">AI正在分析传导链路...</div>
      </div>`;
      return;
    }

    if (!this.chainData || !this.chainData.nodes || this.chainData.nodes.length === 0) {
      this.bodyEl.innerHTML = `<div style="text-align:center;padding:40px 0;color:#888;font-size:12px">
        无法生成传导链，请稍后重试
      </div>`;
      return;
    }

    const { nodes, edges, summary } = this.chainData;

    let summaryHtml = '';
    if (summary) {
      summaryHtml = `<div class="drawer-chain-summary">
        <div class="drawer-chain-summary-label">传导路径摘要</div>
        <div>${escapeHtml(summary)}</div>
      </div>`;
    }

    // Layout: group nodes by level, compute positions
    const levelGroups: Map<number, any[]> = new Map();
    for (const n of nodes) {
      const lvl = n.level ?? 0;
      if (!levelGroups.has(lvl)) levelGroups.set(lvl, []);
      levelGroups.get(lvl)!.push(n);
    }

    const colWidth = 140;
    const nodeW = 120, nodeH = 38, rowGap = 52;
    const padLeft = 16, padTop = 20;
    const maxLevel = Math.max(...Array.from(levelGroups.keys()), 4);
    const svgW = padLeft * 2 + (maxLevel + 1) * colWidth;

    const nodePos: Map<string, { x: number; y: number }> = new Map();
    let maxRows = 0;
    for (let lvl = 0; lvl <= maxLevel; lvl++) {
      const group = levelGroups.get(lvl) || [];
      if (group.length > maxRows) maxRows = group.length;
    }
    const svgH = padTop * 2 + maxRows * (nodeH + rowGap) - rowGap + 10;

    for (let lvl = 0; lvl <= maxLevel; lvl++) {
      const group = levelGroups.get(lvl) || [];
      const totalH = group.length * nodeH + (group.length - 1) * rowGap;
      const startY = padTop + (svgH - padTop * 2 - totalH) / 2;
      group.forEach((n: any, idx: number) => {
        nodePos.set(n.id, {
          x: padLeft + lvl * colWidth,
          y: startY + idx * (nodeH + rowGap),
        });
      });
    }

    const levelLabels = ['政策', '传导机制', '一级板块', '二级板块', '具体标的'];
    let levelLabelsSvg = '';
    for (let lvl = 0; lvl <= maxLevel && lvl < levelLabels.length; lvl++) {
      const cx = padLeft + lvl * colWidth + nodeW / 2;
      levelLabelsSvg += `<text x="${cx}" y="14" text-anchor="middle" fill="#777" font-size="10" font-weight="600">${levelLabels[lvl]}</text>`;
    }

    let edgesSvg = '';
    for (const edge of edges) {
      const fromPos = nodePos.get(edge.from);
      const toPos = nodePos.get(edge.to);
      if (!fromPos || !toPos) continue;

      const x1 = fromPos.x + nodeW;
      const y1 = fromPos.y + nodeH / 2;
      const x2 = toPos.x;
      const y2 = toPos.y + nodeH / 2;
      const cpx = (x1 + x2) / 2;

      const sw = edge.strength === 'strong' ? 2.5 : edge.strength === 'weak' ? 0.8 : 1.5;
      const opacity = edge.strength === 'strong' ? 0.6 : edge.strength === 'weak' ? 0.25 : 0.4;

      edgesSvg += `<path d="M${x1},${y1} C${cpx},${y1} ${cpx},${y2} ${x2},${y2}"
        fill="none" stroke="rgba(232,168,56,${opacity})" stroke-width="${sw}"
        data-edge-from="${edge.from}" data-edge-to="${edge.to}"
        style="transition:stroke 0.2s,stroke-width 0.2s"/>`;

      if (edge.label) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2 - 6;
        edgesSvg += `<text x="${mx}" y="${my}" text-anchor="middle" fill="rgba(232,168,56,0.55)" font-size="8.5"
          data-edge-from="${edge.from}" data-edge-to="${edge.to}">${escapeHtml((edge.label || '').slice(0, 12))}</text>`;
      }
    }

    let nodesSvg = '';
    for (const n of nodes) {
      const pos = nodePos.get(n.id);
      if (!pos) continue;

      const dir = n.direction || '中性';
      let fillColor: string, strokeColor: string, textColor: string;
      if (dir === '利好') {
        fillColor = 'rgba(229,57,53,0.12)'; strokeColor = 'rgba(229,57,53,0.4)'; textColor = '#ef5350';
      } else if (dir === '利空') {
        fillColor = 'rgba(67,160,71,0.12)'; strokeColor = 'rgba(67,160,71,0.4)'; textColor = '#43a047';
      } else {
        fillColor = 'rgba(255,255,255,0.04)'; strokeColor = 'rgba(255,255,255,0.15)'; textColor = '#bbb';
      }

      const label = (n.label || '').slice(0, 8);
      const isRoot = n.level === 0;

      nodesSvg += `<g class="drawer-chain-node" data-nid="${n.id}" style="cursor:pointer">
        <rect x="${pos.x}" y="${pos.y}" width="${nodeW}" height="${nodeH}" rx="6" ry="6"
          fill="${fillColor}" stroke="${strokeColor}" stroke-width="${isRoot ? 1.5 : 1}"
          style="transition:fill 0.15s,stroke-width 0.15s"/>
        <text x="${pos.x + nodeW / 2}" y="${pos.y + nodeH / 2 + (n.code ? -2 : 1)}" text-anchor="middle"
          dominant-baseline="middle" fill="${textColor}" font-size="${isRoot ? 12 : 11}"
          font-weight="${isRoot ? 700 : 500}">${escapeHtml(label)}</text>
        ${n.code ? `<text x="${pos.x + nodeW / 2}" y="${pos.y + nodeH - 5}" text-anchor="middle" fill="#888" font-size="8">${escapeHtml(n.code)}</text>` : ''}
      </g>`;
    }

    const svgContent = `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">
      ${levelLabelsSvg}
      ${edgesSvg}
      ${nodesSvg}
    </svg>`;

    const legendHtml = `<div class="drawer-chain-legend">
      <div class="drawer-chain-legend-item"><div class="drawer-chain-legend-dot" style="background:rgba(229,57,53,0.4)"></div>利好</div>
      <div class="drawer-chain-legend-item"><div class="drawer-chain-legend-dot" style="background:rgba(67,160,71,0.4)"></div>利空</div>
      <div class="drawer-chain-legend-item"><div class="drawer-chain-legend-dot" style="background:rgba(255,255,255,0.15)"></div>中性</div>
      <div class="drawer-chain-legend-item" style="margin-left:12px">
        <svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="#e8a838" stroke-width="2.5" opacity="0.6"/></svg>强
      </div>
      <div class="drawer-chain-legend-item">
        <svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="#e8a838" stroke-width="1.5" opacity="0.4"/></svg>中
      </div>
      <div class="drawer-chain-legend-item">
        <svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="#e8a838" stroke-width="0.8" opacity="0.25"/></svg>弱
      </div>
    </div>`;

    this.bodyEl.innerHTML = `${summaryHtml}
      <div class="drawer-chain-svg-wrap" style="position:relative">${svgContent}</div>
      ${legendHtml}`;

    this._bindChainEvents(nodes, edges);
  }

  private _bindChainEvents(nodes: any[], edges: any[]): void {
    const svgWrap = this.bodyEl.querySelector('.drawer-chain-svg-wrap');
    if (!svgWrap) return;

    const connectedEdges = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!connectedEdges.has(e.from)) connectedEdges.set(e.from, new Set());
      if (!connectedEdges.has(e.to)) connectedEdges.set(e.to, new Set());
      connectedEdges.get(e.from)!.add(e.to);
      connectedEdges.get(e.to)!.add(e.from);
    }

    let tooltip: HTMLDivElement | null = null;

    svgWrap.querySelectorAll('.drawer-chain-node').forEach(g => {
      const nid = (g as SVGElement).dataset.nid || '';
      const node = nodes.find((n: any) => n.id === nid);

      g.addEventListener('mouseenter', (ev) => {
        const connected = connectedEdges.get(nid) || new Set();

        svgWrap.querySelectorAll('path[data-edge-from]').forEach(path => {
          const ef = (path as SVGElement).dataset.edgeFrom || '';
          const et = (path as SVGElement).dataset.edgeTo || '';
          const isConnected = ef === nid || et === nid;
          (path as SVGElement).style.stroke = isConnected ? 'rgba(232,168,56,0.9)' : 'rgba(255,255,255,0.04)';
          (path as SVGElement).style.strokeWidth = isConnected ? '3' : '0.5';
        });

        svgWrap.querySelectorAll('.drawer-chain-node').forEach(otherG => {
          const oid = (otherG as SVGElement).dataset.nid || '';
          const isConn = oid === nid || connected.has(oid);
          (otherG as SVGElement).style.opacity = isConn ? '1' : '0.3';
        });

        if (node) {
          if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.className = 'drawer-chain-tooltip';
            svgWrap.appendChild(tooltip);
          }
          const dir = node.direction || '中性';
          const dirColor = dir === '利好' ? '#ef5350' : dir === '利空' ? '#43a047' : '#888';
          tooltip.innerHTML = `<div style="font-weight:600;margin-bottom:2px">${escapeHtml(node.label || '')}</div>
            <div style="color:${dirColor};font-size:10px">${escapeHtml(dir)}</div>
            ${node.code ? `<div style="color:#888;font-size:10px">${escapeHtml(node.code)}</div>` : ''}`;
          const me = ev as MouseEvent;
          const rect = (svgWrap as HTMLElement).getBoundingClientRect();
          tooltip.style.left = (me.clientX - rect.left + 10) + 'px';
          tooltip.style.top = (me.clientY - rect.top - 30) + 'px';
        }
      });

      g.addEventListener('mouseleave', () => {
        svgWrap.querySelectorAll('path[data-edge-from]').forEach(path => {
          (path as SVGElement).style.stroke = '';
          (path as SVGElement).style.strokeWidth = '';
        });
        svgWrap.querySelectorAll('.drawer-chain-node').forEach(otherG => {
          (otherG as SVGElement).style.opacity = '1';
        });
        if (tooltip) {
          tooltip.remove();
          tooltip = null;
        }
      });
    });
  }

  private async fetchChain(): Promise<void> {
    if (!this.report || this.chainLoading) return;
    this.chainLoading = true;
    this.renderBody();
    try {
      const body: any = { title: this.report.title };
      const plainText = this.fullContent || this.report.content || this.report.summary || '';
      if (plainText && plainText.length > 50) {
        body.content = plainText.slice(0, 5000);
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60000);
      this.abortController?.signal.addEventListener('abort', () => ac.abort());
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/research/transmission-chain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        this.chainData = await res.json();
      }
    } catch {
      // ignore abort / timeout
    } finally {
      this.chainLoading = false;
      if (this.activeTab === 'chain') this.renderBody();
    }
  }

  // ── Compare Tab ─────────────────────────────────────────────────────────────

  private renderCompareTab(): void {
    if (this.compareResult && !this.compareLoading) {
      this.renderCompareResult();
      return;
    }

    if (this.compareLoading) {
      this.bodyEl.innerHTML = `
        <div style="text-align:center;padding:40px 0">
          <div class="drawer-typing-dots" style="justify-content:center">
            <div class="drawer-typing-dot"></div>
            <div class="drawer-typing-dot"></div>
            <div class="drawer-typing-dot"></div>
          </div>
          <div style="color:var(--text-dim);font-size:12px;margin-top:12px">AI正在对比分析研报差异...</div>
        </div>`;
      return;
    }

    if (this.relatedLoading) {
      this.bodyEl.innerHTML = `<div style="text-align:center;padding:40px 0">
        <div class="drawer-typing-dots" style="justify-content:center">
          <div class="drawer-typing-dot"></div><div class="drawer-typing-dot"></div><div class="drawer-typing-dot"></div>
        </div>
        <div style="color:var(--text-dim);font-size:12px;margin-top:12px">搜索相关研报中...</div>
      </div>`;
      return;
    }

    // Auto-search on first visit
    if (!this.relatedReports && !this.relatedLoading) {
      void this.searchRelatedReports();
      return;
    }

    const searchBoxHtml = `
      <div style="display:flex;gap:6px;margin-bottom:10px">
        <input id="drawerCompareSearch" type="text" placeholder="输入关键词搜索相关研报..."
          style="flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
          border-radius:6px;padding:6px 10px;color:var(--text);font-size:12px;outline:none"
          value="" />
        <button id="drawerCompareSearchBtn"
          style="background:#e8a838;color:#000;border:none;border-radius:6px;padding:6px 12px;
          font-size:12px;cursor:pointer;white-space:nowrap">搜索</button>
      </div>`;

    if (!this.relatedReports || this.relatedReports.total === 0) {
      const rp = this.relatedReports;
      const kwsHtml = rp?.keywords?.length
        ? `<div style="color:#888;font-size:11px;margin-bottom:8px">已搜索关键词: ${rp.keywords.map((k: string) => `<span style="color:#e8a838">${escapeHtml(k)}</span>`).join(' · ')}</div>`
        : '';

      this.bodyEl.innerHTML = `
        <div style="padding:16px 0">
          ${searchBoxHtml}
          <div style="text-align:center;padding:20px 0">
            <div style="color:var(--text-dim);font-size:13px;margin-bottom:8px">未找到相关研报</div>
            ${kwsHtml}
            <div style="color:#666;font-size:11px">可尝试输入其他关键词搜索</div>
          </div>
        </div>`;
      this._attachCompareSearchHandler();
      return;
    }

    const rp = this.relatedReports;
    const years = Object.keys(rp.by_year).sort((a: string, b: string) => b.localeCompare(a));

    let groupsHtml = '';
    for (const year of years) {
      const items = rp.by_year[year] || [];
      const itemsHtml = items.slice(0, 10).map((it: any) => {
        const checked = this.selectedCompareIds.has(it.id);
        return `<div class="drawer-compare-item" data-compare-id="${escapeHtml(it.id)}">
          <div class="drawer-compare-check ${checked ? 'checked' : ''}">&#10003;</div>
          <div class="drawer-compare-item-title">${escapeHtml(it.title)}</div>
          <div class="drawer-compare-item-date">${escapeHtml(it.date || '')}</div>
        </div>`;
      }).join('');

      groupsHtml += `<div class="drawer-compare-year-group">
        <div class="drawer-compare-year-label">
          <span class="drawer-compare-year-badge">${escapeHtml(year)}</span>
          <span style="color:#888;font-size:11px">${items.length}条相关</span>
        </div>
        ${itemsHtml}
      </div>`;
    }

    const selectedCount = this.selectedCompareIds.size;
    const btnDisabled = selectedCount === 0 ? 'disabled' : '';
    const btnText = selectedCount > 0 ? `对比分析 (已选${selectedCount}篇)` : '请选择要对比的研报';

    this.bodyEl.innerHTML = `
      ${searchBoxHtml}
      <div style="margin-bottom:10px">
        <div style="font-size:12px;color:#888;margin-bottom:4px">
          关键词: ${rp.keywords.map((k: string) => `<span style="color:#e8a838">${escapeHtml(k)}</span>`).join(' · ')}
        </div>
        <div style="font-size:11px;color:#666">共找到 ${rp.total} 条相关研报，选择最多3篇进行对比</div>
      </div>
      ${groupsHtml}
      <button class="drawer-compare-btn" id="drawerCompareBtn" ${btnDisabled}>${btnText}</button>
    `;

    this._attachCompareSearchHandler();

    // Checkbox click handlers
    this.bodyEl.querySelectorAll('.drawer-compare-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.compareId || '';
        if (!id) return;
        if (this.selectedCompareIds.has(id)) {
          this.selectedCompareIds.delete(id);
        } else if (this.selectedCompareIds.size < 3) {
          this.selectedCompareIds.add(id);
        }
        this.renderBody();
      });
    });

    this.bodyEl.querySelector('#drawerCompareBtn')?.addEventListener('click', () => {
      void this.runComparison();
    });
  }

  private _attachCompareSearchHandler(): void {
    const input = this.bodyEl.querySelector('#drawerCompareSearch') as HTMLInputElement;
    const btn = this.bodyEl.querySelector('#drawerCompareSearchBtn');
    if (!input || !btn) return;

    const doSearch = () => {
      const val = input.value.trim();
      if (!val) return;
      const kws = val.split(/[,，\s]+/).filter((k: string) => k.length >= 2);
      if (kws.length > 0) {
        void this.searchRelatedReports(kws);
      }
    };

    btn.addEventListener('click', doSearch);
    input.addEventListener('keydown', (e: Event) => {
      if ((e as KeyboardEvent).key === 'Enter') doSearch();
    });
  }

  private renderCompareResult(): void {
    const r = this.compareResult!;
    const parts: string[] = [];

    // Back button
    parts.push(`<div style="margin-bottom:12px">
      <button class="drawer-compare-btn" id="drawerCompareBack" style="background:rgba(255,255,255,0.04);color:#aaa;border-color:rgba(255,255,255,0.1);padding:6px 12px;width:auto;display:inline-block;font-size:12px">
        &larr; 返回选择
      </button>
    </div>`);

    if (r.keyTakeaway) {
      parts.push(`<div class="drawer-compare-section" style="border-color:rgba(232,168,56,0.2);background:rgba(232,168,56,0.04)">
        <div class="drawer-compare-section-title" style="color:#e8a838">核心变化</div>
        <div class="drawer-compare-section-text" style="font-weight:600">${escapeHtml(r.keyTakeaway)}</div>
      </div>`);
    }

    if (r.summary) {
      parts.push(`<div class="drawer-compare-section">
        <div class="drawer-compare-section-title">对比概述</div>
        <div class="drawer-compare-section-text">${escapeHtml(r.summary)}</div>
      </div>`);
    }

    if (r.dimensions && r.dimensions.length > 0) {
      const dimCards = r.dimensions.map((d: any) => {
        const changeClass = this._getChangeClass(d.change);
        return `<div class="drawer-compare-dim-card">
          <div class="drawer-compare-dim-name">
            ${escapeHtml(d.name)}
            <span class="drawer-compare-change-badge ${changeClass}">${escapeHtml(d.change)}</span>
          </div>
          <div class="drawer-compare-dim-row">
            <span class="drawer-compare-dim-label" style="color:#ef5350">当前:</span>
            <span class="drawer-compare-dim-val">${escapeHtml(d.current)}</span>
          </div>
          <div class="drawer-compare-dim-row">
            <span class="drawer-compare-dim-label" style="color:#64B5F6">此前:</span>
            <span class="drawer-compare-dim-val">${escapeHtml(d.previous)}</span>
          </div>
          ${d.analysis ? `<div class="drawer-compare-analysis">${escapeHtml(d.analysis)}</div>` : ''}
        </div>`;
      }).join('');
      parts.push(dimCards);
    }

    if (r.newAdditions && r.newAdditions.length > 0) {
      const items = r.newAdditions.map((a: string) => `<li>${escapeHtml(a)}</li>`).join('');
      parts.push(`<div class="drawer-compare-section">
        <div class="drawer-compare-section-title" style="color:#ef5350">新增内容</div>
        <ul class="drawer-compare-list additions">${items}</ul>
      </div>`);
    }
    if (r.removals && r.removals.length > 0) {
      const items = r.removals.map((a: string) => `<li>${escapeHtml(a)}</li>`).join('');
      parts.push(`<div class="drawer-compare-section">
        <div class="drawer-compare-section-title" style="color:#43a047">不再提及</div>
        <ul class="drawer-compare-list removals">${items}</ul>
      </div>`);
    }

    if (r.toneShift) {
      parts.push(`<div class="drawer-compare-section">
        <div class="drawer-compare-section-title">基调变化</div>
        <div class="drawer-compare-section-text">${escapeHtml(r.toneShift)}</div>
      </div>`);
    }

    if (r.marketImplication) {
      parts.push(`<div class="drawer-compare-section">
        <div class="drawer-compare-section-title">市场影响</div>
        <div class="drawer-compare-section-text">${escapeHtml(r.marketImplication)}</div>
      </div>`);
    }

    this.bodyEl.innerHTML = parts.join('');

    this.bodyEl.querySelector('#drawerCompareBack')?.addEventListener('click', () => {
      this.compareResult = null;
      this.renderBody();
    });
  }

  private _getChangeClass(change: string): string {
    if (['新增', '加强'].includes(change)) return 'drawer-change-add';
    if (['删除', '减弱'].includes(change)) return 'drawer-change-remove';
    if (['不变'].includes(change)) return 'drawer-change-same';
    return 'drawer-change-adjust';
  }

  private async searchRelatedReports(customKeywords?: string[]): Promise<void> {
    if (!this.report || this.relatedLoading) return;
    this.relatedLoading = true;
    this.selectedCompareIds.clear();
    this.compareResult = null;
    this.renderBody();
    try {
      const body: Record<string, unknown> = { title: this.report.title, exclude_id: this.report.id };
      if (customKeywords && customKeywords.length > 0) {
        body.keywords = customKeywords;
      }
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/research/compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: this.abortController?.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.relatedReports = await res.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.relatedReports = { keywords: customKeywords || [], related: [], by_year: {}, total: 0 };
    } finally {
      this.relatedLoading = false;
      this.renderBody();
    }
  }

  private async runComparison(): Promise<void> {
    if (!this.report || this.compareLoading || this.selectedCompareIds.size === 0) return;

    const plainText = this.fullContent || this.report.content || this.report.summary || '';

    const compareItems = (this.relatedReports?.related || [])
      .filter((it: any) => this.selectedCompareIds.has(it.id))
      .slice(0, 3)
      .map((it: any) => ({ id: it.id, title: it.title, date: it.date }));

    this.compareLoading = true;
    this.renderBody();

    const fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: this.report.title,
        content: plainText.slice(0, 5000),
        compare_items: compareItems,
      }),
      signal: this.abortController?.signal,
      timeout: 180_000, // 180s — compare involves AI analysis
    } as RequestInit & { timeout?: number };

    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/research/compare`, fetchOpts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.compareResult = await res.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        try {
          const retry = await cnFetch(`${CN_INTEL_BASE}/api/cn/research/compare`, {
            ...fetchOpts, timeout: 20_000,
          } as RequestInit & { timeout?: number });
          if (retry.ok) {
            this.compareResult = await retry.json();
          } else {
            this.compareResult = { summary: '对比分析超时，请稍后重试。' };
          }
        } catch {
          this.compareResult = { summary: '对比分析超时，请稍后重试。' };
        }
      } else {
        this.compareResult = { summary: '对比分析失败，请稍后重试。' };
      }
    } finally {
      this.compareLoading = false;
      this.renderBody();
    }
  }

  public destroy(): void {
    this.close();
    this.overlay.remove();
  }
}

/**
 * CnReportViewer — Renders enterprise intelligence reports (5 types).
 * Includes: report viewing, scheduled generation, and report history archive.
 */
import { getUserId, cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';
import { escapeHtml } from '@/utils/sanitize';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

type ReportType = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual';
type ViewTab = 'report' | 'schedule' | 'history';
type HistoryTab = string;

interface ReportSection {
  policy_review?: {
    total: number;
    relevant: number;
    top_items: Array<{ title: string; date: string; source: string; score: number }>;
  };
  sentiment?: {
    distribution: Record<string, number>;
    top_keywords: string[];
  };
  cross_signals?: Array<{
    pattern: string;
    sector: string;
    direction: string;
    confidence: number;
    description: string;
  }>;
}

interface Report {
  type: string;
  period: string;
  generated_at: string;
  company_name?: string;
  industries?: string[];
  sections?: ReportSection;
  ai_summary: string;
  total_policies?: number;
  daily_trend?: Array<{ date: string; count: number }>;
  monthly_trend?: Array<{ month: string; count: number }>;
  quarterly_trend?: Array<{ quarter: string; count: number }>;
}

interface ReportListItem {
  type: string;
  label: string;
  description: string;
  generated_at: string | null;
  available: boolean;
}

interface ScheduleConfig {
  type: ReportType;
  enabled: boolean;
  time: string; // HH:MM
  day_of_week?: number; // 0=Mon ... 6=Sun (for weekly)
  day_of_month?: number; // 1-28 (for monthly/quarterly/annual)
}

interface HistoryItem {
  id: number;
  report_type: string;
  title: string;
  summary: string;
  risk_score: number | null;
  generated_at: string;
}

const REPORT_TYPE_CONFIG: Record<ReportType, { label: string; icon: string; color: string; desc: string }> = {
  daily: { label: '日报', icon: 'bi-sunrise', color: '#64B5F6', desc: '每日情报速览' },
  weekly: { label: '周报', icon: 'bi-calendar-week', color: '#e8a838', desc: '本周回顾分析' },
  monthly: { label: '月报', icon: 'bi-calendar-month', color: '#81C784', desc: '月度趋势洞察' },
  quarterly: { label: '季报', icon: 'bi-calendar3', color: '#BA68C8', desc: '季末战略评估' },
  annual: { label: '年报', icon: 'bi-calendar-range', color: '#FF8A65', desc: '年末全局复盘' },
};

const SCHEDULE_DEFAULTS: Record<ReportType, ScheduleConfig> = {
  daily: { type: 'daily', enabled: false, time: '08:30' },
  weekly: { type: 'weekly', enabled: false, time: '09:00', day_of_week: 0 },
  monthly: { type: 'monthly', enabled: false, time: '09:00', day_of_month: 28 },
  quarterly: { type: 'quarterly', enabled: false, time: '09:00', day_of_month: 28 },
  annual: { type: 'annual', enabled: false, time: '09:00', day_of_month: 28 },
};

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const HISTORY_TABS: { key: HistoryTab; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'daily', label: '日报' },
  { key: 'weekly', label: '周报' },
  { key: 'monthly', label: '月报' },
  { key: 'quarterly', label: '季报' },
  { key: 'annual', label: '年报' },
  { key: '_has_risk', label: '机遇和风险' },
  { key: 'morning_brief', label: '简报' },
  { key: 'industry_brief', label: '产业' },
];

/** Convert markdown to sanitized HTML. */
function markdownToHtml(md: string): string {
  if (!md) return '';
  let cleaned = md.replace(/\\([*_~`])/g, '$1');
  const raw = marked.parse(cleaned, { async: false }) as string;
  let html = DOMPurify.sanitize(raw);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return html;
}

/** Strip markdown syntax for plain-text preview in list items. */
function stripMarkdown(md: string): string {
  if (!md) return '';
  return md
    .replace(/#{1,6}\s+/g, '')          // ## headers
    .replace(/\*\*(.+?)\*\*/g, '$1')    // **bold**
    .replace(/\*(.+?)\*/g, '$1')        // *italic*
    .replace(/`(.+?)`/g, '$1')          // `code`
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // [link](url)
    .replace(/^[-*+]\s+/gm, '')         // list markers
    .replace(/^\d+\.\s+/gm, '')         // numbered list
    .replace(/^>\s+/gm, '')             // blockquote
    .replace(/\n{2,}/g, ' ')            // collapse multiple newlines
    .replace(/\n/g, ' ')                // newlines → spaces
    .trim();
}

/** Render simple bar chart for trend data. */
function _renderTrendBars(items: any[], labelKey: string, valKey: string): string {
  if (!items?.length) return '';
  const maxVal = Math.max(...items.map(i => i[valKey] || 0), 1);
  return items.map(i => {
    const v = i[valKey] || 0;
    const h = Math.max(Math.round((v / maxVal) * 60), 2);
    const label = String(i[labelKey] || '').replace(/^\d{4}-/, '');
    return `<div class="cn-hist-trend-col">
      <div class="cn-hist-trend-val">${v}</div>
      <div class="cn-hist-trend-bar" style="height:${h}px"></div>
      <div class="cn-hist-trend-label">${escapeHtml(label)}</div>
    </div>`;
  }).join('');
}

const VIEWER_STYLE = `<style>
@layer base {
.cn-report-viewer {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,0.75); display: flex; align-items: center; justify-content: center;
  backdrop-filter: blur(4px);
}
.cn-report-content {
  background: #141422; border: 1px solid rgba(232,168,56,0.25); border-radius: 8px;
  width: 98vw; max-width: 98vw; height: 96vh; overflow-y: auto;
  padding: 32px 48px; color: #e0e0e0; font-size: 14px; scroll-behavior: smooth;
  box-shadow: 0 20px 60px rgba(0,0,0,0.5);
}
.cn-report-content::-webkit-scrollbar { width: 6px; }
.cn-report-content::-webkit-scrollbar-track { background: transparent; }
.cn-report-content::-webkit-scrollbar-thumb { background: rgba(232,168,56,0.2); border-radius: 3px; }
/* Header */
.cn-report-top {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px;
  padding-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.06);
}
.cn-report-title {
  font-size: 22px; font-weight: 700; color: #e8a838;
  display: flex; align-items: center; gap: 10px;
}
.cn-report-title i { font-size: 24px; }
.cn-report-actions { display: flex; gap: 8px; align-items: center; }
.cn-report-action-btn {
  padding: 6px 14px; border-radius: 8px; font-size: 12px; cursor: pointer; border: none;
  background: rgba(255,255,255,0.06); color: #aaa; transition: all .15s; text-decoration: none;
  display: inline-flex; align-items: center; gap: 4px;
}
.cn-report-action-btn:hover { background: rgba(255,255,255,0.12); color: #ccc; }
.cn-report-action-btn.primary {
  background: rgba(232,168,56,0.15); color: #e8a838; border: 1px solid rgba(232,168,56,0.3);
}
.cn-report-action-btn.primary:hover { background: rgba(232,168,56,0.25); }
.cn-report-close-btn { font-size: 14px; font-weight: 600; padding: 6px 16px; }
/* Report meta */
.cn-report-period {
  font-size: 13px; color: #999; margin-bottom: 16px;
  display: flex; align-items: center; gap: 10px;
}
.cn-report-company { font-size: 14px; color: #ccc; margin-bottom: 4px; font-weight: 500; }
.cn-report-industries { font-size: 12px; color: #888; margin-bottom: 16px; }
/* Tab bar for report/schedule/history toggle */
.cn-report-tab-bar {
  display: flex; gap: 0; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.08);
}
.cn-report-tab {
  padding: 10px 20px; font-size: 13px; font-weight: 600; cursor: pointer;
  color: #888; border-bottom: 2px solid transparent; transition: all .2s;
  display: flex; align-items: center; gap: 6px; background: none; border-top: none; border-left: none; border-right: none;
}
.cn-report-tab:hover { color: #ccc; }
.cn-report-tab.active { color: #e8a838; border-bottom-color: #e8a838; }
.cn-report-tab i { font-size: 14px; }
/* Report type selector */
.cn-report-type-grid {
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 20px;
}
.cn-report-type-card {
  padding: 16px 10px; border-radius: 12px; text-align: center; cursor: pointer;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
  transition: all .2s; position: relative;
}
.cn-report-type-card:hover {
  background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.12);
  transform: translateY(-1px);
}
.cn-report-type-card.active {
  border-color: rgba(232,168,56,0.5); background: rgba(232,168,56,0.08);
  box-shadow: 0 0 12px rgba(232,168,56,0.1);
}
.cn-report-type-icon { font-size: 24px; margin-bottom: 6px; }
.cn-report-type-label { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
.cn-report-type-desc { font-size: 10px; color: #666; margin-bottom: 4px; }
.cn-report-type-time { font-size: 10px; color: #777; margin-top: 4px; }
.cn-report-type-badge {
  display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; margin-top: 6px;
}
.cn-report-type-badge.ready { background: rgba(76,175,80,0.15); color: #66bb6a; }
.cn-report-type-badge.pending { background: rgba(255,255,255,0.06); color: #888; }
/* Section cards */
.cn-report-section {
  margin-bottom: 20px; padding: 18px 20px; border-radius: 12px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
}
.cn-report-section-title {
  font-size: 15px; font-weight: 600; color: #e8a838; margin-bottom: 14px;
  padding-bottom: 8px; border-bottom: 1px solid rgba(232,168,56,0.15);
  display: flex; align-items: center; gap: 8px;
}
.cn-report-section-title i { font-size: 16px; }
/* AI summary markdown body */
.cn-report-ai-body {
  line-height: 1.9; font-size: 14px;
}
.cn-report-ai-body h1, .cn-report-ai-body h2 {
  color: #e8a838; font-size: 16px; font-weight: 700; margin: 20px 0 10px 0;
  padding-bottom: 6px; border-bottom: 1px solid rgba(232,168,56,0.15);
}
.cn-report-ai-body h3 {
  color: #ddd; font-size: 15px; font-weight: 600; margin: 16px 0 8px 0;
}
.cn-report-ai-body h4 {
  color: #ccc; font-size: 14px; font-weight: 600; margin: 12px 0 6px 0;
}
.cn-report-ai-body ul, .cn-report-ai-body ol {
  padding-left: 22px; margin: 8px 0;
}
.cn-report-ai-body li { margin-bottom: 6px; line-height: 1.7; }
.cn-report-ai-body strong { color: #e8a838; }
.cn-report-ai-body em { color: #aaa; font-style: italic; }
.cn-report-ai-body table {
  width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px;
}
.cn-report-ai-body table th, .cn-report-ai-body table td {
  padding: 8px 10px; border: 1px solid rgba(255,255,255,0.08); text-align: left;
}
.cn-report-ai-body table th { background: rgba(255,255,255,0.04); color: #e8a838; font-weight: 600; }
.cn-report-ai-body blockquote {
  border-left: 3px solid rgba(232,168,56,0.4); margin: 10px 0; padding: 8px 16px;
  color: #bbb; background: rgba(255,255,255,0.02); border-radius: 0 8px 8px 0;
  font-size: 13px;
}
.cn-report-ai-body code {
  background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; font-size: 13px;
}
.cn-report-ai-body p { margin: 8px 0; }
/* Data tables */
.cn-report-table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
.cn-report-table th, .cn-report-table td {
  padding: 8px 10px; border: 1px solid rgba(255,255,255,0.06); text-align: left;
}
.cn-report-table th { background: rgba(255,255,255,0.04); color: #e8a838; font-weight: 600; }
.cn-report-table td { color: #ccc; }
/* Sentiment bar */
.cn-report-sentiment-bar {
  display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin: 10px 0;
}
.cn-report-sentiment-pos { background: #4caf50; }
.cn-report-sentiment-neu { background: #78909c; }
.cn-report-sentiment-neg { background: #ef5350; }
.cn-report-sentiment-labels {
  display: flex; gap: 20px; font-size: 12px; color: #999; margin-bottom: 8px;
}
.cn-report-sentiment-labels span { display: flex; align-items: center; gap: 6px; }
.cn-report-sentiment-labels .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
/* Keywords */
.cn-report-keyword-wrap { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.cn-report-keyword-tag {
  padding: 3px 10px; border-radius: 12px; font-size: 12px;
  background: rgba(255,255,255,0.05); color: #bbb; border: 1px solid rgba(255,255,255,0.06);
}
.cn-report-loading {
  text-align: center; color: #888; padding: 40px;
  display: flex; flex-direction: column; align-items: center; gap: 12px; font-size: 13px;
}
.cn-report-loading i { font-size: 20px; }
/* Schedule panel */
.cn-report-schedule-panel {
  display: flex; flex-direction: column; gap: 12px;
}
.cn-report-schedule-row {
  display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-radius: 10px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
  transition: all .15s;
}
.cn-report-schedule-row:hover { background: rgba(255,255,255,0.04); }
.cn-sched-icon { font-size: 20px; width: 32px; text-align: center; flex-shrink: 0; }
.cn-sched-info { flex: 1; min-width: 0; }
.cn-sched-label { font-size: 14px; font-weight: 600; color: #e0e0e0; }
.cn-sched-desc { font-size: 11px; color: #888; margin-top: 2px; }
.cn-sched-controls { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
/* Dark-themed form controls */
.cn-sched-select {
  padding: 5px 10px; border-radius: 6px; font-size: 12px; cursor: pointer;
  background: #1a1a2e; border: 1px solid rgba(232,168,56,0.2);
  color: #e0e0e0; appearance: none; -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 8px center;
  padding-right: 22px; color-scheme: dark;
}
.cn-sched-select:focus { outline: none; border-color: rgba(232,168,56,0.5); }
.cn-sched-select:hover { border-color: rgba(232,168,56,0.35); }
.cn-sched-select option { background: #1a1a2e; color: #e0e0e0; }
.cn-sched-time-group {
  display: flex; align-items: center; gap: 2px;
}
.cn-sched-time-group .cn-sched-select { padding-right: 22px; min-width: 52px; text-align: center; }
.cn-sched-time-sep { color: #e8a838; font-weight: 700; font-size: 14px; margin: 0 1px; }
.cn-sched-toggle {
  position: relative; width: 36px; height: 20px; border-radius: 10px;
  background: rgba(255,255,255,0.1); cursor: pointer; transition: all .2s;
  border: none; padding: 0; flex-shrink: 0;
}
.cn-sched-toggle.on { background: rgba(232,168,56,0.5); }
.cn-sched-toggle::after {
  content: ''; position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; border-radius: 50%; background: #fff;
  transition: transform .2s;
}
.cn-sched-toggle.on::after { transform: translateX(16px); }
.cn-sched-status { font-size: 11px; color: #666; min-width: 40px; text-align: center; }
.cn-sched-status.on { color: #e8a838; }
.cn-report-schedule-note {
  font-size: 11px; color: #666; text-align: center; padding: 8px;
  border-top: 1px solid rgba(255,255,255,0.04); margin-top: 4px;
}
.cn-report-schedule-save {
  padding: 8px 24px; border-radius: 8px; font-size: 13px; font-weight: 600;
  cursor: pointer; border: 1px solid rgba(232,168,56,0.3);
  background: rgba(232,168,56,0.15); color: #e8a838; transition: all .15s;
  align-self: center; margin-top: 4px;
}
.cn-report-schedule-save:hover { background: rgba(232,168,56,0.25); }
/* History tab */
.cn-hist-tabs { display: flex; gap: 6px; margin-bottom: 16px; }
.cn-hist-tab {
  padding: 6px 14px; border-radius: 16px; font-size: 12px; cursor: pointer; font-weight: 500;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); color: #999;
  transition: all .15s;
}
.cn-hist-tab:hover { color: #ccc; background: rgba(255,255,255,0.06); }
.cn-hist-tab.active { background: rgba(232,168,56,0.15); color: #e8a838; border-color: rgba(232,168,56,0.3); }
.cn-hist-item {
  padding: 14px 16px; border-radius: 10px; margin-bottom: 8px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
  transition: all .15s; cursor: pointer;
}
.cn-hist-item:hover { border-color: rgba(232,168,56,0.25); background: rgba(255,255,255,0.04); }
.cn-hist-item-date { font-size: 11px; color: #888; margin-bottom: 4px; }
.cn-hist-item-title { font-size: 14px; color: #ddd; font-weight: 600; margin-bottom: 4px; }
.cn-hist-item-summary { font-size: 12px; color: #999; line-height: 1.5; }
.cn-hist-item-footer { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.cn-hist-score {
  font-size: 10px; padding: 2px 8px; border-radius: 8px; font-weight: 600;
}
.cn-hist-btn {
  padding: 4px 12px; border-radius: 6px; font-size: 11px; cursor: pointer;
  background: rgba(232,168,56,0.1); color: #e8a838; border: 1px solid rgba(232,168,56,0.2);
  transition: all .15s; display: inline-flex; align-items: center; gap: 4px;
}
.cn-hist-btn:hover { background: rgba(232,168,56,0.2); }
.cn-hist-back-btn {
  padding: 5px 14px; border-radius: 6px; font-size: 12px; cursor: pointer;
  background: rgba(255,255,255,0.04); color: #aaa; border: 1px solid rgba(255,255,255,0.08);
  display: inline-flex; align-items: center; gap: 4px; transition: all .15s;
}
.cn-hist-back-btn:hover { color: #ddd; background: rgba(255,255,255,0.08); }
.cn-hist-detail-header {
  display: flex; gap: 8px; align-items: center; margin-bottom: 14px;
  padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.06);
}
.cn-hist-detail-body { line-height: 1.8; font-size: 13px; color: #ccc; }
.cn-hist-detail-body .cn-exec-section {
  display: flex; gap: 10px; align-items: flex-start; margin-bottom: 10px;
}
.cn-hist-detail-body .cn-exec-label {
  flex-shrink: 0; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 600;
}
.cn-hist-detail-body .cn-exec-label-situation { background: rgba(100,181,246,0.15); color: #64B5F6; }
.cn-hist-detail-body .cn-exec-label-impact { background: rgba(255,167,38,0.15); color: #ffa726; }
.cn-hist-detail-body .cn-exec-label-direction { background: rgba(129,199,132,0.15); color: #81C784; }
.cn-hist-empty {
  text-align: center; padding: 40px 20px; color: #888;
}
.cn-hist-empty i { font-size: 32px; color: #555; margin-bottom: 10px; display: block; }
/* History detail: banner, sections, cards */
.cn-hist-detail-banner {
  display: flex; align-items: center; gap: 14px; margin-bottom: 20px; padding: 16px 20px;
  border-radius: 12px; background: rgba(255,255,255,0.03);
  border: 1px solid rgba(232,168,56,0.2);
}
.cn-hist-highlight {
  font-size:15px; font-weight:700; color:#e8a838; margin-bottom:12px;
  padding:12px 16px; border-radius:10px; background:rgba(232,168,56,0.08);
  border-left: 3px solid rgba(232,168,56,0.4);
}
.cn-hist-section {
  margin-bottom: 18px; padding: 16px 18px; border-radius: 10px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
}
.cn-hist-section-title {
  font-size: 14px; font-weight: 600; margin-bottom: 12px; padding-bottom: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  display: flex; align-items: center; gap: 8px;
}
.cn-hist-section-title i { font-size: 15px; }
.cn-hist-card {
  padding: 10px 14px; margin-bottom: 8px; border-radius: 8px;
  background: rgba(255,255,255,0.02); border-left: 3px solid rgba(255,255,255,0.1);
}
.cn-hist-card:last-child { margin-bottom: 0; }
/* Trend bars */
.cn-hist-trend-bar-wrap {
  display: flex; align-items: flex-end; gap: 3px; height: 80px; padding: 8px 0;
}
.cn-hist-trend-col {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 0;
}
.cn-hist-trend-bar {
  width: 100%; max-width: 28px; border-radius: 3px 3px 0 0; background: rgba(232,168,56,0.35);
  transition: height .3s; min-height: 2px;
}
.cn-hist-trend-label { font-size: 9px; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; text-align: center; }
.cn-hist-trend-val { font-size: 9px; color: #aaa; }
/* Summary text in list — max 2 lines */
.cn-hist-item-summary { max-height: 2.8em; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
@media print {
  .cn-report-viewer { position: static; background: none; backdrop-filter: none; }
  .cn-report-content { max-height: none; border: none; width: 100%; box-shadow: none; }
}
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
} /* @layer base */
</style>`;

let _viewerEl: HTMLElement | null = null;
let _reportList: ReportListItem[] = [];
let _currentType: ReportType = 'weekly';
let _currentTab: ViewTab = 'report';
let _schedules: Record<ReportType, ScheduleConfig> = { ...SCHEDULE_DEFAULTS };

// History state
let _historyTab: HistoryTab = '';
let _historyItems: HistoryItem[] = [];
let _historyLoading = false;
let _historyViewingId: number | null = null;
let _historyViewingContent: any = null;
let _historyViewingLoading = false;

export async function openReportViewer(type: ReportType = 'weekly'): Promise<void> {
  if (_viewerEl) return;
  _currentType = type;
  _currentTab = 'report';

  _viewerEl = document.createElement('div');
  _viewerEl.innerHTML = VIEWER_STYLE + '<div class="cn-report-viewer"><div class="cn-report-content"><div class="cn-report-loading"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i><span>加载报告列表...</span></div></div></div>';
  document.body.appendChild(_viewerEl);

  // Close on overlay click
  _viewerEl.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('cn-report-viewer')) {
      _close();
    }
  });

  // ESC to close
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { _close(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);

  // Fetch report list + schedules in parallel
  const uid = getUserId();
  const [listResult, schedResult] = await Promise.allSettled([
    cnFetch(`${CN_INTEL_BASE}/api/cn/enterprise/reports/list?user_id=${encodeURIComponent(uid)}`).then(r => r.ok ? r.json() : null),
    cnFetch(`${CN_INTEL_BASE}/api/cn/enterprise/schedules?user_id=${encodeURIComponent(uid)}`).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);

  if (listResult.status === 'fulfilled' && listResult.value) {
    _reportList = listResult.value.reports || [];
  }
  if (schedResult.status === 'fulfilled' && schedResult.value?.schedules) {
    const saved = schedResult.value.schedules as ScheduleConfig[];
    for (const s of saved) {
      if (_schedules[s.type]) {
        _schedules[s.type] = { ..._schedules[s.type], ...s };
      }
    }
  }

  // Render type selector and load the specified report
  _renderSelector();
  _loadReport(type);
}

function _close(): void {
  if (_viewerEl) {
    _viewerEl.remove();
    _viewerEl = null;
  }
  // Reset all module-level state to prevent cross-session pollution
  _reportList = [];
  _currentType = 'weekly';
  _currentTab = 'report';
  _schedules = { ...SCHEDULE_DEFAULTS };
  _historyTab = '';
  _historyItems = [];
  _historyLoading = false;
  _historyViewingId = null;
  _historyViewingContent = null;
  _historyViewingLoading = false;
}

function _renderSelector(): void {
  if (!_viewerEl) return;
  const content = _viewerEl.querySelector('.cn-report-content');
  if (!content) return;

  const types: ReportType[] = ['daily', 'weekly', 'monthly', 'quarterly', 'annual'];
  const cards = types.map(t => {
    const cfg = REPORT_TYPE_CONFIG[t];
    const listItem = _reportList.find(r => r.type === t);
    const active = t === _currentType ? ' active' : '';
    const time = listItem?.generated_at ? listItem.generated_at.split('T')[0] : '';
    const badge = listItem?.available
      ? '<span class="cn-report-type-badge ready">已生成</span>'
      : '<span class="cn-report-type-badge pending">待生成</span>';

    return `<div class="cn-report-type-card${active}" data-rtype="${t}">
      <div class="cn-report-type-icon" style="color:${cfg.color}"><i class="bi ${cfg.icon}"></i></div>
      <div class="cn-report-type-label">${cfg.label}</div>
      <div class="cn-report-type-desc">${cfg.desc}</div>
      ${time ? `<div class="cn-report-type-time">${time}</div>` : ''}
      ${badge}
    </div>`;
  }).join('');

  const tabActive = (t: ViewTab) => t === _currentTab ? ' active' : '';

  content.innerHTML = `
    <div class="cn-report-top">
      <span class="cn-report-title"><i class="bi bi-file-earmark-bar-graph"></i> 企业情报报告</span>
      <div class="cn-report-actions">
        <button class="cn-report-action-btn cn-report-pdf-btn"><i class="bi bi-file-pdf"></i> 导出PDF</button>
        <button class="cn-report-action-btn cn-report-close-btn">&times; 关闭</button>
      </div>
    </div>
    <div class="cn-report-tab-bar">
      <button class="cn-report-tab cn-tab-report${tabActive('report')}" data-tab="report"><i class="bi bi-file-earmark-text"></i> 报告查看</button>
      <button class="cn-report-tab cn-tab-schedule${tabActive('schedule')}" data-tab="schedule"><i class="bi bi-clock"></i> 定时生成</button>
      <button class="cn-report-tab cn-tab-history${tabActive('history')}" data-tab="history"><i class="bi bi-clock-history"></i> 历史报告</button>
    </div>
    <div class="cn-report-type-grid">${cards}</div>
    <div class="cn-report-body"><div class="cn-report-loading"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i><span>加载报告中...</span></div></div>`;

  // Close button
  content.querySelector('.cn-report-close-btn')?.addEventListener('click', _close);

  // PDF export button
  content.querySelector('.cn-report-pdf-btn')?.addEventListener('click', async () => {
    const body = content.querySelector('.cn-report-body') as HTMLElement | null;
    if (!body) return;
    const btn = content.querySelector('.cn-report-pdf-btn') as HTMLElement;
    if (btn) btn.textContent = '导出中...';
    try {
      const { exportToPDF } = await import('@/utils/pdf-export');
      const date = new Date().toISOString().slice(0, 10);
      await exportToPDF(body, `企业情报报告-${date}`);
    } catch { /* silent */ }
    if (btn) btn.innerHTML = '<i class="bi bi-file-pdf"></i> 导出PDF';
  });

  // Tab switching
  content.querySelectorAll('.cn-report-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = (tab as HTMLElement).dataset.tab as ViewTab;
      if (tabName === _currentTab) return;
      _currentTab = tabName;
      content.querySelectorAll('.cn-report-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const typeGrid = content.querySelector('.cn-report-type-grid') as HTMLElement;
      const body = content.querySelector('.cn-report-body') as HTMLElement;

      if (tabName === 'schedule') {
        if (typeGrid) typeGrid.style.display = 'none';
        _renderSchedulePanel(body);
      } else if (tabName === 'history') {
        if (typeGrid) typeGrid.style.display = 'none';
        _historyViewingId = null;
        _historyViewingContent = null;
        _renderHistoryPanel(body);
        _fetchHistory();
      } else {
        if (typeGrid) typeGrid.style.display = '';
        _loadReport(_currentType);
      }
    });
  });

  // Type card click
  content.querySelectorAll('.cn-report-type-card').forEach(card => {
    card.addEventListener('click', () => {
      const t = (card as HTMLElement).dataset.rtype as ReportType;
      if (t && t !== _currentType) {
        _currentType = t;
        content.querySelectorAll('.cn-report-type-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        if (_currentTab === 'report') {
          _loadReport(t);
        }
      }
    });
  });

  // If schedule or history tab was active when re-rendering
  if (_currentTab === 'schedule') {
    const typeGrid = content.querySelector('.cn-report-type-grid') as HTMLElement;
    const body = content.querySelector('.cn-report-body') as HTMLElement;
    if (typeGrid) typeGrid.style.display = 'none';
    _renderSchedulePanel(body);
  } else if (_currentTab === 'history') {
    const typeGrid = content.querySelector('.cn-report-type-grid') as HTMLElement;
    const body = content.querySelector('.cn-report-body') as HTMLElement;
    if (typeGrid) typeGrid.style.display = 'none';
    _renderHistoryPanel(body);
    _fetchHistory();
  }
}

async function _loadReport(type: ReportType): Promise<void> {
  if (!_viewerEl) return;
  const body = _viewerEl.querySelector('.cn-report-body');
  if (!body) return;

  const listItem = _reportList.find(r => r.type === type);

  // Not yet generated → guide to schedule
  if (!listItem?.available) {
    const cfg = REPORT_TYPE_CONFIG[type];
    body.innerHTML = `<div class="cn-report-loading" style="gap:16px;padding:60px 20px">
      <i class="bi ${cfg.icon}" style="font-size:32px;color:${cfg.color};opacity:0.5"></i>
      <span style="font-size:15px;color:#ccc">${cfg.label}尚未生成</span>
      <span style="font-size:12px;color:#888;line-height:1.6;max-width:400px;text-align:center">
        报告由系统按定时计划自动生成并归档。<br>请在「定时生成」中配置${cfg.label}的生成时间。
      </span>
      <div style="display:flex;gap:10px;margin-top:8px">
        <button class="cn-report-action-btn primary cn-goto-schedule"><i class="bi bi-clock"></i> 前往定时生成</button>
        <button class="cn-report-action-btn cn-generate-once" data-type="${type}"><i class="bi bi-play-circle"></i> 立即生成一次</button>
      </div>
    </div>`;
    body.querySelector('.cn-goto-schedule')?.addEventListener('click', () => {
      const schedTab = _viewerEl?.querySelector('[data-tab="schedule"]') as HTMLElement;
      schedTab?.click();
    });
    body.querySelector('.cn-generate-once')?.addEventListener('click', () => {
      _generateReport(type);
    });
    return;
  }

  body.innerHTML = '<div class="cn-report-loading"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i><span>加载报告...</span></div>';

  const uid = getUserId();
  try {
    const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/enterprise/report/${type}?user_id=${encodeURIComponent(uid)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const report: Report = await res.json();
    _renderReportBody(report, body as HTMLElement);
  } catch {
    body.innerHTML = `<div class="cn-report-loading">
      <i class="bi bi-exclamation-triangle" style="font-size:24px;color:#FF8A65"></i>
      <span>报告加载失败，请稍后重试</span>
    </div>`;
  }
}

/** One-time manual generation for a report type. */
async function _generateReport(type: ReportType): Promise<void> {
  if (!_viewerEl) return;
  const body = _viewerEl.querySelector('.cn-report-body');
  if (!body) return;

  body.innerHTML = '<div class="cn-report-loading"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i><span>正在生成报告，请稍候（约30-60秒）...</span></div>';

  const uid = getUserId();
  try {
    const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/enterprise/report/${type}?user_id=${encodeURIComponent(uid)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const report: Report = await res.json();
    // Update report list to reflect availability
    const existing = _reportList.find(r => r.type === type);
    if (existing) {
      existing.available = true;
      existing.generated_at = report.generated_at || new Date().toISOString();
    }
    // Update the card badge
    const card = _viewerEl?.querySelector(`.cn-report-type-card[data-rtype="${type}"]`);
    if (card) {
      card.classList.add('active');
      const badge = card.querySelector('.cn-report-type-badge');
      if (badge) {
        badge.className = 'cn-report-type-badge ready';
        badge.textContent = '已生成';
      }
    }
    _renderReportBody(report, body as HTMLElement);
  } catch {
    body.innerHTML = `<div class="cn-report-loading">
      <i class="bi bi-exclamation-triangle" style="font-size:24px;color:#FF8A65"></i>
      <span>报告生成失败，请稍后重试</span>
    </div>`;
  }
}

function _renderReportBody(report: Report, container: HTMLElement): void {
  const cfg = REPORT_TYPE_CONFIG[report.type as ReportType] || REPORT_TYPE_CONFIG.weekly;
  const sections = report.sections || {};
  const uid = getUserId();

  // Company info
  const companyName = report.company_name || '';
  const industries = report.industries || [];
  const companyHtml = companyName ? `<div class="cn-report-company"><i class="bi bi-building" style="color:#e8a838;margin-right:6px"></i>${escapeHtml(companyName)}</div>` : '';
  const industryHtml = industries.length ? `<div class="cn-report-industries"><i class="bi bi-tag" style="margin-right:4px"></i>行业: ${industries.map(i => escapeHtml(i)).join(' / ')}</div>` : '';

  // AI summary -> rendered markdown
  const aiBodyHtml = markdownToHtml(report.ai_summary || '');

  // Policy table
  let policySection = '';
  const policyItems = sections.policy_review?.top_items || [];
  if (policyItems.length) {
    const policyRows = policyItems.map(p =>
      `<tr><td>${escapeHtml(p.date)}</td><td>${escapeHtml(p.title)}</td><td>${escapeHtml(p.source)}</td></tr>`
    ).join('');
    policySection = `<div class="cn-report-section">
      <div class="cn-report-section-title"><i class="bi bi-file-earmark-ruled"></i> 重点政策 (${sections.policy_review?.relevant || 0}/${sections.policy_review?.total || 0})</div>
      <table class="cn-report-table"><tr><th>日期</th><th>标题</th><th>来源</th></tr>${policyRows}</table>
    </div>`;
  }

  // Sentiment
  let sentimentSection = '';
  const dist = sections.sentiment?.distribution || {};
  const pos = dist.positive || 0;
  const neg = dist.negative || 0;
  const neu = dist.neutral || 0;
  const sentTotal = pos + neg + neu || 1;
  if (sentTotal > 1) {
    const keywords = sections.sentiment?.top_keywords || [];
    const keywordsHtml = keywords.map(k => `<span class="cn-report-keyword-tag">${escapeHtml(k)}</span>`).join('');
    sentimentSection = `<div class="cn-report-section">
      <div class="cn-report-section-title"><i class="bi bi-emoji-neutral"></i> 行业舆情概况</div>
      <div class="cn-report-sentiment-labels">
        <span><span class="dot" style="background:#4caf50"></span> 正面 ${pos}</span>
        <span><span class="dot" style="background:#78909c"></span> 中性 ${neu}</span>
        <span><span class="dot" style="background:#ef5350"></span> 负面 ${neg}</span>
      </div>
      <div class="cn-report-sentiment-bar">
        <div class="cn-report-sentiment-pos" style="width:${(pos/sentTotal*100).toFixed(1)}%"></div>
        <div class="cn-report-sentiment-neu" style="width:${(neu/sentTotal*100).toFixed(1)}%"></div>
        <div class="cn-report-sentiment-neg" style="width:${(neg/sentTotal*100).toFixed(1)}%"></div>
      </div>
      ${keywordsHtml ? `<div class="cn-report-keyword-wrap">${keywordsHtml}</div>` : ''}
    </div>`;
  }

  // Signals
  let signalsSection = '';
  const signals = sections.cross_signals || [];
  if (signals.length) {
    const signalRows = signals.map(s =>
      `<tr><td>${escapeHtml(s.pattern)}</td><td>${escapeHtml(s.sector)}</td><td>${s.direction}</td><td>${(s.confidence*100).toFixed(0)}%</td><td style="font-size:12px;color:#aaa">${escapeHtml(s.description || '')}</td></tr>`
    ).join('');
    signalsSection = `<div class="cn-report-section">
      <div class="cn-report-section-title"><i class="bi bi-diagram-3"></i> 跨域关联信号</div>
      <table class="cn-report-table"><tr><th>模式</th><th>板块</th><th>方向</th><th>置信度</th><th>说明</th></tr>${signalRows}</table>
    </div>`;
  }

  // Total policies stat
  const totalPolicies = report.total_policies || 0;
  const statHtml = totalPolicies
    ? `<div style="font-size:12px;color:#888;margin-bottom:14px"><i class="bi bi-file-text" style="margin-right:4px"></i>涉及政策: ${totalPolicies}条</div>`
    : '';

  container.innerHTML = `
    ${companyHtml}
    <div class="cn-report-period">
      <span style="color:${cfg.color};font-weight:600"><i class="bi ${cfg.icon}"></i> ${cfg.label}</span>
      <span style="color:#999">${escapeHtml(report.period)}</span>
      <span style="color:#666">|</span>
      <span style="color:#777">${escapeHtml(report.generated_at || '')}</span>
      <a class="cn-report-action-btn primary" style="margin-left:auto;font-size:12px;text-decoration:none"
         href="${CN_INTEL_BASE}/api/cn/enterprise/export?type=${report.type}&user_id=${encodeURIComponent(uid)}"
         target="_blank"><i class="bi bi-download"></i> 导出HTML</a>
    </div>
    ${industryHtml}
    ${statHtml}
    <div class="cn-report-section">
      <div class="cn-report-section-title"><i class="bi bi-cpu"></i> AI 情报分析</div>
      <div class="cn-report-ai-body">${aiBodyHtml}</div>
    </div>
    ${policySection}
    ${sentimentSection}
    ${signalsSection}`;
}

function _renderSchedulePanel(container: HTMLElement): void {
  const types: ReportType[] = ['daily', 'weekly', 'monthly', 'quarterly', 'annual'];

  const rows = types.map(t => {
    const cfg = REPORT_TYPE_CONFIG[t];
    const sched = _schedules[t];
    const onClass = sched.enabled ? ' on' : '';
    const statusText = sched.enabled ? '已开启' : '未开启';
    const statusClass = sched.enabled ? ' on' : '';

    let extraControls = '';
    if (t === 'weekly') {
      const weekOpts = WEEKDAY_LABELS.map((d, i) =>
        `<option value="${i}"${sched.day_of_week === i ? ' selected' : ''}>${d}</option>`
      ).join('');
      extraControls = `<select class="cn-sched-select" data-field="day_of_week" data-type="${t}">${weekOpts}</select>`;
    } else if (t === 'monthly' || t === 'quarterly' || t === 'annual') {
      const dayLabel = t === 'monthly' ? '每月' : t === 'quarterly' ? '季末月(3/6/9/12)' : '每年12月';
      const dayOpts = Array.from({ length: 28 }, (_, i) =>
        `<option value="${i + 1}"${sched.day_of_month === (i + 1) ? ' selected' : ''}>${i + 1}日</option>`
      ).join('');
      extraControls = `<span style="font-size:11px;color:#888">${dayLabel}</span><select class="cn-sched-select" data-field="day_of_month" data-type="${t}">${dayOpts}</select>`;
    }

    const [hh, mm] = sched.time.split(':');
    const hourOpts = Array.from({ length: 24 }, (_, i) => {
      const v = String(i).padStart(2, '0');
      return `<option value="${v}"${v === hh ? ' selected' : ''}>${v}</option>`;
    }).join('');
    const minOpts = Array.from({ length: 12 }, (_, i) => {
      const v = String(i * 5).padStart(2, '0');
      return `<option value="${v}"${v === mm ? ' selected' : ''}>${v}</option>`;
    }).join('');
    const timeHtml = `<div class="cn-sched-time-group">
      <select class="cn-sched-select" data-field="hour" data-type="${t}">${hourOpts}</select>
      <span class="cn-sched-time-sep">:</span>
      <select class="cn-sched-select" data-field="minute" data-type="${t}">${minOpts}</select>
    </div>`;

    return `<div class="cn-report-schedule-row" data-sched-type="${t}">
      <div class="cn-sched-icon" style="color:${cfg.color}"><i class="bi ${cfg.icon}"></i></div>
      <div class="cn-sched-info">
        <div class="cn-sched-label">${cfg.label}</div>
        <div class="cn-sched-desc">${cfg.desc}</div>
      </div>
      <div class="cn-sched-controls">
        ${extraControls}
        ${timeHtml}
        <button class="cn-sched-toggle${onClass}" data-type="${t}" title="开关定时"></button>
        <span class="cn-sched-status${statusClass}">${statusText}</span>
      </div>
    </div>`;
  }).join('');

  container.innerHTML = `
    <div class="cn-report-schedule-panel">
      <div style="font-size:13px;color:#999;margin-bottom:4px"><i class="bi bi-info-circle" style="margin-right:4px"></i>设置定时自动生成报告，到达指定时间后系统将自动生成并归档</div>
      ${rows}
      <button class="cn-report-schedule-save cn-sched-save-btn"><i class="bi bi-check-lg"></i> 保存设置</button>
      <div class="cn-report-schedule-note">定时任务由服务端执行，保存后即刻生效。生成的报告将自动归档到「历史报告」中。</div>
    </div>`;

  // Toggle handlers
  container.querySelectorAll('.cn-sched-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = (btn as HTMLElement).dataset.type as ReportType;
      _schedules[t].enabled = !_schedules[t].enabled;
      btn.classList.toggle('on');
      const statusEl = btn.nextElementSibling;
      if (statusEl) {
        statusEl.textContent = _schedules[t].enabled ? '已开启' : '未开启';
        statusEl.classList.toggle('on', _schedules[t].enabled);
      }
    });
  });

  // Select handlers (hour, minute, day_of_week, day_of_month)
  container.querySelectorAll('.cn-sched-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const t = (sel as HTMLSelectElement).dataset.type as ReportType;
      const field = (sel as HTMLSelectElement).dataset.field as string;
      const val = (sel as HTMLSelectElement).value;
      if (field === 'hour') {
        const [, mm] = _schedules[t].time.split(':');
        _schedules[t].time = `${val}:${mm}`;
      } else if (field === 'minute') {
        const [hh] = _schedules[t].time.split(':');
        _schedules[t].time = `${hh}:${val}`;
      } else if (field === 'day_of_week') {
        _schedules[t].day_of_week = parseInt(val);
      } else if (field === 'day_of_month') {
        _schedules[t].day_of_month = parseInt(val);
      }
    });
  });

  // Save button
  container.querySelector('.cn-sched-save-btn')?.addEventListener('click', async () => {
    const saveBtn = container.querySelector('.cn-sched-save-btn') as HTMLButtonElement;
    if (!saveBtn) return;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 保存中...';

    const uid = getUserId();
    const schedList = Object.values(_schedules);

    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/enterprise/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: uid, schedules: schedList }),
      });
      if (res.ok) {
        saveBtn.innerHTML = '<i class="bi bi-check-lg"></i> 已保存';
        saveBtn.style.color = '#66bb6a';
        saveBtn.style.borderColor = 'rgba(76,175,80,0.3)';
        setTimeout(() => {
          saveBtn.innerHTML = '<i class="bi bi-check-lg"></i> 保存设置';
          saveBtn.style.color = '';
          saveBtn.style.borderColor = '';
          saveBtn.disabled = false;
        }, 2000);
      } else {
        throw new Error('save failed');
      }
    } catch {
      saveBtn.innerHTML = '<i class="bi bi-exclamation-triangle"></i> 保存失败';
      saveBtn.style.color = '#ef5350';
      setTimeout(() => {
        saveBtn.innerHTML = '<i class="bi bi-check-lg"></i> 保存设置';
        saveBtn.style.color = '';
        saveBtn.disabled = false;
      }, 2000);
    }
  });
}

// ── History Tab ──────────────────────────────────────────────────────────────

async function _fetchHistory(): Promise<void> {
  const uid = getUserId();
  if (!uid) return;
  _historyLoading = true;
  _updateHistoryList();

  try {
    const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/reports/history?user_id=${encodeURIComponent(uid)}&type=${_historyTab}&limit=20`);
    if (res.ok) {
      const data = await res.json();
      _historyItems = data.items || [];
    }
  } catch { /* ignore */ }
  _historyLoading = false;
  _updateHistoryList();
}

async function _fetchHistoryDetail(reportId: number): Promise<void> {
  _historyViewingId = reportId;
  _historyViewingLoading = true;
  _historyViewingContent = null;
  _updateHistoryList();

  try {
    const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/reports/${reportId}`);
    if (res.ok) {
      _historyViewingContent = await res.json();
    }
  } catch { /* ignore */ }
  _historyViewingLoading = false;
  _updateHistoryList();
}

function _renderHistoryPanel(container: HTMLElement): void {
  container.innerHTML = '<div class="cn-hist-root"></div>';
  _updateHistoryList();
}

function _updateHistoryList(): void {
  if (!_viewerEl) return;
  const root = _viewerEl.querySelector('.cn-hist-root');
  if (!root) return;

  // If viewing detail
  if (_historyViewingId) {
    if (_historyViewingLoading) {
      root.innerHTML = `<div class="cn-report-loading"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i><span>加载报告...</span></div>`;
      return;
    }
    const c = _historyViewingContent;
    if (!c) {
      root.innerHTML = `
        <div class="cn-hist-detail-header">
          <button class="cn-hist-back-btn" data-action="back"><i class="bi bi-arrow-left"></i> 返回列表</button>
          <span style="font-size:12px;color:#888">报告不存在或加载失败</span>
        </div>`;
      _bindHistoryEvents(root as HTMLElement);
      return;
    }
    const report = c.report || {};
    const genAt = c.generated_at || '';
    const reportType = report.type || c.type || '';
    const typeConf = REPORT_TYPE_CONFIG[reportType as ReportType];
    const typeLabel = typeConf?.label || reportType;
    const typeIcon = typeConf?.icon || 'bi-file-text';
    const typeColor = typeConf?.color || '#e8a838';

    let contentHtml = '';

    // ── Report title banner ──
    contentHtml += `<div class="cn-hist-detail-banner" style="--type-color:${typeColor}">
      <i class="bi ${typeIcon}" style="font-size:22px;color:${typeColor}"></i>
      <div>
        <div style="font-size:16px;font-weight:700;color:#eee">${escapeHtml(typeLabel)}${report.period ? ` · ${escapeHtml(report.period)}` : ''}</div>
        ${report.company_name ? `<div style="font-size:12px;color:#999;margin-top:2px">${escapeHtml(report.company_name)}${report.industries?.length ? ` · ${report.industries.map((i: string) => escapeHtml(i)).join('、')}` : ''}</div>` : ''}
      </div>
    </div>`;

    // ── Structured fields (if present) ──
    if (report.ceo_one_liner) {
      contentHtml += `<div class="cn-hist-highlight">${escapeHtml(report.ceo_one_liner)}</div>`;
    }
    if (report.headline_alert || report.headline) {
      contentHtml += `<div style="font-size:14px;font-weight:600;color:#ddd;margin-bottom:12px">${escapeHtml(report.headline_alert || report.headline || '')}</div>`;
    }
    const es = report.executive_summary;
    if (es) {
      if (typeof es === 'object' && es.situation) {
        contentHtml += `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
          ${es.situation ? `<div class="cn-exec-section"><span class="cn-exec-label cn-exec-label-situation">形势</span><div>${escapeHtml(es.situation)}</div></div>` : ''}
          ${es.impact ? `<div class="cn-exec-section"><span class="cn-exec-label cn-exec-label-impact">影响</span><div>${escapeHtml(es.impact)}</div></div>` : ''}
          ${es.direction ? `<div class="cn-exec-section"><span class="cn-exec-label cn-exec-label-direction">方向</span><div>${escapeHtml(es.direction)}</div></div>` : ''}
        </div>`;
      } else {
        contentHtml += `<div style="font-size:13px;color:#ccc;line-height:1.7;margin-bottom:14px">${escapeHtml(String(es))}</div>`;
      }
    }

    // Opportunities
    const opps = report.opportunities as any[] | undefined;
    if (opps?.length) {
      contentHtml += `<div class="cn-hist-section"><div class="cn-hist-section-title" style="color:#66bb6a"><i class="bi bi-graph-up-arrow"></i>机遇</div>`;
      opps.forEach((o: any) => {
        contentHtml += `<div class="cn-hist-card" style="border-left-color:rgba(102,187,106,0.4)">
          <div style="font-size:13px;font-weight:600;color:#ddd">${escapeHtml(o.title || '')}</div>
          <div style="font-size:12px;color:#aaa;margin-top:3px">${escapeHtml(o.description || '')}</div>
          ${o.estimated_effect ? `<div style="font-size:11px;color:#66bb6a;margin-top:3px">${escapeHtml(o.estimated_effect)}</div>` : ''}
        </div>`;
      });
      contentHtml += `</div>`;
    }

    // Risks
    const risks = report.risks as any[] | undefined;
    if (risks?.length) {
      contentHtml += `<div class="cn-hist-section"><div class="cn-hist-section-title" style="color:#ef5350"><i class="bi bi-exclamation-triangle"></i>风险</div>`;
      risks.forEach((r: any) => {
        contentHtml += `<div class="cn-hist-card" style="border-left-color:rgba(239,83,80,0.4)">
          <div style="font-size:13px;font-weight:600;color:#ddd">${escapeHtml(r.title || '')}</div>
          <div style="font-size:12px;color:#aaa;margin-top:3px">${escapeHtml(r.description || '')}</div>
          ${r.estimated_loss ? `<div style="font-size:11px;color:#ef5350;margin-top:3px">${escapeHtml(r.estimated_loss)}</div>` : ''}
        </div>`;
      });
      contentHtml += `</div>`;
    }

    // Action items
    const actions = report.action_items as any[] | undefined;
    if (actions?.length) {
      contentHtml += `<div class="cn-hist-section"><div class="cn-hist-section-title" style="color:#42a5f5"><i class="bi bi-check2-square"></i>行动项</div>`;
      actions.forEach((a: any, idx: number) => {
        const priorityColor = a.priority === '紧急' || a.priority === 'urgent' ? '#ef5350' : a.priority === '高' || a.priority === 'high' ? '#ffa726' : '#42a5f5';
        contentHtml += `<div style="padding:6px 12px;margin-bottom:4px;font-size:12px;color:#ccc;display:flex;gap:8px;align-items:flex-start">
          <span style="color:${priorityColor};font-weight:600;flex-shrink:0">${idx + 1}.</span>
          <span>${escapeHtml(a.action || '')}</span>
          ${a.deadline_hint ? `<span style="margin-left:auto;flex-shrink:0;color:#888;font-size:11px">${escapeHtml(a.deadline_hint)}</span>` : ''}
        </div>`;
      });
      contentHtml += `</div>`;
    }

    // Competitive landscape
    const compLand = report.competitive_landscape as any;
    if (compLand) {
      const clItems: string[] = [];
      if (typeof compLand === 'string') {
        clItems.push(compLand);
      } else if (Array.isArray(compLand)) {
        compLand.forEach((ci: any) => clItems.push(typeof ci === 'string' ? ci : (ci.summary || ci.description || JSON.stringify(ci))));
      } else if (compLand.summary) {
        clItems.push(compLand.summary);
      }
      if (clItems.length) {
        contentHtml += `<div class="cn-hist-section"><div class="cn-hist-section-title" style="color:#ab47bc"><i class="bi bi-people"></i>竞争格局</div>
          <div style="font-size:12px;color:#bbb;line-height:1.7;padding:10px 14px;border-radius:8px;background:rgba(171,71,188,0.06);border:1px solid rgba(171,71,188,0.15)">${clItems.map(t => escapeHtml(t)).join('<br>')}</div></div>`;
      }
    }

    // Industry direction
    const indDir = report.industry_direction as any;
    if (indDir) {
      const dirText = typeof indDir === 'string' ? indDir : (indDir.summary || indDir.description || '');
      if (dirText) {
        contentHtml += `<div class="cn-hist-section"><div class="cn-hist-section-title" style="color:#26c6da"><i class="bi bi-compass"></i>产业方向</div>
          <div style="font-size:12px;color:#bbb;line-height:1.7;padding:10px 14px;border-radius:8px;background:rgba(38,198,218,0.06);border:1px solid rgba(38,198,218,0.15)">${escapeHtml(dirText)}</div></div>`;
      }
    }

    // Key developments (industry_brief)
    const devs = report.key_developments as any[] | undefined;
    if (devs?.length) {
      contentHtml += `<div class="cn-hist-section"><div class="cn-hist-section-title" style="color:#ffa726"><i class="bi bi-lightning"></i>关键动态</div>`;
      devs.forEach((d: any) => {
        const urgColor = d.urgency_label === '紧急' ? '#ef5350' : d.urgency_label === '重要' ? '#ffa726' : '#66bb6a';
        contentHtml += `<div class="cn-hist-card" style="border-left-color:rgba(255,167,38,0.3)">
          ${d.urgency_label ? `<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:${urgColor}22;color:${urgColor};margin-right:6px">${escapeHtml(d.urgency_label)}</span>` : ''}
          <span style="font-size:13px;font-weight:600;color:#ddd">${escapeHtml(d.title || '')}</span>
          <div style="font-size:12px;color:#aaa;margin-top:3px">${escapeHtml(d.impact_summary || '')}</div>
          ${d.business_impact ? `<div style="font-size:11px;color:#e8a838;margin-top:3px;font-style:italic">对贵司影响: ${escapeHtml(d.business_impact)}</div>` : ''}
        </div>`;
      });
      contentHtml += `</div>`;
    }

    // Chapters (enterprise reports with structured chapters)
    const chapters = report.chapters as any[] | undefined;
    if (chapters?.length) {
      chapters.forEach((ch: any) => {
        contentHtml += `<div class="cn-hist-section">
          <div class="cn-hist-section-title" style="color:#e8a838"><i class="bi bi-bookmark"></i>${escapeHtml(ch.title || '')}</div>
          <div class="cn-report-ai-body">${markdownToHtml(ch.content || '')}</div>
        </div>`;
      });
    }

    // ── AI Summary (main content for daily/weekly/monthly/quarterly/annual) ──
    if (report.ai_summary) {
      contentHtml += `<div class="cn-hist-section">
        <div class="cn-report-ai-body">${markdownToHtml(report.ai_summary)}</div>
      </div>`;
    }

    // ── Sections: policy_review / sentiment / cross_signals (weekly reports) ──
    const sections = report.sections as ReportSection | undefined;
    if (sections) {
      // Policy review
      const pr = sections.policy_review;
      if (pr) {
        contentHtml += `<div class="cn-hist-section">
          <div class="cn-hist-section-title" style="color:#64B5F6"><i class="bi bi-bank"></i>政策回顾 <span style="font-size:11px;font-weight:400;color:#888;margin-left:6px">共 ${pr.total || 0} 条，相关 ${pr.relevant || 0} 条</span></div>`;
        if (pr.top_items?.length) {
          contentHtml += `<table class="cn-report-table"><thead><tr><th>标题</th><th style="width:80px">来源</th><th style="width:80px">日期</th><th style="width:50px">相关度</th></tr></thead><tbody>`;
          pr.top_items.forEach((p: any) => {
            const score = Math.round((p.score || 0) * 100);
            const sColor = score > 70 ? '#66bb6a' : score > 40 ? '#ffa726' : '#888';
            contentHtml += `<tr><td>${escapeHtml(p.title || '')}</td><td style="color:#888">${escapeHtml(p.source || '')}</td><td style="color:#888">${escapeHtml(p.date || '')}</td><td style="color:${sColor};font-weight:600">${score}%</td></tr>`;
          });
          contentHtml += `</tbody></table>`;
        }
        contentHtml += `</div>`;
      }

      // Sentiment
      const sent = sections.sentiment;
      if (sent) {
        contentHtml += `<div class="cn-hist-section">
          <div class="cn-hist-section-title" style="color:#BA68C8"><i class="bi bi-emoji-neutral"></i>舆情情绪</div>`;
        const dist = sent.distribution;
        if (dist) {
          const total = Object.values(dist).reduce((s, v) => s + (v || 0), 0) || 1;
          const posW = ((dist.positive || 0) / total * 100).toFixed(0);
          const neuW = ((dist.neutral || 0) / total * 100).toFixed(0);
          const negW = ((dist.negative || 0) / total * 100).toFixed(0);
          contentHtml += `
            <div class="cn-report-sentiment-labels">
              <span><span class="dot" style="background:#4caf50"></span>正面 ${posW}%</span>
              <span><span class="dot" style="background:#78909c"></span>中性 ${neuW}%</span>
              <span><span class="dot" style="background:#ef5350"></span>负面 ${negW}%</span>
            </div>
            <div class="cn-report-sentiment-bar">
              <div class="cn-report-sentiment-pos" style="width:${posW}%"></div>
              <div class="cn-report-sentiment-neu" style="width:${neuW}%"></div>
              <div class="cn-report-sentiment-neg" style="width:${negW}%"></div>
            </div>`;
        }
        if (sent.top_keywords?.length) {
          contentHtml += `<div class="cn-report-keyword-wrap">${sent.top_keywords.map(k => `<span class="cn-report-keyword-tag">${escapeHtml(k)}</span>`).join('')}</div>`;
        }
        contentHtml += `</div>`;
      }

      // Cross signals
      const cs = sections.cross_signals;
      if (cs?.length) {
        contentHtml += `<div class="cn-hist-section">
          <div class="cn-hist-section-title" style="color:#ffa726"><i class="bi bi-diagram-3"></i>跨域信号</div>`;
        cs.forEach((s: any) => {
          const confPct = Math.round((s.confidence || 0) * 100);
          const dirColor = s.direction === '利好' ? '#66bb6a' : s.direction === '利空' ? '#ef5350' : '#888';
          contentHtml += `<div class="cn-hist-card" style="border-left-color:rgba(255,167,38,0.3)">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
              <span style="font-size:13px;font-weight:600;color:#ddd">${escapeHtml(s.pattern || '')}</span>
              <span style="font-size:10px;padding:1px 6px;border-radius:3px;background:${dirColor}22;color:${dirColor}">${escapeHtml(s.direction || '')}</span>
              <span style="font-size:10px;color:#888;margin-left:auto">置信度 ${confPct}%</span>
            </div>
            <div style="font-size:12px;color:#aaa">${escapeHtml(s.description || '')}</div>
            ${s.sector ? `<div style="font-size:11px;color:#e8a838;margin-top:3px">板块: ${escapeHtml(s.sector)}</div>` : ''}
          </div>`;
        });
        contentHtml += `</div>`;
      }
    }

    // ── Trend data (monthly/quarterly/annual charts as simple tables) ──
    if (report.daily_trend?.length) {
      contentHtml += `<div class="cn-hist-section">
        <div class="cn-hist-section-title" style="color:#64B5F6"><i class="bi bi-graph-up"></i>每日政策趋势</div>
        <div class="cn-hist-trend-bar-wrap">${_renderTrendBars(report.daily_trend, 'date', 'count')}</div>
      </div>`;
    }
    if (report.monthly_trend?.length) {
      contentHtml += `<div class="cn-hist-section">
        <div class="cn-hist-section-title" style="color:#81C784"><i class="bi bi-bar-chart-line"></i>月度政策趋势</div>
        <div class="cn-hist-trend-bar-wrap">${_renderTrendBars(report.monthly_trend, 'month', 'count')}</div>
      </div>`;
    }
    if (report.quarterly_trend?.length) {
      contentHtml += `<div class="cn-hist-section">
        <div class="cn-hist-section-title" style="color:#BA68C8"><i class="bi bi-bar-chart-steps"></i>季度政策趋势</div>
        <div class="cn-hist-trend-bar-wrap">${_renderTrendBars(report.quarterly_trend, 'quarter', 'count')}</div>
      </div>`;
    }

    // Outlook
    if (report.outlook?.summary) {
      contentHtml += `<div class="cn-hist-section" style="border:1px solid rgba(232,168,56,0.15);background:rgba(232,168,56,0.03)">
        <div class="cn-hist-section-title" style="color:#e8a838"><i class="bi bi-binoculars"></i>展望</div>
        <div style="font-size:13px;color:#bbb;line-height:1.7">${escapeHtml(report.outlook.summary)}</div>
      </div>`;
    }

    // ── Fallback: if nothing rendered at all, show raw JSON summary ──
    if (!contentHtml.includes('cn-report-ai-body') && !contentHtml.includes('cn-hist-card') && !contentHtml.includes('cn-report-table') && !contentHtml.includes('cn-hist-trend-bar-wrap')) {
      contentHtml += `<div class="cn-hist-section"><div style="font-size:13px;color:#999;text-align:center;padding:20px">报告数据为空或格式不支持</div></div>`;
    }

    root.innerHTML = `
      <div class="cn-hist-detail-header">
        <button class="cn-hist-back-btn" data-action="back"><i class="bi bi-arrow-left"></i> 返回列表</button>
        <span style="font-size:12px;color:#888">${escapeHtml(genAt)}</span>
        <button class="cn-hist-btn" data-action="download" data-id="${_historyViewingId}" style="margin-left:auto"><i class="bi bi-download"></i> 导出HTML</button>
      </div>
      <div class="cn-hist-detail-body">${contentHtml}</div>`;
    _bindHistoryEvents(root as HTMLElement);
    return;
  }

  // List view
  const tabsHtml = HISTORY_TABS.map(t =>
    `<button class="cn-hist-tab${t.key === _historyTab ? ' active' : ''}" data-hist-tab="${t.key}">${t.label}</button>`
  ).join('');

  let listHtml = '';
  if (_historyLoading) {
    listHtml = '<div class="cn-report-loading"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i><span>加载历史...</span></div>';
  } else if (_historyItems.length === 0) {
    listHtml = `<div class="cn-hist-empty">
      <i class="bi bi-inbox"></i>
      <div style="font-size:13px;margin-bottom:6px">暂无历史报告</div>
      <div style="font-size:11px;color:#666">AI情报简报和产业洞察生成后将自动存档</div>
    </div>`;
  } else {
    const typeLabels: Record<string, string> = {
      daily: '日报', weekly: '周报', monthly: '月报', quarterly: '季报', annual: '年报',
      morning_brief: '情报简报', industry_brief: '产业洞察',
    };
    listHtml = _historyItems.map(it => {
      const scoreColor = (it.risk_score || 0) > 70 ? '#ef5350' : (it.risk_score || 0) > 40 ? '#ffa726' : '#66bb6a';
      const scoreBg = (it.risk_score || 0) > 70 ? 'rgba(239,83,80,0.15)' : (it.risk_score || 0) > 40 ? 'rgba(255,167,38,0.15)' : 'rgba(102,187,106,0.15)';
      const typeName = typeLabels[it.report_type] || it.report_type;
      return `<div class="cn-hist-item">
        <div class="cn-hist-item-date">
          <span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;background:rgba(232,168,56,0.1);color:#e8a838;margin-right:6px">${escapeHtml(typeName)}</span>
          ${escapeHtml(it.generated_at)}
        </div>
        <div class="cn-hist-item-title">${escapeHtml(stripMarkdown(it.title || it.summary || '(无标题)'))}</div>
        ${it.summary && it.summary !== it.title ? `<div class="cn-hist-item-summary">${escapeHtml(stripMarkdown(it.summary))}</div>` : ''}
        <div class="cn-hist-item-footer">
          ${it.risk_score != null ? `<span class="cn-hist-score" style="background:${scoreBg};color:${scoreColor}">${it.risk_score}/100</span>` : ''}
          <button class="cn-hist-btn" data-action="view" data-id="${it.id}">查看</button>
          <button class="cn-hist-btn" data-action="download" data-id="${it.id}"><i class="bi bi-download"></i></button>
        </div>
      </div>`;
    }).join('');
  }

  root.innerHTML = `
    <div class="cn-hist-tabs">${tabsHtml}</div>
    ${listHtml}`;
  _bindHistoryEvents(root as HTMLElement);
}

function _bindHistoryEvents(root: HTMLElement): void {
  // Tab switching
  root.querySelectorAll('.cn-hist-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const key = (tab as HTMLElement).dataset.histTab as HistoryTab;
      if (key && key !== _historyTab) {
        _historyTab = key;
        _historyViewingId = null;
        _historyViewingContent = null;
        _fetchHistory();
      }
    });
  });

  // View detail
  root.querySelectorAll('[data-action="view"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt((btn as HTMLElement).dataset.id || '');
      if (id) _fetchHistoryDetail(id);
    });
  });

  // Download
  root.querySelectorAll('[data-action="download"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id;
      if (id) window.open(`${CN_INTEL_BASE}/api/cn/reports/${id}/export`, '_blank');
    });
  });

  // Back to list
  root.querySelectorAll('[data-action="back"]').forEach(btn => {
    btn.addEventListener('click', () => {
      _historyViewingId = null;
      _historyViewingContent = null;
      _updateHistoryList();
    });
  });
}

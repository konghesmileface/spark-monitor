/**
 * CnPolicyPanel — 独立政策数据库面板
 * 包含: 实时官媒新闻 + AI政策日报 + 历史数据查询 + 统计概览
 *
 * Types/constants extracted to cn-policy/ sub-modules.
 */
import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { openPolicyDrawer } from './PolicyDetailDrawer';
import { openReportViewer } from './CnReportViewer';
import { loadProfile, getUserId, markOnboardingComplete, cnFetch, CN_INTEL_BASE, type UserProfile } from '@/services/cn-profile';
import type { GovNewsItem, GovNewsData, PolicyStats, MorningBriefData, IndustryBrief } from './cn-policy/types';
import { GOV_CATEGORY_FILTERS, type ViewMode } from './cn-policy/constants';

const STYLE = `<style>
@layer base {
.cn-policy { font-size: 13px; color: #e0e0e0; }
/* Header: enterprise info left, action icons right */
.cn-policy-header {
  display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
  padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.04);
}
.cn-header-ent-info {
  display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0;
  cursor: pointer; transition: opacity .15s;
}
.cn-header-ent-info:hover { opacity: 0.85; }
.cn-header-ent-name {
  font-size: 14px; font-weight: 700; color: #f0e6d0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cn-header-ent-placeholder {
  font-size: 12px; color: #666; cursor: pointer;
}
.cn-header-ent-placeholder:hover { color: #e8a838; }
.cn-header-actions { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
.cn-header-icon-btn {
  height: 28px; border-radius: 6px; display: inline-flex; align-items: center; gap: 4px;
  cursor: pointer; border: none; background: rgba(255,255,255,0.04); color: #888;
  font-size: 11px; transition: all .15s; position: relative; padding: 0 10px; white-space: nowrap;
}
.cn-header-icon-btn .bi { font-size: 13px; }
.cn-header-icon-btn:hover { background: rgba(255,255,255,0.08); color: #ddd; }
.cn-header-icon-btn.active { color: #e8a838; background: rgba(232,168,56,0.1); }
.cn-header-alert-badge {
  position: absolute; top: 2px; right: 2px; width: 7px; height: 7px;
  border-radius: 50%; background: #ef5350;
}
/* Body view tabs: text-only, compact */
.cn-policy-tabs {
  display: flex; gap: 2px; margin-bottom: 10px;
  border-bottom: 1px solid rgba(255,255,255,0.04); padding-bottom: 6px;
}
.cn-policy-tab {
  padding: 4px 12px; border-radius: 4px 4px 0 0; font-size: 12px; cursor: pointer;
  color: #888; background: none; border: none; transition: all .15s;
  border-bottom: 2px solid transparent;
}
.cn-policy-tab:hover { color: #ccc; }
.cn-policy-tab.active { color: #e8a838; border-bottom-color: #e8a838; }
/* Keep old view-btn style for backwards compatibility (gear/alert modals etc) */
.cn-policy-view-btn {
  padding: 4px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04); color: #aaa;
  transition: all .15s;
}
.cn-policy-view-btn.active { background: rgba(232,168,56,0.15); color: #e8a838; border-color: rgba(232,168,56,0.3); }
.cn-policy-view-btn:hover { background: rgba(255,255,255,0.08); }
.cn-policy-report-btn {
  padding: 4px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
  border: 1px solid rgba(232,168,56,0.3); background: rgba(232,168,56,0.15); color: #e8a838;
  transition: all .15s; white-space: nowrap;
}
.cn-policy-report-btn:hover { background: rgba(232,168,56,0.25); }
.cn-policy-stats-bar {
  display: flex; gap: 16px; padding: 8px 12px; border-radius: 8px;
  background: rgba(255,255,255,0.03); margin-bottom: 8px; flex-wrap: wrap;
}
.cn-policy-stat { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #888; }
.cn-policy-stat .val { color: #e8a838; font-weight: 600; }
.cn-policy-chips {
  display: flex; gap: 4px; flex-wrap: nowrap; margin-bottom: 8px;
  overflow-x: auto; scrollbar-width: none; -ms-overflow-style: none;
  padding-bottom: 2px;
}
.cn-policy-chips::-webkit-scrollbar { display: none; }
.cn-policy-chip {
  padding: 3px 10px; border-radius: 12px; font-size: 11px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.03); color: #999;
  transition: all .15s; white-space: nowrap; flex-shrink: 0;
}
.cn-policy-chip.active { background: rgba(232,168,56,0.15); color: #e8a838; border-color: rgba(232,168,56,0.3); }
.cn-policy-chip:hover { background: rgba(255,255,255,0.06); }
.cn-policy-item {
  padding: 8px 4px; border-bottom: 1px solid rgba(255,255,255,0.04);
  border-radius: 4px; transition: background 0.15s;
}
.cn-policy-item:hover { background: rgba(255,255,255,0.04); }
.cn-policy-item:last-child { border-bottom: none; }
.cn-policy-item-title {
  font-size: 13px; color: #ddd; line-height: 1.5; margin-bottom: 4px;
}
.cn-policy-item-meta {
  display: flex; gap: 8px; align-items: center; font-size: 11px; color: #777; flex-wrap: wrap;
}
.cn-policy-src-tag {
  padding: 1px 6px; border-radius: 4px; font-size: 10px;
  background: rgba(232,168,56,0.1); color: #e8a838;
}
.cn-policy-cat-tag {
  padding: 1px 6px; border-radius: 4px; font-size: 10px;
}
.cn-policy-link { color: #64B5F6; text-decoration: none; }
.cn-policy-link:hover { text-decoration: underline; }
.cn-policy-empty { padding: 20px; text-align: center; color: #666; }
.cn-policy-report-drawer {
  background: rgba(30,30,30,0.95); border: 1px solid rgba(232,168,56,0.2);
  border-radius: 8px; padding: 12px; margin-bottom: 12px;
}
.cn-policy-report-header {
  display: flex; justify-content: space-between; align-items: center;
  color: #e8a838; font-size: 13px; font-weight: 600; margin-bottom: 8px;
}
.cn-policy-report-close { background: none; border: none; color: #888; cursor: pointer; font-size: 14px; }
.cn-policy-report-body { font-size: 12px; line-height: 1.8; color: #ccc; }
.cn-policy-report-section { color: #e8a838; font-weight: 600; margin-top: 10px; margin-bottom: 4px; }
.cn-policy-report-bullet { padding-left: 12px; margin: 2px 0; }
.cn-policy-report-bullet::before { content: "•"; color: #666; margin-right: 6px; }
/* History mode */
.cn-policy-date-range {
  display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap;
}
.cn-policy-date-input {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px; padding: 4px 8px; color: #ddd; font-size: 12px;
}
.cn-policy-search-input {
  flex: 1; min-width: 150px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px; padding: 4px 8px; color: #ddd; font-size: 12px;
}
.cn-policy-search-btn {
  padding: 4px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
  background: rgba(232,168,56,0.2); color: #e8a838; border: 1px solid rgba(232,168,56,0.3);
}
/* Stats mode */
.cn-policy-stats-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;
}
.cn-policy-stats-card {
  padding: 10px; border-radius: 8px; background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.05);
}
.cn-policy-stats-card-title { font-size: 11px; color: #888; margin-bottom: 4px; }
.cn-policy-stats-card-value { font-size: 18px; font-weight: 700; color: #e8a838; }
.cn-policy-date-chart {
  display: flex; gap: 2px; align-items: flex-end; height: 60px; margin-bottom: 12px;
  padding: 4px 0;
}
.cn-policy-date-bar {
  flex: 1; min-width: 3px; border-radius: 2px 2px 0 0;
  background: rgba(232,168,56,0.4); transition: height .3s;
  position: relative;
}
.cn-policy-date-bar:hover { background: rgba(232,168,56,0.7); }
.cn-policy-source-list { margin-top: 8px; }
.cn-policy-source-row {
  display: flex; justify-content: space-between; padding: 3px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03); font-size: 12px;
}
.cn-policy-source-name { color: #ccc; }
.cn-policy-source-count { color: #e8a838; }
/* International card layout */
.cn-policy-intl-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
@media (max-width: 768px) {
  .cn-policy-intl-grid { grid-template-columns: 1fr; }
}
.cn-policy-intl-card {
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 10px;
  padding: 12px;
  transition: border-color 0.2s;
}
.cn-policy-intl-card:hover {
  border-color: rgba(92,107,192,0.3);
}
.cn-policy-intl-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.cn-policy-intl-flag {
  font-size: 18px;
  line-height: 1;
}
.cn-policy-intl-name {
  font-size: 13px;
  font-weight: 600;
  color: #ddd;
}
.cn-policy-intl-count {
  margin-left: auto;
  font-size: 10px;
  color: #888;
  background: rgba(255,255,255,0.04);
  padding: 1px 6px;
  border-radius: 8px;
}
.cn-policy-intl-item {
  padding: 4px 0;
  border-bottom: 1px solid rgba(255,255,255,0.02);
  cursor: pointer;
  transition: background 0.15s;
  border-radius: 3px;
}
.cn-policy-intl-item:hover { background: rgba(255,255,255,0.04); padding: 4px; margin: 0 -4px; }
.cn-policy-intl-item:last-child { border-bottom: none; }
.cn-policy-intl-item-title {
  font-size: 12px;
  color: #ccc;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.cn-policy-intl-item-date {
  font-size: 10px;
  color: #666;
  margin-top: 2px;
}
.cn-policy-intl-item-link {
  color: #64B5F6;
  text-decoration: none;
  font-size: 10px;
}
.cn-policy-chip-count {
  font-size: 10px; opacity: 0.7; margin-left: 2px;
  background: rgba(255,255,255,0.1); padding: 0 4px; border-radius: 6px;
  display: inline-block; min-width: 14px; text-align: center;
}
.cn-policy-chip.active .cn-policy-chip-count { background: rgba(232,168,56,0.2); }
.cn-policy-export-btn {
  padding: 4px 10px; border-radius: 6px; font-size: 11px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04); color: #aaa;
  transition: all .15s; white-space: nowrap;
}
.cn-policy-export-btn:hover { background: rgba(255,255,255,0.08); color: #ddd; }
.cn-policy-donut-wrap {
  display: flex; align-items: center; gap: 16px; margin: 12px 0;
  padding: 10px; border-radius: 8px; background: rgba(255,255,255,0.02);
}
.cn-policy-donut-legend { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
.cn-policy-donut-legend-item {
  display: flex; align-items: center; gap: 6px; font-size: 11px; color: #bbb;
}
.cn-policy-donut-legend-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.cn-policy-donut-legend-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cn-policy-donut-legend-val { color: #e8a838; font-weight: 600; }
@keyframes spin { to { transform: rotate(360deg); } }
/* Calendar mode */
.cn-cal-list { display: flex; flex-direction: column; gap: 6px; }
.cn-cal-card {
  padding: 10px 12px; border-radius: 8px; cursor: pointer;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);
  transition: all .15s;
}
.cn-cal-card:hover { border-color: rgba(232,168,56,0.2); background: rgba(255,255,255,0.04); }
.cn-cal-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.cn-cal-card-name { font-size: 13px; font-weight: 600; color: #ddd; flex: 1; }
.cn-cal-badge {
  padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700;
}
.cn-cal-badge-S { background: rgba(244,67,54,0.2); color: #ef5350; }
.cn-cal-badge-A { background: rgba(232,168,56,0.2); color: #e8a838; }
.cn-cal-badge-B { background: rgba(66,165,245,0.2); color: #42a5f5; }
.cn-cal-countdown {
  font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 10px;
  background: rgba(232,168,56,0.12); color: #e8a838;
}
.cn-cal-countdown.today { background: rgba(244,67,54,0.2); color: #ef5350; }
.cn-cal-card-desc { font-size: 11px; color: #888; line-height: 1.5; margin-bottom: 4px; }
.cn-cal-sectors { display: flex; gap: 4px; flex-wrap: wrap; }
.cn-cal-sector-tag {
  font-size: 10px; padding: 1px 6px; border-radius: 4px;
  background: rgba(255,255,255,0.04); color: #999;
}
.cn-cal-preview { margin-top: 8px; padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.2); font-size: 11px; }
.cn-cal-preview-loading { color: #888; text-align: center; padding: 8px; }
.cn-cal-scenario { display: flex; gap: 6px; align-items: center; margin: 3px 0; }
.cn-cal-scenario-dir { width: 32px; font-weight: 600; font-size: 11px; }
.cn-cal-scenario-bar-bg { flex: 1; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.06); }
.cn-cal-scenario-bar { height: 100%; border-radius: 3px; }
.cn-cal-scenario-pct { width: 30px; text-align: right; color: #e8a838; font-size: 11px; }
.cn-cal-focus { margin-top: 6px; }
.cn-cal-focus-item { color: #ccc; line-height: 1.6; }
.cn-cal-focus-item::before { content: '•'; color: #e8a838; margin-right: 6px; }
/* Sector matrix */
.cn-sector-bar {
  margin-bottom: 12px; border-radius: 8px; overflow: hidden;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);
}
.cn-sector-bar-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px; cursor: pointer; font-size: 11px; color: #888;
  transition: background 0.15s;
}
.cn-sector-bar-header:hover { background: rgba(255,255,255,0.03); }
.cn-sector-bar-title { font-weight: 600; color: #e8a838; }
.cn-sector-bar-toggle { font-size: 10px; color: #666; }
.cn-sector-heatmap {
  display: flex; flex-wrap: wrap; gap: 5px; padding: 8px 10px 10px;
}
.cn-sector-cell {
  padding: 5px 8px; border-radius: 4px; font-size: 10px; font-weight: 600;
  cursor: pointer; transition: all 0.15s; position: relative; white-space: nowrap;
  line-height: 1.2;
}
.cn-sector-cell:hover { transform: scale(1.05); z-index: 1; }
.cn-sector-collapsed { max-height: 46px; overflow: hidden; }
.cn-sector-cell.active { outline: 2px solid #e8a838; outline-offset: 1px; }
.cn-sector-tooltip-pop {
  position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
  padding: 4px 8px; border-radius: 4px; background: rgba(20,28,44,0.95);
  border: 1px solid rgba(255,255,255,0.15); font-size: 10px; color: #ddd;
  white-space: nowrap; pointer-events: none; z-index: 10; margin-bottom: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
.cn-sector-filter-banner {
  display: flex; align-items: center; gap: 8px; padding: 4px 10px; margin-bottom: 6px;
  border-radius: 6px; background: rgba(232,168,56,0.08); font-size: 11px; color: #e8a838;
}
.cn-sector-filter-clear {
  background: none; border: none; color: #888; cursor: pointer; font-size: 12px;
  margin-left: auto;
}
.cn-sector-filter-clear:hover { color: #e8a838; }
/* Signal tracker */
.cn-signal-group { margin-bottom: 12px; }
.cn-signal-group-name { font-size: 12px; font-weight: 600; color: #e8a838; margin-bottom: 6px; }
.cn-signal-kw {
  display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 11px;
}
.cn-signal-word { width: 72px; color: #ccc; flex-shrink: 0; }
.cn-signal-sparkline { flex: 1; height: 18px; min-width: 60px; }
.cn-signal-total { width: 28px; text-align: right; color: #888; font-size: 10px; }
.cn-signal-trend {
  font-size: 9px; padding: 1px 5px; border-radius: 3px; font-weight: 600; width: 36px; text-align: center;
}
.cn-signal-trend.rising { background: rgba(229,57,53,0.15); color: #ef5350; }
.cn-signal-trend.falling { background: rgba(67,160,71,0.15); color: #43a047; }
.cn-signal-trend.stable { background: rgba(255,255,255,0.06); color: #888; }
.cn-signal-trend.new { background: rgba(232,168,56,0.2); color: #e8a838; }
.cn-signal-emerging {
  padding: 8px 10px; border-radius: 8px; margin-bottom: 12px;
  background: rgba(232,168,56,0.06); border: 1px solid rgba(232,168,56,0.15);
}
.cn-signal-emerging-title { font-size: 11px; font-weight: 600; color: #e8a838; margin-bottom: 6px; }
.cn-signal-emerging-chip {
  display: inline-block; padding: 2px 8px; border-radius: 10px; margin: 2px;
  font-size: 10px; background: rgba(229,57,53,0.12); color: #ef5350; font-weight: 600;
}
/* Policy flash */
.cn-flash-banner {
  padding: 8px 12px; border-radius: 8px; margin-bottom: 8px;
  background: rgba(244,67,54,0.06); border: 1px solid rgba(244,67,54,0.15);
}
.cn-flash-banner.amber {
  background: rgba(232,168,56,0.04); border-color: rgba(232,168,56,0.15);
}
.cn-flash-header {
  display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600;
  color: #ef5350; margin-bottom: 6px;
}
.cn-flash-banner.amber .cn-flash-header { color: #e8a838; }
.cn-flash-item {
  font-size: 12px; color: #ddd; line-height: 1.4; padding: 4px 0;
  cursor: pointer; transition: color 0.15s;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  display: flex; align-items: baseline; gap: 4px;
}
.cn-flash-item:last-child { border-bottom: none; }
.cn-flash-item:hover { color: #e8a838; }
.cn-flash-title {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
}
.cn-flash-summary {
  font-size: 10px; color: #888; margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 100%;
}
/* Insights (Phase 4) styles within policy panel */
.cn-insights-section { font-size: 13px; color: #e0e0e0; }
.cn-insights-sub-tabs {
  display: flex; gap: 6px; margin-bottom: 10px;
}
.cn-insights-sub-tab {
  padding: 5px 14px; border-radius: 6px; font-size: 12px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04); color: #aaa;
  transition: all .15s;
}
.cn-insights-sub-tab.active { background: rgba(232,168,56,0.15); color: #e8a838; border-color: rgba(232,168,56,0.3); }
.cn-regime-bar {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-radius: 8px; background: rgba(255,255,255,0.03); margin-bottom: 10px;
}
.cn-regime-indicator {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600;
}
.cn-regime-indicator.risk_on { background: rgba(229,57,53,0.12); color: #ef5350; }
.cn-regime-indicator.risk_off { background: rgba(67,160,71,0.12); color: #43a047; }
.cn-regime-indicator.rotation { background: rgba(232,168,56,0.12); color: #e8a838; }
.cn-regime-indicator.range_bound { background: rgba(255,255,255,0.06); color: #999; }
.cn-regime-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; }
.cn-regime-desc { font-size: 11px; color: #888; margin-left: auto; }
.cn-signal-card {
  padding: 10px; margin-bottom: 6px; border-radius: 8px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);
  transition: all .15s;
}
.cn-signal-card:hover { border-color: rgba(232,168,56,0.2); }
.cn-signal-card-head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 4px;
}
.cn-signal-pattern {
  padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700;
}
.cn-signal-TRIPLE { background: rgba(229,57,53,0.2); color: #ef5350; }
.cn-signal-CONVERGENCE { background: rgba(232,168,56,0.2); color: #e8a838; }
.cn-signal-DIVERGENCE { background: rgba(156,39,176,0.2); color: #ab47bc; }
.cn-signal-LEADING { background: rgba(66,165,245,0.2); color: #42a5f5; }
.cn-signal-sector { font-size: 13px; font-weight: 600; color: #ddd; }
.cn-signal-conf { margin-left: auto; font-size: 11px; font-weight: 600; }
.cn-signal-conf.high { color: #ef5350; }
.cn-signal-conf.med { color: #e8a838; }
.cn-signal-conf.low { color: #42a5f5; }
.cn-signal-desc { font-size: 11px; color: #999; line-height: 1.5; }
.cn-signal-domains { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.cn-signal-domain {
  padding: 2px 6px; border-radius: 4px; font-size: 10px;
  background: rgba(255,255,255,0.04); color: #aaa;
}
.cn-idea-card {
  padding: 12px; margin-bottom: 8px; border-radius: 8px;
  border: 1px solid; transition: all .15s;
}
.cn-idea-card.BUY { background: rgba(229,57,53,0.04); border-color: rgba(229,57,53,0.2); }
.cn-idea-card.SELL { background: rgba(67,160,71,0.04); border-color: rgba(67,160,71,0.2); }
.cn-idea-card.WATCH { background: rgba(232,168,56,0.04); border-color: rgba(232,168,56,0.2); }
.cn-idea-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.cn-idea-action { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
.cn-idea-action.BUY { background: rgba(229,57,53,0.2); color: #ef5350; }
.cn-idea-action.SELL { background: rgba(67,160,71,0.2); color: #43a047; }
.cn-idea-action.WATCH { background: rgba(232,168,56,0.2); color: #e8a838; }
.cn-idea-instrument { font-size: 14px; font-weight: 600; color: #ddd; }
.cn-idea-conf-bar {
  margin-left: auto; width: 60px; height: 6px; border-radius: 3px;
  background: rgba(255,255,255,0.06); overflow: hidden;
}
.cn-idea-conf-fill { height: 100%; border-radius: 3px; }
.cn-idea-thesis { font-size: 12px; color: #ccc; line-height: 1.6; margin-bottom: 6px; }
.cn-idea-meta { font-size: 10px; color: #888; line-height: 1.6; }
.cn-idea-meta-label { color: #e8a838; font-weight: 600; }
/* Welcome strip (compact) */
.cn-welcome-strip {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; margin-bottom: 8px; border-radius: 6px;
  background: rgba(33,150,243,0.05); border: 1px solid rgba(33,150,243,0.12);
  font-size: 12px; color: #90caf9;
}
.cn-welcome-strip-icon { color: #42a5f5; font-size: 13px; flex-shrink: 0; }
.cn-welcome-strip-text { flex: 1; color: #90caf9; }
.cn-welcome-setup-btn {
  padding: 2px 10px; border-radius: 4px; font-size: 11px; font-weight: 600;
  background: rgba(33,150,243,0.15); color: #42a5f5; border: 1px solid rgba(33,150,243,0.2);
  cursor: pointer; transition: all .15s; white-space: nowrap;
}
.cn-welcome-setup-btn:hover { background: rgba(33,150,243,0.25); }
.cn-welcome-dismiss-btn {
  background: none; border: none; color: #555; cursor: pointer;
  font-size: 14px; padding: 0 2px; line-height: 1; transition: color .15s;
}
.cn-welcome-dismiss-btn:hover { color: #aaa; }
/* Enterprise identity bar */
.cn-ent-bar {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  padding: 8px 12px; margin-bottom: 8px; border-radius: 8px;
  background: linear-gradient(135deg, rgba(232,168,56,0.06) 0%, rgba(30,30,50,0.4) 100%);
  border: 1px solid rgba(232,168,56,0.15); transition: all .15s;
}
.cn-ent-bar:hover { border-color: rgba(232,168,56,0.3); background: rgba(232,168,56,0.08); }
.cn-ent-bar-icon { color: #e8a838; font-size: 15px; flex-shrink: 0; }
.cn-ent-bar-name { font-size: 13px; font-weight: 700; color: #f0e6d0; }
.cn-ent-bar-edit { color: #666; font-size: 11px; margin-left: auto; transition: color .15s; }
.cn-ent-bar:hover .cn-ent-bar-edit { color: #e8a838; }
/* Profile status dot */
.cn-profile-status-dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: #43a047; margin-left: 3px; vertical-align: middle;
}
/* Success toast */
.cn-setup-toast {
  padding: 8px 14px; border-radius: 6px; margin-bottom: 8px;
  background: rgba(67,160,71,0.1); border: 1px solid rgba(67,160,71,0.2);
  color: #43a047; font-size: 12px; display: flex; align-items: center; gap: 6px;
  animation: cn-toast-fade 3s ease-out forwards;
}
@keyframes cn-toast-fade {
  0%, 70% { opacity: 1; }
  100% { opacity: 0; }
}
/* ── Industry view ── */
.cn-ind-header {
  padding: 16px 18px; border-radius: 10px; margin-bottom: 16px;
  background: linear-gradient(135deg, rgba(232,168,56,0.08) 0%, rgba(30,30,30,0.6) 100%);
  border: 1px solid rgba(232,168,56,0.18);
}
.cn-ind-headline {
  font-size: 15px; font-weight: 600; color: #f0e6d0; line-height: 1.7; margin-bottom: 10px;
}
.cn-ind-meta {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; color: #888;
}
.cn-ind-risk {
  padding: 3px 10px; border-radius: 10px; font-size: 11px; font-weight: 600;
}
.cn-ind-risk-low { background: rgba(67,160,71,0.15); color: #66BB6A; }
.cn-ind-risk-moderate { background: rgba(255,193,7,0.15); color: #FFC107; }
.cn-ind-risk-elevated { background: rgba(255,152,0,0.15); color: #FF9800; }
.cn-ind-risk-high { background: rgba(244,67,54,0.15); color: #EF5350; }
.cn-ind-risk-critical { background: rgba(183,28,28,0.2); color: #E53935; }
.cn-ind-tag {
  padding: 3px 10px; border-radius: 10px; font-size: 11px;
  background: rgba(255,255,255,0.06); color: #aaa; border: 1px solid rgba(255,255,255,0.08);
}
.cn-ind-section-title {
  font-size: 14px; font-weight: 700; color: #ddd; margin: 20px 0 10px;
  display: flex; align-items: center; gap: 8px;
  padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.06);
}
.cn-ind-section-title .bi { color: #e8a838; font-size: 15px; }
.cn-ind-card {
  padding: 14px 16px; border-radius: 10px; margin-bottom: 12px;
  background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.06);
  transition: border-color .15s;
}
.cn-ind-card:hover { border-color: rgba(232,168,56,0.3); }
.cn-ind-card-title {
  font-size: 14px; font-weight: 700; color: #eee; margin-bottom: 6px;
  display: flex; align-items: center; gap: 8px; line-height: 1.5;
}
.cn-ind-urgency {
  padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700;
  flex-shrink: 0; letter-spacing: 0.3px;
}
.cn-ind-urgency-urgent { background: rgba(244,67,54,0.18); color: #EF5350; }
.cn-ind-urgency-important { background: rgba(232,168,56,0.18); color: #e8a838; }
.cn-ind-urgency-watch { background: rgba(158,158,158,0.15); color: #9E9E9E; }
.cn-ind-card-meta { font-size: 11px; color: #777; margin-bottom: 10px; letter-spacing: 0.2px; }
.cn-ind-impact {
  font-size: 13px; color: #bbb; line-height: 1.7; margin-bottom: 10px;
}
.cn-ind-actions { margin: 10px 0; display: flex; flex-direction: column; gap: 4px; }
.cn-ind-action {
  font-size: 12px; color: #8bc34a; padding: 3px 0;
  display: flex; align-items: baseline; gap: 6px; line-height: 1.5;
}
.cn-ind-action .bi { color: #66BB6A; font-size: 12px; flex-shrink: 0; }
.cn-ind-card-footer {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.04);
}
.cn-ind-deep-btn {
  padding: 5px 14px; border-radius: 8px; font-size: 11px; cursor: pointer; font-weight: 600;
  background: rgba(232,168,56,0.1); color: #e8a838; border: 1px solid rgba(232,168,56,0.25);
  margin-left: auto; transition: all .15s;
}
.cn-ind-deep-btn:hover { background: rgba(232,168,56,0.22); }
.cn-ind-deep-panel {
  margin-top: 10px; padding: 12px 14px; border-radius: 8px;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
}
.cn-ind-deep-row {
  font-size: 13px; color: #bbb; line-height: 1.7; margin-bottom: 8px;
}
.cn-ind-deep-row:last-child { margin-bottom: 0; }
.cn-ind-deep-label { color: #e8a838; font-weight: 600; margin-right: 6px; }
.cn-ind-outlook {
  padding: 14px 16px; border-radius: 10px; margin-bottom: 12px;
  background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.06);
}
.cn-ind-outlook-text { font-size: 13px; color: #bbb; line-height: 1.7; margin-bottom: 8px; }
.cn-ind-date-item {
  font-size: 12px; color: #aaa; padding: 4px 0;
  display: flex; align-items: center; gap: 6px;
}
.cn-ind-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 10px; }
.cn-ind-risk-col, .cn-ind-opp-col {
  padding: 12px 14px; border-radius: 10px;
  background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.06);
}
.cn-ind-risk-item, .cn-ind-opp-item {
  font-size: 13px; line-height: 1.6; padding: 6px 0; color: #ccc;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.cn-ind-risk-item:last-child, .cn-ind-opp-item:last-child { border-bottom: none; }
.cn-ind-severity {
  padding: 2px 8px; border-radius: 8px; font-size: 10px; font-weight: 700; margin-right: 6px;
  display: inline-block;
}
.cn-ind-sev-high, .cn-ind-sev-高 { background: rgba(244,67,54,0.15); color: #EF5350; }
.cn-ind-sev-medium, .cn-ind-sev-中 { background: rgba(255,193,7,0.15); color: #FFC107; }
.cn-ind-sev-low, .cn-ind-sev-低 { background: rgba(67,160,71,0.15); color: #66BB6A; }
/* Enterprise onboarding */
.cn-ind-onboard {
  padding: 24px; border-radius: 12px;
  background: linear-gradient(135deg, rgba(232,168,56,0.06) 0%, rgba(30,30,30,0.6) 100%);
  border: 1px solid rgba(232,168,56,0.15);
}
.cn-ind-onboard-header { font-size: 17px; font-weight: 700; color: #e8a838; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
.cn-ind-onboard-desc { font-size: 13px; color: #999; margin-bottom: 16px; }
.cn-ind-onboard-features { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px; }
.cn-ind-onboard-feat {
  display: flex; align-items: flex-start; gap: 10px; padding: 12px; border-radius: 10px;
  background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.05);
}
.cn-ind-onboard-feat > i { color: #e8a838; font-size: 18px; flex-shrink: 0; margin-top: 2px; }
.cn-ind-feat-title { font-size: 13px; font-weight: 600; color: #ddd; margin-bottom: 3px; }
.cn-ind-feat-desc { font-size: 12px; color: #777; line-height: 1.5; }
/* Enterprise header elements */
.cn-ind-ent-row { display: flex; align-items: center; margin-bottom: 10px; }
.cn-ind-ent-name { font-size: 15px; font-weight: 700; color: #f0e6d0; display: flex; align-items: center; gap: 6px; }
.cn-ind-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 12px; }
.cn-ind-stat {
  text-align: center; padding: 10px 0; border-radius: 8px;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
}
.cn-ind-stat-num { font-size: 20px; font-weight: 700; color: #e8a838; }
.cn-ind-stat-label { font-size: 11px; color: #888; margin-top: 3px; }
.cn-ind-setup-btn-sm {
  padding: 7px 18px; border-radius: 8px; font-size: 13px; cursor: pointer; font-weight: 600;
  background: rgba(232,168,56,0.12); color: #e8a838; border: 1px solid rgba(232,168,56,0.25);
  transition: all .15s; white-space: nowrap;
  display: inline-flex; align-items: center; gap: 6px;
}
.cn-ind-setup-btn-sm:hover { background: rgba(232,168,56,0.22); }
.cn-ind-intl {
  padding: 14px 16px; border-radius: 10px; margin-bottom: 12px;
  background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.06);
}
.cn-ind-intl-text { font-size: 13px; color: #bbb; line-height: 1.7; }
.cn-ind-chain-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 12px; }
.cn-ind-chain-col {
  padding: 12px; border-radius: 10px;
  background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.06);
}
.cn-ind-chain-label { font-size: 12px; font-weight: 700; margin-bottom: 6px; }
.cn-ind-chain-text { font-size: 13px; color: #bbb; line-height: 1.6; }
.cn-ind-chain-up { color: #FF9800; }
.cn-ind-chain-mid { color: #42A5F5; }
.cn-ind-chain-down { color: #66BB6A; }
/* ── Enterprise Dashboard ── */
.cn-dash-card {
  border-radius: 10px; padding: 14px 16px; margin-bottom: 10px;
  background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.06);
}
.cn-dash-card-title {
  font-size: 12px; font-weight: 700; color: #e8a838; margin-bottom: 10px;
  display: flex; align-items: center; gap: 6px;
}
.cn-dash-overview { background: linear-gradient(135deg, rgba(30,30,60,0.5), rgba(20,20,40,0.6)); }
.cn-dash-top-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.cn-dash-company { font-size: 14px; font-weight: 700; color: #f0e6d0; }
.cn-dash-regime { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; margin-left: auto; }
.cn-dash-regime-risk_on { background: rgba(76,175,80,0.15); color: #66bb6a; }
.cn-dash-regime-risk_off { background: rgba(239,83,80,0.15); color: #ef5350; }
.cn-dash-regime-rotation { background: rgba(255,152,0,0.15); color: #ffa726; }
.cn-dash-regime-range_bound { background: rgba(66,165,245,0.15); color: #42a5f5; }
.cn-dash-delta { font-size: 12px; color: #aaa; margin: 6px 0; line-height: 1.6; }
.cn-dash-kw-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.cn-dash-alerts-row { display: flex; gap: 12px; font-size: 11px; margin-top: 8px; }
.cn-dash-alert-badge { padding: 2px 8px; border-radius: 4px; font-weight: 600; }
.cn-dash-alert-flash { background: rgba(239,83,80,0.15); color: #ef5350; }
.cn-dash-alert-priority { background: rgba(255,152,0,0.15); color: #ffa726; }
.cn-dash-alert-routine { background: rgba(66,165,245,0.15); color: #42a5f5; }
.cn-dash-policy-item {
  padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.04);
  cursor: pointer; transition: background .15s;
}
.cn-dash-policy-item:hover { background: rgba(255,255,255,0.03); }
.cn-dash-policy-title { font-size: 12px; color: #ddd; }
.cn-dash-policy-meta { font-size: 10px; color: #777; margin-top: 3px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cn-dash-relevance { color: #e8a838; font-weight: 600; }
.cn-dash-kw-tag { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: rgba(232,168,56,0.1); color: #e8a838; }
.cn-dash-signal-item { padding: 6px 0; font-size: 12px; }
.cn-dash-signal-top { display: flex; gap: 6px; align-items: center; margin-bottom: 2px; }
.cn-dash-signal-pattern { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 700; }
.cn-dash-signal-CONVERGENCE { background: rgba(76,175,80,0.15); color: #66bb6a; }
.cn-dash-signal-DIVERGENCE { background: rgba(255,152,0,0.15); color: #ffa726; }
.cn-dash-signal-TRIPLE { background: rgba(233,30,99,0.15); color: #ec407a; }
.cn-dash-signal-LEADING { background: rgba(66,165,245,0.15); color: #42a5f5; }
.cn-dash-signal-desc { font-size: 11px; color: #999; margin-left: 2px; }
.cn-dash-brief-row { font-size: 12px; color: #bbb; line-height: 1.6; margin-bottom: 6px; display: flex; gap: 6px; align-items: baseline; }
.cn-dash-chain-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 8px; }
.cn-dash-chain-col { padding: 8px; border-radius: 6px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); }
.cn-dash-chain-label { font-size: 10px; font-weight: 600; margin-bottom: 3px; }
.cn-dash-chain-text { font-size: 11px; color: #bbb; }
.cn-dash-opp-risk { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.cn-dash-opp-item { font-size: 11px; padding: 6px 8px; border-radius: 6px; background: rgba(76,175,80,0.06); border-left: 3px solid #66bb6a; margin-bottom: 4px; color: #bbb; }
.cn-dash-risk-item { font-size: 11px; padding: 6px 8px; border-radius: 6px; background: rgba(239,83,80,0.06); border-left: 3px solid #ef5350; margin-bottom: 4px; color: #bbb; }
.cn-dash-opp-pot, .cn-dash-risk-sev { font-size: 9px; padding: 1px 5px; border-radius: 3px; font-weight: 600; margin-left: 4px; }
.cn-dash-outlook { font-size: 12px; color: #ccc; line-height: 1.6; margin-bottom: 10px; }
.cn-dash-dev-item { padding: 6px 0; font-size: 12px; border-bottom: 1px solid rgba(255,255,255,0.04); }
.cn-dash-dev-item:last-child { border-bottom: none; }
.cn-dash-urgency { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600; margin-right: 4px; }
.cn-dash-urgency-urgent { background: rgba(239,83,80,0.15); color: #ef5350; }
.cn-dash-urgency-important { background: rgba(255,152,0,0.15); color: #ffa726; }
.cn-dash-urgency-watch { background: rgba(66,165,245,0.15); color: #42a5f5; }
.cn-dash-dev-actions { font-size: 11px; color: #8bc34a; margin-top: 3px; }
.cn-dash-empty { text-align: center; padding: 20px; color: #666; font-size: 12px; }
.cn-dash-more-btn {
  display: block; width: 100%; text-align: center; padding: 6px; margin-top: 6px;
  background: none; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px;
  color: #888; font-size: 11px; cursor: pointer; transition: all .15s;
}
.cn-dash-more-btn:hover { border-color: rgba(232,168,56,0.3); color: #e8a838; }
/* ── Morning Brief / Overview ── */
.cn-brief-hero {
  border-left: 3px solid #e8a838; padding: 12px 14px; border-radius: 0 8px 8px 0;
  background: rgba(232,168,56,0.05); margin-bottom: 12px; font-size: 14px;
  color: #ddd; line-height: 1.7;
}
.cn-brief-hero-label { font-size: 11px; color: #e8a838; font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
.cn-brief-hero-time { margin-left: auto; font-size: 10px; color: #666; font-weight: 400; }
.cn-metrics-bar { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
.cn-metric-card {
  text-align: center; padding: 10px 4px; border-radius: 8px;
  background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.05);
}
.cn-metric-num { font-size: 22px; font-weight: 700; color: #e8a838; }
.cn-metric-label { font-size: 10px; color: #888; margin-top: 2px; }
.cn-direction-badge {
  display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px;
  border-radius: 8px; margin-bottom: 12px; font-size: 13px; font-weight: 600; width: 100%;
  box-sizing: border-box;
}
.cn-direction-improving { background: rgba(67,160,71,0.08); border: 1px solid rgba(67,160,71,0.2); color: #66bb6a; }
.cn-direction-stable { background: rgba(255,193,7,0.08); border: 1px solid rgba(255,193,7,0.2); color: #ffc107; }
.cn-direction-deteriorating { background: rgba(239,83,80,0.08); border: 1px solid rgba(239,83,80,0.2); color: #ef5350; }
.cn-action-list { margin-bottom: 14px; }
.cn-action-item {
  display: flex; align-items: flex-start; gap: 10px; padding: 8px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px;
}
.cn-action-item:last-child { border-bottom: none; }
.cn-action-num {
  width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; flex-shrink: 0;
}
.cn-action-num-1 { background: rgba(239,83,80,0.2); color: #ef5350; }
.cn-action-num-2 { background: rgba(255,152,0,0.2); color: #ffa726; }
.cn-action-num-3 { background: rgba(66,165,245,0.2); color: #42a5f5; }
.cn-action-num-4, .cn-action-num-5 { background: rgba(255,255,255,0.08); color: #999; }
.cn-action-text { color: #ccc; flex: 1; line-height: 1.5; }
.cn-action-owner { font-size: 10px; color: #888; }
.cn-action-deadline { font-size: 10px; color: #e8a838; }
.cn-comp-section { margin-bottom: 12px; }
.cn-comp-section-title { font-size: 12px; font-weight: 600; color: #ccc; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
.cn-comp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; }
.cn-comp-card {
  padding: 12px 14px; border-radius: 10px;
  background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.06);
  transition: border-color 0.15s;
}
.cn-comp-card:hover { border-color: rgba(232,168,56,0.25); }
.cn-comp-name { font-size: 13px; font-weight: 700; color: #eee; margin-bottom: 6px; }
.cn-comp-impact { font-size: 12px; color: #aaa; margin-bottom: 6px; line-height: 1.5; }
.cn-comp-advantage { font-size: 12px; color: #66bb6a; display: flex; align-items: center; gap: 5px; }
.cn-comp-threat { font-size: 9px; padding: 1px 5px; border-radius: 6px; font-weight: 600; margin-left: 4px; }
.cn-comp-threat-high { background: rgba(239,83,80,0.15); color: #ef5350; }
.cn-comp-threat-medium { background: rgba(255,152,0,0.15); color: #ffa726; }
.cn-comp-threat-low { background: rgba(66,165,245,0.15); color: #42a5f5; }
/* ── CEO Key Angles ── */
.cn-ceo-angles { display: flex; gap: 10px; margin-bottom: 12px; }
.cn-ceo-angle-card {
  flex: 1; padding: 14px 16px; border-radius: 10px;
  background: rgba(232,168,56,0.04); border: 1px solid rgba(232,168,56,0.12);
  display: flex; flex-direction: column; gap: 6px;
  transition: border-color 0.2s, background 0.2s;
}
.cn-ceo-angle-card:hover { border-color: rgba(232,168,56,0.3); background: rgba(232,168,56,0.07); }
.cn-ceo-angle-card-market { border-left: 3px solid rgba(102,187,106,0.5); }
.cn-ceo-angle-card-impact { border-left: 3px solid rgba(255,167,38,0.5); }
.cn-ceo-angle-card-action { border-left: 3px solid rgba(66,165,245,0.5); }
.cn-ceo-angle-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.cn-ceo-angle-label { font-size: 10px; color: #e8a838; font-weight: 600; display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.cn-ceo-angle-metric { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
.cn-ceo-angle-metric-market { background: rgba(102,187,106,0.12); color: #66bb6a; }
.cn-ceo-angle-metric-impact { background: rgba(255,167,38,0.12); color: #ffa726; }
.cn-ceo-angle-metric-action { background: rgba(66,165,245,0.12); color: #42a5f5; }
.cn-ceo-angle-insight { font-size: 14px; color: #e0e0e0; font-weight: 700; line-height: 1.4; }
.cn-ceo-angle-detail { font-size: 12px; color: #999; line-height: 1.6; }
@media (max-width: 600px) { .cn-ceo-angles { flex-direction: column; } }
/* ── Sub-dimension items (shared across competitive/industry/global) ── */
.cn-sub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
@media (max-width: 600px) { .cn-sub-grid { grid-template-columns: 1fr; } }
.cn-section-sub-item {
  font-size: 11px; color: #bbb; display: flex; align-items: flex-start; gap: 6px;
  padding: 6px 8px; border-radius: 6px; background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.04); line-height: 1.5;
}
.cn-section-sub-item i { color: #64B5F6; font-size: 12px; flex-shrink: 0; margin-top: 1px; }
.cn-sub-label { color: #888; font-weight: 600; white-space: nowrap; flex-shrink: 0; }
.cn-section-sub-alert {
  font-size: 11px; color: #ffa726; padding: 5px 8px; border-radius: 6px;
  background: rgba(255,167,38,0.06); border: 1px solid rgba(255,167,38,0.12);
  margin-top: 6px; display: flex; align-items: center; gap: 6px;
}
/* ── Recent Moves ── */
.cn-recent-moves { margin-top: 8px; }
.cn-recent-moves .cn-sub-label { font-size: 11px; color: #888; margin-bottom: 4px; display: flex; align-items: center; gap: 4px; }
.cn-recent-move-item { font-size: 11px; color: #bbb; padding: 2px 0; line-height: 1.5; }
/* ── Transmission Chain (per card) ── */
.cn-transmission-chain {
  margin: 6px 0 8px; padding: 8px 10px; border-radius: 6px;
  background: rgba(100,181,246,0.04); border: 1px solid rgba(100,181,246,0.1);
}
.cn-transmission-chain-risk {
  background: rgba(239,83,80,0.04); border-color: rgba(239,83,80,0.1);
}
.cn-chain-label { font-size: 10px; font-weight: 600; color: #64B5F6; margin-bottom: 6px; display: flex; align-items: center; gap: 4px; }
.cn-transmission-chain-risk .cn-chain-label { color: #ef5350; }
.cn-chain-steps { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 2px; }
.cn-chain-step { display: flex; align-items: center; gap: 2px; }
.cn-chain-arrow { color: #555; font-size: 11px; margin: 0 2px; flex-shrink: 0; }
.cn-chain-step-text { font-size: 11px; color: #bbb; line-height: 1.4; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.03); }
.cn-chain-step-final {
  color: #e8a838; font-weight: 600; background: rgba(232,168,56,0.08);
  border: 1px solid rgba(232,168,56,0.2); padding: 2px 8px;
}
.cn-delta-row {
  font-size: 11px; color: #888; padding: 6px 10px; border-radius: 6px;
  background: rgba(255,255,255,0.02); margin-bottom: 10px;
}
/* ── Opp/Risk view ── */
.cn-filter-chips { display: flex; gap: 6px; margin-bottom: 12px; }
.cn-filter-chip {
  padding: 4px 14px; border-radius: 14px; font-size: 12px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); color: #999;
  transition: all .15s;
}
.cn-filter-chip.active { background: rgba(232,168,56,0.15); color: #e8a838; border-color: rgba(232,168,56,0.3); }
.cn-filter-chip:hover { background: rgba(255,255,255,0.06); }
.cn-opprisk-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 600px) { .cn-opprisk-grid { grid-template-columns: 1fr; } }
.cn-opprisk-col-title { font-size: 13px; font-weight: 700; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
.cn-opp-card {
  padding: 10px 12px; border-radius: 8px; margin-bottom: 8px;
  border-left: 3px solid #66bb6a; background: rgba(76,175,80,0.04);
  border-top: 1px solid rgba(255,255,255,0.04); border-right: 1px solid rgba(255,255,255,0.04); border-bottom: 1px solid rgba(255,255,255,0.04);
}
.cn-risk-card {
  padding: 10px 12px; border-radius: 8px; margin-bottom: 8px;
  border-left: 3px solid #ef5350; background: rgba(239,83,80,0.04);
  border-top: 1px solid rgba(255,255,255,0.04); border-right: 1px solid rgba(255,255,255,0.04); border-bottom: 1px solid rgba(255,255,255,0.04);
}
.cn-opp-card-title, .cn-risk-card-title { font-size: 13px; font-weight: 600; color: #ddd; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
.cn-opp-card-analysis, .cn-risk-card-analysis { font-size: 12px; color: #bbb; line-height: 1.5; margin-bottom: 6px; }
.cn-opp-card-action { font-size: 12px; color: #8bc34a; margin-bottom: 4px; }
.cn-risk-card-action { font-size: 12px; color: #ffa726; margin-bottom: 4px; }
.cn-opp-card-source, .cn-risk-card-source { font-size: 10px; color: #666; }
.cn-opp-card-footer, .cn-risk-card-footer { display: flex; gap: 6px; margin-top: 6px; }
.cn-opprisk-action-btn {
  padding: 2px 10px; border-radius: 4px; font-size: 10px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); color: #888;
  transition: all .15s;
}
.cn-opprisk-action-btn:hover { border-color: rgba(232,168,56,0.3); color: #e8a838; }
.cn-urgency-badge {
  padding: 1px 6px; border-radius: 8px; font-size: 10px; font-weight: 600; flex-shrink: 0;
}
.cn-urgency-紧急, .cn-urgency-high { background: rgba(239,83,80,0.15); color: #ef5350; }
.cn-urgency-重要, .cn-urgency-medium { background: rgba(255,152,0,0.15); color: #ffa726; }
.cn-urgency-关注, .cn-urgency-low { background: rgba(66,165,245,0.15); color: #42a5f5; }
.cn-severity-badge {
  padding: 1px 6px; border-radius: 8px; font-size: 10px; font-weight: 600; flex-shrink: 0;
}
.cn-severity-高 { background: rgba(239,83,80,0.15); color: #ef5350; }
.cn-severity-中 { background: rgba(255,152,0,0.15); color: #ffa726; }
.cn-severity-低 { background: rgba(66,165,245,0.15); color: #42a5f5; }
/* Trend sparkline text */
.cn-trend-sparkline { font-size: 18px; letter-spacing: 2px; line-height: 1; margin-right: 6px; }
.cn-brief-refresh-btn {
  padding: 2px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;
  background: rgba(232,168,56,0.1); color: #e8a838; border: 1px solid rgba(232,168,56,0.2);
  transition: all .15s;
}
.cn-brief-refresh-btn:hover { background: rgba(232,168,56,0.2); }
.cn-opprisk-empty { text-align: center; padding: 16px; color: #666; font-size: 12px; }
/* ── Headline Alert ── */
.cn-headline-alert {
  display: flex; align-items: center; gap: 12px; padding: 12px 16px; margin-bottom: 10px;
  border-radius: 10px; border: 1px solid rgba(239,83,80,0.15);
  background: linear-gradient(135deg, rgba(239,83,80,0.06) 0%, rgba(255,167,38,0.04) 100%);
}
.cn-headline-alert-icon {
  font-size: 20px; color: #ffa726; flex-shrink: 0;
  animation: pulse-glow 2s ease-in-out infinite;
}
@keyframes pulse-glow { 0%,100%{opacity:1} 50%{opacity:0.5} }
.cn-headline-alert-body { flex: 1; min-width: 0; }
.cn-headline-alert-text { font-size: 14px; font-weight: 700; color: #eee; line-height: 1.4; }
.cn-headline-alert-number { font-size: 12px; color: #ffa726; margin-top: 2px; font-weight: 600; }
.cn-risk-gauge {
  display: flex; flex-direction: column; align-items: center; gap: 1px; flex-shrink: 0;
  padding: 6px 12px; border-radius: 8px; background: rgba(0,0,0,0.15);
}
.cn-risk-gauge-score { font-size: 24px; font-weight: 800; line-height: 1; }
.cn-risk-gauge-label { font-size: 9px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
.cn-risk-gauge-trend { font-size: 10px; font-weight: 600; }
/* ── Risk Dashboard Bar ── */
.cn-risk-dashboard {
  padding: 8px 12px; border-radius: 8px; margin-bottom: 10px;
  border: 1px solid rgba(255,255,255,0.04);
}
.cn-risk-dashboard-row { display: flex; align-items: center; gap: 10px; }
.cn-risk-dashboard-label { font-size: 11px; color: #888; white-space: nowrap; }
.cn-risk-bar { flex: 1; height: 8px; border-radius: 4px; background: rgba(255,255,255,0.06); overflow: hidden; }
.cn-risk-fill { height: 100%; border-radius: 4px; transition: width 0.6s ease; }
.cn-risk-dashboard-score { font-size: 16px; font-weight: 700; }
.cn-risk-dashboard-max { font-size: 10px; color: #666; font-weight: 400; }
.cn-risk-dashboard-trend { font-size: 11px; font-weight: 600; white-space: nowrap; }
/* ── Overview Dual Column ── */
.cn-overview-dual {
  display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;
}
.cn-overview-single { margin-bottom: 12px; }
@media (max-width: 600px) { .cn-overview-dual { grid-template-columns: 1fr; } }
.cn-overview-col {
  padding: 10px 14px; border-radius: 8px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04);
}
.cn-overview-col-title {
  font-size: 12px; font-weight: 600; color: #ccc; margin-bottom: 8px;
  display: flex; align-items: center; gap: 6px;
}
.cn-overview-summary { font-size: 13px; color: #bbb; line-height: 1.7; }
/* Action items v2 */
.cn-action-list-v2 { display: flex; flex-direction: column; gap: 6px; }
.cn-action-item-v2 {
  display: flex; align-items: flex-start; gap: 8px; padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.cn-action-item-v2:last-child { border-bottom: none; }
.cn-action-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 4px; }
.cn-action-dot-urgent { background: #ef5350; box-shadow: 0 0 6px rgba(239,83,80,0.4); }
.cn-action-dot-important { background: #ffa726; }
.cn-action-dot-monitor { background: #42a5f5; }
.cn-action-item-v2-body { flex: 1; min-width: 0; }
.cn-action-item-v2-text { font-size: 12px; color: #ccc; line-height: 1.5; }
.cn-action-pri-tag {
  padding: 1px 6px; border-radius: 8px; font-size: 10px; font-weight: 600; margin-right: 4px;
}
.cn-action-pri-urgent { background: rgba(239,83,80,0.15); color: #ef5350; }
.cn-action-pri-important { background: rgba(255,152,0,0.15); color: #ffa726; }
.cn-action-pri-monitor { background: rgba(66,165,245,0.15); color: #42a5f5; }
.cn-action-item-v2-meta { font-size: 10px; color: #666; margin-top: 2px; }
/* ── Collapsible sections (Tier 3) ── */
.cn-overview-tier3 { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.cn-collapsible-section {
  border-radius: 8px; background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.04); overflow: hidden;
}
.cn-collapse-toggle {
  display: flex; align-items: center; gap: 6px; padding: 8px 12px;
  font-size: 12px; font-weight: 600; color: #bbb; cursor: pointer;
  transition: background 0.15s;
}
.cn-collapse-toggle:hover { background: rgba(255,255,255,0.03); }
.cn-collapse-hint { font-size: 10px; color: #888; font-weight: 400; margin-left: auto; }
.cn-collapse-hint-trend { font-weight: 600; }
.cn-collapse-body { padding: 0 12px 10px; }
/* ── Sort toolbar ── */
.cn-sort-toolbar {
  display: flex; gap: 4px; margin-bottom: 8px;
}
.cn-sort-btn {
  padding: 4px 10px; border-radius: 6px; font-size: 11px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.02);
  color: #888; transition: all .15s; display: flex; align-items: center; gap: 4px;
}
.cn-sort-btn:hover { border-color: rgba(232,168,56,0.2); color: #ccc; }
.cn-sort-btn.active { background: rgba(232,168,56,0.1); color: #e8a838; border-color: rgba(232,168,56,0.3); }
/* ── Impact cards (enhanced opp/risk) ── */
.cn-impact-card {
  padding: 10px 12px; border-radius: 8px; margin-bottom: 8px;
  border: 1px solid rgba(255,255,255,0.04); transition: border-color 0.15s;
}
.cn-impact-card:hover { border-color: rgba(255,255,255,0.1); }
.cn-impact-card-opp {
  border-left: 3px solid #66bb6a; background: rgba(76,175,80,0.04);
}
.cn-impact-card-risk {
  border-left: 3px solid #ef5350; background: rgba(239,83,80,0.04);
}
.cn-impact-card-header {
  display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap;
}
.cn-impact-bar-wrap { display: flex; align-items: center; gap: 4px; }
.cn-impact-bar {
  width: 60px; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.06); overflow: hidden;
}
.cn-impact-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
.cn-impact-score { font-size: 11px; font-weight: 700; }
.cn-impact-dim {
  padding: 1px 6px; border-radius: 8px; font-size: 9px; font-weight: 600;
  background: rgba(100,181,246,0.1); color: #64B5F6;
}
.cn-prob-badge {
  padding: 1px 6px; border-radius: 8px; font-size: 9px; font-weight: 600;
  background: rgba(239,83,80,0.1); color: #ef5350;
}
.cn-impact-card-title { font-size: 13px; font-weight: 600; color: #ddd; margin-bottom: 4px; }
.cn-impact-card-desc { font-size: 12px; color: #bbb; line-height: 1.5; margin-bottom: 6px; }
.cn-impact-card-amount { font-size: 13px; font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; gap: 4px; }
.cn-impact-card-amount-pos { color: #66bb6a; }
.cn-impact-card-amount-neg { color: #ef5350; }
.cn-impact-card-action { font-size: 12px; color: #8bc34a; margin-bottom: 4px; display: flex; align-items: center; gap: 4px; }
.cn-impact-card-mitigation { font-size: 12px; color: #ffa726; margin-bottom: 4px; display: flex; align-items: center; gap: 4px; }
.cn-impact-card-source { font-size: 10px; color: #666; display: flex; align-items: center; gap: 4px; }
/* ── CEO One-liner ── */
.cn-ceo-oneliner {
  font-size: 16px; font-weight: 700; color: #f0e6d0; line-height: 1.5;
  padding: 12px 16px; margin-bottom: 10px; border-radius: 8px;
  background: linear-gradient(135deg, rgba(232,168,56,0.1) 0%, rgba(30,30,50,0.4) 100%);
  border-left: 4px solid #e8a838; position: relative;
}
.cn-ceo-oneliner::before { content: '"'; color: #e8a838; font-size: 24px; position: absolute; top: 6px; left: 8px; opacity: 0.3; }
.cn-ceo-oneliner::after { content: '"'; color: #e8a838; font-size: 24px; opacity: 0.3; }
/* ── Structured executive summary ── */
.cn-exec-summary-struct { margin-bottom: 10px; }
.cn-exec-section { margin-bottom: 8px; }
.cn-exec-section-label {
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;
  padding: 2px 8px; border-radius: 4px; display: inline-block; margin-bottom: 3px;
}
.cn-exec-label-situation { background: rgba(66,165,245,0.12); color: #42a5f5; }
.cn-exec-label-impact { background: rgba(255,167,38,0.12); color: #ffa726; }
.cn-exec-label-direction { background: rgba(102,187,106,0.12); color: #66bb6a; }
.cn-exec-section-text { font-size: 12px; color: #ccc; line-height: 1.6; }
/* ── Situation delta ── */
.cn-situation-delta {
  font-size: 11px; color: #aaa; padding: 6px 10px; border-radius: 6px;
  background: rgba(255,255,255,0.02); margin-bottom: 8px; display: flex; align-items: center; gap: 6px;
}
.cn-situation-delta-icon { color: #64B5F6; }
/* ── Decision summary (opp/risk) ── */
.cn-decision-summary {
  padding: 12px 14px; border-radius: 8px; margin-bottom: 10px;
  background: linear-gradient(135deg, rgba(232,168,56,0.06) 0%, rgba(30,30,50,0.3) 100%);
  border: 1px solid rgba(232,168,56,0.15);
}
.cn-decision-summary-title { font-size: 11px; font-weight: 600; color: #e8a838; margin-bottom: 8px; }
.cn-decision-row { display: flex; gap: 12px; margin-bottom: 6px; }
.cn-decision-item { flex: 1; }
.cn-decision-item-label { font-size: 10px; color: #888; margin-bottom: 2px; }
.cn-decision-item-text { font-size: 12px; color: #ddd; font-weight: 600; }
.cn-decision-item-action { font-size: 11px; color: #8bc34a; margin-top: 2px; }
/* ── Time window / velocity / early warning badges ── */
.cn-time-window { font-size: 10px; color: #42a5f5; display: flex; align-items: center; gap: 3px; margin-top: 4px; }
.cn-velocity-badge {
  padding: 1px 6px; border-radius: 8px; font-size: 9px; font-weight: 600;
}
.cn-velocity-fast { background: rgba(239,83,80,0.15); color: #ef5350; }
.cn-velocity-medium { background: rgba(255,167,38,0.15); color: #ffa726; }
.cn-velocity-slow { background: rgba(102,187,106,0.15); color: #66bb6a; }
.cn-early-warning {
  font-size: 11px; color: #ffa726; padding: 4px 8px; border-radius: 4px;
  background: rgba(255,167,38,0.06); margin-top: 4px; display: flex; align-items: center; gap: 4px;
}
.cn-confidence-dots { display: inline-flex; gap: 2px; margin-left: 4px; }
.cn-confidence-dot { width: 5px; height: 5px; border-radius: 50%; background: rgba(255,255,255,0.15); }
.cn-confidence-dot.filled { background: #e8a838; }
/* ── Industry health score bar ── */
.cn-health-bar-wrap {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 8px;
  background: rgba(255,255,255,0.025); margin-bottom: 10px;
}
.cn-health-score { font-size: 28px; font-weight: 700; color: #e8a838; }
.cn-health-label-tag { font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 10px; }
.cn-health-label-景气 { background: rgba(102,187,106,0.15); color: #66bb6a; }
.cn-health-label-平稳 { background: rgba(255,193,7,0.15); color: #ffc107; }
.cn-health-label-承压 { background: rgba(255,152,0,0.15); color: #ff9800; }
.cn-health-label-衰退 { background: rgba(239,83,80,0.15); color: #ef5350; }
.cn-health-bar { flex: 1; height: 8px; border-radius: 4px; background: rgba(255,255,255,0.06); overflow: hidden; }
.cn-health-fill { height: 100%; border-radius: 4px; transition: width 0.4s; }
/* ── Trend signals (industry) ── */
.cn-trend-signals { margin-bottom: 14px; }
.cn-trend-signal-row {
  display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 13px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.cn-trend-signal-row:last-child { border-bottom: none; }
.cn-trend-arrow { font-size: 15px; font-weight: 700; width: 20px; text-align: center; }
.cn-trend-arrow-positive { color: #66bb6a; }
.cn-trend-arrow-negative { color: #ef5350; }
.cn-trend-arrow-neutral { color: #888; }
.cn-trend-signal-text { flex: 1; color: #ccc; line-height: 1.5; }
.cn-trend-strength { display: inline-flex; gap: 2px; }
.cn-trend-strength-dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(255,255,255,0.1); }
.cn-trend-strength-dot.active { background: #e8a838; }
.cn-trend-signals-list {
  padding: 6px 14px; border-radius: 10px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);
}
.cn-trend-signal-item {
  display: flex; align-items: center; gap: 10px; padding: 8px 0; font-size: 13px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.cn-trend-signal-item:last-child { border-bottom: none; }
.cn-trend-signal-arrow { font-weight: 700; font-size: 14px; flex-shrink: 0; width: 16px; text-align: center; }
.cn-trend-signal-dots { font-size: 12px; letter-spacing: 1px; }
.cn-trend-signal-strength { font-size: 11px; color: #777; white-space: nowrap; }
/* ── Business impact tag ── */
.cn-business-impact {
  font-size: 12px; color: #64B5F6; padding: 8px 12px; border-radius: 8px; line-height: 1.6;
  background: rgba(66,165,245,0.06); margin: 8px 0;
  border-left: 3px solid rgba(66,165,245,0.4);
}
.cn-business-impact .bi { color: #64B5F6; margin-right: 4px; }
.cn-action-deadline-tag { font-size: 11px; color: #ffa726; display: flex; align-items: center; gap: 4px; }
/* ── Next week watchlist ── */
.cn-watchlist { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.cn-watchlist-item {
  font-size: 12px; color: #ccc; padding: 6px 10px; border-radius: 6px;
  background: rgba(255,255,255,0.02); display: flex; align-items: center; gap: 6px;
}
.cn-watchlist-bullet { color: #e8a838; font-weight: 700; }
.cn-watchlist-section { flex: 1; min-width: 200px; }
.cn-watchlist-items { display: flex; flex-direction: column; gap: 4px; }
/* ── Empty state (industry) ── */
.cn-ind-empty-state {
  padding: 20px; border-radius: 10px; text-align: center;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
}
.cn-ind-empty-title { font-size: 14px; font-weight: 600; color: #ccc; margin-bottom: 8px; }
.cn-ind-empty-body { font-size: 12px; color: #888; line-height: 1.6; margin-bottom: 12px; }
.cn-ind-empty-hint {
  font-size: 11px; color: #64B5F6; padding: 8px 12px; border-radius: 6px;
  background: rgba(33,150,243,0.06); display: inline-block;
}
/* ── History panel ── */
.cn-history-panel {
  position: absolute; top: 0; right: 0; bottom: 0; width: 100%;
  background: rgba(20,20,30,0.98); z-index: 20; overflow-y: auto;
  border-radius: 8px; padding: 12px;
}
.cn-history-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.06);
}
.cn-history-header-title { font-size: 14px; font-weight: 700; color: #e8a838; display: flex; align-items: center; gap: 6px; }
.cn-history-close { background: none; border: none; color: #888; cursor: pointer; font-size: 16px; }
.cn-history-close:hover { color: #ddd; }
.cn-history-tabs { display: flex; gap: 4px; margin-bottom: 10px; }
.cn-history-tab {
  padding: 4px 12px; border-radius: 12px; font-size: 11px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.03); color: #999;
  transition: all .15s;
}
.cn-history-tab.active { background: rgba(232,168,56,0.15); color: #e8a838; border-color: rgba(232,168,56,0.3); }
.cn-history-item {
  padding: 10px 12px; border-radius: 8px; margin-bottom: 6px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);
  transition: all .15s; cursor: pointer;
}
.cn-history-item:hover { border-color: rgba(232,168,56,0.2); }
.cn-history-item-date { font-size: 11px; color: #888; margin-bottom: 3px; }
.cn-history-item-title { font-size: 13px; color: #ddd; font-weight: 600; margin-bottom: 3px; }
.cn-history-item-summary { font-size: 11px; color: #999; line-height: 1.4; }
.cn-history-item-footer { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
.cn-history-item-score {
  font-size: 10px; padding: 1px 6px; border-radius: 8px; font-weight: 600;
}
.cn-history-btn {
  padding: 3px 10px; border-radius: 6px; font-size: 11px; cursor: pointer;
  background: rgba(232,168,56,0.1); color: #e8a838; border: 1px solid rgba(232,168,56,0.2);
  transition: all .15s;
}
.cn-history-btn:hover { background: rgba(232,168,56,0.2); }
.cn-history-back-btn {
  padding: 4px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
  background: rgba(255,255,255,0.04); color: #aaa; border: 1px solid rgba(255,255,255,0.08);
  display: flex; align-items: center; gap: 4px; transition: all .15s;
}
.cn-history-back-btn:hover { color: #ddd; background: rgba(255,255,255,0.08); }
/* ── Executive Perspectives (multi-role) ── */
.cn-exec-perspectives { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 14px 0; }
@media (max-width: 700px) { .cn-exec-perspectives { grid-template-columns: 1fr 1fr; } }
@media (max-width: 400px) { .cn-exec-perspectives { grid-template-columns: 1fr; } }
.cn-exec-role-card {
  padding: 12px 14px; border-radius: 10px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
  display: flex; flex-direction: column; gap: 8px;
  transition: border-color 0.2s, background 0.2s;
}
.cn-exec-role-card:hover { border-color: rgba(232,168,56,0.2); background: rgba(232,168,56,0.03); }
.cn-exec-role-card-ceo { border-top: 3px solid rgba(232,168,56,0.5); }
.cn-exec-role-card-cmo { border-top: 3px solid rgba(102,187,106,0.5); }
.cn-exec-role-card-cfo { border-top: 3px solid rgba(66,165,245,0.5); }
.cn-exec-role-card-cso { border-top: 3px solid rgba(186,104,200,0.5); }
.cn-exec-role-header { display: flex; align-items: center; gap: 6px; }
.cn-exec-role-icon { font-size: 14px; }
.cn-exec-role-card-ceo .cn-exec-role-icon { color: #e8a838; }
.cn-exec-role-card-cmo .cn-exec-role-icon { color: #66bb6a; }
.cn-exec-role-card-cfo .cn-exec-role-icon { color: #42a5f5; }
.cn-exec-role-card-cso .cn-exec-role-icon { color: #BA68C8; }
.cn-exec-role-title { font-size: 12px; font-weight: 700; color: #ddd; }
.cn-exec-role-focus { font-size: 10px; color: #888; margin-left: auto; }
.cn-exec-time-item { display: flex; gap: 6px; align-items: flex-start; }
.cn-exec-time-tag {
  font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 4px;
  white-space: nowrap; flex-shrink: 0; margin-top: 1px;
}
.cn-exec-time-near { background: rgba(239,83,80,0.15); color: #ef5350; }
.cn-exec-time-mid { background: rgba(255,167,38,0.15); color: #ffa726; }
.cn-exec-time-long { background: rgba(66,165,245,0.15); color: #42a5f5; }
.cn-exec-time-text { font-size: 11px; color: #bbb; line-height: 1.5; }
/* ── Time Horizon (industry) ── */
.cn-time-horizon { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 14px 0; }
@media (max-width: 600px) { .cn-time-horizon { grid-template-columns: 1fr; } }
.cn-time-col {
  padding: 12px 14px; border-radius: 10px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
}
.cn-time-col-near { border-top: 3px solid rgba(239,83,80,0.5); }
.cn-time-col-mid { border-top: 3px solid rgba(255,167,38,0.5); }
.cn-time-col-long { border-top: 3px solid rgba(66,165,245,0.5); }
.cn-time-col-title { font-size: 12px; font-weight: 700; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
.cn-time-col-near .cn-time-col-title { color: #ef5350; }
.cn-time-col-mid .cn-time-col-title { color: #ffa726; }
.cn-time-col-long .cn-time-col-title { color: #42a5f5; }
.cn-time-col-text { font-size: 12px; color: #bbb; line-height: 1.6; }
/* ── Executive impact (policy drawer) ── */
.cn-exec-impact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 500px) { .cn-exec-impact-grid { grid-template-columns: 1fr; } }
.cn-exec-impact-item {
  padding: 8px 10px; border-radius: 8px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
  font-size: 12px; color: #bbb; line-height: 1.5;
}
.cn-exec-impact-role { font-size: 10px; font-weight: 700; margin-bottom: 3px; display: flex; align-items: center; gap: 4px; }
.cn-time-impact-row {
  display: flex; gap: 6px; align-items: flex-start; padding: 8px 10px; border-radius: 8px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); margin-bottom: 6px;
}
.cn-time-impact-label {
  font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px;
  white-space: nowrap; flex-shrink: 0; margin-top: 1px;
}
.cn-time-impact-text { font-size: 12px; color: #bbb; line-height: 1.5; }
} /* @layer base */
</style>`;

export class CnPolicyPanel extends Panel {
  private viewMode: ViewMode = 'live';
  // Live mode state
  private newsData: GovNewsData | null = null;
  private newsLoading = false;
  private newsFetched = false;
  private categoryFilter = 'all';
  private reportData: { report: string; generated: boolean } | null = null;
  private reportLoading = false;
  private reportVisible = false;
  // History mode state
  private historyItems: GovNewsItem[] = [];
  private historyLoading = false;
  private historyStart = '';
  private historyEnd = '';
  private historyCategory = '';
  private searchQuery = '';
  // Stats mode state
  private stats: PolicyStats | null = null;
  private statsLoading = false;
  // Calendar mode state
  private calendarEvents: any[] | null = null;
  private calendarLoading = false;
  private calendarPreviews = new Map<string, any>();
  private calendarPreviewLoading = new Set<string>();
  private expandedEvent: string | null = null;
  // Sector matrix state
  private sectorMatrix: { name: string; impact_score: number; direction: string; policy_count: number; top_policies: string[]; reasoning: string }[] | null = null;
  private sectorMatrixLoading = false;
  private sectorMatrixExpanded = false;
  private sectorFilter: string | null = null;  // filter news by sector name
  // Signal tracker state
  private signalData: { groups: any[]; emerging: any[] } | null = null;
  private signalLoading = false;
  // Policy flash state
  private flashData: { title: string; source: string; summary: string; timestamp: string; url: string }[] | null = null;
  private flashLoading = false;
  // Insights (Phase 4) state
  private insightsSignals: any[] = [];
  private insightsIdeas: any[] = [];
  private insightsRegime: { regime: string; label: string; description: string } | null = null;
  private insightsLoading = false;
  private insightsFetched = false;
  private insightsView: 'signals' | 'ideas' = 'signals';
  // Industry mode state
  private industryBrief: IndustryBrief | null = null;
  private industryLoading = false;
  private industryFetched = false;
  private industryDeepLoading = new Set<number>();
  private industryDeepResults = new Map<number, any>();
  // Morning brief state
  private morningBrief: MorningBriefData | null = null;
  private morningBriefLoading = false;
  private morningBriefFetched = false;
  // Opp/Risk filter state
  private oppRiskFilter: 'all' | '紧急' | '重要' | '关注' = 'all';
  private oppRiskDimFilter: 'all' | '合规' | '供应链' | '市场准入' | '成本' | '竞争' = 'all';
  private oppRiskSort: 'impact' | 'urgency' | 'source' = 'impact';
  // Overview collapsible sections
  private overviewCollapsed: Record<string, boolean> = { competitive: false, industry: false, global: false, executives: false };
  // AI provider selector moved to global header (panel-layout.ts)
  // New-item tracking + freshness
  private seenPolicyUrls = new Set<string>();
  private lastFetchTime = 0;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;
  // Onboarding + profile state
  private profileData: UserProfile | null = null;
  private showSetupToast = false;
  private _onVisibilityChange: (() => void) | null = null;

  constructor() {
    super({ id: 'cn-policy', title: '政策数据库 <span class="spark-subtitle">POLICY DATABASE</span>' });
    // Load profile data asynchronously
    loadProfile().then(({ profile }) => {
      this.profileData = profile;
      // If no profile, reset premium-only tabs back to overview
      const noProfile = !profile || (!profile.industries?.length && !profile.company_name);
      if (noProfile && (this.viewMode === 'opprisk' || this.viewMode === 'industry')) {
        this.viewMode = 'overview';
      }
      // Auto-fetch data once profile is ready
      if (this.viewMode === 'live' && !this.newsFetched) {
        void this.fetchLiveNews();
      } else if (this.viewMode === 'overview' && !this.morningBriefFetched) {
        void this.fetchMorningBrief();
      }
      this.render();
    }).catch(() => {
      // Profile load failed — still fetch live news so the panel isn't stuck on "暂无数据"
      if (this.viewMode === 'live' && !this.newsFetched) {
        void this.fetchLiveNews();
      }
    });

    // Save snapshot when user leaves (fire-and-forget)
    this._onVisibilityChange = () => {
      if (document.hidden && this.profileData?.user_id) {
        const uid = this.profileData.user_id;
        cnFetch(`${CN_INTEL_BASE}/api/cn/enterprise/snapshot?user_id=${encodeURIComponent(uid)}`, { method: 'POST' }).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // New items badge click → clear
      if (target.closest('.cn-new-items-badge')) {
        if (this.newsData) {
          this.seenPolicyUrls = new Set((this.newsData.all || []).map(it => it.url));
        }
        this.render();
        return;
      }

      // View mode buttons — both body tabs (.cn-policy-tab) and legacy view buttons (.cn-policy-view-btn)
      const viewBtn = (target.closest('.cn-policy-tab') || target.closest('.cn-policy-view-btn')) as HTMLElement | null;
      if (viewBtn?.dataset.view) {
        this.viewMode = viewBtn.dataset.view as ViewMode;
        if (this.viewMode === 'overview' && !this.morningBriefFetched) void this.fetchMorningBrief();
        if (this.viewMode === 'opprisk' && !this.morningBriefFetched) void this.fetchMorningBrief();
        if (this.viewMode === 'live' && !this.newsFetched) void this.fetchLiveNews();
        if (this.viewMode === 'stats' && !this.stats) {
          void this.fetchStats();
          if (!this.signalData) void this.fetchSignalTracker();
        }
        if (this.viewMode === 'calendar' && !this.calendarEvents) void this.fetchCalendar();
        if (this.viewMode === 'insights' && !this.insightsFetched) void this.fetchInsights();
        if (this.viewMode === 'industry' && !this.industryFetched) void this.fetchIndustryBrief();
        this.render();
        return;
      }

      // Opp/Risk filter chips
      const filterChip = target.closest('.cn-filter-chip') as HTMLElement | null;
      if (filterChip?.dataset.filter) {
        this.oppRiskFilter = filterChip.dataset.filter as any;
        this.render();
        return;
      }

      // Opp/Risk dimension filter chips
      const dimChip = target.closest('.cn-dim-chip') as HTMLElement | null;
      if (dimChip?.dataset.dim) {
        this.oppRiskDimFilter = dimChip.dataset.dim as any;
        this.render();
        return;
      }

      // Opp/Risk sort buttons
      const sortBtn = target.closest('.cn-sort-btn') as HTMLElement | null;
      if (sortBtn?.dataset.sort) {
        this.oppRiskSort = sortBtn.dataset.sort as any;
        this.render();
        return;
      }

      // Overview collapsible sections
      const collapseBtn = target.closest('.cn-collapse-toggle') as HTMLElement | null;
      if (collapseBtn?.dataset.section) {
        const sec = collapseBtn.dataset.section;
        this.overviewCollapsed[sec] = !this.overviewCollapsed[sec];
        this.render();
        return;
      }

      // Report viewer buttons
      const reportBtn = target.closest('.cn-open-report') as HTMLElement | null;
      if (reportBtn?.dataset.reportType) {
        openReportViewer(reportBtn.dataset.reportType as any);
        return;
      }

      // Morning brief refresh button
      if (target.closest('.cn-brief-refresh-btn')) {
        this.morningBriefFetched = false;
        this.morningBrief = null;
        void this.fetchMorningBrief();
        return;
      }

      // Category chip
      const catChip = target.closest('.cn-policy-chip') as HTMLElement | null;
      if (catChip?.dataset.cat) {
        this.categoryFilter = catChip.dataset.cat;
        this.render();
        return;
      }

      // AI report button
      if (target.closest('.cn-policy-report-btn')) {
        if (this.reportVisible && this.reportData) {
          this.reportVisible = false;
          this.render();
        } else {
          void this.fetchReport();
        }
        return;
      }

      // Report close
      if (target.closest('.cn-policy-report-close')) {
        this.reportVisible = false;
        this.render();
        return;
      }

      // Enterprise bar edit icon → open profile modal (stop propagation)
      if (target.closest('.cn-ent-bar-edit')) {
        this._openProfileModal();
        return;
      }

      // Profile gear button → open profile modal
      if (target.closest('.cn-profile-gear-btn')) {
        this._openProfileModal();
        return;
      }

      // Dashboard: "查看实时" button → switch to live view (政策雷达)
      if (target.closest('.cn-dash-goto-live')) {
        this.viewMode = 'live';
        if (!this.newsFetched) void this.fetchLiveNews();
        this.render();
        return;
      }

      // Goto opp/risk view from overview
      if (target.closest('.cn-goto-opprisk')) {
        this.viewMode = 'opprisk';
        if (!this.morningBriefFetched) void this.fetchMorningBrief();
        this.render();
        return;
      }

      // Welcome banner: setup button
      if (target.closest('.cn-welcome-setup-btn')) {
        this._openProfileModal();
        return;
      }

      // Welcome banner: dismiss button
      if (target.closest('.cn-welcome-dismiss-btn')) {
        markOnboardingComplete();
        this.render();
        return;
      }

      // Insights sub-tab (signals / ideas)
      const insightsTab = target.closest('.cn-insights-sub-tab') as HTMLElement | null;
      if (insightsTab?.dataset.subtab) {
        this.insightsView = insightsTab.dataset.subtab as 'signals' | 'ideas';
        if (this.insightsView === 'ideas' && !this.insightsIdeas.length) void this.fetchInsightIdeas();
        this.render();
        return;
      }

      // CSV export button
      if (target.closest('.cn-policy-export-btn')) {
        this.exportCSV();
        return;
      }

      // History search button
      if (target.closest('.cn-policy-search-btn')) {
        void this.fetchHistory();
        return;
      }

      // Sector matrix toggle
      if (target.closest('.cn-sector-bar-header')) {
        this.sectorMatrixExpanded = !this.sectorMatrixExpanded;
        this.render();
        return;
      }

      // Sector cell click → filter
      const sectorCell = target.closest('.cn-sector-cell[data-sector]') as HTMLElement | null;
      if (sectorCell?.dataset.sector) {
        const name = sectorCell.dataset.sector;
        this.sectorFilter = this.sectorFilter === name ? null : name;
        this.render();
        return;
      }

      // Sector filter clear
      if (target.closest('.cn-sector-filter-clear')) {
        this.sectorFilter = null;
        this.render();
        return;
      }

      // Calendar event card click → toggle AI preview
      const calCard = target.closest('.cn-cal-card[data-event]') as HTMLElement | null;
      if (calCard?.dataset.event) {
        const eventName = calCard.dataset.event;
        if (this.expandedEvent === eventName) {
          this.expandedEvent = null;
        } else {
          this.expandedEvent = eventName;
          if (!this.calendarPreviews.has(eventName) && !this.calendarPreviewLoading.has(eventName)) {
            void this.fetchCalendarPreview(eventName);
          }
        }
        this.render();
        return;
      }

      // Industry: deep analysis button
      const deepBtn = target.closest('.cn-ind-deep-btn[data-deep-idx]') as HTMLElement | null;
      if (deepBtn?.dataset.deepIdx) {
        const idx = parseInt(deepBtn.dataset.deepIdx, 10);
        void this.fetchDeepAnalysis(idx);
        return;
      }

      // Industry: retry button
      if (target.closest('.cn-ind-retry-btn')) {
        this.industryFetched = false;
        this.industryBrief = null;
        void this.fetchIndustryBrief();
        return;
      }

      // Industry: setup profile button (all views)
      if (target.closest('.cn-ind-setup-btn-sm')) {
        this._openProfileModal();
        return;
      }

      // Click on policy news item → open detail drawer
      const itemEl = target.closest('.cn-policy-item[data-idx]') as HTMLElement | null;
      if (itemEl) {
        const idx = parseInt(itemEl.dataset.idx || '-1', 10);
        const item = this.getVisibleItems()[idx];
        if (item && item.url) {
          openPolicyDrawer(item);
        }
        return;
      }

      // Dashboard policy item click → open detail drawer
      const dashItem = target.closest('.cn-dash-policy-item[data-url]') as HTMLElement | null;
      if (dashItem) {
        const url = dashItem.dataset.url || '';
        if (url) {
          const titleEl = dashItem.querySelector('.cn-dash-policy-title');
          openPolicyDrawer({ title: titleEl?.textContent || '', url, date: '', source: '', category: '', icon: '' });
        }
        return;
      }
    });

    // Auto-fetch data on mount based on default view
    void this.fetchMorningBrief();
    if (this.viewMode === 'live' && !this.newsFetched) {
      void this.fetchLiveNews();
    }
    this.freshnessTimer = setInterval(() => this.updateFreshness(), 30_000);

    // Load delta banner (Phase 2)
    import('@/components/CnDeltaBanner').then(m => {
      const wrap = this.content;
      if (wrap) m.mountDeltaBanner(wrap);
    }).catch(() => {});

    // Connect FLASH alert SSE stream (Phase 3)
    import('@/services/cn-alerts').then(m => {
      m.connectFlashStream();
    }).catch(() => {});
  }

  /** Public: switch view mode (called from global header buttons). */
  switchToView(mode: ViewMode): void {
    this.viewMode = mode;
    if (mode === 'overview' && !this.morningBriefFetched) void this.fetchMorningBrief();
    if (mode === 'opprisk' && !this.morningBriefFetched) void this.fetchMorningBrief();
    if (mode === 'live' && !this.newsFetched) void this.fetchLiveNews();
    if (mode === 'industry' && !this.industryFetched) void this.fetchIndustryBrief();
    this.render();
  }

  // ── Data fetching ──────────────────────────────────────────────────────────

  private _newsRetryTimer: ReturnType<typeof setTimeout> | null = null;

  private async fetchLiveNews(isRetry = false): Promise<void> {
    if (this.newsLoading) return;
    this.newsLoading = true;
    this.render();
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/gov-news`, { signal: this.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Reconstruct flat `all` list from categories (server omits it to reduce payload ~35%)
      if (!data.all && data.categories) {
        const seen = new Set<string>();
        const merged: any[] = [];
        for (const items of Object.values(data.categories) as any[][]) {
          for (const it of items) {
            if (it.url && !seen.has(it.url)) { seen.add(it.url); merged.push(it); }
          }
        }
        merged.sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''));
        data.all = merged;
      }

      // Backend returns _loading=true when cache is cold and crawl is in progress
      // Retry after a few seconds to get the real data
      if (data._loading || (data._from_db && !isRetry)) {
        this.newsData = data;
        this.newsFetched = true;
        this.newsLoading = false;
        if (data._from_db) {
          this.setDataBadge('cached', '显示历史数据，正在刷新...');
        }
        this.render();
        // Auto-retry after 8s to pick up freshly crawled data
        if (this._newsRetryTimer) clearTimeout(this._newsRetryTimer);
        this._newsRetryTimer = setTimeout(() => {
          this._newsRetryTimer = null;
          this.newsFetched = false;  // allow re-fetch
          void this.fetchLiveNews(true);
        }, 8000);
        return;
      }

      this.newsData = data;
      this.newsFetched = true;
      this.lastFetchTime = Date.now();
      // Auto-fetch sector matrix + flash after live news loads
      if (!this.sectorMatrix && !this.sectorMatrixLoading) {
        void this.fetchSectorMatrix();
      }
      if (!this.flashData && !this.flashLoading) {
        void this.fetchFlash();
      }
      if ((this.newsData as any)?._stale) {
        this.setDataBadge('cached', '数据可能过时');
      } else {
        this.updateFreshness();
      }
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.newsData) {
        this.showError('政策数据加载失败，点击重试');
        return;
      }
    } finally {
      this.newsLoading = false;
      this.render();
    }
  }

  private async fetchReport(): Promise<void> {
    if (this.reportLoading) return;
    this.reportLoading = true;
    this.reportVisible = true;
    this.render();
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/gov-news/report`, { signal: this.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.reportData = await res.json();
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.reportData = { report: '加载失败，请稍后重试。', generated: false };
    } finally {
      this.reportLoading = false;
      this.render();
    }
  }

  private async fetchHistory(): Promise<void> {
    // Read from input fields
    const startInput = this.content.querySelector('.cn-policy-start') as HTMLInputElement | null;
    const endInput = this.content.querySelector('.cn-policy-end') as HTMLInputElement | null;
    const searchInput = this.content.querySelector('.cn-policy-search-input') as HTMLInputElement | null;

    if (startInput) this.historyStart = startInput.value;
    if (endInput) this.historyEnd = endInput.value;
    if (searchInput) this.searchQuery = searchInput.value.trim();

    this.historyLoading = true;
    this.render();
    try {
      let url: string;
      if (this.searchQuery) {
        url = `${CN_INTEL_BASE}/api/cn/policy/search?q=${encodeURIComponent(this.searchQuery)}&limit=200`;
      } else {
        const params = new URLSearchParams();
        if (this.historyStart) params.set('start', this.historyStart);
        if (this.historyEnd) params.set('end', this.historyEnd);
        if (this.historyCategory) params.set('category', this.historyCategory);
        params.set('limit', '300');
        url = `${CN_INTEL_BASE}/api/cn/policy/history?${params}`;
      }
      const res = await fetch(url, { signal: this.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.historyItems = data.items || [];
    } catch (err) {
      if (this.isAbortError(err)) return;
    } finally {
      this.historyLoading = false;
      this.render();
    }
  }

  private async fetchStats(): Promise<void> {
    if (this.statsLoading) return;
    this.statsLoading = true;
    this.render();
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/policy/stats`, { signal: this.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.stats = await res.json();
    } catch (err) {
      if (this.isAbortError(err)) return;
    } finally {
      this.statsLoading = false;
      this.render();
    }
  }

  private async fetchCalendar(): Promise<void> {
    if (this.calendarLoading) return;
    this.calendarLoading = true;
    this.render();
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/policy/calendar?days_ahead=60`, { signal: this.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.calendarEvents = data.events || [];
    } catch (err) {
      if (this.isAbortError(err)) return;
    } finally {
      this.calendarLoading = false;
      this.render();
    }
  }

  private async fetchCalendarPreview(eventName: string): Promise<void> {
    this.calendarPreviewLoading.add(eventName);
    this.render();
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/policy/calendar/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_name: eventName }),
        signal: this.signal,
      });
      if (res.ok) {
        const data = await res.json();
        this.calendarPreviews.set(eventName, data);
      }
    } catch (err) {
      if (this.isAbortError(err)) return;
    } finally {
      this.calendarPreviewLoading.delete(eventName);
      this.render();
    }
  }

  private async fetchSignalTracker(): Promise<void> {
    if (this.signalLoading) return;
    this.signalLoading = true;
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/policy/signal-tracker?days_back=90`, { signal: this.signal });
      if (res.ok) {
        this.signalData = await res.json();
      }
    } catch (err) {
      if (this.isAbortError(err)) return;
    } finally {
      this.signalLoading = false;
      this.render();
    }
  }

  private async fetchFlash(): Promise<void> {
    if (this.flashLoading) return;
    this.flashLoading = true;
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/policy/flash?limit=10`, { signal: this.signal });
      if (res.ok) {
        const data = await res.json();
        this.flashData = data.flashes || [];
      }
    } catch (err) {
      if (this.isAbortError(err)) return;
    } finally {
      this.flashLoading = false;
      this.render();
    }
  }

  private async fetchSectorMatrix(): Promise<void> {
    if (this.sectorMatrixLoading) return;
    this.sectorMatrixLoading = true;
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/policy/sector-matrix`, { signal: this.signal });
      if (res.ok) {
        const data = await res.json();
        this.sectorMatrix = data.sectors || [];
      }
    } catch (err) {
      if (this.isAbortError(err)) return;
    } finally {
      this.sectorMatrixLoading = false;
      this.render();
    }
  }

  // ── Report History ─────────────────────────────────────────────────────────

  // ── Rendering ──────────────────────────────────────────────────────────────

  private render(): void {
    const reportBtnIcon = this.reportLoading ? 'bi-arrow-repeat' : 'bi-file-earmark-text';
    const reportBtnSpin = this.reportLoading ? ' style="animation:spin 1s linear infinite"' : '';
    const reportBtnTitle = this.reportVisible ? '关闭日报' : 'AI政策日报';

    // --- Tabs row with action buttons on the right ---
    // Always show all 4 tabs; individual render methods show onboarding prompt when no profile
    const tabViews: { key: ViewMode; label: string }[] = [
      { key: 'overview', label: '情报概览' },
      { key: 'opprisk', label: '机遇与风险' },
      { key: 'live', label: '政策雷达' },
      { key: 'industry', label: '产业洞察' },
    ];
    const tabsHtml = tabViews.map(t =>
      `<button class="cn-policy-tab ${t.key === this.viewMode ? 'active' : ''}" data-view="${t.key}">${t.label}</button>`
    ).join('');

    let bodyHtml = '';
    switch (this.viewMode) {
      case 'overview': bodyHtml = this.renderOverview(); break;
      case 'opprisk': bodyHtml = this.renderOppRisk(); break;
      case 'live': bodyHtml = this.renderLive(); break;
      case 'history': bodyHtml = this.renderHistory(); break;
      case 'stats': bodyHtml = this.renderStats(); break;
      case 'calendar': bodyHtml = this.renderCalendar(); break;
      case 'insights': bodyHtml = this.renderInsights(); break;
      case 'industry': bodyHtml = this.renderIndustry(); break;
      default: bodyHtml = this.renderOverview(); break;
    }

    // Success toast after profile setup
    const toastHtml = this.showSetupToast
      ? `<div class="cn-setup-toast"><i class="bi bi-check-circle-fill"></i> 画像已设置！系统正在为你筛选相关政策...</div>`
      : '';

    this.setContent(`${STYLE}
      <div class="cn-policy" style="position:relative">
        <div class="cn-policy-header">
          <div class="cn-policy-tabs" style="flex:1;margin-bottom:0;border-bottom:none;padding-bottom:0">${tabsHtml}</div>
          <div class="cn-header-actions">
            <button class="cn-header-icon-btn cn-policy-report-btn ${this.reportVisible ? 'active' : ''}" title="${reportBtnTitle}"><i class="bi ${reportBtnIcon}"${reportBtnSpin}></i> AI政策日报</button>
          </div>
        </div>
        ${toastHtml}
        ${bodyHtml}
      </div>
    `);
  }

  private renderLive(): string {
    // Category chips with count badges
    const chipsHtml = GOV_CATEGORY_FILTERS.map(f => {
      let count = 0;
      if (this.newsData) {
        if (f.key === 'all') {
          count = this.newsData.all?.length || 0;
        } else {
          count = (this.newsData.categories?.[f.key] || []).length;
        }
      }
      const badge = count > 0 ? ` <span class="cn-policy-chip-count">${count}</span>` : '';
      return `<button class="cn-policy-chip ${f.key === this.categoryFilter ? 'active' : ''}" data-cat="${f.key}">${f.label}${badge}</button>`;
    }).join('');

    // Report drawer
    let reportHtml = '';
    if (this.reportVisible) {
      if (this.reportLoading) {
        reportHtml = '<div class="cn-policy-report-drawer"><div class="cn-policy-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> AI正在生成政策日报...</div></div>';
      } else if (this.reportData) {
        const content = this.reportData.report
          .replace(/^## (.+)$/gm, '<div class="cn-policy-report-section">$1</div>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/^\d+\.\s+(.+)$/gm, '<div class="cn-policy-report-bullet">$1</div>')
          .replace(/^- (.+)$/gm, '<div class="cn-policy-report-bullet">$1</div>')
          .replace(/\n\n/g, '<br>')
          .replace(/\n/g, '<br>');
        reportHtml = `<div class="cn-policy-report-drawer">
          <div class="cn-policy-report-header">
            <span><i class="bi bi-file-earmark-text"></i> AI政策日报</span>
            <button class="cn-policy-report-close"><i class="bi bi-x-lg"></i></button>
          </div>
          <div class="cn-policy-report-body">${content}</div>
        </div>`;
      }
    }

    // Stats bar
    let statsBar = '';
    if (this.newsData) {
      const sources = this.newsData.sources || {};
      const activeCount = Object.values(sources).filter(n => n > 0).length;
      statsBar = `<div class="cn-policy-stats-bar">
        <div class="cn-policy-stat"><i class="bi bi-newspaper"></i> <span class="val">${this.newsData.total}</span> 条新闻</div>
        <div class="cn-policy-stat"><i class="bi bi-flag-fill"></i> <span class="val">${activeCount}/${Object.keys(sources).length}</span> 数据源</div>
        <div class="cn-policy-stat"><i class="bi bi-grid-3x3"></i> <span class="val">${(this.newsData.category_list || []).length}</span> 分类</div>
      </div>`;
    }

    // If we have real data (total > 0), always show it — don't block with spinner
    const hasRealData = this.newsData && (this.newsData.total ?? 0) > 0;
    if (!hasRealData) {
      // Loading — show spinner when actively loading, when backend signals cold cache (_loading),
      // or when data hasn't been fetched yet (first visit)
      const isBackendLoading = (this.newsData as any)?._loading;
      const isWaitingRetry = this._newsRetryTimer !== null;
      if (this.newsLoading || isBackendLoading || isWaitingRetry) {
        const hint = isBackendLoading || isWaitingRetry
          ? '正在采集最新政策数据，请稍候...'
          : '加载政策新闻中...';
        return `<div class="cn-policy-chips">${chipsHtml}</div>${reportHtml}${statsBar}<div class="cn-policy-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> ${hint}</div>`;
      }
      if (!this.newsData) {
        return `<div class="cn-policy-chips">${chipsHtml}</div>${reportHtml}<div class="cn-policy-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 正在加载政策数据...</div>`;
      }
    }

    // Filter items — after the early-return block above, newsData is guaranteed non-null
    const nd = this.newsData!;
    let items: GovNewsItem[] = [];
    if (this.categoryFilter === 'all') {
      items = nd.all || [];
    } else {
      items = (nd.categories || {})[this.categoryFilter] || [];
    }

    // Track new items
    const allUrls = new Set((nd.all || []).map(it => it.url));
    const newUrls = this.seenPolicyUrls.size > 0
      ? new Set(items.filter(it => !this.seenPolicyUrls.has(it.url)).map(it => it.url))
      : new Set<string>();
    const newCount = newUrls.size;
    this.seenPolicyUrls = allUrls;

    const badgeHtml = newCount > 0
      ? `<div class="cn-new-items-badge"><i class="bi bi-bell"></i> ${newCount}条新政策</div>`
      : '';

    // Flash banner + Sector matrix bar
    const flashBanner = this.renderFlashBanner();
    const sectorBar = this.renderSectorMatrix();

    // Sector filter: filter items by sector's top_policies
    let sectorFilterBanner = '';
    if (this.sectorFilter && this.sectorMatrix) {
      const sec = this.sectorMatrix.find(s => s.name === this.sectorFilter);
      if (sec && sec.top_policies) {
        const policyTitles = new Set(sec.top_policies);
        items = items.filter(it => {
          const title = it.title || '';
          return policyTitles.has(title) || title.includes(this.sectorFilter!);
        });
      }
      sectorFilterBanner = `<div class="cn-sector-filter-banner">
        <i class="bi bi-funnel"></i> 筛选: ${escapeHtml(this.sectorFilter)} (${items.length}条)
        <button class="cn-sector-filter-clear"><i class="bi bi-x-lg"></i></button>
      </div>`;
    }

    // International categories use card layout
    const isIntl = this.categoryFilter === '国际央行' || this.categoryFilter === '国际机构' || this.categoryFilter === '国际媒体';
    let newsHtml: string;
    if (items.length === 0) {
      newsHtml = '<div class="cn-policy-empty">该类别暂无新闻</div>';
    } else if (isIntl) {
      newsHtml = this.renderIntlCards(items);
    } else {
      newsHtml = items.slice(0, 50).map((item, i) => this.renderItem(item, i, newUrls.has(item.url))).join('');
    }

    return `<div class="cn-policy-chips">${chipsHtml}</div>${reportHtml}${statsBar}${flashBanner}${sectorBar}${badgeHtml}${sectorFilterBanner}${newsHtml}`;
  }

  private renderHistory(): string {
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const start = this.historyStart || weekAgo;
    const end = this.historyEnd || today;

    const catOptions = GOV_CATEGORY_FILTERS.map(f =>
      `<button class="cn-policy-chip ${f.key === (this.historyCategory || 'all') ? 'active' : ''}" data-cat="${f.key}">${f.label}</button>`
    ).join('');

    const dateRange = `<div class="cn-policy-date-range">
      <input type="date" class="cn-policy-date-input cn-policy-start" value="${start}">
      <span style="color:#666">至</span>
      <input type="date" class="cn-policy-date-input cn-policy-end" value="${end}">
      <input type="text" class="cn-policy-search-input" placeholder="搜索关键词..." value="${escapeHtml(this.searchQuery)}">
      <button class="cn-policy-search-btn"><i class="bi bi-search"></i> 查询</button>
    </div>`;

    let resultHtml = '';
    if (this.historyLoading) {
      resultHtml = '<div class="cn-policy-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 查询中...</div>';
    } else if (this.historyItems.length > 0) {
      resultHtml = `<div class="cn-policy-stats-bar">
        <div class="cn-policy-stat">查询结果: <span class="val">${this.historyItems.length}</span> 条</div>
      </div>` + this.historyItems.map((item, i) => this.renderItem(item, i)).join('');
    } else if (this.historyStart || this.searchQuery) {
      resultHtml = '<div class="cn-policy-empty">未找到匹配结果，请调整查询条件</div>';
    } else {
      resultHtml = '<div class="cn-policy-empty">选择日期范围或输入关键词，点击查询</div>';
    }

    return `${dateRange}<div class="cn-policy-chips">${catOptions}</div>${resultHtml}`;
  }

  private renderStats(): string {
    if (this.statsLoading) {
      return '<div class="cn-policy-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 加载统计数据...</div>';
    }
    if (!this.stats) {
      return '<div class="cn-policy-empty">暂无统计数据</div>';
    }

    const s = this.stats;
    const cardsHtml = `<div class="cn-policy-stats-grid">
      <div class="cn-policy-stats-card">
        <div class="cn-policy-stats-card-title">总条目数</div>
        <div class="cn-policy-stats-card-value">${s.total.toLocaleString()}</div>
      </div>
      <div class="cn-policy-stats-card">
        <div class="cn-policy-stats-card-title">今日新增</div>
        <div class="cn-policy-stats-card-value">${s.today_count}</div>
      </div>
      <div class="cn-policy-stats-card">
        <div class="cn-policy-stats-card-title">数据源</div>
        <div class="cn-policy-stats-card-value">${Object.keys(s.sources || {}).length}</div>
      </div>
      <div class="cn-policy-stats-card">
        <div class="cn-policy-stats-card-title">覆盖日期</div>
        <div class="cn-policy-stats-card-value" style="font-size:13px">${s.earliest_date || '-'}<br>${s.latest_date || '-'}</div>
      </div>
    </div>`;

    // Date chart (last 30 days)
    const dateSummary = s.date_summary || [];
    let chartHtml = '';
    if (dateSummary.length > 0) {
      const maxCount = Math.max(...dateSummary.map(d => d.count));
      const bars = dateSummary.slice(0, 30).reverse().map(d => {
        const h = maxCount > 0 ? Math.max(4, (d.count / maxCount) * 56) : 4;
        return `<div class="cn-policy-date-bar" style="height:${h}px" title="${d.date}: ${d.count}条"></div>`;
      }).join('');
      chartHtml = `<div style="font-size:11px;color:#888;margin-bottom:4px">近30天数据量趋势</div>
        <div class="cn-policy-date-chart">${bars}</div>`;
    }

    // Category breakdown
    const catHtml = Object.entries(s.categories || {}).map(([cat, cnt]) =>
      `<div class="cn-policy-source-row">
        <span class="cn-policy-source-name">${escapeHtml(cat)}</span>
        <span class="cn-policy-source-count">${cnt}</span>
      </div>`
    ).join('');

    // Source breakdown
    const srcHtml = Object.entries(s.sources || {}).map(([key, info]) =>
      `<div class="cn-policy-source-row">
        <span class="cn-policy-source-name">${escapeHtml(info.name || key)}</span>
        <span class="cn-policy-source-count">${info.count}</span>
      </div>`
    ).join('');

    // Donut chart for category distribution
    const donutHtml = this.renderCategoryDonut(s.categories || {});

    // Signal tracker section
    const signalHtml = this.signalLoading
      ? '<div style="text-align:center;padding:12px;color:#888;font-size:11px"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 加载信号数据...</div>'
      : this.renderSignalTracker();

    return `${cardsHtml}${chartHtml}
      <div style="font-size:12px;color:#aaa;font-weight:600;margin:8px 0 4px">分类分布</div>
      ${donutHtml}
      <div class="cn-policy-source-list">${catHtml}</div>
      ${signalHtml}
      <div style="font-size:12px;color:#aaa;font-weight:600;margin:12px 0 4px">数据源详情</div>
      <div class="cn-policy-source-list">${srcHtml}</div>`;
  }

  private renderCalendar(): string {
    if (this.calendarLoading) {
      return '<div class="cn-policy-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 加载政策日历...</div>';
    }
    if (!this.calendarEvents || this.calendarEvents.length === 0) {
      return '<div class="cn-policy-empty">未来30天暂无已知重大政策事件</div>';
    }

    const cards = this.calendarEvents.map(evt => {
      const name = evt.name || '';
      const importance = evt.importance || 'B';
      const isToday = evt.is_today;
      const daysUntil = evt.days_until;
      const isRecurring = evt.is_recurring;

      let countdownText = '';
      if (isToday) countdownText = '今天';
      else if (isRecurring) countdownText = evt.frequency || '定期';
      else if (daysUntil >= 0) countdownText = `${daysUntil}天后`;

      const countdownClass = isToday ? 'cn-cal-countdown today' : 'cn-cal-countdown';
      const dateStr = evt.date ? `<span style="color:#888;font-size:11px">${escapeHtml(evt.date)}</span>` : '';
      const sectorsHtml = (evt.impact_sectors || []).map(
        (s: string) => `<span class="cn-cal-sector-tag">${escapeHtml(s)}</span>`
      ).join('');

      // AI preview (expanded)
      let previewHtml = '';
      if (this.expandedEvent === name) {
        if (this.calendarPreviewLoading.has(name)) {
          previewHtml = '<div class="cn-cal-preview"><div class="cn-cal-preview-loading"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> AI预判生成中...</div></div>';
        } else {
          const preview = this.calendarPreviews.get(name);
          if (preview && preview.scenarios && preview.scenarios.length > 0) {
            const scenariosHtml = preview.scenarios.map((sc: any) => {
              const color = sc.direction === '乐观' ? '#ef5350' : (sc.direction === '悲观' ? '#43a047' : '#e8a838');
              return `<div class="cn-cal-scenario">
                <span class="cn-cal-scenario-dir" style="color:${color}">${escapeHtml(sc.direction)}</span>
                <div class="cn-cal-scenario-bar-bg"><div class="cn-cal-scenario-bar" style="width:${sc.probability}%;background:${color}"></div></div>
                <span class="cn-cal-scenario-pct">${sc.probability}%</span>
              </div>
              <div style="font-size:10px;color:#888;margin-left:38px;margin-bottom:4px">${escapeHtml(sc.description || '')}</div>`;
            }).join('');

            const focusHtml = (preview.key_focus || []).map(
              (f: string) => `<div class="cn-cal-focus-item">${escapeHtml(f)}</div>`
            ).join('');

            const implication = preview.market_implication ? `<div style="margin-top:6px;font-size:11px;color:#ccc">${escapeHtml(preview.market_implication)}</div>` : '';

            previewHtml = `<div class="cn-cal-preview">
              <div style="font-size:11px;color:#e8a838;margin-bottom:6px;font-weight:600">AI预判</div>
              ${scenariosHtml}
              ${focusHtml ? `<div class="cn-cal-focus" style="margin-top:6px"><div style="font-size:10px;color:#e8a838;margin-bottom:2px">关注要点</div>${focusHtml}</div>` : ''}
              ${implication}
            </div>`;
          } else {
            previewHtml = '<div class="cn-cal-preview"><div style="color:#888;font-size:11px">暂无AI预判</div></div>';
          }
        }
      }

      return `<div class="cn-cal-card" data-event="${escapeHtml(name)}">
        <div class="cn-cal-card-head">
          <span class="cn-cal-badge cn-cal-badge-${importance}">${importance}</span>
          <span class="cn-cal-card-name">${escapeHtml(name)}</span>
          ${dateStr}
          ${countdownText ? `<span class="${countdownClass}">${countdownText}</span>` : ''}
        </div>
        <div class="cn-cal-card-desc">${escapeHtml(evt.description || '')}</div>
        <div class="cn-cal-sectors">${sectorsHtml}</div>
        ${previewHtml}
      </div>`;
    }).join('');

    return `<div class="cn-cal-list">${cards}</div>`;
  }

  private renderFlashBanner(): string {
    if (!this.flashData || this.flashData.length === 0) return '';

    const items = this.flashData.slice(0, 3);
    const isRecent = items.some(f => {
      const ts = new Date(f.timestamp).getTime();
      return Date.now() - ts < 3600_000; // within 1 hour
    });
    const bannerClass = isRecent ? 'cn-flash-banner' : 'cn-flash-banner amber';

    const itemsHtml = items.map(f =>
      `<div class="cn-flash-item" title="${escapeHtml(f.summary || f.title || '')}">
        <span style="color:#888;font-size:10px;white-space:nowrap">[${escapeHtml(f.source || '')}]</span>
        <span class="cn-flash-title">${escapeHtml(f.title || '')}</span>
      </div>`
    ).join('');

    return `<div class="${bannerClass}">
      <div class="cn-flash-header"><i class="bi bi-lightning-charge-fill"></i> 政策快报</div>
      ${itemsHtml}
    </div>`;
  }

  // ── Insights (Phase 4) ─────────────────────────────────────────────────────

  private async fetchInsights(): Promise<void> {
    if (this.insightsLoading) return;
    this.insightsLoading = true;
    this.render();
    try {
      const [corrRes, regimeRes] = await Promise.all([
        cnFetch(`${CN_INTEL_BASE}/api/cn/insights/correlations`, { signal: this.signal }),
        cnFetch(`${CN_INTEL_BASE}/api/cn/insights/regime`, { signal: this.signal }),
      ]);
      if (corrRes.ok) {
        const data = await corrRes.json();
        this.insightsSignals = data.signals || [];
      }
      if (regimeRes.ok) {
        this.insightsRegime = await regimeRes.json();
      }
      this.insightsFetched = true;
    } catch (err) {
      if (this.isAbortError(err)) return;
    } finally {
      this.insightsLoading = false;
      this.render();
    }
  }

  private async fetchInsightIdeas(): Promise<void> {
    this.insightsLoading = true;
    this.render();
    try {
      const { getUserId } = await import('@/services/cn-profile');
      const uid = getUserId();
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/insights/trade-ideas?user_id=${encodeURIComponent(uid)}`, { signal: this.signal });
      if (res.ok) {
        const data = await res.json();
        this.insightsIdeas = data.ideas || [];
      }
    } catch (err) {
      if (this.isAbortError(err)) return;
    } finally {
      this.insightsLoading = false;
      this.render();
    }
  }

  private renderInsights(): string {
    // Sub-tabs: signals / ideas
    const subTabs = (['signals', 'ideas'] as const).map(v => {
      const labels = { signals: '<i class="bi bi-diagram-3"></i> 跨域信号', ideas: '<i class="bi bi-lightbulb"></i> 交易建议' };
      return `<button class="cn-insights-sub-tab ${v === this.insightsView ? 'active' : ''}" data-subtab="${v}">${labels[v]}</button>`;
    }).join('');

    // Regime bar
    let regimeHtml = '';
    if (this.insightsRegime) {
      const r = this.insightsRegime;
      regimeHtml = `<div class="cn-regime-bar">
        <span class="cn-regime-indicator ${r.regime}"><span class="cn-regime-dot"></span> ${escapeHtml(r.label)}</span>
        <span class="cn-regime-desc">${escapeHtml(r.description)}</span>
      </div>`;
    }

    if (this.insightsLoading) {
      return `<div class="cn-insights-section">
        <div class="cn-insights-sub-tabs">${subTabs}</div>
        ${regimeHtml}
        <div style="text-align:center;padding:30px;color:#888"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 加载跨域分析...</div>
      </div>`;
    }

    let bodyHtml = '';
    if (this.insightsView === 'signals') {
      bodyHtml = this._renderInsightSignals();
    } else {
      bodyHtml = this._renderInsightIdeas();
    }

    return `<div class="cn-insights-section">
      <div class="cn-insights-sub-tabs">${subTabs}</div>
      ${regimeHtml}
      ${bodyHtml}
    </div>`;
  }

  private _renderInsightSignals(): string {
    if (!this.insightsSignals.length) {
      return `<div style="text-align:center;padding:30px;color:#666">
        <i class="bi bi-diagram-3" style="font-size:28px;display:block;margin-bottom:8px;color:#444"></i>
        暂无跨域信号
        <div style="font-size:11px;margin-top:6px;color:#555">跨域信号需要政策、舆情、市场三个维度同时活跃时才会生成。<br>交易时段(9:30-15:00)数据更丰富，信号更多。</div>
      </div>`;
    }

    return this.insightsSignals.map(sig => {
      const confCls = sig.confidence > 0.7 ? 'high' : (sig.confidence > 0.5 ? 'med' : 'low');
      const domains: string[] = [];
      if (sig.policy_detail?.direction && sig.policy_detail.direction !== 'neutral')
        domains.push(`政策:${sig.policy_detail.direction}`);
      if (sig.sentiment_detail?.direction && sig.sentiment_detail.direction !== 'neutral')
        domains.push(`舆情:${sig.sentiment_detail.direction}`);
      if (sig.market_detail?.direction && sig.market_detail.direction !== 'neutral')
        domains.push(`市场:${sig.market_detail.direction}`);

      return `<div class="cn-signal-card">
        <div class="cn-signal-card-head">
          <span class="cn-signal-pattern cn-signal-${escapeHtml(sig.pattern)}">${escapeHtml(sig.pattern)}</span>
          <span class="cn-signal-sector">${escapeHtml(sig.sector)}</span>
          <span class="cn-signal-conf ${confCls}">${(sig.confidence * 100).toFixed(0)}%</span>
        </div>
        <div class="cn-signal-desc">${escapeHtml(sig.description)}</div>
        <div class="cn-signal-domains">
          ${domains.map(d => `<span class="cn-signal-domain">${d}</span>`).join('')}
        </div>
      </div>`;
    }).join('');
  }

  private _renderInsightIdeas(): string {
    if (!this.insightsIdeas.length) {
      return '<div style="text-align:center;padding:30px;color:#666">暂无交易建议<div style="font-size:11px;margin-top:6px;color:#555">设置企业画像后，AI将生成个性化投资建议</div></div>';
    }

    return this.insightsIdeas.map((idea: any) => {
      const confPct = (idea.confidence * 100).toFixed(0);
      const confColor = idea.action === 'BUY' ? '#ef5350' : (idea.action === 'SELL' ? '#43a047' : '#e8a838');

      return `<div class="cn-idea-card ${escapeHtml(idea.action)}">
        <div class="cn-idea-header">
          <span class="cn-idea-action ${escapeHtml(idea.action)}">${escapeHtml(idea.action)}</span>
          <span class="cn-idea-instrument">${escapeHtml(idea.instrument || '')}</span>
          <div class="cn-idea-conf-bar">
            <div class="cn-idea-conf-fill" style="width:${confPct}%;background:${confColor}"></div>
          </div>
        </div>
        <div class="cn-idea-thesis">${escapeHtml(idea.thesis || '')}</div>
        <div class="cn-idea-meta">
          <span class="cn-idea-meta-label">时间框架:</span> ${escapeHtml(idea.timeframe || '')}
          ${idea.entry_condition ? ` | <span class="cn-idea-meta-label">入场:</span> ${escapeHtml(idea.entry_condition)}` : ''}
          ${idea.risks?.length ? `<br><span class="cn-idea-meta-label">风险:</span> ${idea.risks.map((r: string) => escapeHtml(r)).join(', ')}` : ''}
        </div>
      </div>`;
    }).join('');
  }

  // ── Profile modal helper ──────────────────────────────────────────────────

  private _openProfileModal(): void {
    import('@/components/CnProfileModal').then(m => m.openProfileModal((saved) => {
      markOnboardingComplete();
      if (saved && saved.industries?.length) {
        this.profileData = saved;
      }
      loadProfile().then(({ profile }) => {
        if (profile && profile.industries?.length) this.profileData = profile;
      }).catch(() => {});
      this.showSetupToast = true;
      this.industryFetched = false;
      this.industryBrief = null;
      this.morningBriefFetched = false;
      this.morningBrief = null;
      this.render();
      setTimeout(() => { this.showSetupToast = false; this.render(); }, 3200);
      if (this.viewMode === 'industry') void this.fetchIndustryBrief();
      if (this.viewMode === 'overview' || this.viewMode === 'opprisk') void this.fetchMorningBrief();
    })).catch(err => console.error('[CnPolicyPanel] openProfileModal failed:', err));
  }

  // ── Industry view ────────────────────────────────────────────────────────

  private async fetchMorningBrief(): Promise<void> {
    if (this.morningBriefLoading) return;
    this.morningBriefLoading = true;
    this.render();
    try {
      const uid = this.profileData?.user_id || getUserId();
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/enterprise/morning-brief?user_id=${encodeURIComponent(uid)}`, { signal: this.signal, timeout: 180_000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.morningBrief = await res.json();
      this.morningBriefFetched = true;
    } catch (err) {
      if (this.isAbortError(err)) return;
    } finally {
      this.morningBriefLoading = false;
      this.render();
    }
  }

  private async fetchIndustryBrief(): Promise<void> {
    if (this.industryLoading) return;
    this.industryLoading = true;
    this.render();
    try {
      const uid = this.profileData?.user_id || getUserId();
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/industry/brief?user_id=${encodeURIComponent(uid)}`, { signal: this.signal, timeout: 180_000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.industryBrief = await res.json();
      this.industryFetched = true;
    } catch (err) {
      if (this.isAbortError(err)) return;
    } finally {
      this.industryLoading = false;
      this.industryFetched = true;
      this.render();
    }
  }

  private async fetchDeepAnalysis(idx: number): Promise<void> {
    if (this.industryDeepLoading.has(idx)) return;
    const dev = this.industryBrief?.key_developments?.[idx];
    if (!dev) return;
    this.industryDeepLoading.add(idx);
    this.render();
    try {
      const industries = this.industryBrief?.industries || this.profileData?.industries || [];
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/industry/deep-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policy: { title: dev.title, source: dev.source, date: dev.date },
          industries,
        }),
        signal: this.signal,
        timeout: 180_000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      this.industryDeepResults.set(idx, result);
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.industryDeepResults.set(idx, { error: true });
    } finally {
      this.industryDeepLoading.delete(idx);
      this.render();
    }
  }

  private renderOverview(): string {
    // Loading
    if (this.morningBriefLoading) {
      return '<div class="cn-policy-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 生成情报简报...</div>';
    }

    // No profile at all → show onboarding
    const hasProfile = this.profileData && (this.profileData.industries?.length || this.profileData.company_name);
    if (!hasProfile && (!this.morningBrief || this.morningBrief.status === 'no_profile')) {
      return `<div class="cn-ind-onboard">
        <div class="cn-ind-onboard-header"><i class="bi bi-shield-check"></i> 企业情报中心</div>
        <div class="cn-ind-onboard-desc">设置您的企业信息，系统将为您生成每日AI情报简报：</div>
        <div class="cn-ind-onboard-features">
          <div class="cn-ind-onboard-feat"><i class="bi bi-lightning"></i><div><div class="cn-ind-feat-title">30秒掌握全局</div><div class="cn-ind-feat-desc">AI浓缩海量政策为执行摘要</div></div></div>
          <div class="cn-ind-onboard-feat"><i class="bi bi-bullseye"></i><div><div class="cn-ind-feat-title">机遇与风险</div><div class="cn-ind-feat-desc">每条洞察附带可执行建议</div></div></div>
          <div class="cn-ind-onboard-feat"><i class="bi bi-people"></i><div><div class="cn-ind-feat-title">竞争情报</div><div class="cn-ind-feat-desc">同一政策对你和竞对的差异化影响</div></div></div>
          <div class="cn-ind-onboard-feat"><i class="bi bi-graph-up-arrow"></i><div><div class="cn-ind-feat-title">产业风向</div><div class="cn-ind-feat-desc">行业趋势追踪与前瞻</div></div></div>
        </div>
        <button class="cn-ind-setup-btn-sm"><i class="bi bi-arrow-right-circle"></i> 设置企业画像</button>
      </div>`;
    }

    // Profile exists but brief not loaded → show loading/retry
    if (!this.morningBrief || this.morningBrief.status === 'no_profile') {
      return `<div class="cn-ind-onboard">
        <div class="cn-ind-onboard-header"><i class="bi bi-shield-check"></i> 企业情报中心</div>
        <div class="cn-ind-onboard-desc">${escapeHtml(this.profileData?.company_name || '我的企业')} — 正在生成情报简报...</div>
        <button class="cn-brief-refresh-btn" style="margin-top:12px;padding:8px 20px;font-size:13px"><i class="bi bi-arrow-clockwise"></i> 生成情报简报</button>
      </div>`;
    }

    const b = this.morningBrief;

    // ── Tier 1: Headline Alert + Risk Dashboard ──
    const score = b.risk_score || 50;
    const scoreColor = score > 70 ? '#ef5350' : score > 40 ? '#ffa726' : '#66bb6a';
    const scoreBg = score > 70 ? 'rgba(239,83,80,0.08)' : score > 40 ? 'rgba(255,167,38,0.08)' : 'rgba(102,187,106,0.08)';
    const trendLabel = b.risk_trend === 'rising' || b.risk_trend === 'deteriorating' as any ? '上升' : b.risk_trend === 'falling' || b.risk_trend === 'improving' as any ? '下降' : '稳定';
    const trendArrow = b.risk_trend === 'rising' || b.risk_trend === 'deteriorating' as any ? '↑' : b.risk_trend === 'falling' || b.risk_trend === 'improving' as any ? '↓' : '→';
    const trendColor = b.risk_trend === 'rising' || b.risk_trend === 'deteriorating' as any ? '#ef5350' : b.risk_trend === 'falling' || b.risk_trend === 'improving' as any ? '#66bb6a' : '#ffc107';

    let headlineHtml = '';
    if (b.headline_alert) {
      headlineHtml = `<div class="cn-headline-alert">
        <div class="cn-headline-alert-icon"><i class="bi bi-lightning-charge-fill"></i></div>
        <div class="cn-headline-alert-body">
          <div class="cn-headline-alert-text">${escapeHtml(b.headline_alert)}</div>
          ${b.key_number ? `<div class="cn-headline-alert-number">${escapeHtml(b.key_number)}</div>` : ''}
        </div>
        <div class="cn-risk-gauge">
          <div class="cn-risk-gauge-score" style="color:${scoreColor}">${score}</div>
          <div class="cn-risk-gauge-label">风险</div>
          <div class="cn-risk-gauge-trend" style="color:${trendColor}">${trendArrow} ${trendLabel}</div>
        </div>
      </div>`;
    }

    const riskBarHtml = `<div class="cn-risk-dashboard" style="background:${scoreBg}">
      <div class="cn-risk-dashboard-row">
        <span class="cn-risk-dashboard-label">风险水平</span>
        <div class="cn-risk-bar"><div class="cn-risk-fill" style="width:${score}%;background:${scoreColor}"></div></div>
        <span class="cn-risk-dashboard-score" style="color:${scoreColor}">${score}<span class="cn-risk-dashboard-max">/100</span></span>
        <span class="cn-risk-dashboard-trend" style="color:${trendColor}">${trendArrow} ${trendLabel}</span>
      </div>
    </div>`;

    // CEO key angles (multi-dimension) — replaces single one-liner
    let ceoHtml = '';
    if (b.ceo_key_angles?.length) {
      const angleConfig: Record<string, { icon: string; variant: string }> = {
        '市场': { icon: 'bi-graph-up-arrow', variant: 'market' },
        '行业': { icon: 'bi-graph-up-arrow', variant: 'market' },
        '公司': { icon: 'bi-building', variant: 'impact' },
        '影响': { icon: 'bi-building', variant: 'impact' },
        '行动': { icon: 'bi-rocket-takeoff', variant: 'action' },
        '马上': { icon: 'bi-rocket-takeoff', variant: 'action' },
      };
      const angleBadges = (b.ceo_key_angles as Array<{angle: string; insight: string; detail?: string; metric?: string}>).map(a => {
        const match = Object.entries(angleConfig).find(([k]) => a.angle.includes(k));
        const icon = match?.[1].icon || 'bi-lightbulb';
        const variant = match?.[1].variant || 'market';
        const metricHtml = a.metric ? `<span class="cn-ceo-angle-metric cn-ceo-angle-metric-${variant}">${escapeHtml(a.metric)}</span>` : '';
        const detailHtml = a.detail ? `<div class="cn-ceo-angle-detail">${escapeHtml(a.detail)}</div>` : '';
        return `<div class="cn-ceo-angle-card cn-ceo-angle-card-${variant}">
          <div class="cn-ceo-angle-header"><div class="cn-ceo-angle-label"><i class="bi ${icon}"></i> ${escapeHtml(a.angle)}</div>${metricHtml}</div>
          <div class="cn-ceo-angle-insight">${escapeHtml(a.insight)}</div>
          ${detailHtml}
        </div>`;
      }).join('');
      ceoHtml = `<div class="cn-ceo-angles">${angleBadges}</div>`;
    } else if (b.ceo_one_liner) {
      ceoHtml = `<div class="cn-ceo-oneliner">${escapeHtml(b.ceo_one_liner)}</div>`;
    }

    // Refresh + time header
    const headerHtml = `<div class="cn-brief-hero-label"><i class="bi bi-lightning-charge"></i> AI情报简报 <span class="cn-brief-hero-time">${escapeHtml(b.generated_at || '')} <button class="cn-brief-refresh-btn" title="刷新"><i class="bi bi-arrow-clockwise"></i></button></span></div>`;

    // Situation delta
    let deltaHtml = '';
    if (b.situation_delta) {
      deltaHtml = `<div class="cn-situation-delta"><span class="cn-situation-delta-icon"><i class="bi bi-arrow-left-right"></i></span> ${escapeHtml(b.situation_delta)}</div>`;
    }

    // Metrics bar — moved below summary
    const oppCount = (b.opportunities || []).length;
    const riskCount = (b.risks || []).length;
    const metricsHtml = `<div class="cn-metrics-bar">
      <div class="cn-metric-card"><div class="cn-metric-num">${b.policy_count || 0}</div><div class="cn-metric-label">相关政策</div></div>
      <div class="cn-metric-card"><div class="cn-metric-num">${oppCount}</div><div class="cn-metric-label">新机遇</div></div>
      <div class="cn-metric-card"><div class="cn-metric-num">${riskCount}</div><div class="cn-metric-label">风险项</div></div>
      <div class="cn-metric-card"><div class="cn-metric-num">${b.alert_count || 0}</div><div class="cn-metric-label">告警数</div></div>
    </div>`;

    // ── Tier 2: Dual Column — Summary + Actions ──
    // Structured executive summary (situation/impact/direction)
    let summaryInner = '';
    const es = b.executive_summary;
    if (typeof es === 'object' && es && (es as any).situation) {
      const esObj = es as { situation?: string; impact?: string; direction?: string };
      summaryInner = `<div class="cn-exec-summary-struct">
        ${esObj.situation ? `<div class="cn-exec-section"><span class="cn-exec-section-label cn-exec-label-situation">形势</span><div class="cn-exec-section-text">${escapeHtml(esObj.situation)}</div></div>` : ''}
        ${esObj.impact ? `<div class="cn-exec-section"><span class="cn-exec-section-label cn-exec-label-impact">影响</span><div class="cn-exec-section-text">${escapeHtml(esObj.impact)}</div></div>` : ''}
        ${esObj.direction ? `<div class="cn-exec-section"><span class="cn-exec-section-label cn-exec-label-direction">方向</span><div class="cn-exec-section-text">${escapeHtml(esObj.direction)}</div></div>` : ''}
      </div>`;
    } else {
      summaryInner = `<div class="cn-overview-summary">${escapeHtml(String(es || ''))}</div>`;
    }

    const summaryCol = `<div class="cn-overview-col">
      <div class="cn-overview-col-title"><i class="bi bi-file-text"></i> 形势研判</div>
      ${summaryInner}
    </div>`;

    let actionsCol = '';
    if (b.action_items && b.action_items.length > 0) {
      const numIcons = ['❶', '❷', '❸', '❹', '❺'];
      const items = b.action_items.map((a, idx) => {
        const pri = typeof a.priority === 'string' ? a.priority : (a.priority <= 1 ? 'urgent' : a.priority <= 2 ? 'important' : 'monitor');
        const priLabel = pri === 'urgent' ? '紧急' : pri === 'important' ? '重要' : '关注';
        const deadline = a.deadline_hint || a.deadline || '';
        const related = a.related_risk_or_opp || '';
        const numIcon = numIcons[idx] || `${idx + 1}`;
        const numCls = idx === 0 ? 'cn-action-num-1' : idx === 1 ? 'cn-action-num-2' : 'cn-action-num-3';
        return `<div class="cn-action-item-v2">
          <span class="cn-action-num ${numCls}">${numIcon}</span>
          <div class="cn-action-item-v2-body">
            <div class="cn-action-item-v2-text"><span class="cn-action-pri-tag cn-action-pri-${pri}">${priLabel}</span> ${escapeHtml(a.action)}</div>
            <div class="cn-action-item-v2-meta">${deadline ? `<span>${escapeHtml(deadline)}</span>` : ''}${related ? ` · 关联: ${escapeHtml(related)}` : ''}${a.owner ? ` · ${escapeHtml(a.owner)}` : ''}</div>
          </div>
        </div>`;
      }).join('');
      actionsCol = `<div class="cn-overview-col">
        <div class="cn-overview-col-title"><i class="bi bi-lightning"></i> 今日行动</div>
        <div class="cn-action-list-v2">${items}</div>
      </div>`;
    }

    const dualHtml = actionsCol
      ? `<div class="cn-overview-dual">${summaryCol}${actionsCol}</div>`
      : `<div class="cn-overview-single">${summaryCol}</div>`;

    // ── Tier 2.5: Executive Perspectives (4-role × 3-timeframe) ──
    let execPerspHtml = '';
    if (b.executive_perspectives?.length) {
      const roleConfig: Record<string, { icon: string; cls: string }> = {
        CEO: { icon: 'bi-person-check', cls: 'ceo' },
        CMO: { icon: 'bi-megaphone', cls: 'cmo' },
        CFO: { icon: 'bi-cash-coin', cls: 'cfo' },
        CSO: { icon: 'bi-compass', cls: 'cso' },
      };
      const roleCards = (b.executive_perspectives as Array<{role: string; role_label: string; focus: string; near_term: string; mid_term: string; long_term: string}>).map(p => {
        const cfg = roleConfig[p.role] || { icon: 'bi-person', cls: 'ceo' };
        return `<div class="cn-exec-role-card cn-exec-role-card-${cfg.cls}">
          <div class="cn-exec-role-header">
            <i class="bi ${cfg.icon} cn-exec-role-icon"></i>
            <span class="cn-exec-role-title">${escapeHtml(p.role_label || p.role)}</span>
            <span class="cn-exec-role-focus">${escapeHtml(p.focus || '')}</span>
          </div>
          ${p.near_term ? `<div class="cn-exec-time-item"><span class="cn-exec-time-tag cn-exec-time-near">近期</span><span class="cn-exec-time-text">${escapeHtml(p.near_term)}</span></div>` : ''}
          ${p.mid_term ? `<div class="cn-exec-time-item"><span class="cn-exec-time-tag cn-exec-time-mid">中期</span><span class="cn-exec-time-text">${escapeHtml(p.mid_term)}</span></div>` : ''}
          ${p.long_term ? `<div class="cn-exec-time-item"><span class="cn-exec-time-tag cn-exec-time-long">远期</span><span class="cn-exec-time-text">${escapeHtml(p.long_term)}</span></div>` : ''}
        </div>`;
      }).join('');
      const isOpen = this.overviewCollapsed['executives'] !== true;
      execPerspHtml = `<div class="cn-collapsible-section" style="margin-top:14px">
        <div class="cn-collapse-toggle" data-section="executives">
          <i class="bi bi-chevron-${isOpen ? 'down' : 'right'}"></i>
          <i class="bi bi-people-fill" style="color:#e8a838"></i> 高管视角
          <span style="font-size:10px;color:#666;margin-left:6px">${(b.executive_perspectives as any[]).length}个角色 × 3时间维度</span>
        </div>
        ${isOpen ? `<div class="cn-collapse-body"><div class="cn-exec-perspectives">${roleCards}</div></div>` : ''}
      </div>`;
    }

    // ── Tier 3: Collapsible Sections ──
    const collSections: string[] = [];

    // Competitive landscape (default OPEN, expanded)
    if (b.competitive_landscape && (b.competitive_landscape.competitors?.length || b.competitive_landscape.summary)) {
      const isOpen = this.overviewCollapsed['competitive'] !== true;
      const cl = b.competitive_landscape;
      const cards = (cl.competitors || []).map(c =>
        `<div class="cn-comp-card">
          <div class="cn-comp-name">${escapeHtml(c.name)} ${c.threat_level ? `<span class="cn-comp-threat cn-comp-threat-${c.threat_level}">${c.threat_level === 'high' ? '高威胁' : c.threat_level === 'medium' ? '中威胁' : '低威胁'}</span>` : ''}</div>
          <div class="cn-comp-impact">${escapeHtml(c.impact)}</div>
          <div class="cn-comp-advantage"><i class="bi bi-check-circle"></i> ${escapeHtml(c.your_advantage)}</div>
        </div>`
      ).join('');
      const concentrationHtml = cl.market_concentration ? `<div class="cn-section-sub-item"><i class="bi bi-pie-chart"></i><span class="cn-sub-label">集中度</span><span>${escapeHtml(cl.market_concentration)}</span></div>` : '';
      const recentMovesHtml = cl.recent_moves?.length ? `<div class="cn-recent-moves"><div class="cn-sub-label"><i class="bi bi-lightning"></i> 竞对动作</div>${cl.recent_moves.map(m => `<div class="cn-recent-move-item">· ${escapeHtml(m)}</div>`).join('')}</div>` : '';
      const newEntrantsHtml = cl.new_entrants && cl.new_entrants !== 'null' && cl.new_entrants !== '无' ? `<div class="cn-section-sub-alert"><i class="bi bi-person-plus"></i> 新进入者: ${escapeHtml(cl.new_entrants)}</div>` : '';
      const substitutesHtml = cl.substitutes && cl.substitutes !== 'null' && cl.substitutes !== '无' ? `<div class="cn-section-sub-alert"><i class="bi bi-arrow-repeat"></i> 替代品: ${escapeHtml(cl.substitutes)}</div>` : '';
      collSections.push(`<div class="cn-collapsible-section">
        <div class="cn-collapse-toggle" data-section="competitive">
          <i class="bi bi-chevron-${isOpen ? 'down' : 'right'}"></i>
          <i class="bi bi-people"></i> 竞争格局
        </div>
        ${isOpen ? `<div class="cn-collapse-body">
          ${cl.summary ? `<div style="font-size:12px;color:#bbb;margin-bottom:8px;line-height:1.6">${escapeHtml(cl.summary)}</div>` : ''}
          ${concentrationHtml}
          ${cards ? `<div class="cn-comp-grid">${cards}</div>` : ''}
          ${recentMovesHtml}
          ${newEntrantsHtml}
          ${substitutesHtml}
        </div>` : ''}
      </div>`);
    }

    // Industry direction (default OPEN, multi-dimension)
    if (b.industry_direction) {
      const isOpen = this.overviewCollapsed['industry'] !== true;
      const d = b.industry_direction;
      const trendCls = `cn-direction-${d.trend || 'stable'}`;
      const arrow = d.trend === 'improving' ? '▲' : d.trend === 'deteriorating' ? '▼' : '●';
      // Sub-dimensions
      const subDims: Array<{icon: string; label: string; text: string}> = [];
      if (d.capacity_cycle) subDims.push({ icon: 'bi-recycle', label: '产能周期', text: d.capacity_cycle });
      if (d.tech_roadmap) subDims.push({ icon: 'bi-cpu', label: '技术路线', text: d.tech_roadmap });
      if (d.demand_outlook) subDims.push({ icon: 'bi-cart-check', label: '需求展望', text: d.demand_outlook });
      if (d.regulatory_trend) subDims.push({ icon: 'bi-shield-exclamation', label: '监管趋势', text: d.regulatory_trend });
      const subGrid = subDims.length ? `<div class="cn-sub-grid">${subDims.map(s =>
        `<div class="cn-section-sub-item"><i class="bi ${s.icon}"></i><span class="cn-sub-label">${escapeHtml(s.label)}</span><span>${escapeHtml(s.text)}</span></div>`
      ).join('')}</div>` : '';
      collSections.push(`<div class="cn-collapsible-section">
        <div class="cn-collapse-toggle" data-section="industry">
          <i class="bi bi-chevron-${isOpen ? 'down' : 'right'}"></i>
          <i class="bi bi-graph-up-arrow"></i> 产业风向
          <span class="cn-collapse-hint cn-collapse-hint-trend ${trendCls}">${arrow} ${escapeHtml(d.trend_label || '平稳')}</span>
        </div>
        ${isOpen ? `<div class="cn-collapse-body">
          <div class="cn-direction-badge ${trendCls}">
            ${arrow} ${escapeHtml(d.trend_label || '平稳')}　${escapeHtml(d.summary || '')}
            ${d.key_indicator ? `<span style="margin-left:auto;font-size:11px;opacity:0.7">${escapeHtml(d.key_indicator)}</span>` : ''}
          </div>
          ${subGrid}
        </div>` : ''}
      </div>`);
    }

    // Global impact (default OPEN, structured)
    if (b.global_impact) {
      const isOpen = this.overviewCollapsed['global'] !== true;
      const gi = typeof b.global_impact === 'object' ? b.global_impact : null;
      const giText = typeof b.global_impact === 'string' ? b.global_impact : '';
      const giSubItems: Array<{icon: string; label: string; text: string}> = [];
      if (gi) {
        if (gi.trade_relations) giSubItems.push({ icon: 'bi-arrow-left-right', label: '贸易关系', text: gi.trade_relations });
        if (gi.forex_commodities) giSubItems.push({ icon: 'bi-currency-exchange', label: '汇率/大宗', text: gi.forex_commodities });
        if (gi.geopolitical) giSubItems.push({ icon: 'bi-geo-alt', label: '地缘风险', text: gi.geopolitical });
        if (gi.supply_chain_shifts) giSubItems.push({ icon: 'bi-truck', label: '供应链重构', text: gi.supply_chain_shifts });
        if (gi.prediction_markets) giSubItems.push({ icon: 'bi-graph-up', label: '预测市场', text: gi.prediction_markets });
      }
      const giContent = gi
        ? `${gi.summary ? `<div style="font-size:12px;color:#bbb;margin-bottom:8px;line-height:1.6">${escapeHtml(gi.summary)}</div>` : ''}
           ${giSubItems.length ? `<div class="cn-sub-grid">${giSubItems.map(s =>
             `<div class="cn-section-sub-item"><i class="bi ${s.icon}"></i><span class="cn-sub-label">${escapeHtml(s.label)}</span><span>${escapeHtml(s.text)}</span></div>`
           ).join('')}</div>` : ''}`
        : `<div style="font-size:12px;color:#bbb;line-height:1.6">${escapeHtml(giText)}</div>`;
      collSections.push(`<div class="cn-collapsible-section">
        <div class="cn-collapse-toggle" data-section="global">
          <i class="bi bi-chevron-${isOpen ? 'down' : 'right'}"></i>
          <i class="bi bi-globe2"></i> 全球影响
        </div>
        ${isOpen ? `<div class="cn-collapse-body">${giContent}</div>` : ''}
      </div>`);
    }

    const tier3Html = collSections.length
      ? `<div class="cn-overview-tier3">${collSections.join('')}</div>`
      : '';

    // ── Tier 4: Macro Snapshot ──
    let macroHtml = '';
    if (b.macro_snapshot && typeof b.macro_snapshot === 'object') {
      const ms = b.macro_snapshot;
      const phaseColors: Record<string, string> = { '复苏': '#66bb6a', '过热': '#ef5350', '滞胀': '#ff9800', '衰退': '#ef5350', '底部企稳': '#ffc107' };
      const stanceColors: Record<string, string> = { '宽松': '#66bb6a', '中性偏松': '#81C784', '中性': '#ffc107', '中性偏紧': '#ff9800', '收紧': '#ef5350' };
      const phaseColor = Object.entries(phaseColors).find(([k]) => (ms.economy_phase || '').includes(k))?.[1] || '#ffc107';
      const stanceColor = Object.entries(stanceColors).find(([k]) => (ms.policy_stance || '').includes(k))?.[1] || '#ffc107';
      macroHtml = `<div style="margin-top:14px;padding:14px 16px;border-radius:10px;background:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.06)">
        <div style="font-size:13px;font-weight:700;color:#ddd;margin-bottom:10px;display:flex;align-items:center;gap:6px"><i class="bi bi-bank" style="color:#e8a838"></i> 宏观快照</div>
        <div style="display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap">
          ${ms.economy_phase ? `<div style="padding:6px 14px;border-radius:8px;background:${phaseColor}12;border:1px solid ${phaseColor}30"><span style="font-size:10px;color:#888">经济周期</span><div style="font-size:14px;font-weight:700;color:${phaseColor}">${escapeHtml(ms.economy_phase)}</div></div>` : ''}
          ${ms.policy_stance ? `<div style="padding:6px 14px;border-radius:8px;background:${stanceColor}12;border:1px solid ${stanceColor}30"><span style="font-size:10px;color:#888">政策基调</span><div style="font-size:14px;font-weight:700;color:${stanceColor}">${escapeHtml(ms.policy_stance)}</div></div>` : ''}
          ${ms.key_indicators ? `<div style="flex:1;min-width:200px;padding:6px 14px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04)"><span style="font-size:10px;color:#888">关键指标</span><div style="font-size:12px;color:#ddd;line-height:1.5">${escapeHtml(ms.key_indicators)}</div></div>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          ${ms.fiscal_highlight ? `<div style="font-size:12px;color:#bbb;line-height:1.5;padding:6px 10px;border-radius:6px;background:rgba(255,255,255,0.015)"><span style="font-size:10px;color:#e8a838;font-weight:600">财政 </span>${escapeHtml(ms.fiscal_highlight)}</div>` : ''}
          ${ms.monetary_highlight ? `<div style="font-size:12px;color:#bbb;line-height:1.5;padding:6px 10px;border-radius:6px;background:rgba(255,255,255,0.015)"><span style="font-size:10px;color:#42a5f5;font-weight:600">货币 </span>${escapeHtml(ms.monetary_highlight)}</div>` : ''}
        </div>
      </div>`;
    }

    // ── Tier 5: Top Opportunities & Risks Preview ──
    let topOppRiskHtml = '';
    const topOpps = (b.opportunities || []).slice(0, 2);
    const topRisks = (b.risks || []).slice(0, 2);
    if (topOpps.length || topRisks.length) {
      const oppItems = topOpps.map(o => `<div style="padding:10px 12px;border-radius:8px;background:rgba(102,187,106,0.04);border:1px solid rgba(102,187,106,0.12);margin-bottom:6px">
        <div style="font-size:13px;font-weight:600;color:#81C784;margin-bottom:4px">${o.urgency === 'high' ? '<span style="padding:1px 6px;border-radius:6px;font-size:10px;background:rgba(239,83,80,0.15);color:#ef5350;margin-right:4px">紧急</span>' : ''}${escapeHtml(o.title || '')}</div>
        <div style="font-size:12px;color:#bbb;line-height:1.6">${escapeHtml(o.description || '')}</div>
        ${o.estimated_effect ? `<div style="font-size:11px;color:#66bb6a;margin-top:4px">预估: ${escapeHtml(o.estimated_effect)}</div>` : ''}
      </div>`).join('');
      const riskItems = topRisks.map(r => `<div style="padding:10px 12px;border-radius:8px;background:rgba(239,83,80,0.04);border:1px solid rgba(239,83,80,0.12);margin-bottom:6px">
        <div style="font-size:13px;font-weight:600;color:#ef5350;margin-bottom:4px">${r.urgency === 'high' ? '<span style="padding:1px 6px;border-radius:6px;font-size:10px;background:rgba(239,83,80,0.15);color:#ef5350;margin-right:4px">紧急</span>' : ''}${escapeHtml(r.title || '')}</div>
        <div style="font-size:12px;color:#bbb;line-height:1.6">${escapeHtml(r.description || '')}</div>
        ${r.estimated_loss ? `<div style="font-size:11px;color:#ef5350;margin-top:4px">预估损失: ${escapeHtml(r.estimated_loss)}</div>` : ''}
      </div>`).join('');
      topOppRiskHtml = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px">
        <div>
          <div style="font-size:13px;font-weight:700;color:#66bb6a;margin-bottom:8px;display:flex;align-items:center;gap:6px"><i class="bi bi-graph-up-arrow"></i> 核心机遇</div>
          ${oppItems || '<div style="font-size:12px;color:#666">暂无</div>'}
        </div>
        <div>
          <div style="font-size:13px;font-weight:700;color:#ef5350;margin-bottom:8px;display:flex;align-items:center;gap:6px"><i class="bi bi-exclamation-triangle"></i> 核心风险</div>
          ${riskItems || '<div style="font-size:12px;color:#666">暂无</div>'}
        </div>
      </div>
      <div style="text-align:center;margin-top:8px"><button class="cn-goto-opprisk" style="padding:4px 16px;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid rgba(232,168,56,0.2);background:rgba(232,168,56,0.08);color:#e8a838">查看全部机遇与风险 →</button></div>`;
    }

    // ── Regional insight ──
    let regionalHtml = '';
    if (b.regional_insight) {
      regionalHtml = `<div style="margin-top:12px;padding:10px 14px;border-radius:8px;background:rgba(66,165,245,0.04);border:1px solid rgba(66,165,245,0.12)">
        <div style="font-size:12px;color:#888;margin-bottom:4px"><i class="bi bi-geo-alt" style="color:#42a5f5"></i> 区域洞察</div>
        <div style="font-size:13px;color:#ccc;line-height:1.6">${escapeHtml(b.regional_insight)}</div>
      </div>`;
    }

    // Report cards — all 5 types
    const reportCardsHtml = `<div style="margin-top:14px">
      <div style="font-size:13px;font-weight:700;color:#e8a838;margin-bottom:8px;display:flex;align-items:center;gap:6px"><i class="bi bi-file-earmark-bar-graph"></i> 情报报告</div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px">
        <div class="cn-dash-more-btn cn-open-report" data-report-type="daily" style="text-align:center;padding:10px 6px;cursor:pointer">
          <div style="font-size:16px;color:#64B5F6"><i class="bi bi-sunrise"></i></div>
          <div style="font-size:12px;font-weight:600">日报</div>
          <div style="font-size:10px;color:#666">今日速览</div>
        </div>
        <div class="cn-dash-more-btn cn-open-report" data-report-type="weekly" style="text-align:center;padding:10px 6px;cursor:pointer">
          <div style="font-size:16px;color:#e8a838"><i class="bi bi-calendar-week"></i></div>
          <div style="font-size:12px;font-weight:600">周报</div>
          <div style="font-size:10px;color:#666">本周回顾</div>
        </div>
        <div class="cn-dash-more-btn cn-open-report" data-report-type="monthly" style="text-align:center;padding:10px 6px;cursor:pointer">
          <div style="font-size:16px;color:#81C784"><i class="bi bi-calendar-month"></i></div>
          <div style="font-size:12px;font-weight:600">月报</div>
          <div style="font-size:10px;color:#666">月度趋势</div>
        </div>
        <div class="cn-dash-more-btn cn-open-report" data-report-type="quarterly" style="text-align:center;padding:10px 6px;cursor:pointer">
          <div style="font-size:16px;color:#BA68C8"><i class="bi bi-calendar3"></i></div>
          <div style="font-size:12px;font-weight:600">季报</div>
          <div style="font-size:10px;color:#666">季度评估</div>
        </div>
        <div class="cn-dash-more-btn cn-open-report" data-report-type="annual" style="text-align:center;padding:10px 6px;cursor:pointer">
          <div style="font-size:16px;color:#FF8A65"><i class="bi bi-calendar-range"></i></div>
          <div style="font-size:12px;font-weight:600">年报</div>
          <div style="font-size:10px;color:#666">全局复盘</div>
        </div>
      </div>
    </div>`;

    return `${headerHtml}${ceoHtml}${headlineHtml}${riskBarHtml}${deltaHtml}${metricsHtml}${dualHtml}${execPerspHtml}${macroHtml}${topOppRiskHtml}${tier3Html}${regionalHtml}${reportCardsHtml}`;
  }

  private renderOppRisk(): string {
    // Loading
    if (this.morningBriefLoading) {
      return '<div class="cn-policy-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 加载机遇与风险...</div>';
    }

    const hasProfile2 = this.profileData && (this.profileData.industries?.length || this.profileData.company_name);
    if (!this.morningBrief || this.morningBrief.status === 'no_profile') {
      if (!hasProfile2) {
        return '<div class="cn-policy-empty">请先设置企业画像，系统将为您分析机遇与风险。<br><button class="cn-ind-setup-btn-sm" style="margin-top:10px"><i class="bi bi-arrow-right-circle"></i> 设置企业画像</button></div>';
      }
      return '<div class="cn-policy-empty">正在加载机遇与风险数据...<br><button class="cn-brief-refresh-btn" style="margin-top:10px;padding:6px 16px"><i class="bi bi-arrow-clockwise"></i> 生成分析</button></div>';
    }

    const b = this.morningBrief;
    const filter = this.oppRiskFilter;
    const dimFilter = this.oppRiskDimFilter;
    const sortMode = this.oppRiskSort;

    // Urgency filter chips
    const chipKeys = ['all', '紧急', '重要', '关注'] as const;
    const chipLabels: Record<string, string> = { all: '全部', '紧急': '紧急', '重要': '重要', '关注': '关注' };
    const chipsHtml = chipKeys.map(k =>
      `<button class="cn-filter-chip ${k === filter ? 'active' : ''}" data-filter="${k}">${chipLabels[k]}</button>`
    ).join('');

    // Dimension filter chips
    const dimKeys = ['all', '合规', '供应链', '市场准入', '成本', '竞争'] as const;
    const dimChipsHtml = dimKeys.map(k =>
      `<button class="cn-dim-chip" data-dim="${k}" style="padding:3px 8px;border-radius:10px;font-size:10px;cursor:pointer;border:1px solid ${k === dimFilter ? 'rgba(232,168,56,0.3)' : 'rgba(255,255,255,0.06)'};background:${k === dimFilter ? 'rgba(232,168,56,0.12)' : 'rgba(255,255,255,0.03)'};color:${k === dimFilter ? '#e8a838' : '#888'};transition:all .15s">${k === 'all' ? '全维度' : k}</button>`
    ).join('');

    // Sort toolbar
    const sortKeys = [
      { key: 'impact', label: '按影响力', icon: 'bi-bar-chart' },
      { key: 'urgency', label: '按紧急度', icon: 'bi-clock' },
      { key: 'source', label: '按来源', icon: 'bi-broadcast' },
    ];
    const sortHtml = `<div class="cn-sort-toolbar">${sortKeys.map(s =>
      `<button class="cn-sort-btn ${s.key === sortMode ? 'active' : ''}" data-sort="${s.key}"><i class="bi ${s.icon}"></i> ${s.label}</button>`
    ).join('')}</div>`;

    // Keyword matching for dimension filter
    const dimKeywords: Record<string, string[]> = {
      '合规': ['合规', '监管', '审批', '备案', '处罚', '整改', '数据安全', 'ESG', '出口管制'],
      '供应链': ['供应链', '供给', '物流', '上游', '下游', '原材料', '产能'],
      '市场准入': ['准入', '许可', '牌照', '资质', '认证', '审批'],
      '成本': ['成本', '价格', '关税', '补贴', '费用', '税'],
      '竞争': ['竞争', '并购', '整合', '龙头', '市占率', '竞对'],
    };

    const matchesDim = (text: string, dim: string): boolean => {
      if (dim === 'all') return true;
      const kws = dimKeywords[dim] || [];
      return kws.some(kw => text.includes(kw));
    };

    // Map urgency values (new format: high/medium/low → old: 紧急/重要/关注)
    const urgencyMap: Record<string, string> = { high: '紧急', medium: '重要', low: '关注', '紧急': '紧急', '重要': '重要', '关注': '关注' };
    const urgencyLabel = (u: string) => urgencyMap[u] || u;

    // Sort comparator
    const sortFn = (a: any, b: any): number => {
      if (sortMode === 'impact') return (b.impact_score || 0) - (a.impact_score || 0);
      if (sortMode === 'urgency') {
        const uOrder: Record<string, number> = { high: 0, '紧急': 0, medium: 1, '重要': 1, low: 2, '关注': 2 };
        return (uOrder[a.urgency] ?? 2) - (uOrder[b.urgency] ?? 2);
      }
      return 0; // source: keep original order
    };

    // Filter + sort opportunities
    const allOpps = b.opportunities || [];
    let filteredOpps = filter === 'all' ? [...allOpps] : allOpps.filter(o => urgencyLabel(o.urgency) === filter);
    const oppText = (o: typeof allOpps[0]) => o.title + (o.description || o.analysis || '') + (o.action || '');
    filteredOpps = filteredOpps.filter(o => matchesDim(oppText(o), dimFilter));
    filteredOpps.sort(sortFn);

    // Filter + sort risks
    const allRisks = b.risks || [];
    let filteredRisks = filter === 'all' ? [...allRisks] : allRisks.filter(r => {
      const mapped = urgencyLabel(r.urgency || '');
      const sevMap: Record<string, string> = { '高': '紧急', '中': '重要', '低': '关注' };
      return mapped === filter || sevMap[r.severity || ''] === filter;
    });
    const riskText = (r: typeof allRisks[0]) => r.title + (r.description || r.analysis || '') + (r.mitigation || '');
    filteredRisks = filteredRisks.filter(r => matchesDim(riskText(r), dimFilter));
    filteredRisks.sort(sortFn);

    // Competitors from profile for tagging
    const competitors = this.profileData?.competitors || [];

    // Impact bar renderer
    const renderImpactBar = (score: number, color: string) => {
      const pct = Math.min(score, 10) * 10;
      return `<div class="cn-impact-bar-wrap">
        <div class="cn-impact-bar"><div class="cn-impact-fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="cn-impact-score" style="color:${color}">${score}/10</span>
      </div>`;
    };

    // Confidence dots renderer (e.g. ●●●○○ for 3/5)
    const renderConfidence = (level: string) => {
      const map: Record<string, number> = { high: 4, medium: 3, low: 2 };
      const n = map[level] || 3;
      const dots = '●'.repeat(n) + '○'.repeat(5 - n);
      const color = n >= 4 ? '#66bb6a' : n >= 3 ? '#ffa726' : '#888';
      return `<span class="cn-confidence-dots" style="color:${color}">${dots}</span>`;
    };

    // Decision summary box — top opportunity + top risk at a glance
    let decisionSummaryHtml = '';
    const topOpp = allOpps.length ? [...allOpps].sort((a, b) => (b.impact_score || 0) - (a.impact_score || 0))[0] : null;
    const topRisk = allRisks.length ? [...allRisks].sort((a, b) => (b.impact_score || 0) - (a.impact_score || 0))[0] : null;
    if (topOpp || topRisk) {
      decisionSummaryHtml = `<div class="cn-decision-summary">
        <div class="cn-decision-summary-title"><i class="bi bi-bullseye"></i> 决策摘要</div>
        ${topOpp ? `<div class="cn-decision-row">
          <span class="cn-decision-label" style="color:#66bb6a">最优先机遇:</span>
          <span class="cn-decision-text">${escapeHtml(topOpp.title)}${topOpp.impact_score ? ` (影响力 ${topOpp.impact_score}/10)` : ''}</span>
          ${topOpp.action ? `<div class="cn-decision-action">→ 建议行动: ${escapeHtml(topOpp.action)}</div>` : ''}
        </div>` : ''}
        ${topRisk ? `<div class="cn-decision-row">
          <span class="cn-decision-label" style="color:#ef5350">最紧迫风险:</span>
          <span class="cn-decision-text">${escapeHtml(topRisk.title)}${topRisk.impact_score ? ` (影响力 ${topRisk.impact_score}/10, ${topRisk.probability ? '概率' + (topRisk.probability === 'high' ? '高' : topRisk.probability === 'medium' ? '中' : '低') : ''})` : ''}</span>
          ${topRisk.mitigation ? `<div class="cn-decision-action">→ 缓解措施: ${escapeHtml(topRisk.mitigation)}</div>` : ''}
        </div>` : ''}
      </div>`;
    }

    // Opportunities column
    const oppCards = filteredOpps.length ? filteredOpps.map(o => {
      const desc = o.description || o.analysis || '';
      const mentionedComps = competitors.filter(c => (desc + o.title).includes(c));
      const compTag = mentionedComps.length
        ? `<div style="font-size:10px;margin-top:3px"><span style="padding:1px 6px;border-radius:8px;background:rgba(186,104,200,0.12);color:#BA68C8;font-size:9px">涉及: ${mentionedComps.join(', ')}</span></div>`
        : '';
      const impactScore = o.impact_score || 0;
      const dimension = o.impact_dimension || '';
      const uLabel = urgencyLabel(o.urgency);
      const srcLabel = o.source || o.source_policy || '';

      const timeWindow = o.time_window || '';
      const confidence = o.confidence || '';

      const oppChain = o.transmission_chain || [];
      const oppChainHtml = oppChain.length >= 2
        ? `<div class="cn-transmission-chain">
            <div class="cn-chain-label"><i class="bi bi-signpost-split"></i> 传导路径</div>
            <div class="cn-chain-steps">${oppChain.map((step: string, i: number) =>
              `<div class="cn-chain-step">${i > 0 ? '<span class="cn-chain-arrow">→</span>' : ''}<span class="cn-chain-step-text ${i === oppChain.length - 1 ? 'cn-chain-step-final' : ''}">${escapeHtml(step)}</span></div>`
            ).join('')}</div>
          </div>`
        : '';

      return `<div class="cn-impact-card cn-impact-card-opp">
        <div class="cn-impact-card-header">
          ${impactScore ? renderImpactBar(impactScore, '#66bb6a') : ''}
          ${dimension ? `<span class="cn-impact-dim">${escapeHtml(dimension)}</span>` : ''}
          <span class="cn-urgency-badge cn-urgency-${escapeHtml(uLabel)}">${escapeHtml(uLabel)}</span>
          ${confidence ? renderConfidence(confidence) : ''}
        </div>
        <div class="cn-impact-card-title">${escapeHtml(o.title)}</div>
        <div class="cn-impact-card-desc">${escapeHtml(desc)}</div>
        ${o.estimated_effect ? `<div class="cn-impact-card-amount cn-impact-card-amount-pos"><i class="bi bi-graph-up-arrow"></i> ${escapeHtml(o.estimated_effect)}</div>` : ''}
        ${oppChainHtml}
        ${timeWindow ? `<div class="cn-time-window"><i class="bi bi-clock"></i> 窗口期: ${escapeHtml(timeWindow)}</div>` : ''}
        <div class="cn-impact-card-action"><i class="bi bi-arrow-right-circle"></i> ${escapeHtml(o.action)}</div>
        ${srcLabel ? `<div class="cn-impact-card-source"><i class="bi bi-broadcast"></i> ${escapeHtml(srcLabel)}</div>` : ''}
        ${compTag}
      </div>`;
    }).join('') : '<div class="cn-opprisk-empty">暂无匹配的机遇</div>';

    // Risks column
    const riskCards = filteredRisks.length ? filteredRisks.map(r => {
      const desc = r.description || r.analysis || '';
      const mentionedComps = competitors.filter(c => (desc + r.title).includes(c));
      const compTag = mentionedComps.length
        ? `<div style="font-size:10px;margin-top:3px"><span style="padding:1px 6px;border-radius:8px;background:rgba(186,104,200,0.12);color:#BA68C8;font-size:9px">涉及: ${mentionedComps.join(', ')}</span></div>`
        : '';
      const impactScore = r.impact_score || 0;
      const dimension = r.impact_dimension || '';
      const probLabel = r.probability === 'high' ? '概率高' : r.probability === 'medium' ? '概率中' : r.probability === 'low' ? '概率低' : (r.severity ? `严重性${r.severity}` : '');
      const riskUrgency = urgencyLabel(r.urgency || '');
      const srcLabel = r.source || r.source_policy || '';

      const velocity = r.velocity || '';
      const velocityLabel = velocity === 'fast' ? '快速演变' : velocity === 'medium' ? '中速演变' : velocity === 'slow' ? '缓慢演变' : '';
      const velocityColor = velocity === 'fast' ? '#ef5350' : velocity === 'medium' ? '#ffa726' : '#888';
      const earlyWarning = r.early_warning || '';

      const riskChain = r.transmission_chain || [];
      const riskChainHtml = riskChain.length >= 2
        ? `<div class="cn-transmission-chain cn-transmission-chain-risk">
            <div class="cn-chain-label"><i class="bi bi-signpost-split"></i> 传导路径</div>
            <div class="cn-chain-steps">${riskChain.map((step: string, i: number) =>
              `<div class="cn-chain-step">${i > 0 ? '<span class="cn-chain-arrow">→</span>' : ''}<span class="cn-chain-step-text ${i === riskChain.length - 1 ? 'cn-chain-step-final' : ''}">${escapeHtml(step)}</span></div>`
            ).join('')}</div>
          </div>`
        : '';

      return `<div class="cn-impact-card cn-impact-card-risk">
        <div class="cn-impact-card-header">
          ${impactScore ? renderImpactBar(impactScore, '#ef5350') : ''}
          ${dimension ? `<span class="cn-impact-dim">${escapeHtml(dimension)}</span>` : ''}
          ${probLabel ? `<span class="cn-prob-badge">${escapeHtml(probLabel)}</span>` : ''}
          ${riskUrgency ? `<span class="cn-urgency-badge cn-urgency-${escapeHtml(riskUrgency)}">${escapeHtml(riskUrgency)}</span>` : ''}
        </div>
        <div class="cn-impact-card-title">${escapeHtml(r.title)}</div>
        <div class="cn-impact-card-desc">${escapeHtml(desc)}</div>
        ${r.estimated_loss ? `<div class="cn-impact-card-amount cn-impact-card-amount-neg"><i class="bi bi-graph-down-arrow"></i> ${escapeHtml(r.estimated_loss)}</div>` : ''}
        ${riskChainHtml}
        ${velocityLabel ? `<div class="cn-velocity-badge" style="color:${velocityColor}"><i class="bi bi-speedometer2"></i> ${velocityLabel}</div>` : ''}
        <div class="cn-impact-card-mitigation"><i class="bi bi-shield-check"></i> ${escapeHtml(r.mitigation)}</div>
        ${earlyWarning ? `<div class="cn-early-warning"><i class="bi bi-exclamation-diamond"></i> 预警: ${escapeHtml(earlyWarning)}</div>` : ''}
        ${srcLabel ? `<div class="cn-impact-card-source"><i class="bi bi-broadcast"></i> ${escapeHtml(srcLabel)}</div>` : ''}
        ${compTag}
      </div>`;
    }).join('') : '<div class="cn-opprisk-empty">暂无匹配的风险</div>';

    // Risk score bar
    const score = b.risk_score || 50;
    const scoreColor = score > 70 ? '#ef5350' : score > 40 ? '#ffa726' : '#66bb6a';
    const trendMap: Record<string, string> = { improving: '↓ 改善中', falling: '↓ 改善中', stable: '— 稳定', deteriorating: '↑ 恶化中', rising: '↑ 恶化中' };
    const trendColor = (b.risk_trend === 'improving' || b.risk_trend === 'falling') ? '#66bb6a' : (b.risk_trend === 'deteriorating' || b.risk_trend === 'rising') ? '#ef5350' : '#ffc107';
    const scoreBarHtml = `<div class="cn-risk-dashboard" style="background:rgba(255,255,255,0.025)">
      <div class="cn-risk-dashboard-row">
        <span class="cn-risk-dashboard-label">风险评分</span>
        <div class="cn-risk-bar"><div class="cn-risk-fill" style="width:${score}%;background:${scoreColor}"></div></div>
        <span class="cn-risk-dashboard-score" style="color:${scoreColor}">${score}<span class="cn-risk-dashboard-max">/100</span></span>
        <span class="cn-risk-dashboard-trend" style="color:${trendColor}">${trendMap[b.risk_trend] || '— 稳定'}</span>
      </div>
    </div>`;

    return `<div class="cn-filter-chips" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">${chipsHtml}</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">${dimChipsHtml}</div>
      ${sortHtml}
      ${decisionSummaryHtml}
      ${scoreBarHtml}
      <div class="cn-opprisk-grid">
        <div>
          <div class="cn-opprisk-col-title" style="color:#66bb6a"><i class="bi bi-graph-up-arrow"></i> 机遇 (${filteredOpps.length})</div>
          ${oppCards}
        </div>
        <div>
          <div class="cn-opprisk-col-title" style="color:#ef5350"><i class="bi bi-exclamation-triangle"></i> 风险 (${filteredRisks.length})</div>
          ${riskCards}
        </div>
      </div>`;
  }

  private renderIndustry(): string {
    // Loading
    if (this.industryLoading) {
      return '<div class="cn-policy-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 生成产业简报...</div>';
    }

    // Not fetched yet (defensive)
    if (!this.industryFetched) {
      return '<div class="cn-policy-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 加载中...</div>';
    }

    // Fetch error — brief is null
    if (!this.industryBrief) {
      return '<div class="cn-policy-empty"><i class="bi bi-exclamation-triangle"></i> 产业简报加载失败，请切换标签后重试</div>';
    }

    // No profile — enterprise onboarding card
    if (this.industryBrief.status === 'no_profile') {
      return `<div class="cn-ind-onboard">
        <div class="cn-ind-onboard-header"><i class="bi bi-building"></i> 企业情报中心</div>
        <div class="cn-ind-onboard-desc">设置您的企业信息，系统将为您提供：</div>
        <div class="cn-ind-onboard-features">
          <div class="cn-ind-onboard-feat"><i class="bi bi-newspaper"></i><div><div class="cn-ind-feat-title">每日政策影响分析</div><div class="cn-ind-feat-desc">精准筛选与企业相关的政策动态</div></div></div>
          <div class="cn-ind-onboard-feat"><i class="bi bi-bell"></i><div><div class="cn-ind-feat-title">舆情风险预警</div><div class="cn-ind-feat-desc">三级告警推送重要变化</div></div></div>
          <div class="cn-ind-onboard-feat"><i class="bi bi-globe2"></i><div><div class="cn-ind-feat-title">全球市场信号</div><div class="cn-ind-feat-desc">国际政策对标与产业链影响</div></div></div>
          <div class="cn-ind-onboard-feat"><i class="bi bi-signpost-split"></i><div><div class="cn-ind-feat-title">企业行动建议</div><div class="cn-ind-feat-desc">可执行的战略布局建议</div></div></div>
        </div>
        <button class="cn-ind-setup-btn-sm"><i class="bi bi-arrow-right-circle"></i> 设置企业画像</button>
      </div>`;
    }

    const b = this.industryBrief;

    // Industry health score bar (replaces simple risk_level text)
    const healthScore = b.industry_health_score || 0;
    const healthLabel = b.industry_health_label || b.risk_label || '适中';
    const healthColor = healthScore >= 70 ? '#66bb6a' : healthScore >= 40 ? '#ffa726' : '#ef5350';
    const healthPct = Math.min(healthScore, 100);

    let healthBarHtml = '';
    if (healthScore > 0) {
      healthBarHtml = `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:10px;margin-bottom:16px;background:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.06)">
        <span style="font-size:13px;font-weight:700;color:#e8a838;display:flex;align-items:center;gap:6px;white-space:nowrap"><i class="bi bi-building"></i> 产业健康度</span>
        <span style="font-size:20px;font-weight:700;color:${healthColor}">${healthScore}</span>
        <span style="font-size:12px;color:#777">/100</span>
        <span style="padding:3px 10px;border-radius:8px;font-size:11px;font-weight:700;background:${healthColor}18;color:${healthColor}">${escapeHtml(healthLabel)}</span>
        <div style="flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,0.08);overflow:hidden"><div style="height:100%;border-radius:3px;width:${healthPct}%;background:${healthColor};transition:width 0.3s"></div></div>
        <span style="font-size:11px;color:#666;white-space:nowrap">${escapeHtml(b.generated_at || '')}</span>
      </div>`;
    }

    // Executive lens (4 roles)
    let execLensHtml = '';
    if (b.executive_lens && typeof b.executive_lens === 'object') {
      const el = b.executive_lens as Record<string, string>;
      const lensItems: Array<{key: string; icon: string; label: string; cls: string}> = [
        { key: 'ceo_view', icon: 'bi-person-check', label: 'CEO视角', cls: 'ceo' },
        { key: 'cmo_view', icon: 'bi-megaphone', label: 'CMO视角', cls: 'cmo' },
        { key: 'cfo_view', icon: 'bi-cash-coin', label: 'CFO视角', cls: 'cfo' },
        { key: 'cso_view', icon: 'bi-compass', label: 'CSO视角', cls: 'cso' },
      ];
      const lensCards = lensItems.filter(l => el[l.key]).map(l =>
        `<div class="cn-exec-role-card cn-exec-role-card-${l.cls}">
          <div class="cn-exec-role-header">
            <i class="bi ${l.icon} cn-exec-role-icon"></i>
            <span class="cn-exec-role-title">${l.label}</span>
          </div>
          <div style="font-size:12px;color:#bbb;line-height:1.6">${escapeHtml(el[l.key] || '')}</div>
        </div>`
      ).join('');
      if (lensCards) {
        execLensHtml = `<div style="margin-bottom:14px">
          <div style="font-size:13px;font-weight:700;color:#e8a838;margin-bottom:8px;display:flex;align-items:center;gap:6px"><i class="bi bi-people-fill"></i> 高管视角</div>
          <div class="cn-exec-perspectives">${lensCards}</div>
        </div>`;
      }
    }

    // Time horizon (3 columns)
    let timeHorizonHtml = '';
    if (b.time_horizon && typeof b.time_horizon === 'object') {
      const th = b.time_horizon as Record<string, string>;
      const cols: Array<{key: string; icon: string; label: string; cls: string}> = [
        { key: 'near_term', icon: 'bi-lightning-charge', label: '近期 (1-4周)', cls: 'near' },
        { key: 'mid_term', icon: 'bi-calendar-check', label: '中期 (1-3季度)', cls: 'mid' },
        { key: 'long_term', icon: 'bi-binoculars', label: '远期 (1-3年)', cls: 'long' },
      ];
      const timeCols = cols.filter(c => th[c.key]).map(c =>
        `<div class="cn-time-col cn-time-col-${c.cls}">
          <div class="cn-time-col-title"><i class="bi ${c.icon}"></i> ${c.label}</div>
          <div class="cn-time-col-text">${escapeHtml(th[c.key] || '')}</div>
        </div>`
      ).join('');
      if (timeCols) {
        timeHorizonHtml = `<div style="margin-bottom:14px">
          <div style="font-size:13px;font-weight:700;color:#e8a838;margin-bottom:8px;display:flex;align-items:center;gap:6px"><i class="bi bi-clock-history"></i> 时间维度分析</div>
          <div class="cn-time-horizon">${timeCols}</div>
        </div>`;
      }
    }

    // Industry brief header — headline + risk + stats
    const riskCls = `cn-ind-risk cn-ind-risk-${b.risk_level || 'low'}`;
    const industryTags = (b.industries || []).map(i => `<span class="cn-ind-tag">${escapeHtml(i)}</span>`).join('');
    const devCount = (b.key_developments || []).length;
    const riskCount = (b.risks || []).length;
    const oppCount = (b.opportunities || []).length;
    const headerHtml = `${healthBarHtml}<div class="cn-ind-header">
      <div class="cn-ind-headline">${escapeHtml(b.headline || '')}</div>
      <div class="cn-ind-meta">
        ${!healthScore ? `<span class="${riskCls}">${escapeHtml(b.risk_label || '适中')}</span>` : ''}
        ${industryTags}
        ${!healthScore ? `<span style="margin-left:auto">${escapeHtml(b.generated_at || '')}</span>` : ''}
        ${b.fallback || b.ai_unavailable ? '<span class="cn-ind-tag" style="color:#FF9800">规则模式</span>' : ''}
        ${b.loose_match ? '<span class="cn-ind-tag" style="color:#ffa726">宽松匹配</span>' : ''}
      </div>
      <div class="cn-ind-stats">
        <div class="cn-ind-stat"><div class="cn-ind-stat-num">${b.policy_count || 0}</div><div class="cn-ind-stat-label">相关政策</div></div>
        <div class="cn-ind-stat"><div class="cn-ind-stat-num">${devCount}</div><div class="cn-ind-stat-label">关键动态</div></div>
        <div class="cn-ind-stat"><div class="cn-ind-stat-num">${riskCount}</div><div class="cn-ind-stat-label">风险项</div></div>
        <div class="cn-ind-stat"><div class="cn-ind-stat-num">${oppCount}</div><div class="cn-ind-stat-label">机会点</div></div>
      </div>
    </div>`;

    // Trend signals section
    let trendSignalsHtml = '';
    const trendSignals = b.trend_signals || [];
    if (trendSignals.length > 0) {
      const signalItems = trendSignals.map((s: any) => {
        const arrow = s.direction === 'positive' ? '▲' : s.direction === 'negative' ? '▼' : '●';
        const color = s.direction === 'positive' ? '#66bb6a' : s.direction === 'negative' ? '#ef5350' : '#ffa726';
        const strength = Math.min(s.strength || 3, 5);
        const dots = '●'.repeat(strength) + '○'.repeat(5 - strength);
        return `<div class="cn-trend-signal-item">
          <span class="cn-trend-signal-arrow" style="color:${color}">${arrow}</span>
          <span class="cn-trend-signal-text">${escapeHtml(s.signal || '')}</span>
          <span class="cn-trend-signal-dots" style="color:${color}">${dots}</span>
          <span class="cn-trend-signal-strength">强度 ${strength}/5</span>
        </div>`;
      }).join('');
      trendSignalsHtml = `<div class="cn-ind-section-title"><i class="bi bi-graph-up"></i> 趋势信号</div>
        <div class="cn-trend-signals-list">${signalItems}</div>`;
    }

    // Key developments
    let devsHtml = '';
    if (b.key_developments && b.key_developments.length > 0) {
      const cards = b.key_developments.map((d, i) => {
        const urgCls = `cn-ind-urgency cn-ind-urgency-${d.urgency || 'watch'}`;
        const actions = (d.recommended_actions || []).map(a => `<div class="cn-ind-action"><i class="bi bi-check"></i>${escapeHtml(a)}</div>`).join('');
        const areaTags = (d.affected_areas || []).map(a => `<span class="cn-ind-tag">${escapeHtml(a)}</span>`).join('');

        // Deep analysis panel
        let deepHtml = '';
        if (this.industryDeepLoading.has(i)) {
          deepHtml = '<div class="cn-ind-deep-panel"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> AI深度分析中...</div>';
        } else if (this.industryDeepResults.has(i)) {
          const dr = this.industryDeepResults.get(i);
          if (dr?.error) {
            deepHtml = '<div class="cn-ind-deep-panel" style="color:#EF5350">深度分析失败，请稍后重试</div>';
          } else {
            deepHtml = `<div class="cn-ind-deep-panel">
              ${dr.supply_chain ? `<div class="cn-ind-deep-row"><span class="cn-ind-deep-label">供应链:</span> ${escapeHtml(dr.supply_chain)}</div>` : ''}
              ${dr.cost ? `<div class="cn-ind-deep-row"><span class="cn-ind-deep-label">成本:</span> ${escapeHtml(dr.cost)}</div>` : ''}
              ${dr.competition ? `<div class="cn-ind-deep-row"><span class="cn-ind-deep-label">竞争:</span> ${escapeHtml(dr.competition)}</div>` : ''}
              ${dr.regulation ? `<div class="cn-ind-deep-row"><span class="cn-ind-deep-label">监管:</span> ${escapeHtml(dr.regulation)}</div>` : ''}
              ${dr.recommended_actions?.length ? `<div class="cn-ind-deep-row"><span class="cn-ind-deep-label">建议:</span> ${dr.recommended_actions.map((a: string) => escapeHtml(a)).join('；')}</div>` : ''}
              ${dr.international_reference ? `<div class="cn-ind-deep-row"><span class="cn-ind-deep-label">国际参考:</span> ${escapeHtml(dr.international_reference)}</div>` : ''}
              ${dr.chain_position ? `<div class="cn-ind-deep-row"><span class="cn-ind-deep-label">产业链:</span> ${escapeHtml(dr.chain_position)}</div>` : ''}
            </div>`;
          }
        }

        const businessImpact = d.business_impact || '';
        const actionDeadline = d.action_deadline || '';

        return `<div class="cn-ind-card">
          <div class="cn-ind-card-title"><span class="${urgCls}">${escapeHtml(d.urgency_label || d.urgency || '')}</span> ${escapeHtml(d.title)}</div>
          <div class="cn-ind-card-meta">${escapeHtml(d.source || '')} | ${escapeHtml(d.date || '')}</div>
          <div class="cn-ind-impact">${escapeHtml(d.impact_summary || '')}</div>
          ${businessImpact ? `<div class="cn-business-impact"><i class="bi bi-building"></i> 对贵司影响: ${escapeHtml(businessImpact)}</div>` : ''}
          ${actions ? `<div class="cn-ind-actions">${actions}</div>` : ''}
          ${actionDeadline ? `<div style="font-size:12px;color:#FFB74D;padding:6px 12px;border-radius:8px;background:rgba(255,183,77,0.06);border-left:3px solid rgba(255,183,77,0.4);margin:8px 0;display:flex;align-items:center;gap:6px"><i class="bi bi-calendar-check"></i> 建议行动截止: ${escapeHtml(actionDeadline)}</div>` : ''}
          <div class="cn-ind-card-footer">
            ${areaTags}
            ${!this.industryDeepResults.has(i) ? `<button class="cn-ind-deep-btn" data-deep-idx="${i}">深度分析</button>` : ''}
          </div>
          ${deepHtml}
        </div>`;
      }).join('');
      devsHtml = `<div class="cn-ind-section-title"><i class="bi bi-newspaper"></i> 关键动态 (${devCount})</div>${cards}`;
    } else {
      // Empty state — meaningful message when no developments found
      const industries = (b.industries || this.profileData?.industries || []).join('、');
      const policyCount = b.total_policy_count || b.policy_count || 0;
      devsHtml = `<div class="cn-industry-empty-state">
        <div class="cn-industry-empty-icon"><i class="bi bi-clipboard-check"></i></div>
        <div class="cn-industry-empty-title">近3天共采集 ${policyCount} 条政策新闻</div>
        <div class="cn-industry-empty-text">未检测到与 <strong>${escapeHtml(industries || '您的行业')}</strong> 直接相关的重大政策</div>
        <div class="cn-industry-empty-hints">
          <div>这可能意味着：</div>
          <div>· 近期该行业政策环境平稳，无重大变化</div>
          <div>· 建议关注即将到来的行业会议和政策窗口期</div>
        </div>
        <div class="cn-industry-empty-tip"><i class="bi bi-lightbulb"></i> 提示：可在企业画像中添加更多关键词提高匹配率</div>
        <button class="cn-ind-setup-btn-sm" style="margin-top:8px"><i class="bi bi-pencil-square"></i> 编辑企业画像</button>
      </div>`;
    }

    // Outlook + Next week watchlist (side by side)
    let outlookHtml = '';
    const watchlist = b.next_week_watchlist || [];
    if (b.outlook || watchlist.length > 0) {
      const outlookInner = b.outlook ? `<div style="flex:1;min-width:200px">
        <div class="cn-ind-section-title" style="margin-top:0"><i class="bi bi-graph-up-arrow"></i> 产业展望 (${escapeHtml(b.outlook.timeframe || '1-4周')})</div>
        <div class="cn-ind-outlook">
          <div class="cn-ind-outlook-text">${escapeHtml(b.outlook.summary || '')}</div>
          ${(b.outlook.key_dates || []).map(d => `<div class="cn-ind-date-item"><i class="bi bi-calendar3" style="color:#e8a838"></i> ${escapeHtml(d)}</div>`).join('')}
        </div>
      </div>` : '';
      const watchlistInner = watchlist.length > 0 ? `<div class="cn-watchlist-section">
        <div class="cn-ind-section-title" style="margin-top:0"><i class="bi bi-calendar-week"></i> 下周关注</div>
        <div class="cn-watchlist-items">
          ${watchlist.map((w: string) => `<div class="cn-watchlist-item"><i class="bi bi-dot" style="color:#e8a838"></i> ${escapeHtml(w)}</div>`).join('')}
        </div>
      </div>` : '';
      outlookHtml = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px">${outlookInner}${watchlistInner}</div>`;
    }

    // International context (optional)
    let intlHtml = '';
    if (b.international_context) {
      intlHtml = `<div class="cn-ind-section-title"><i class="bi bi-globe2"></i> 国际对标</div>
        <div class="cn-ind-intl">
          <div class="cn-ind-intl-text">${escapeHtml(b.international_context)}</div>
        </div>`;
    }

    // Supply chain map (optional)
    let chainHtml = '';
    if (b.supply_chain_map) {
      const m = b.supply_chain_map;
      chainHtml = `<div class="cn-ind-section-title"><i class="bi bi-diagram-3"></i> 产业链影响图谱</div>
        <div class="cn-ind-chain-grid">
          <div class="cn-ind-chain-col">
            <div class="cn-ind-chain-label cn-ind-chain-up">上游</div>
            <div class="cn-ind-chain-text">${escapeHtml(m.upstream || '')}</div>
          </div>
          <div class="cn-ind-chain-col">
            <div class="cn-ind-chain-label cn-ind-chain-mid">中游</div>
            <div class="cn-ind-chain-text">${escapeHtml(m.midstream || '')}</div>
          </div>
          <div class="cn-ind-chain-col">
            <div class="cn-ind-chain-label cn-ind-chain-down">下游</div>
            <div class="cn-ind-chain-text">${escapeHtml(m.downstream || '')}</div>
          </div>
        </div>`;
    }

    // Risks + Opportunities (two-column)
    let riskOppHtml = '';
    const hasRisks = b.risks && b.risks.length > 0;
    const hasOpps = b.opportunities && b.opportunities.length > 0;
    if (hasRisks || hasOpps) {
      const risksInner = (b.risks || []).map(r => {
        const sevCls = `cn-ind-severity cn-ind-sev-${r.severity || '中'}`;
        return `<div class="cn-ind-risk-item"><span class="${sevCls}">${escapeHtml(r.severity || '')}</span> ${escapeHtml(r.description)}</div>`;
      }).join('') || '<div style="color:#666;font-size:12px">暂无明显风险</div>';

      const oppsInner = (b.opportunities || []).map(o => {
        const potCls = `cn-ind-severity cn-ind-sev-${o.potential || '中'}`;
        return `<div class="cn-ind-opp-item"><span class="${potCls}">${escapeHtml(o.potential || '')}</span> ${escapeHtml(o.description)}</div>`;
      }).join('') || '<div style="color:#666;font-size:12px">暂无明显机会</div>';

      riskOppHtml = `<div class="cn-ind-two-col">
        <div class="cn-ind-risk-col">
          <div style="font-size:13px;font-weight:700;color:#EF5350;margin-bottom:10px;display:flex;align-items:center;gap:6px"><i class="bi bi-exclamation-triangle"></i> 风险 (${(b.risks || []).length})</div>
          ${risksInner}
        </div>
        <div class="cn-ind-opp-col">
          <div style="font-size:13px;font-weight:700;color:#66BB6A;margin-bottom:10px;display:flex;align-items:center;gap:6px"><i class="bi bi-lightning"></i> 机会 (${(b.opportunities || []).length})</div>
          ${oppsInner}
        </div>
      </div>`;
    }

    // Trend sparkline (from morning brief industry_direction if available)
    let trendHtml = '';
    if (this.morningBrief?.industry_direction) {
      const dir = this.morningBrief.industry_direction;
      const trendCls = `cn-direction-${dir.trend || 'stable'}`;
      const arrow = dir.trend === 'improving' ? '▲' : dir.trend === 'deteriorating' ? '▼' : '●';
      trendHtml = `<div class="cn-direction-badge ${trendCls}" style="margin-top:12px">
        <i class="bi bi-activity"></i> 产业趋势: ${arrow} ${escapeHtml(dir.trend_label || '平稳')}　${escapeHtml(dir.summary || '')}
        ${dir.key_indicator ? `<span style="margin-left:auto;font-size:11px;opacity:0.7">${escapeHtml(dir.key_indicator)}</span>` : ''}
      </div>`;
    }

    // Competitive landscape from morning brief
    let compHtml = '';
    if (this.morningBrief?.competitive_landscape?.competitors?.length) {
      const cl = this.morningBrief.competitive_landscape;
      const cards = cl.competitors.map(c =>
        `<div class="cn-comp-card">
          <div class="cn-comp-name">${escapeHtml(c.name)}</div>
          <div class="cn-comp-impact">${escapeHtml(c.impact)}</div>
          <div class="cn-comp-advantage"><i class="bi bi-check-circle" style="font-size:11px"></i> 你的优势: ${escapeHtml(c.your_advantage)}</div>
        </div>`
      ).join('');
      compHtml = `<div class="cn-ind-section-title"><i class="bi bi-people"></i> 竞争对比</div>
        ${cl.summary ? `<div style="font-size:13px;color:#bbb;margin-bottom:10px;line-height:1.6">${escapeHtml(cl.summary)}</div>` : ''}
        <div class="cn-comp-grid">${cards}</div>`;
    }

    // Supply chain dynamics block (from profile data)
    let supplyDynamicsHtml = '';
    if (this.profileData?.supply_chain_up?.length || this.profileData?.supply_chain_down?.length) {
      const upItems = (this.profileData?.supply_chain_up || []).map(s =>
        `<div style="display:flex;align-items:center;gap:6px;padding:4px 0">
          <span style="padding:2px 8px;border-radius:8px;font-size:10px;background:rgba(100,181,246,0.12);color:#64B5F6">${escapeHtml(s)}</span>
          <span style="font-size:10px;color:#888">← 上游供应</span>
        </div>`
      ).join('');
      const downItems = (this.profileData?.supply_chain_down || []).map(s =>
        `<div style="display:flex;align-items:center;gap:6px;padding:4px 0">
          <span style="padding:2px 8px;border-radius:8px;font-size:10px;background:rgba(129,199,132,0.12);color:#81C784">${escapeHtml(s)}</span>
          <span style="font-size:10px;color:#888">→ 下游客户</span>
        </div>`
      ).join('');
      supplyDynamicsHtml = `<div class="cn-ind-section-title"><i class="bi bi-arrow-left-right"></i> 供应链动态</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div style="padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04)">
            <div style="font-size:11px;font-weight:600;color:#64B5F6;margin-bottom:4px">上游</div>
            ${upItems || '<div style="font-size:11px;color:#666">未设置</div>'}
          </div>
          <div style="padding:8px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04)">
            <div style="font-size:11px;font-weight:600;color:#81C784;margin-bottom:4px">下游</div>
            ${downItems || '<div style="font-size:11px;color:#666">未设置</div>'}
          </div>
        </div>`;
    }

    return `${headerHtml}${execLensHtml}${timeHorizonHtml}${trendSignalsHtml}${devsHtml}${outlookHtml}${intlHtml}${chainHtml}${riskOppHtml}${supplyDynamicsHtml}${trendHtml}${compHtml}`;
  }

  private renderSignalTracker(): string {
    if (!this.signalData) return '';

    const { groups, emerging } = this.signalData;
    if (!groups || groups.length === 0) return '';

    // Emerging keywords banner
    let emergingHtml = '';
    if (emerging && emerging.length > 0) {
      const chips = emerging.slice(0, 8).map(e =>
        `<span class="cn-signal-emerging-chip">${escapeHtml(e.word)} +${e.change_pct}%</span>`
      ).join('');
      emergingHtml = `<div class="cn-signal-emerging">
        <div class="cn-signal-emerging-title"><i class="bi bi-graph-up-arrow"></i> 上升信号</div>
        ${chips}
      </div>`;
    }

    // Keyword groups with sparklines
    const groupsHtml = groups.slice(0, 6).map(g => {
      const kwsHtml = g.keywords.slice(0, 5).map((kw: any) => {
        const counts = (kw.weekly_counts || []) as { count: number }[];
        const maxC = Math.max(...counts.map(c => c.count), 1);

        // SVG sparkline
        const sparkW = 80, sparkH = 16;
        const points = counts.map((c: any, i: number) => {
          const x = counts.length > 1 ? (i / (counts.length - 1)) * sparkW : sparkW / 2;
          const y = sparkH - (c.count / maxC) * (sparkH - 2) - 1;
          return `${x},${y}`;
        }).join(' ');

        const sparkColor = kw.trend === 'rising' ? '#ef5350' : kw.trend === 'falling' ? '#43a047' : '#888';
        const sparkSvg = counts.length > 1
          ? `<svg class="cn-signal-sparkline" viewBox="0 0 ${sparkW} ${sparkH}" preserveAspectRatio="none">
              <polyline points="${points}" fill="none" stroke="${sparkColor}" stroke-width="1.5" stroke-linecap="round"/>
            </svg>`
          : '<div class="cn-signal-sparkline"></div>';

        return `<div class="cn-signal-kw">
          <span class="cn-signal-word">${escapeHtml(kw.word)}</span>
          ${sparkSvg}
          <span class="cn-signal-total">${kw.total}</span>
          <span class="cn-signal-trend ${kw.trend}">${kw.trend === 'rising' ? '↑' : kw.trend === 'falling' ? '↓' : kw.trend === 'new' ? '新' : '–'}</span>
        </div>`;
      }).join('');

      return `<div class="cn-signal-group">
        <div class="cn-signal-group-name">${escapeHtml(g.name)}</div>
        ${kwsHtml}
      </div>`;
    }).join('');

    return `<div style="font-size:12px;color:#aaa;font-weight:600;margin:12px 0 6px"><i class="bi bi-broadcast-pin"></i> 信号追踪 (90天)</div>
      ${emergingHtml}${groupsHtml}`;
  }

  private renderSectorMatrix(): string {
    if (!this.sectorMatrix || this.sectorMatrix.length === 0) return '';

    const sectors = this.sectorMatrix;
    const cellsHtml = sectors.map(s => {
      const score = s.impact_score || 0;
      let bg: string, fg: string;
      if (score >= 60) { bg = 'rgba(229,57,53,0.3)'; fg = '#ef5350'; }
      else if (score >= 30) { bg = 'rgba(229,57,53,0.15)'; fg = '#e57373'; }
      else if (score >= 10) { bg = 'rgba(229,57,53,0.08)'; fg = '#ef9a9a'; }
      else if (score <= -60) { bg = 'rgba(67,160,71,0.3)'; fg = '#43a047'; }
      else if (score <= -30) { bg = 'rgba(67,160,71,0.15)'; fg = '#66bb6a'; }
      else if (score <= -10) { bg = 'rgba(67,160,71,0.08)'; fg = '#a5d6a7'; }
      else { bg = 'rgba(255,255,255,0.04)'; fg = '#888'; }

      const isActive = this.sectorFilter === s.name;
      const scoreSign = score > 0 ? '+' : '';
      return `<div class="cn-sector-cell${isActive ? ' active' : ''}" data-sector="${escapeHtml(s.name)}"
        style="background:${bg};color:${fg}" title="${escapeHtml(s.name)} ${scoreSign}${score} (${s.policy_count}条)">
        ${escapeHtml(s.name)} <span style="opacity:0.7">${scoreSign}${score}</span>
      </div>`;
    }).join('');

    const expandIcon = this.sectorMatrixExpanded ? 'bi-chevron-up' : 'bi-chevron-down';
    const heatmapHtml = this.sectorMatrixExpanded
      ? `<div class="cn-sector-heatmap">${cellsHtml}</div>`
      : `<div class="cn-sector-heatmap cn-sector-collapsed">${cellsHtml}</div>`;

    return `<div class="cn-sector-bar">
      <div class="cn-sector-bar-header">
        <span class="cn-sector-bar-title"><i class="bi bi-grid-3x3-gap"></i> 板块影响矩阵</span>
        <span style="color:#666;font-size:10px">${sectors.length}个板块</span>
        <span class="cn-sector-bar-toggle"><i class="bi ${expandIcon}"></i></span>
      </div>
      ${heatmapHtml}
    </div>`;
  }

  /** Get the currently visible list of items (used for click → drawer mapping). */
  private getVisibleItems(): GovNewsItem[] {
    if (this.viewMode === 'history') {
      return this.historyItems;
    }
    if (!this.newsData) return [];
    if (this.categoryFilter === 'all') {
      return (this.newsData.all || []).slice(0, 50);
    }
    return ((this.newsData.categories || {})[this.categoryFilter] || []).slice(0, 50);
  }

  private static readonly INTL_FLAGS: Record<string, string> = {
    '美联储': '🇺🇸', '欧央行': '🇪🇺', '日本央行': '🇯🇵', '英国央行': '🇬🇧',
    'IMF': '🌐', 'BIS': '🏦',
  };

  /** Render international news as source-grouped cards */
  private renderIntlCards(items: GovNewsItem[]): string {
    // Build index lookup: item → original array position (for correct click mapping)
    const itemIndexMap = new Map<GovNewsItem, number>();
    items.forEach((item, i) => itemIndexMap.set(item, i));

    // Group by source
    const groups = new Map<string, GovNewsItem[]>();
    for (const item of items) {
      const src = item.source || 'Unknown';
      if (!groups.has(src)) groups.set(src, []);
      groups.get(src)!.push(item);
    }

    const cards: string[] = [];
    for (const [source, sourceItems] of groups) {
      const flag = CnPolicyPanel.INTL_FLAGS[source] || '🏛';
      const itemsHtml = sourceItems.slice(0, 8).map(item => {
        const idx = itemIndexMap.get(item) ?? 0;
        return `<div class="cn-policy-intl-item cn-policy-item" data-idx="${idx}" style="cursor:pointer">
          <div class="cn-policy-intl-item-title">${escapeHtml(item.title)}</div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            ${item.date ? `<span class="cn-policy-intl-item-date">${escapeHtml(item.date)}</span>` : '<span></span>'}
            ${item.url ? `<a class="cn-policy-intl-item-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="bi bi-box-arrow-up-right"></i></a>` : ''}
          </div>
        </div>`;
      }).join('');

      cards.push(`<div class="cn-policy-intl-card">
        <div class="cn-policy-intl-card-header">
          <span class="cn-policy-intl-flag">${flag}</span>
          <span class="cn-policy-intl-name">${escapeHtml(source)}</span>
          <span class="cn-policy-intl-count">${sourceItems.length}条</span>
        </div>
        ${itemsHtml}
      </div>`);
    }

    return `<div class="cn-policy-intl-grid">${cards.join('')}</div>`;
  }

  private renderItem(item: GovNewsItem, index?: number, isNew = false): string {
    const catColor = this.govCategoryColor(item.category);
    const icon = item.icon || 'bi-flag-fill';
    const idxAttr = index !== undefined ? ` data-idx="${index}"` : '';
    return `<div class="cn-policy-item${isNew ? ' spark-new-item' : ''}"${idxAttr} style="cursor:pointer">
      <div class="cn-policy-item-title">${escapeHtml(item.title)}</div>
      <div class="cn-policy-item-meta">
        <i class="bi ${icon}" style="font-size:11px"></i>
        <span class="cn-policy-src-tag">${escapeHtml(item.source)}</span>
        ${item.via_search ? '<span style="opacity:0.5;font-size:10px" title="来源: 搜索引擎转载">转载</span>' : ''}
        <span class="cn-policy-cat-tag" style="background:${catColor.bg};color:${catColor.fg}">${escapeHtml(item.category)}</span>
        ${item.date ? `<span>${escapeHtml(item.date)}</span>` : ''}
        ${item.url ? `<a class="cn-policy-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="bi bi-box-arrow-up-right"></i></a>` : ''}
      </div>
    </div>`;
  }

  private exportCSV(): void {
    const items = this.getVisibleItems();
    if (!items.length) return;
    const header = '标题,来源,分类,日期,链接\n';
    const rows = items.map(it =>
      `"${(it.title || '').replace(/"/g, '""')}","${it.source || ''}","${it.category || ''}","${it.date || ''}","${it.url || ''}"`
    ).join('\n');
    const blob = new Blob(['\uFEFF' + header + rows], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `政策新闻_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  private renderCategoryDonut(categories: Record<string, number>): string {
    const entries = Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    if (!entries.length) return '';
    const total = entries.reduce((s, e) => s + e[1], 0);
    if (total === 0) return '';

    const R = 40, CX = 50, CY = 50, C = 2 * Math.PI * R;
    let offset = 0;
    const segments: string[] = [];
    const legend: string[] = [];
    const colors = [
      '#E53935', '#e8a838', '#64B5F6', '#43A047',
      '#AB47BC', '#FF5722', '#009688', '#5C6BC0',
    ];

    entries.forEach(([cat, count], i) => {
      const pct = count / total;
      const dash = pct * C;
      const gap = C - dash;
      const color = colors[i % colors.length];
      const catColor = this.govCategoryColor(cat);
      const fg = catColor.fg || color;
      segments.push(
        `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${fg}" stroke-width="14"
          stroke-dasharray="${dash.toFixed(1)} ${gap.toFixed(1)}"
          stroke-dashoffset="${(-offset).toFixed(1)}" opacity="0.85"/>`
      );
      offset += dash;
      legend.push(
        `<div class="cn-policy-donut-legend-item">
          <span class="cn-policy-donut-legend-dot" style="background:${fg}"></span>
          <span class="cn-policy-donut-legend-label">${escapeHtml(cat)}</span>
          <span class="cn-policy-donut-legend-val">${count}</span>
        </div>`
      );
    });

    return `<div class="cn-policy-donut-wrap">
      <svg width="100" height="100" viewBox="0 0 100 100" style="flex-shrink:0;transform:rotate(-90deg)">
        ${segments.join('')}
      </svg>
      <div class="cn-policy-donut-legend">${legend.join('')}</div>
    </div>`;
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
    if (this.freshnessTimer) {
      clearInterval(this.freshnessTimer);
      this.freshnessTimer = null;
    }
    if (this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
    // Disconnect SSE flash stream to prevent resource leak
    void import('@/services/cn-alerts').then(m => m.disconnectFlashStream());
    super.destroy();
  }

  private govCategoryColor(cat: string): { bg: string; fg: string } {
    switch (cat) {
      case '领导活动': return { bg: 'rgba(198,40,40,0.15)', fg: '#EF5350' };
      case '央媒': return { bg: 'rgba(229,57,53,0.12)', fg: '#E53935' };
      case '纪检监察': return { bg: 'rgba(183,28,28,0.12)', fg: '#D32F2F' };
      case '审计': return { bg: 'rgba(156,39,176,0.12)', fg: '#AB47BC' };
      case '财政货币': return { bg: 'rgba(232,168,56,0.12)', fg: '#e8a838' };
      case '金融监管': return { bg: 'rgba(33,150,243,0.12)', fg: '#64B5F6' };
      case '国务院': return { bg: 'rgba(171,71,188,0.12)', fg: '#AB47BC' };
      case '统计': return { bg: 'rgba(67,160,71,0.12)', fg: '#43A047' };
      case '部委动态': return { bg: 'rgba(30,136,229,0.12)', fg: '#42A5F5' };
      case '国资央企': return { bg: 'rgba(255,111,0,0.12)', fg: '#FF8F00' };
      case '理论': return { bg: 'rgba(255,152,0,0.12)', fg: '#FF9800' };
      case '海外': return { bg: 'rgba(0,188,212,0.12)', fg: '#00BCD4' };
      case '财经媒体': return { bg: 'rgba(255,87,34,0.12)', fg: '#FF5722' };
      case '智库': return { bg: 'rgba(121,85,72,0.12)', fg: '#8D6E63' };
      case '外贸外交': return { bg: 'rgba(0,150,136,0.12)', fg: '#009688' };
      case '国际央行': return { bg: 'rgba(63,81,181,0.12)', fg: '#5C6BC0' };
      case '国际机构': return { bg: 'rgba(236,64,122,0.12)', fg: '#EC407A' };
      case '国际媒体': return { bg: 'rgba(0,172,193,0.12)', fg: '#00ACC1' };
      default: return { bg: 'rgba(158,158,158,0.12)', fg: '#9E9E9E' };
    }
  }
}

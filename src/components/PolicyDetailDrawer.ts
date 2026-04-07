/**
 * PolicyDetailDrawer — right-side sliding drawer for policy/gov news article detail.
 * 3 tabs: 正文 (full content) / AI分析 (structured analysis) / AI问答 (chat)
 */

import { escapeHtml } from '@/utils/sanitize';
import { cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';

interface PolicyItem {
  title: string;
  url: string;
  date: string;
  source: string;
  source_key?: string;
  category: string;
  icon: string;
  /** If set, fetch content from DB news detail API instead of article scraper */
  dbNewsId?: string;
  /** If true, skip fetch and show redirect UI directly (known JS-SPA domain) */
  jsSpa?: boolean;
  /** Optional excerpt/description to display when content can't be fetched */
  excerpt?: string;
}

interface PolicyAnalysis {
  summary?: string;
  keyPoints?: string[];
  marketImpact?: string;
  sectors?: string[];
  risks?: string[];
  investmentAdvice?: string;
  policyDirection?: string;
  executive_impact?: { ceo?: string; cmo?: string; cfo?: string; cso?: string };
  time_impact?: { near_term?: string; mid_term?: string; long_term?: string };
  error?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface CompareResult {
  summary?: string;
  dimensions?: { name: string; current: string; previous: string; change: string; analysis: string }[];
  newAdditions?: string[];
  removals?: string[];
  toneShift?: string;
  marketImplication?: string;
  keyTakeaway?: string;
  compare_items?: { title: string; date: string; has_content: boolean }[];
}

interface RelatedSearchResult {
  keywords: string[];
  related: PolicyItem[];
  by_year: Record<string, PolicyItem[]>;
  total: number;
  ai_feedback?: string;
  ai_suggested_keywords?: string[];
}

const SUGGESTED_QUESTIONS = [
  '这篇政策的核心要点是什么？',
  '对A股市场有什么影响？',
  '哪些板块会受益？',
  '有什么投资风险？',
];

const DRAWER_STYLE = `
<style>
.policy-drawer-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.35);
  z-index: 9000;
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
}
.policy-drawer-overlay.open {
  opacity: 1;
  pointer-events: auto;
}
.policy-drawer {
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
.policy-drawer-overlay.open .policy-drawer {
  transform: translateX(0);
}
@media (max-width: 768px) {
  .policy-drawer { width: 100vw; }
}
.policy-drawer-header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
  position: relative;
}
.policy-drawer-header h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text, #E0E6EF);
  margin: 0 0 6px;
  line-height: 1.4;
  padding-right: 32px;
}
.policy-drawer-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim, #6B7A8D);
  flex-wrap: wrap;
}
.policy-drawer-meta .drawer-source {
  color: #e8a838;
  font-weight: 500;
}
.policy-drawer-meta .drawer-cat-badge {
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 500;
  font-size: 10px;
  background: rgba(33,150,243,0.12);
  color: #64B5F6;
}
.policy-drawer-close {
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
.policy-drawer-close:hover {
  background: rgba(255,255,255,0.12);
  color: var(--text, #E0E6EF);
}
/* Tabs */
.policy-drawer-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
  padding: 0 20px;
}
.policy-drawer-tab {
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
.policy-drawer-tab:hover { color: var(--text, #E0E6EF); }
.policy-drawer-tab.active {
  color: #e8a838;
  border-bottom-color: #e8a838;
}
.policy-drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  min-height: 0;
}
.policy-drawer-body.chat-mode {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.policy-drawer-body::-webkit-scrollbar { width: 4px; }
.policy-drawer-body::-webkit-scrollbar-thumb { background: rgba(232,168,56,0.2); border-radius: 2px; }
.policy-drawer-body::-webkit-scrollbar-track { background: transparent; }
/* Content area */
.policy-content-area {
  font-size: 13px;
  color: var(--text, #E0E6EF);
  line-height: 1.8;
  word-break: break-word;
}
.policy-content-area p { margin: 8px 0; }
.policy-content-area h1, .policy-content-area h2, .policy-content-area h3, .policy-content-area h4 {
  color: var(--text, #E0E6EF);
  margin: 16px 0 8px;
  font-weight: 600;
}
.policy-content-area h1 { font-size: 18px; }
.policy-content-area h2 { font-size: 16px; }
.policy-content-area h3 { font-size: 14px; }
.policy-content-area table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin: 8px 0;
  display: block;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  max-width: 100%;
}
.policy-content-area th, .policy-content-area td {
  padding: 6px 8px;
  border: 1px solid rgba(255,255,255,0.08);
  text-align: left;
}
.policy-content-area th {
  background: rgba(255,255,255,0.04);
  font-weight: 600;
}
.policy-content-area img {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  margin: 6px 0;
}
.policy-content-area img[data-failed] {
  display: none !important;
}
.policy-content-area select,
.policy-content-area form,
.policy-content-area input,
.policy-content-area button:not(.policy-drawer-close) {
  display: none !important;
}
.policy-content-area a {
  color: #e8a838;
  text-decoration: none;
}
.policy-content-area a:hover { text-decoration: underline; }
.policy-content-area ul, .policy-content-area ol {
  padding-left: 20px;
  margin: 6px 0;
}
.policy-content-area li { margin: 3px 0; }
.policy-content-area strong { color: var(--text, #E0E6EF); font-weight: 600; }
/* Force dark theme on injected content */
.policy-content-area * {
  color: inherit;
  background-color: transparent !important;
  font-family: inherit !important;
}
.policy-content-area p, .policy-content-area span, .policy-content-area div {
  color: var(--text, #E0E6EF) !important;
}
.policy-content-area strong, .policy-content-area b {
  color: var(--text, #E0E6EF) !important;
}
.policy-content-area table * { color: var(--text, #E0E6EF) !important; }
.policy-content-area table th { color: #e8a838 !important; }
.policy-link-bar {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid rgba(255,255,255,0.06);
  text-align: center;
}
.policy-link-bar a {
  color: #64B5F6;
  text-decoration: none;
  font-size: 12px;
}
.policy-link-bar a:hover { text-decoration: underline; }
/* Loading / error */
.policy-loading {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-dim, #6B7A8D);
  font-size: 12px;
}
.policy-loading i {
  font-size: 20px;
  display: block;
  margin-bottom: 8px;
  animation: pol-spin 1s linear infinite;
}
.policy-error {
  text-align: center;
  padding: 30px 20px;
  color: var(--text-dim, #6B7A8D);
  font-size: 12px;
}
.policy-error i {
  font-size: 24px;
  display: block;
  margin-bottom: 8px;
  color: #FF9800;
}
@keyframes pol-spin { to { transform: rotate(360deg); } }
/* AI Analysis cards */
.pol-analysis-card {
  padding: 12px;
  margin-bottom: 10px;
  border-radius: 8px;
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.06);
}
.pol-analysis-label {
  font-size: 10px;
  color: var(--text-dim, #6B7A8D);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
  font-weight: 600;
}
.pol-analysis-text {
  font-size: 13px;
  color: var(--text, #E0E6EF);
  line-height: 1.6;
}
.pol-analysis-list {
  list-style: disc;
  padding-left: 18px;
  margin: 0;
}
.pol-analysis-list li {
  font-size: 12px;
  color: var(--text, #E0E6EF);
  line-height: 1.5;
  margin: 3px 0;
}
.pol-analysis-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.pol-analysis-tag {
  padding: 2px 8px;
  font-size: 10px;
  border-radius: 4px;
  background: rgba(255,255,255,0.06);
  color: var(--text-dim, #6B7A8D);
}
.pol-analysis-tag.sector { background: rgba(229,57,53,0.1); color: #ef5350; }
.pol-analysis-tag.risk { background: rgba(255,152,0,0.1); color: #ff9800; }
.pol-direction-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}
.pol-dir-positive { background: rgba(229,57,53,0.15); color: #e53935; }
.pol-dir-negative { background: rgba(67,160,71,0.15); color: #43a047; }
.pol-dir-neutral { background: rgba(158,158,158,0.15); color: #9e9e9e; }
.pol-analyze-btn {
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
.pol-analyze-btn:hover { background: rgba(232,168,56,0.2); }
.pol-analyze-btn:disabled { opacity: 0.5; cursor: not-allowed; }
/* Chat */
.pol-chat-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.pol-chat-messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 8px;
}
.pol-chat-msg {
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
  max-width: 90%;
  word-wrap: break-word;
}
.pol-chat-msg.user {
  white-space: pre-wrap;
  background: rgba(229,57,53,0.12);
  color: var(--text, #E0E6EF);
  align-self: flex-end;
  border-bottom-right-radius: 4px;
}
.pol-chat-msg.assistant {
  background: rgba(255,255,255,0.04);
  color: var(--text, #E0E6EF);
  align-self: flex-start;
  border-bottom-left-radius: 4px;
  border-left: 2px solid rgba(232,168,56,0.4);
}
.pol-chat-msg.assistant strong {
  color: #e8a838;
  font-weight: 600;
}
.pol-chat-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.pol-chat-suggest-btn {
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
.pol-chat-suggest-btn:hover {
  background: rgba(232,168,56,0.1);
  color: #e8a838;
  border-color: rgba(232,168,56,0.3);
}
.pol-chat-input-area {
  display: flex;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid rgba(255,255,255,0.06);
  margin-top: auto;
  flex-shrink: 0;
}
.pol-chat-input {
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
.pol-chat-input:focus { border-color: rgba(232,168,56,0.5); }
.pol-chat-input::placeholder { color: var(--text-dim, #6B7A8D); opacity: 0.6; }
.pol-chat-send {
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
.pol-chat-send:hover { opacity: 0.85; }
.pol-chat-send:disabled { opacity: 0.4; cursor: not-allowed; }
.pol-typing-dots {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 8px 12px;
  align-self: flex-start;
}
.pol-typing-dot {
  width: 6px; height: 6px;
  background: var(--text-dim, #6B7A8D);
  border-radius: 50%;
  animation: pol-blink 1.4s infinite both;
}
.pol-typing-dot:nth-child(2) { animation-delay: 0.2s; }
.pol-typing-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes pol-blink {
  0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}
/* Compare tab */
.pol-compare-year-group {
  margin-bottom: 14px;
}
.pol-compare-year-label {
  font-size: 12px; font-weight: 700; color: #e8a838;
  margin-bottom: 6px; display: flex; align-items: center; gap: 6px;
}
.pol-compare-year-badge {
  background: rgba(232,168,56,0.15); padding: 1px 8px; border-radius: 4px; font-size: 11px;
}
.pol-compare-item {
  display: flex; align-items: flex-start; gap: 8px; padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px; color: #ccc;
  cursor: pointer; transition: background 0.15s; border-radius: 4px;
}
.pol-compare-item:hover { background: rgba(255,255,255,0.03); padding: 6px 4px; margin: 0 -4px; }
.pol-compare-check {
  width: 16px; height: 16px; border-radius: 3px; flex-shrink: 0; margin-top: 1px;
  border: 1.5px solid rgba(255,255,255,0.2); background: transparent; cursor: pointer;
  display: flex; align-items: center; justify-content: center; font-size: 10px; color: transparent;
  transition: all 0.15s;
}
.pol-compare-check.checked {
  background: rgba(232,168,56,0.2); border-color: #e8a838; color: #e8a838;
}
.pol-compare-item-title { flex: 1; line-height: 1.4; }
.pol-compare-item-date { color: #666; font-size: 11px; white-space: nowrap; }
.pol-compare-btn {
  display: block; width: 100%; padding: 10px; margin-top: 12px;
  font-size: 13px; font-weight: 600; border-radius: 8px;
  background: rgba(232,168,56,0.12); color: #e8a838;
  border: 1px solid rgba(232,168,56,0.3); cursor: pointer;
  transition: all 0.15s; text-align: center;
}
.pol-compare-btn:hover { background: rgba(232,168,56,0.2); }
.pol-compare-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pol-compare-dim-card {
  margin-bottom: 8px; padding: 10px; border-radius: 8px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
}
.pol-compare-dim-name {
  font-size: 12px; font-weight: 600; color: #e8a838; margin-bottom: 6px;
  display: flex; align-items: center; gap: 6px;
}
.pol-compare-change-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 500;
}
.pol-change-add { background: rgba(229,57,53,0.12); color: #ef5350; }
.pol-change-remove { background: rgba(67,160,71,0.12); color: #43a047; }
.pol-change-adjust { background: rgba(33,150,243,0.12); color: #64B5F6; }
.pol-change-same { background: rgba(158,158,158,0.12); color: #9e9e9e; }
.pol-compare-dim-row {
  display: flex; gap: 8px; font-size: 11px; margin-bottom: 4px; line-height: 1.5;
}
.pol-compare-dim-label { color: #888; min-width: 50px; flex-shrink: 0; }
.pol-compare-dim-val { color: #ccc; flex: 1; }
.pol-compare-analysis { font-size: 11px; color: #999; margin-top: 4px; font-style: italic; }
.pol-compare-section {
  margin-bottom: 12px; padding: 10px; border-radius: 8px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
}
.pol-compare-section-title {
  font-size: 11px; font-weight: 600; color: #888; text-transform: uppercase;
  letter-spacing: 0.5px; margin-bottom: 6px;
}
.pol-compare-section-text { font-size: 13px; color: #ddd; line-height: 1.6; }
.pol-compare-list { list-style: none; padding: 0; margin: 0; }
.pol-compare-list li {
  font-size: 12px; color: #ccc; line-height: 1.5; padding: 2px 0 2px 14px;
  position: relative;
}
.pol-compare-list li::before {
  content: ''; position: absolute; left: 0; top: 8px;
  width: 6px; height: 6px; border-radius: 50%;
}
.pol-compare-list.additions li::before { background: #ef5350; }
.pol-compare-list.removals li::before { background: #43a047; }
/* Skeleton */
.pol-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pol-skeleton-line {
  height: 14px;
  border-radius: 4px;
  background: rgba(255,255,255,0.06);
  animation: pol-skeleton-pulse 1.5s ease-in-out infinite;
}
.pol-skeleton-line:nth-child(1) { width: 90%; }
.pol-skeleton-line:nth-child(2) { width: 75%; }
.pol-skeleton-line:nth-child(3) { width: 85%; }
.pol-skeleton-line:nth-child(4) { width: 60%; }
.pol-skeleton-line:nth-child(5) { width: 80%; }
@keyframes pol-skeleton-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.8; }
}
/* ── Policy Scoring ── */
.pol-score-wrap {
  margin-bottom: 16px; padding: 14px; border-radius: 10px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
}
.pol-score-header {
  display: flex; align-items: center; gap: 14px; margin-bottom: 10px;
}
.pol-score-gauge { flex-shrink: 0; }
.pol-score-info { flex: 1; min-width: 0; }
.pol-score-total { font-size: 26px; font-weight: 700; color: #e8a838; line-height: 1; }
.pol-score-grade {
  display: inline-block; padding: 1px 8px; border-radius: 4px; font-size: 12px; font-weight: 700; margin-left: 8px;
}
.pol-grade-S { background: rgba(244,67,54,0.2); color: #ef5350; }
.pol-grade-A { background: rgba(232,168,56,0.2); color: #e8a838; }
.pol-grade-B { background: rgba(66,165,245,0.2); color: #42a5f5; }
.pol-grade-C { background: rgba(158,158,158,0.2); color: #bbb; }
.pol-grade-D { background: rgba(100,100,100,0.2); color: #888; }
.pol-score-mode { font-size: 10px; color: #666; margin-top: 2px; }
.pol-score-radar { display: flex; justify-content: center; margin: 8px 0 4px; }
.pol-score-dims { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.pol-score-dim-row { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.pol-score-dim-name { width: 56px; color: #999; flex-shrink: 0; text-align: right; }
.pol-score-dim-bar-bg {
  flex: 1; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.06); overflow: hidden;
}
.pol-score-dim-bar {
  height: 100%; border-radius: 3px; transition: width 0.6s ease;
}
.pol-score-dim-val { width: 28px; color: #e8a838; font-weight: 600; text-align: right; }
.pol-score-dim-reason { font-size: 10px; color: #666; margin-left: 64px; margin-top: -2px; }
.pol-score-deep-btn {
  margin-top: 8px; padding: 4px 12px; border-radius: 6px; font-size: 11px; cursor: pointer;
  border: 1px solid rgba(232,168,56,0.3); background: rgba(232,168,56,0.1); color: #e8a838;
}
.pol-score-deep-btn:hover { background: rgba(232,168,56,0.2); }
/* ── Timeline ── */
.pol-tl-wrap { position: relative; padding-left: 20px; }
.pol-tl-line {
  position: absolute; left: 8px; top: 0; bottom: 0; width: 2px;
  background: rgba(255,255,255,0.08);
}
.pol-tl-node {
  position: relative; margin-bottom: 16px; padding: 8px 12px;
  border-radius: 8px; background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.05);
}
.pol-tl-node::before {
  content: ''; position: absolute; left: -16px; top: 14px;
  width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid #888; background: var(--bg-primary, #0C1222);
}
.pol-tl-node.dir-松::before { border-color: #ef5350; background: rgba(244,67,54,0.15); }
.pol-tl-node.dir-紧::before { border-color: #43a047; background: rgba(67,160,71,0.15); }
.pol-tl-node.dir-中性::before { border-color: #888; }
.pol-tl-node.inflection::before {
  width: 14px; height: 14px; left: -18px; top: 12px;
  transform: rotate(45deg); border-radius: 2px;
}
.pol-tl-date {
  font-size: 10px; color: #888; margin-bottom: 2px;
}
.pol-tl-title {
  font-size: 12px; color: #ddd; font-weight: 500; line-height: 1.5;
}
.pol-tl-dir-tag {
  display: inline-block; font-size: 10px; padding: 0 6px; border-radius: 3px;
  margin-left: 6px; font-weight: 600;
}
.pol-tl-dir-松 { background: rgba(244,67,54,0.15); color: #ef5350; }
.pol-tl-dir-紧 { background: rgba(67,160,71,0.15); color: #43a047; }
.pol-tl-dir-中性 { background: rgba(255,255,255,0.06); color: #888; }
.pol-tl-summary { font-size: 10px; color: #999; margin-top: 2px; }
.pol-tl-phase {
  padding: 10px; border-radius: 8px; margin-bottom: 12px;
  background: rgba(232,168,56,0.06); border: 1px solid rgba(232,168,56,0.15);
  font-size: 12px; color: #ccc;
}
.pol-tl-phase-label { color: #e8a838; font-weight: 600; margin-bottom: 4px; font-size: 11px; }
/* ── Transmission Chain ── */
.pol-chain-summary {
  padding: 10px 12px; border-radius: 8px; margin-bottom: 12px;
  background: rgba(232,168,56,0.06); border: 1px solid rgba(232,168,56,0.15);
  font-size: 12px; color: #ccc; line-height: 1.5;
}
.pol-chain-summary-label { color: #e8a838; font-weight: 600; font-size: 11px; margin-bottom: 4px; }
.pol-chain-svg-wrap {
  overflow-x: auto; overflow-y: visible; padding: 8px 0;
  -webkit-overflow-scrolling: touch;
}
.pol-chain-svg-wrap::-webkit-scrollbar { height: 4px; }
.pol-chain-svg-wrap::-webkit-scrollbar-thumb { background: rgba(232,168,56,0.2); border-radius: 2px; }
.pol-chain-legend {
  display: flex; gap: 12px; justify-content: center; margin-top: 8px; font-size: 10px; color: #888;
}
.pol-chain-legend-item { display: flex; align-items: center; gap: 4px; }
.pol-chain-legend-dot {
  width: 10px; height: 10px; border-radius: 2px;
}
.pol-chain-tooltip {
  position: absolute; padding: 6px 10px; border-radius: 6px;
  background: rgba(20,28,44,0.95); border: 1px solid rgba(255,255,255,0.15);
  font-size: 11px; color: #ddd; pointer-events: none; z-index: 10;
  white-space: nowrap; max-width: 200px; white-space: normal;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
</style>
`;

/** Simple markdown → HTML for AI chat responses */
function formatMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^#{1,3}\s+(.+)$/gm, '<div style="font-weight:700;margin:6px 0 2px">$1</div>')
    .replace(/^\d+\.\s+(.+)$/gm, '<div style="padding-left:16px;text-indent:-14px;margin:2px 0"><span style="color:#e8a838;font-weight:600;margin-right:2px">·</span>$1</div>')
    .replace(/^[-•]\s+(.+)$/gm, '<div style="padding-left:16px;text-indent:-14px;margin:2px 0"><span style="color:#e8a838;font-weight:600;margin-right:2px">·</span>$1</div>')
    .replace(/\n/g, '<br>');
}

function directionClass(dir: string): string {
  if (['利好', '偏松', '中性偏多'].includes(dir)) return 'pol-dir-positive';
  if (['利空', '偏紧', '中性偏空'].includes(dir)) return 'pol-dir-negative';
  return 'pol-dir-neutral';
}

class PolicyDrawer {
  private overlay: HTMLElement;
  private drawerEl: HTMLElement;
  private bodyEl: HTMLElement;
  private item: PolicyItem | null = null;
  private activeTab: 'content' | 'analysis' | 'chat' | 'compare' | 'timeline' | 'chain' = 'content';

  // Content tab state
  private articleContent: { content: string; plainText: string; jsSpa?: boolean; excerpt?: string } | null = null;
  private loadingContent = false;
  private fetchError = false;

  // Analysis tab state
  private analysis: PolicyAnalysis | null = null;
  private analyzingLoading = false;

  // Chat tab state
  private chatMessages: ChatMessage[] = [];
  private chatLoading = false;

  // Compare tab state
  private relatedPolicies: RelatedSearchResult | null = null;
  private relatedLoading = false;
  private selectedCompareUrls = new Set<string>();
  private compareResult: CompareResult | null = null;
  private compareLoading = false;

  // Timeline state
  private timelineData: { topic: string; events: any[]; inflection_points: any[]; overall_trend: string; current_phase: string } | null = null;
  private timelineLoading = false;

  // Scoring state
  private scoreData: { total: number; grade: string; mode: string; dimensions: { name: string; score: number; max: number; reasoning: string }[] } | null = null;
  private scoreLoading = false;

  // Chain state
  private chainData: { nodes: any[]; edges: any[]; summary: string } | null = null;
  private chainLoading = false;

  private abortController: AbortController | null = null;
  // Cache per article (by URL hash)
  private analysisCache = new Map<string, PolicyAnalysis>();

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'policy-drawer-overlay';
    this.overlay.innerHTML = DRAWER_STYLE;

    this.drawerEl = document.createElement('div');
    this.drawerEl.className = 'policy-drawer';

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'policy-drawer-body';

    this.overlay.appendChild(this.drawerEl);
    document.body.appendChild(this.overlay);

    // Close on overlay click
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    this._onKeyDown = this._onKeyDown.bind(this);
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.close();
  }

  public open(item: PolicyItem): void {
    this.item = item;
    this.activeTab = 'content';
    this.articleContent = null;
    this.loadingContent = false;
    this.fetchError = false;
    this.analysis = this.analysisCache.get(item.url) || null;
    this.chatMessages = [];
    this.chatLoading = false;
    this.analyzingLoading = false;
    this.relatedPolicies = null;
    this.relatedLoading = false;
    this.selectedCompareUrls = new Set();
    this.compareResult = null;
    this.compareLoading = false;
    this.scoreData = null;
    this.scoreLoading = false;
    this.timelineData = null;
    this.timelineLoading = false;
    this.chainData = null;
    this.chainLoading = false;

    this.abortController = new AbortController();
    this.render();
    this.overlay.classList.add('open');
    document.addEventListener('keydown', this._onKeyDown);

    if (item.jsSpa) {
      this.articleContent = { content: '', plainText: '', jsSpa: true, excerpt: item.excerpt || '' };
      this.renderBody();
    } else {
      this.loadingContent = true;
      this.renderBody();
      void this.fetchContent();
    }
  }

  public close(): void {
    this.overlay.classList.remove('open');
    document.removeEventListener('keydown', this._onKeyDown);
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async fetchContent(): Promise<void> {
    if (!this.item) return;
    try {
      let apiUrl: string;
      if (this.item.dbNewsId) {
        apiUrl = `${CN_INTEL_BASE}/api/cn/news/db/detail?id=${encodeURIComponent(this.item.dbNewsId)}`;
      } else {
        apiUrl = `${CN_INTEL_BASE}/api/cn/gov-news/content?url=${encodeURIComponent(this.item.url)}&title=${encodeURIComponent(this.item.title || '')}`;
      }
      const res = await cnFetch(apiUrl, { signal: this.abortController?.signal });
      if (!res.ok) {
        this.fetchError = true;
        this.articleContent = null;
        return;
      }
      const data = await res.json();
      if (data.error) {
        if (data.error === 'js_spa') {
          this.fetchError = false;
          this.articleContent = { content: '', plainText: '', jsSpa: true, excerpt: this.item.excerpt || '' };
        } else {
          this.fetchError = true;
          this.articleContent = null;
        }
      } else if (this.item.dbNewsId) {
        const html = data.macro_array || data.content || '';
        const plain = data.plainText || '';
        this.articleContent = { content: html, plainText: plain };
      } else {
        this.articleContent = data;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.fetchError = true;
      this.articleContent = null;
    } finally {
      this.loadingContent = false;
      this.renderBody();
    }
  }

  private async fetchAnalysis(): Promise<void> {
    if (!this.item) return;
    const cacheKey = this.item.url;
    if (this.analysisCache.has(cacheKey)) {
      this.analysis = this.analysisCache.get(cacheKey)!;
      this.renderBody();
      return;
    }

    // Need content for analysis
    const plainText = this.articleContent?.plainText || this.articleContent?.content || '';
    if (!plainText || plainText.length < 30) {
      this.analysis = { summary: '文章内容太短，无法生成分析。请先加载正文。' };
      this.renderBody();
      return;
    }

    this.analyzingLoading = true;
    this.renderBody();

    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/policy/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: this.item.title,
          content: plainText,
          source: this.item.source,
          category: this.item.category,
          url: this.item.url,
        }),
        signal: this.abortController?.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.analysis = await res.json();
      if (this.analysis && !this.analysis.error) {
        this.analysisCache.set(cacheKey, this.analysis);
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
    if (!this.item || this.chatLoading) return;

    this.chatMessages.push({ role: 'user', content: question, timestamp: Date.now() });
    this.chatLoading = true;
    this.renderBody();

    try {
      const plainText = this.articleContent?.plainText || this.articleContent?.content || '';
      const history = this.chatMessages
        .filter((m) => m.role !== 'user' || m.content !== question)
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/policy/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: this.item.title,
          content: plainText,
          question,
          history,
        }),
        signal: this.abortController?.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      this.chatMessages.push({
        role: 'assistant',
        content: data.answer || '抱歉，暂时无法回答。',
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
    if (!this.item) return;
    const it = this.item;

    this.drawerEl.innerHTML = `
      <div class="policy-drawer-header">
        <h3>${escapeHtml(it.title)}</h3>
        <div class="policy-drawer-meta">
          ${it.source ? `<span class="drawer-source">${escapeHtml(it.source)}</span>` : ''}
          ${it.date ? `<span>${escapeHtml(it.date)}</span>` : ''}
          <span class="drawer-cat-badge">${escapeHtml(it.category)}</span>
        </div>
        <button class="policy-drawer-close" id="polDrawerClose">&times;</button>
      </div>
      <div class="policy-drawer-tabs">
        <button class="policy-drawer-tab ${this.activeTab === 'content' ? 'active' : ''}" data-ptab="content">正文</button>
        <button class="policy-drawer-tab ${this.activeTab === 'analysis' ? 'active' : ''}" data-ptab="analysis">AI分析</button>
        <button class="policy-drawer-tab ${this.activeTab === 'chat' ? 'active' : ''}" data-ptab="chat">AI问答</button>
        <button class="policy-drawer-tab ${this.activeTab === 'compare' ? 'active' : ''}" data-ptab="compare">对比</button>
        <button class="policy-drawer-tab ${this.activeTab === 'timeline' ? 'active' : ''}" data-ptab="timeline">脉络</button>
        <button class="policy-drawer-tab ${this.activeTab === 'chain' ? 'active' : ''}" data-ptab="chain">传导链</button>
      </div>
    `;

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'policy-drawer-body';
    this.drawerEl.appendChild(this.bodyEl);
    this.renderBody();

    // Event listeners
    this.drawerEl.querySelector('#polDrawerClose')?.addEventListener('click', () => this.close());

    this.drawerEl.querySelectorAll('.policy-drawer-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const t = (tab as HTMLElement).dataset.ptab as typeof this.activeTab;
        if (t) {
          this.activeTab = t;
          this.drawerEl.querySelectorAll('.policy-drawer-tab').forEach((el) => el.classList.remove('active'));
          tab.classList.add('active');

          if (t === 'analysis' && !this.analysis && !this.analyzingLoading) {
            void this.fetchAnalysis();
          }
          if (t === 'compare' && !this.relatedPolicies && !this.relatedLoading) {
            void this.searchRelated();
          }

          this.renderBody();
        }
      });
    });
  }

  private renderBody(): void {
    if (!this.item) return;
    // Chat mode needs special flex layout so input stays at bottom
    this.bodyEl.classList.toggle('chat-mode', this.activeTab === 'chat');
    if (this.activeTab === 'content') {
      this.renderContentTab();
    } else if (this.activeTab === 'analysis') {
      this.renderAnalysisTab();
    } else if (this.activeTab === 'compare') {
      this.renderCompareTab();
    } else if (this.activeTab === 'timeline') {
      this.renderTimelineTab();
    } else if (this.activeTab === 'chain') {
      this.renderChainTab();
    } else {
      this.renderChatTab();
    }
  }

  private renderContentTab(): void {
    const it = this.item!;

    if (this.loadingContent) {
      this.bodyEl.innerHTML = `<div class="policy-loading"><i class="bi bi-arrow-repeat"></i>加载正文中...</div>`;
      return;
    }

    if (this.fetchError) {
      this.bodyEl.innerHTML = `<div class="policy-error">
        <i class="bi bi-exclamation-triangle"></i>
        无法获取正文内容
        <div class="policy-link-bar"><a href="${escapeHtml(it.url)}" target="_blank" rel="noopener"><i class="bi bi-box-arrow-up-right"></i> 前往原文查看</a></div>
      </div>`;
      return;
    }

    if (this.articleContent && this.articleContent.jsSpa) {
      const excerpt = this.articleContent.excerpt || '';
      this.bodyEl.innerHTML = `<div style="padding:16px 0">
        ${excerpt ? `<div style="font-size:13px;color:var(--text,#E0E6EF);line-height:1.8;margin-bottom:20px;padding:12px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid rgba(255,255,255,0.06)">${escapeHtml(excerpt)}</div>` : ''}
        <div style="text-align:center;padding:${excerpt ? '8' : '40'}px 0">
          <div style="margin-bottom:12px;color:#888;font-size:12px">该网站为动态加载页面，完整内容需在浏览器中查看</div>
          <a href="${escapeHtml(it.url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:8px 20px;background:rgba(92,107,192,0.15);border:1px solid rgba(92,107,192,0.3);border-radius:8px;color:#7986CB;font-size:13px;font-weight:500">
            <i class="bi bi-box-arrow-up-right"></i> 前往原文
          </a>
        </div>
      </div>`;
      return;
    }

    if (this.articleContent && this.articleContent.content) {
      const isExternalUrl = it.url && it.url.startsWith('http');
      // SAFETY: content is server-fetched HTML from gov/official news sites, not user input.
      // If user-generated content is ever added, wrap with DOMPurify.sanitize().
      this.bodyEl.innerHTML = `
        <div class="policy-content-area">${this.articleContent.content}</div>
        ${isExternalUrl ? `<div class="policy-link-bar"><a href="${escapeHtml(it.url)}" target="_blank" rel="noopener"><i class="bi bi-box-arrow-up-right"></i> 查看原文</a></div>` : ''}
      `;
      // Hide broken images
      this.bodyEl.querySelectorAll('.policy-content-area img').forEach((img) => {
        (img as HTMLImageElement).onerror = () => { (img as HTMLElement).setAttribute('data-failed', '1'); };
      });
      return;
    }

    this.bodyEl.innerHTML = `<div class="policy-error">
      <i class="bi bi-file-earmark-x"></i>
      暂无正文内容
      <div class="policy-link-bar"><a href="${escapeHtml(it.url)}" target="_blank" rel="noopener"><i class="bi bi-box-arrow-up-right"></i> 前往原文查看</a></div>
    </div>`;
  }

  private renderAnalysisTab(): void {
    // Auto-fetch fast score when analysis tab opens and we have a title
    if (!this.scoreData && !this.scoreLoading && this.item) {
      void this.fetchScore('fast');
    }

    if (this.analyzingLoading) {
      this.bodyEl.innerHTML = this._renderScoreWidget() + `
        <div style="text-align:center;padding:40px 0">
          <div class="pol-typing-dots" style="justify-content:center">
            <div class="pol-typing-dot"></div>
            <div class="pol-typing-dot"></div>
            <div class="pol-typing-dot"></div>
          </div>
          <div style="color:var(--text-dim);font-size:12px;margin-top:12px">AI正在分析政策文章...</div>
        </div>
      `;
      this._bindScoreEvents();
      return;
    }

    if (!this.analysis) {
      const hasContent = this.articleContent && (this.articleContent.content || this.articleContent.plainText);
      this.bodyEl.innerHTML = this._renderScoreWidget() + `
        <div style="text-align:center;padding:40px 0">
          <div style="color:var(--text-dim);font-size:13px;margin-bottom:16px">${hasContent ? '点击下方按钮，AI将为你分析政策影响' : '请先等待正文加载完成'}</div>
          <button class="pol-analyze-btn" id="polAnalyzeBtn" ${hasContent ? '' : 'disabled'}>生成AI分析</button>
        </div>
      `;
      this.bodyEl.querySelector('#polAnalyzeBtn')?.addEventListener('click', () => {
        void this.fetchAnalysis();
      });
      this._bindScoreEvents();
      return;
    }

    const a = this.analysis;
    const cards: string[] = [this._renderScoreWidget()];

    // Error case
    if (a.error) {
      cards.push(`<div class="pol-analysis-card"><div class="pol-analysis-text" style="color:#ff9800">${escapeHtml(a.error)}</div></div>`);
      this.bodyEl.innerHTML = cards.join('');
      return;
    }

    if (a.summary) {
      cards.push(`
        <div class="pol-analysis-card">
          <div class="pol-analysis-label">政策摘要</div>
          <div class="pol-analysis-text">${escapeHtml(a.summary)}</div>
        </div>
      `);
    }

    if (a.keyPoints && a.keyPoints.length > 0) {
      const items = a.keyPoints.map((v) => `<li>${escapeHtml(v)}</li>`).join('');
      cards.push(`
        <div class="pol-analysis-card">
          <div class="pol-analysis-label">核心要点</div>
          <ul class="pol-analysis-list">${items}</ul>
        </div>
      `);
    }

    if (a.policyDirection) {
      cards.push(`
        <div class="pol-analysis-card">
          <div class="pol-analysis-label">政策方向</div>
          <span class="pol-direction-badge ${directionClass(a.policyDirection)}">${escapeHtml(a.policyDirection)}</span>
        </div>
      `);
    }

    if (a.marketImpact) {
      cards.push(`
        <div class="pol-analysis-card">
          <div class="pol-analysis-label">市场影响</div>
          <div class="pol-analysis-text">${escapeHtml(a.marketImpact)}</div>
        </div>
      `);
    }

    if (a.sectors && a.sectors.length > 0) {
      const tags = a.sectors.map((s) => `<span class="pol-analysis-tag sector">${escapeHtml(s)}</span>`).join('');
      cards.push(`
        <div class="pol-analysis-card">
          <div class="pol-analysis-label">相关板块</div>
          <div class="pol-analysis-tags">${tags}</div>
        </div>
      `);
    }

    if (a.risks && a.risks.length > 0) {
      const tags = a.risks.map((r) => `<span class="pol-analysis-tag risk">${escapeHtml(r)}</span>`).join('');
      cards.push(`
        <div class="pol-analysis-card">
          <div class="pol-analysis-label">风险提示</div>
          <div class="pol-analysis-tags">${tags}</div>
        </div>
      `);
    }

    if (a.investmentAdvice) {
      cards.push(`
        <div class="pol-analysis-card">
          <div class="pol-analysis-label">投资建议</div>
          <div class="pol-analysis-text">${escapeHtml(a.investmentAdvice)}</div>
        </div>
      `);
    }

    // Executive impact (4-role)
    if (a.executive_impact && typeof a.executive_impact === 'object') {
      const ei = a.executive_impact;
      const roleItems: Array<{key: string; icon: string; label: string; color: string}> = [
        { key: 'ceo', icon: 'bi-person-check', label: 'CEO', color: '#e8a838' },
        { key: 'cmo', icon: 'bi-megaphone', label: 'CMO', color: '#66bb6a' },
        { key: 'cfo', icon: 'bi-cash-coin', label: 'CFO', color: '#42a5f5' },
        { key: 'cso', icon: 'bi-compass', label: 'CSO', color: '#BA68C8' },
      ];
      const eiCards = roleItems.filter(r => (ei as any)[r.key]).map(r =>
        `<div style="padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06)">
          <div style="font-size:10px;font-weight:700;color:${r.color};margin-bottom:3px;display:flex;align-items:center;gap:4px"><i class="bi ${r.icon}"></i> ${r.label}</div>
          <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">${escapeHtml((ei as any)[r.key])}</div>
        </div>`
      ).join('');
      if (eiCards) {
        cards.push(`
          <div class="pol-analysis-card">
            <div class="pol-analysis-label"><i class="bi bi-people-fill"></i> 高管视角</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${eiCards}</div>
          </div>
        `);
      }
    }

    // Time impact (3-horizon)
    if (a.time_impact && typeof a.time_impact === 'object') {
      const ti = a.time_impact;
      const timeRows: Array<{key: string; label: string; color: string; bg: string}> = [
        { key: 'near_term', label: '近期', color: '#ef5350', bg: 'rgba(239,83,80,0.15)' },
        { key: 'mid_term', label: '中期', color: '#ffa726', bg: 'rgba(255,167,38,0.15)' },
        { key: 'long_term', label: '远期', color: '#42a5f5', bg: 'rgba(66,165,245,0.15)' },
      ];
      const tiRows = timeRows.filter(t => (ti as any)[t.key]).map(t =>
        `<div style="display:flex;gap:6px;align-items:flex-start;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);margin-bottom:6px">
          <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap;flex-shrink:0;margin-top:1px;background:${t.bg};color:${t.color}">${t.label}</span>
          <span style="font-size:12px;color:var(--text-secondary);line-height:1.5">${escapeHtml((ti as any)[t.key])}</span>
        </div>`
      ).join('');
      if (tiRows) {
        cards.push(`
          <div class="pol-analysis-card">
            <div class="pol-analysis-label"><i class="bi bi-clock-history"></i> 时间维度影响</div>
            ${tiRows}
          </div>
        `);
      }
    }

    // Cross-domain signals section (Phase 4)
    if (a.sectors && a.sectors.length > 0) {
      cards.push(`
        <div class="pol-analysis-card" id="pol-cross-domain-section">
          <div class="pol-analysis-label"><i class="bi bi-diagram-3"></i> 跨域信号</div>
          <div style="color:#888;font-size:12px;cursor:pointer" id="pol-load-cross-signals">
            <i class="bi bi-arrow-right-circle"></i> 点击加载政策×舆情×市场跨域关联分析
          </div>
        </div>
      `);
    }

    this.bodyEl.innerHTML = cards.join('');
    this._bindScoreEvents();

    // Bind cross-domain signal loader
    const crossBtn = this.bodyEl.querySelector('#pol-load-cross-signals');
    if (crossBtn) {
      crossBtn.addEventListener('click', async () => {
        crossBtn.innerHTML = '<i class="bi bi-arrow-repeat" style="animation:pol-spin 1s linear infinite"></i> 分析跨域信号中...';
        try {
          const sectors = (a.sectors || []).join(',');
          const res = await cnFetch(`/api/cn/insights/correlations?sectors=${encodeURIComponent(sectors)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const signals = data.signals || [];
          if (signals.length === 0) {
            crossBtn.innerHTML = '<span style="color:#666">暂无跨域信号</span>';
          } else {
            const signalHtml = signals.slice(0, 5).map((s: any) => {
              const patternColors: Record<string, string> = { TRIPLE: '#ef5350', CONVERGENCE: '#66bb6a', DIVERGENCE: '#ff9800', LEADING: '#42a5f5' };
              const color = patternColors[s.pattern] || '#888';
              return `<div style="display:flex;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
                <span style="color:${color};font-size:10px;font-weight:600;min-width:80px">${escapeHtml(s.pattern)}</span>
                <span style="color:#ccc;font-size:12px;flex:1">${escapeHtml(s.description || s.sector || '')}</span>
                <span style="color:#e8a838;font-size:11px">${(s.confidence * 100).toFixed(0)}%</span>
              </div>`;
            }).join('');
            const section = this.bodyEl.querySelector('#pol-cross-domain-section');
            if (section) {
              section.innerHTML = `
                <div class="pol-analysis-label"><i class="bi bi-diagram-3"></i> 跨域信号 <span style="color:#666;font-size:10px">(${signals.length}条)</span></div>
                ${signalHtml}
              `;
            }
          }
        } catch {
          crossBtn.innerHTML = '<span style="color:#ff9800">跨域分析暂不可用</span>';
        }
      });
    }
  }

  // ── Scoring Widget ──────────────────────────────────────────────────────────

  private _renderScoreWidget(): string {
    if (this.scoreLoading && !this.scoreData) {
      return `<div class="pol-score-wrap" style="text-align:center;padding:20px">
        <div style="color:#888;font-size:12px"><i class="bi bi-arrow-repeat" style="animation:pol-spin 1s linear infinite"></i> 评分计算中...</div>
      </div>`;
    }
    if (!this.scoreData) return '';

    const d = this.scoreData;
    const pct = d.total / 100;
    const gradeClass = `pol-grade-${d.grade}`;

    // SVG arc gauge (0-100)
    const r = 32, cx = 40, cy = 40, sw = 6;
    const circumference = 2 * Math.PI * r;
    const arcLen = circumference * 0.75; // 270 degrees
    const dashOffset = arcLen * (1 - pct);
    const gaugeColor = d.total >= 80 ? '#ef5350' : d.total >= 60 ? '#e8a838' : d.total >= 40 ? '#42a5f5' : '#888';

    const gaugeSvg = `<svg class="pol-score-gauge" width="80" height="80" viewBox="0 0 80 80">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="${sw}"
        stroke-dasharray="${arcLen} ${circumference}" stroke-dashoffset="0"
        transform="rotate(135 ${cx} ${cy})" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${gaugeColor}" stroke-width="${sw}"
        stroke-dasharray="${arcLen} ${circumference}" stroke-dashoffset="${dashOffset}"
        transform="rotate(135 ${cx} ${cy})" stroke-linecap="round" style="transition:stroke-dashoffset .8s ease"/>
      <text x="${cx}" y="${cy + 2}" text-anchor="middle" fill="#e8a838" font-size="18" font-weight="700">${d.total}</text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="#666" font-size="9">/ 100</text>
    </svg>`;

    // SVG radar chart (5 dimensions)
    const dims = d.dimensions;
    const radarR = 40, radarCx = 50, radarCy = 50;
    const angleStep = (2 * Math.PI) / 5;
    const startAngle = -Math.PI / 2;

    const gridLines = [0.25, 0.5, 0.75, 1.0].map(scale => {
      const pts = Array.from({length: 5}, (_, i) => {
        const a = startAngle + i * angleStep;
        return `${radarCx + radarR * scale * Math.cos(a)},${radarCy + radarR * scale * Math.sin(a)}`;
      }).join(' ');
      return `<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="0.5"/>`;
    }).join('');

    const dataPts = dims.map((dim, i) => {
      const a = startAngle + i * angleStep;
      const scale = dim.score / dim.max;
      return `${radarCx + radarR * scale * Math.cos(a)},${radarCy + radarR * scale * Math.sin(a)}`;
    }).join(' ');

    const labelEls = dims.map((dim, i) => {
      const a = startAngle + i * angleStep;
      const lx = radarCx + (radarR + 14) * Math.cos(a);
      const ly = radarCy + (radarR + 14) * Math.sin(a);
      const anchor = Math.abs(Math.cos(a)) < 0.3 ? 'middle' : (Math.cos(a) > 0 ? 'start' : 'end');
      return `<text x="${lx}" y="${ly + 3}" text-anchor="${anchor}" fill="#999" font-size="8">${dim.name.slice(0, 4)}</text>`;
    }).join('');

    const radarSvg = `<svg class="pol-score-radar-svg" width="120" height="120" viewBox="0 0 100 100">
      ${gridLines}
      <polygon points="${dataPts}" fill="rgba(232,168,56,0.15)" stroke="#e8a838" stroke-width="1.5"/>
      ${dataPts.split(' ').map(pt => `<circle cx="${pt.split(',')[0]}" cy="${pt.split(',')[1]}" r="2.5" fill="#e8a838"/>`).join('')}
      ${labelEls}
    </svg>`;

    // Dimension bars
    const dimBars = dims.map(dim => {
      const barPct = (dim.score / dim.max) * 100;
      const barColor = dim.score >= 16 ? '#ef5350' : dim.score >= 12 ? '#e8a838' : dim.score >= 8 ? '#42a5f5' : '#888';
      return `<div class="pol-score-dim-row">
        <span class="pol-score-dim-name">${escapeHtml(dim.name)}</span>
        <div class="pol-score-dim-bar-bg"><div class="pol-score-dim-bar" style="width:${barPct}%;background:${barColor}"></div></div>
        <span class="pol-score-dim-val">${dim.score}</span>
      </div>
      ${dim.reasoning ? `<div class="pol-score-dim-reason">${escapeHtml(dim.reasoning)}</div>` : ''}`;
    }).join('');

    const modeLabel = d.mode === 'deep' ? 'AI深度评分' : (d.mode === 'fast_fallback' ? '规则评分(AI降级)' : '规则快速评分');
    const deepBtn = d.mode !== 'deep'
      ? `<button class="pol-score-deep-btn" id="polScoreDeepBtn"${this.scoreLoading ? ' disabled' : ''}>
          ${this.scoreLoading ? '<i class="bi bi-arrow-repeat" style="animation:pol-spin 1s linear infinite"></i> ' : '<i class="bi bi-stars"></i> '}AI深度评分
        </button>`
      : '';

    return `<div class="pol-score-wrap">
      <div class="pol-score-header">
        ${gaugeSvg}
        <div class="pol-score-info">
          <div><span class="pol-score-total">${d.total}</span><span class="pol-score-grade ${gradeClass}">${d.grade}</span></div>
          <div class="pol-score-mode">${modeLabel}</div>
          ${deepBtn}
        </div>
        ${radarSvg}
      </div>
      <div class="pol-score-dims">${dimBars}</div>
    </div>`;
  }

  private _bindScoreEvents(): void {
    this.bodyEl.querySelector('#polScoreDeepBtn')?.addEventListener('click', () => {
      void this.fetchScore('deep');
    });
  }

  private async fetchScore(mode: 'fast' | 'deep'): Promise<void> {
    if (!this.item || this.scoreLoading) return;
    this.scoreLoading = true;
    if (this.activeTab === 'analysis') this.renderBody();
    try {
      const body: any = {
        title: this.item.title,
        source: this.item.source || '',
        category: this.item.category || '',
        mode,
      };
      if (this.articleContent?.plainText) {
        body.content = this.articleContent.plainText.slice(0, 5000);
      }
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/policy/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: this.abortController?.signal,
      });
      if (res.ok) {
        this.scoreData = await res.json();
      }
    } catch (err) {
      // ignore abort errors
    } finally {
      this.scoreLoading = false;
      if (this.activeTab === 'analysis') this.renderBody();
    }
  }

  // ── Timeline Tab ─────────────────────────────────────────────────────────────

  private renderTimelineTab(): void {
    if (!this.timelineData && !this.timelineLoading) {
      void this.fetchTimeline();
    }

    if (this.timelineLoading) {
      this.bodyEl.innerHTML = `<div style="text-align:center;padding:40px 0">
        <div class="pol-typing-dots" style="justify-content:center">
          <div class="pol-typing-dot"></div><div class="pol-typing-dot"></div><div class="pol-typing-dot"></div>
        </div>
        <div style="color:var(--text-dim);font-size:12px;margin-top:12px">AI正在分析政策演变脉络...</div>
      </div>`;
      return;
    }

    if (!this.timelineData || this.timelineData.events.length === 0) {
      this.bodyEl.innerHTML = `<div style="text-align:center;padding:40px 0;color:#888;font-size:12px">
        数据库中未找到相关历史政策记录
      </div>`;
      return;
    }

    const tl = this.timelineData;
    const inflectionDates = new Set((tl.inflection_points || []).map((ip: any) => ip.date));

    // Phase banner at top
    let phaseHtml = '';
    if (tl.current_phase || tl.overall_trend) {
      phaseHtml = `<div class="pol-tl-phase">
        ${tl.current_phase ? `<div class="pol-tl-phase-label">当前阶段</div><div>${escapeHtml(tl.current_phase)}</div>` : ''}
        ${tl.overall_trend ? `<div class="pol-tl-phase-label" style="margin-top:6px">总体趋势</div><div>${escapeHtml(tl.overall_trend)}</div>` : ''}
      </div>`;
    }

    // Timeline nodes
    const nodesHtml = tl.events.map((evt: any) => {
      const dir = evt.direction || '中性';
      const isInflection = inflectionDates.has(evt.date);
      const nodeClass = `pol-tl-node dir-${dir}${isInflection ? ' inflection' : ''}`;
      return `<div class="${nodeClass}">
        <div class="pol-tl-date">${escapeHtml(evt.date || '')}</div>
        <div class="pol-tl-title">${escapeHtml(evt.title || '')}
          <span class="pol-tl-dir-tag pol-tl-dir-${dir}">${dir}</span>
          ${isInflection ? '<span class="pol-tl-dir-tag" style="background:rgba(232,168,56,0.2);color:#e8a838">转折</span>' : ''}
        </div>
        ${evt.summary ? `<div class="pol-tl-summary">${escapeHtml(evt.summary)}</div>` : ''}
      </div>`;
    }).join('');

    this.bodyEl.innerHTML = `${phaseHtml}
      <div class="pol-tl-wrap">
        <div class="pol-tl-line"></div>
        ${nodesHtml}
      </div>`;
  }

  private async fetchTimeline(): Promise<void> {
    if (!this.item || this.timelineLoading) return;
    this.timelineLoading = true;
    this.renderBody();
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/policy/timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: this.item.title, topic: this.item.title }),
        signal: this.abortController?.signal,
      });
      if (res.ok) {
        this.timelineData = await res.json();
      }
    } catch (err) {
      // ignore abort
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
        <div class="pol-typing-dots" style="justify-content:center">
          <div class="pol-typing-dot"></div><div class="pol-typing-dot"></div><div class="pol-typing-dot"></div>
        </div>
        <div style="color:var(--text-dim);font-size:12px;margin-top:12px">AI正在分析政策传导链路...</div>
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

    // Summary banner
    let summaryHtml = '';
    if (summary) {
      summaryHtml = `<div class="pol-chain-summary">
        <div class="pol-chain-summary-label">传导路径摘要</div>
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

    // Compute node positions
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

    // Level labels
    const levelLabels = ['政策', '传导机制', '一级板块', '二级板块', '具体标的'];
    let levelLabelsSvg = '';
    for (let lvl = 0; lvl <= maxLevel && lvl < levelLabels.length; lvl++) {
      const cx = padLeft + lvl * colWidth + nodeW / 2;
      levelLabelsSvg += `<text x="${cx}" y="14" text-anchor="middle" fill="#777" font-size="10" font-weight="600">${levelLabels[lvl]}</text>`;
    }

    // Draw edges
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
      const hoverFrom = edge.from;
      const hoverTo = edge.to;

      edgesSvg += `<path d="M${x1},${y1} C${cpx},${y1} ${cpx},${y2} ${x2},${y2}"
        fill="none" stroke="rgba(232,168,56,${opacity})" stroke-width="${sw}"
        data-edge-from="${hoverFrom}" data-edge-to="${hoverTo}"
        style="transition:stroke 0.2s,stroke-width 0.2s"/>`;

      // Edge label at midpoint
      if (edge.label) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2 - 6;
        edgesSvg += `<text x="${mx}" y="${my}" text-anchor="middle" fill="rgba(232,168,56,0.55)" font-size="8.5"
          data-edge-from="${hoverFrom}" data-edge-to="${hoverTo}">${escapeHtml((edge.label || '').slice(0, 12))}</text>`;
      }
    }

    // Draw nodes
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
      const isPolicy = n.level === 0;

      nodesSvg += `<g class="pol-chain-node" data-nid="${n.id}" style="cursor:pointer">
        <rect x="${pos.x}" y="${pos.y}" width="${nodeW}" height="${nodeH}" rx="6" ry="6"
          fill="${fillColor}" stroke="${strokeColor}" stroke-width="${isPolicy ? 1.5 : 1}"
          style="transition:fill 0.15s,stroke-width 0.15s"/>
        <text x="${pos.x + nodeW / 2}" y="${pos.y + nodeH / 2 + (n.code ? -2 : 1)}" text-anchor="middle"
          dominant-baseline="middle" fill="${textColor}" font-size="${isPolicy ? 12 : 11}"
          font-weight="${isPolicy ? 700 : 500}">${escapeHtml(label)}</text>
        ${n.code ? `<text x="${pos.x + nodeW / 2}" y="${pos.y + nodeH - 5}" text-anchor="middle" fill="#888" font-size="8">${escapeHtml(n.code)}</text>` : ''}
      </g>`;
    }

    const svgContent = `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">
      ${levelLabelsSvg}
      ${edgesSvg}
      ${nodesSvg}
    </svg>`;

    // Legend
    const legendHtml = `<div class="pol-chain-legend">
      <div class="pol-chain-legend-item"><div class="pol-chain-legend-dot" style="background:rgba(229,57,53,0.4)"></div>利好</div>
      <div class="pol-chain-legend-item"><div class="pol-chain-legend-dot" style="background:rgba(67,160,71,0.4)"></div>利空</div>
      <div class="pol-chain-legend-item"><div class="pol-chain-legend-dot" style="background:rgba(255,255,255,0.15)"></div>中性</div>
      <div class="pol-chain-legend-item" style="margin-left:12px">
        <svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="#e8a838" stroke-width="2.5" opacity="0.6"/></svg>强
      </div>
      <div class="pol-chain-legend-item">
        <svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="#e8a838" stroke-width="1.5" opacity="0.4"/></svg>中
      </div>
      <div class="pol-chain-legend-item">
        <svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="#e8a838" stroke-width="0.8" opacity="0.25"/></svg>弱
      </div>
    </div>`;

    this.bodyEl.innerHTML = `${summaryHtml}
      <div class="pol-chain-svg-wrap" style="position:relative">${svgContent}</div>
      ${legendHtml}`;

    // Hover interactions
    this._bindChainEvents(nodes, edges);
  }

  private _bindChainEvents(nodes: any[], edges: any[]): void {
    const svgWrap = this.bodyEl.querySelector('.pol-chain-svg-wrap');
    if (!svgWrap) return;

    // Build adjacency for highlight
    const connectedEdges = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!connectedEdges.has(e.from)) connectedEdges.set(e.from, new Set());
      if (!connectedEdges.has(e.to)) connectedEdges.set(e.to, new Set());
      connectedEdges.get(e.from)!.add(e.to);
      connectedEdges.get(e.to)!.add(e.from);
    }

    // Tooltip element
    let tooltip: HTMLDivElement | null = null;

    svgWrap.querySelectorAll('.pol-chain-node').forEach(g => {
      const nid = (g as SVGElement).dataset.nid || '';
      const node = nodes.find((n: any) => n.id === nid);

      g.addEventListener('mouseenter', (ev) => {
        // hover state tracked locally via closure
        const connected = connectedEdges.get(nid) || new Set();

        // Highlight connected edges
        svgWrap.querySelectorAll('path[data-edge-from]').forEach(path => {
          const ef = (path as SVGElement).dataset.edgeFrom || '';
          const et = (path as SVGElement).dataset.edgeTo || '';
          const isConnected = ef === nid || et === nid;
          (path as SVGElement).style.stroke = isConnected ? 'rgba(232,168,56,0.9)' : 'rgba(255,255,255,0.04)';
          (path as SVGElement).style.strokeWidth = isConnected ? '3' : '0.5';
        });

        // Dim non-connected nodes
        svgWrap.querySelectorAll('.pol-chain-node').forEach(otherG => {
          const oid = (otherG as SVGElement).dataset.nid || '';
          const isConn = oid === nid || connected.has(oid);
          (otherG as SVGElement).style.opacity = isConn ? '1' : '0.3';
        });

        // Show tooltip
        if (node) {
          if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.className = 'pol-chain-tooltip';
            svgWrap.appendChild(tooltip);
          }
          const dir = node.direction || '中性';
          const dirColor = dir === '利好' ? '#ef5350' : dir === '利空' ? '#43a047' : '#888';
          tooltip.innerHTML = `<div style="font-weight:600;margin-bottom:2px">${escapeHtml(node.label || '')}</div>
            <div style="color:${dirColor};font-size:10px">${escapeHtml(dir)}</div>
            ${node.code ? `<div style="color:#888;font-size:10px">${escapeHtml(node.code)}</div>` : ''}
            ${node.entity_id ? `<div style="color:#666;font-size:9px">${escapeHtml(node.entity_id)}</div>` : ''}`;
          const me = ev as MouseEvent;
          const rect = (svgWrap as HTMLElement).getBoundingClientRect();
          tooltip.style.left = (me.clientX - rect.left + 10) + 'px';
          tooltip.style.top = (me.clientY - rect.top - 30) + 'px';
        }
      });

      g.addEventListener('mouseleave', () => {
        // hover cleared
        // Reset all
        svgWrap.querySelectorAll('path[data-edge-from]').forEach(path => {
          (path as SVGElement).style.stroke = '';
          (path as SVGElement).style.strokeWidth = '';
        });
        svgWrap.querySelectorAll('.pol-chain-node').forEach(otherG => {
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
    if (!this.item || this.chainLoading) return;
    this.chainLoading = true;
    this.renderBody();
    try {
      const body: any = { title: this.item.title };
      const plainText = this.articleContent?.plainText || this.articleContent?.content || '';
      if (plainText && plainText.length > 50) {
        body.content = plainText.slice(0, 5000);
      }
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/policy/transmission-chain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: this.abortController?.signal,
      });
      if (res.ok) {
        this.chainData = await res.json();
      }
    } catch (err) {
      // ignore abort
    } finally {
      this.chainLoading = false;
      if (this.activeTab === 'chain') this.renderBody();
    }
  }

  private renderChatTab(): void {
    const hasMessages = this.chatMessages.length > 0;

    let messagesHtml = '';
    if (!hasMessages && !this.chatLoading) {
      const suggestionsHtml = SUGGESTED_QUESTIONS.map(
        (q) => `<button class="pol-chat-suggest-btn" data-question="${escapeHtml(q)}">${escapeHtml(q)}</button>`,
      ).join('');
      messagesHtml = `
        <div style="text-align:center;padding:20px 0;color:var(--text-dim);font-size:12px;margin-bottom:8px">
          基于政策文章内容，回答你的政策分析问题
        </div>
        <div class="pol-chat-suggestions">${suggestionsHtml}</div>
      `;
    } else {
      messagesHtml = this.chatMessages.map((msg) => `
        <div class="pol-chat-msg ${msg.role}">
          ${msg.role === 'assistant' ? formatMarkdown(msg.content) : escapeHtml(msg.content)}
        </div>
      `).join('');

      if (this.chatLoading) {
        messagesHtml += `
          <div class="pol-typing-dots">
            <div class="pol-typing-dot"></div>
            <div class="pol-typing-dot"></div>
            <div class="pol-typing-dot"></div>
          </div>
        `;
      }
    }

    this.bodyEl.innerHTML = `
      <div class="pol-chat-container">
        <div class="pol-chat-messages" id="polChatMessages">
          ${messagesHtml}
        </div>
        <div class="pol-chat-input-area">
          <input type="text"
            class="pol-chat-input"
            id="polChatInput"
            placeholder="输入你的问题..."
            ${this.chatLoading ? 'disabled' : ''}
            autocomplete="off"
          />
          <button class="pol-chat-send" id="polChatSend" ${this.chatLoading ? 'disabled' : ''}>发送</button>
        </div>
      </div>
    `;

    // Scroll to bottom
    const msgContainer = this.bodyEl.querySelector('#polChatMessages') as HTMLElement;
    if (msgContainer) {
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }

    // Attach listeners
    const input = this.bodyEl.querySelector('#polChatInput') as HTMLInputElement;
    const sendBtn = this.bodyEl.querySelector('#polChatSend') as HTMLButtonElement;

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !this.chatLoading) {
          e.preventDefault();
          const q = input.value.trim();
          if (q) void this.sendChat(q);
        }
      });
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
    this.bodyEl.querySelectorAll('.pol-chat-suggest-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const q = (btn as HTMLElement).dataset.question;
        if (q) void this.sendChat(q);
      });
    });
  }

  // ── Compare tab methods ─────────────────────────────────────────────────────

  private async searchRelated(customKeywords?: string[]): Promise<void> {
    if (!this.item || this.relatedLoading) return;
    this.relatedLoading = true;
    this.selectedCompareUrls.clear();
    this.compareResult = null;
    this.renderBody();
    try {
      const body: Record<string, unknown> = {
        title: this.item.title,
        url: this.item.url,
      };
      if (customKeywords && customKeywords.length > 0) {
        body.keywords = customKeywords;
      }
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/policy/compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: this.abortController?.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.relatedPolicies = await res.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.relatedPolicies = { keywords: customKeywords || [], related: [], by_year: {}, total: 0 };
    } finally {
      this.relatedLoading = false;
      this.renderBody();
    }
  }

  private _attachSearchHandler(): void {
    const input = this.bodyEl.querySelector('#polCompareSearch') as HTMLInputElement;
    const btn = this.bodyEl.querySelector('#polCompareSearchBtn');
    if (!input || !btn) return;

    const doSearch = () => {
      const val = input.value.trim();
      if (!val) return;
      // Split on spaces, commas, etc. to support multi-keyword input
      const kws = val.split(/[,，\s]+/).filter(k => k.length >= 2);
      if (kws.length > 0) {
        void this.searchRelated(kws);
      }
    };

    btn.addEventListener('click', doSearch);
    input.addEventListener('keydown', (e: Event) => {
      if ((e as KeyboardEvent).key === 'Enter') doSearch();
    });
  }

  private async runComparison(): Promise<void> {
    if (!this.item || this.compareLoading || this.selectedCompareUrls.size === 0) return;

    const plainText = this.articleContent?.plainText || this.articleContent?.content || '';
    if (!plainText || plainText.length < 20) {
      this.compareResult = { summary: '请先加载当前文章正文内容再进行对比。' };
      this.renderBody();
      return;
    }

    const compareItems = (this.relatedPolicies?.related || [])
      .filter(it => this.selectedCompareUrls.has(it.url))
      .slice(0, 3)
      .map(it => ({ title: it.title, url: it.url, date: it.date }));

    this.compareLoading = true;
    this.renderBody();

    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/policy/compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: this.item.title,
          content: plainText,
          url: this.item.url,
          compare_items: compareItems,
        }),
        signal: this.abortController?.signal,
        timeout: 120_000, // 120s — compare involves article fetching + AI analysis
      } as RequestInit & { timeout?: number });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.compareResult = await res.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.compareResult = { summary: '对比分析失败，请稍后重试。' };
    } finally {
      this.compareLoading = false;
      this.renderBody();
    }
  }

  private renderCompareTab(): void {
    // Show comparison result if available
    if (this.compareResult && !this.compareLoading) {
      this.renderCompareResult();
      return;
    }

    if (this.compareLoading) {
      this.bodyEl.innerHTML = `
        <div style="text-align:center;padding:40px 0">
          <div class="pol-typing-dots" style="justify-content:center">
            <div class="pol-typing-dot"></div>
            <div class="pol-typing-dot"></div>
            <div class="pol-typing-dot"></div>
          </div>
          <div style="color:var(--text-dim);font-size:12px;margin-top:12px">AI正在对比分析政策差异...</div>
        </div>`;
      return;
    }

    if (this.relatedLoading) {
      this.bodyEl.innerHTML = `<div class="policy-loading"><i class="bi bi-arrow-repeat"></i>搜索相关政策中...</div>`;
      return;
    }

    // Build manual search box (always shown)
    const searchBoxHtml = `
      <div style="display:flex;gap:6px;margin-bottom:10px">
        <input id="polCompareSearch" type="text" placeholder="输入关键词搜索相关政策..."
          style="flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
          border-radius:6px;padding:6px 10px;color:var(--text-main);font-size:12px;outline:none"
          value="" />
        <button id="polCompareSearchBtn"
          style="background:#e8a838;color:#000;border:none;border-radius:6px;padding:6px 12px;
          font-size:12px;cursor:pointer;white-space:nowrap">搜索</button>
      </div>`;

    if (!this.relatedPolicies || this.relatedPolicies.total === 0) {
      const rp = this.relatedPolicies;
      const kwsHtml = rp?.keywords?.length
        ? `<div style="color:#888;font-size:11px;margin-bottom:8px">已搜索关键词: ${rp.keywords.map(k => `<span style="color:#e8a838">${escapeHtml(k)}</span>`).join(' · ')}</div>`
        : '';

      // AI feedback when available
      let aiFeedbackHtml = '';
      if (rp?.ai_feedback) {
        const suggestedKws = (rp.ai_suggested_keywords || []) as string[];
        const suggestChips = suggestedKws.map(k =>
          `<span class="pol-ai-suggest-chip" data-kw="${escapeHtml(k)}" style="display:inline-block;background:rgba(232,168,56,0.15);color:#e8a838;padding:2px 8px;border-radius:10px;margin:2px 3px;font-size:11px;cursor:pointer;border:1px solid rgba(232,168,56,0.3)">${escapeHtml(k)}</span>`
        ).join('');
        aiFeedbackHtml = `
          <div style="background:rgba(232,168,56,0.06);border:1px solid rgba(232,168,56,0.15);border-radius:8px;padding:10px 12px;margin-top:12px">
            <div style="font-size:11px;color:#e8a838;margin-bottom:6px"><i class="bi bi-robot"></i> AI建议</div>
            <div style="font-size:12px;color:var(--text-main);margin-bottom:8px">${escapeHtml(rp.ai_feedback)}</div>
            ${suggestChips ? `<div style="font-size:11px;color:#888;margin-bottom:4px">点击关键词尝试搜索:</div>${suggestChips}` : ''}
          </div>`;
      }

      this.bodyEl.innerHTML = `
        <div style="padding:16px 0">
          ${searchBoxHtml}
          <div style="text-align:center;padding:20px 0">
            <i class="bi bi-search" style="font-size:24px;color:#666;display:block;margin-bottom:8px"></i>
            <div style="color:var(--text-dim);font-size:13px;margin-bottom:8px">未找到相关政策文件</div>
            ${kwsHtml}
            <div style="color:#666;font-size:11px">可尝试输入其他关键词搜索，如"货币政策""房地产"等</div>
          </div>
          ${aiFeedbackHtml}
        </div>`;
      this._attachSearchHandler();

      // Attach AI suggested keyword click handlers
      this.bodyEl.querySelectorAll('.pol-ai-suggest-chip').forEach(el => {
        el.addEventListener('click', () => {
          const kw = (el as HTMLElement).dataset.kw || '';
          if (kw) void this.searchRelated([kw]);
        });
      });
      return;
    }

    const rp = this.relatedPolicies;
    const years = Object.keys(rp.by_year).sort((a, b) => b.localeCompare(a));

    let groupsHtml = '';
    for (const year of years) {
      const items = rp.by_year[year] || [];
      const itemsHtml = items.slice(0, 10).map(it => {
        const checked = this.selectedCompareUrls.has(it.url);
        return `<div class="pol-compare-item" data-compare-url="${escapeHtml(it.url)}">
          <div class="pol-compare-check ${checked ? 'checked' : ''}">&#10003;</div>
          <div class="pol-compare-item-title">${escapeHtml(it.title)}</div>
          <div class="pol-compare-item-date">${escapeHtml(it.date || '')}</div>
        </div>`;
      }).join('');

      groupsHtml += `<div class="pol-compare-year-group">
        <div class="pol-compare-year-label">
          <span class="pol-compare-year-badge">${escapeHtml(year)}</span>
          <span style="color:#888;font-size:11px">${items.length}条相关</span>
        </div>
        ${itemsHtml}
      </div>`;
    }

    const selectedCount = this.selectedCompareUrls.size;
    const btnDisabled = selectedCount === 0 ? 'disabled' : '';
    const btnText = selectedCount > 0 ? `对比分析 (已选${selectedCount}篇)` : '请选择要对比的政策';

    this.bodyEl.innerHTML = `
      ${searchBoxHtml}
      <div style="margin-bottom:10px">
        <div style="font-size:12px;color:#888;margin-bottom:4px">
          关键词: ${rp.keywords.map(k => `<span style="color:#e8a838">${escapeHtml(k)}</span>`).join(' · ')}
        </div>
        <div style="font-size:11px;color:#666">共找到 ${rp.total} 条相关政策，选择最多3篇进行对比</div>
      </div>
      ${groupsHtml}
      <button class="pol-compare-btn" id="polCompareBtn" ${btnDisabled}>${btnText}</button>
    `;

    this._attachSearchHandler();

    // Attach click handlers for checkboxes
    this.bodyEl.querySelectorAll('.pol-compare-item').forEach(el => {
      el.addEventListener('click', () => {
        const url = (el as HTMLElement).dataset.compareUrl || '';
        if (!url) return;
        if (this.selectedCompareUrls.has(url)) {
          this.selectedCompareUrls.delete(url);
        } else if (this.selectedCompareUrls.size < 3) {
          this.selectedCompareUrls.add(url);
        }
        this.renderBody();
      });
    });

    this.bodyEl.querySelector('#polCompareBtn')?.addEventListener('click', () => {
      void this.runComparison();
    });
  }

  private renderCompareResult(): void {
    const r = this.compareResult!;
    const parts: string[] = [];

    // Back button
    parts.push(`<div style="margin-bottom:12px">
      <button class="pol-compare-btn" id="polCompareBack" style="background:rgba(255,255,255,0.04);color:#aaa;border-color:rgba(255,255,255,0.1);padding:6px 12px;width:auto;display:inline-block;font-size:12px">
        <i class="bi bi-arrow-left"></i> 返回选择
      </button>
    </div>`);

    // Key takeaway
    if (r.keyTakeaway) {
      parts.push(`<div class="pol-compare-section" style="border-color:rgba(232,168,56,0.2);background:rgba(232,168,56,0.04)">
        <div class="pol-compare-section-title" style="color:#e8a838">核心变化</div>
        <div class="pol-compare-section-text" style="font-weight:600">${escapeHtml(r.keyTakeaway)}</div>
      </div>`);
    }

    // Summary
    if (r.summary) {
      parts.push(`<div class="pol-compare-section">
        <div class="pol-compare-section-title">对比概述</div>
        <div class="pol-compare-section-text">${escapeHtml(r.summary)}</div>
      </div>`);
    }

    // Dimension comparison cards
    if (r.dimensions && r.dimensions.length > 0) {
      const dimCards = r.dimensions.map(d => {
        const changeClass = this.getChangeClass(d.change);
        return `<div class="pol-compare-dim-card">
          <div class="pol-compare-dim-name">
            ${escapeHtml(d.name)}
            <span class="pol-compare-change-badge ${changeClass}">${escapeHtml(d.change)}</span>
          </div>
          <div class="pol-compare-dim-row">
            <span class="pol-compare-dim-label" style="color:#ef5350">当前:</span>
            <span class="pol-compare-dim-val">${escapeHtml(d.current)}</span>
          </div>
          <div class="pol-compare-dim-row">
            <span class="pol-compare-dim-label" style="color:#64B5F6">此前:</span>
            <span class="pol-compare-dim-val">${escapeHtml(d.previous)}</span>
          </div>
          ${d.analysis ? `<div class="pol-compare-analysis">${escapeHtml(d.analysis)}</div>` : ''}
        </div>`;
      }).join('');
      parts.push(dimCards);
    }

    // New additions & removals
    if (r.newAdditions && r.newAdditions.length > 0) {
      const items = r.newAdditions.map(a => `<li>${escapeHtml(a)}</li>`).join('');
      parts.push(`<div class="pol-compare-section">
        <div class="pol-compare-section-title" style="color:#ef5350">新增内容</div>
        <ul class="pol-compare-list additions">${items}</ul>
      </div>`);
    }
    if (r.removals && r.removals.length > 0) {
      const items = r.removals.map(a => `<li>${escapeHtml(a)}</li>`).join('');
      parts.push(`<div class="pol-compare-section">
        <div class="pol-compare-section-title" style="color:#43a047">不再提及</div>
        <ul class="pol-compare-list removals">${items}</ul>
      </div>`);
    }

    // Tone shift
    if (r.toneShift) {
      parts.push(`<div class="pol-compare-section">
        <div class="pol-compare-section-title">基调变化</div>
        <div class="pol-compare-section-text">${escapeHtml(r.toneShift)}</div>
      </div>`);
    }

    // Market implication
    if (r.marketImplication) {
      parts.push(`<div class="pol-compare-section">
        <div class="pol-compare-section-title">市场影响</div>
        <div class="pol-compare-section-text">${escapeHtml(r.marketImplication)}</div>
      </div>`);
    }

    this.bodyEl.innerHTML = parts.join('');

    // Back button handler
    this.bodyEl.querySelector('#polCompareBack')?.addEventListener('click', () => {
      this.compareResult = null;
      this.renderBody();
    });
  }

  private getChangeClass(change: string): string {
    if (['新增', '加强'].includes(change)) return 'pol-change-add';
    if (['删除', '减弱'].includes(change)) return 'pol-change-remove';
    if (['不变'].includes(change)) return 'pol-change-same';
    return 'pol-change-adjust';
  }

  public destroy(): void {
    this.close();
    this.overlay.remove();
  }
}

// Singleton instance — created lazily
let instance: PolicyDrawer | null = null;

function getInstance(): PolicyDrawer {
  if (!instance) instance = new PolicyDrawer();
  return instance;
}

export function openPolicyDrawer(item: PolicyItem): void {
  getInstance().open(item);
}

export function closePolicyDrawer(): void {
  if (instance) instance.close();
}

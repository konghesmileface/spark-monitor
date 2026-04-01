import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { ResearchDrawer } from './ResearchDrawer';
import { cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';
const POLL_INTERVAL = 3_600_000; // 3600s = 1h

interface ResearchReport {
  id: string;
  title: string;
  institution: string;
  rating: string;
  industry: string;
  date: string;
  summary?: string;
  stockCode?: string;
  stockName?: string;
  targetPrice?: number;
}

interface CnResearchData {
  reports: ResearchReport[];
  industries: string[];
  timestamp: string;
}

interface DbReport {
  id: string;
  title: string;
  institution: string;
  date: string;
  summary?: string;
  content?: string;  // Full report HTML from macro_array
  link?: string;
  industry?: string;
  stocks?: string;
  emotion?: string | null;
  type?: string;      // '04'=研报, '05'=自媒体
  typeLabel?: string;  // 研报/自媒体
}

interface DbReportSource {
  name: string;
  count: number;
}

interface DbResearchData {
  reports: DbReport[];
  total: number;
  page: number;
  pageSize: number;
  sources: DbReportSource[];
  timestamp: string;
}

function ratingBadgeClass(rating: string): string {
  switch (rating) {
    case '买入': return 'cn-rating-buy';
    case '增持': return 'cn-rating-overweight';
    case '中性': return 'cn-rating-neutral';
    case '减持': return 'cn-rating-underweight';
    case '卖出': return 'cn-rating-sell';
    default: return 'cn-rating-neutral';
  }
}

const STYLE = `
<style>
@layer base {
.cn-research-container {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.cn-research-tabs {
  display: flex;
  gap: 0;
  margin-bottom: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.cn-research-tab {
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-dim);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
  background: none;
  border-top: none;
  border-left: none;
  border-right: none;
}
.cn-research-tab:hover {
  color: var(--text);
}
.cn-research-tab.active {
  color: #e8a838;
  border-bottom-color: #e8a838;
}
.cn-research-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.cn-research-upload-btn {
  padding: 4px 12px;
  font-size: 11px;
  border-radius: 6px;
  background: rgba(232,168,56,0.15);
  color: #e8a838;
  border: 1px solid rgba(232,168,56,0.3);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  flex-shrink: 0;
}
.cn-research-upload-btn:hover {
  background: rgba(232,168,56,0.25);
}
.cn-research-upload-btn.loading {
  opacity: 0.6;
  pointer-events: none;
}
.cn-upload-result {
  padding: 10px;
  margin-bottom: 8px;
  background: rgba(232,168,56,0.08);
  border-radius: 8px;
  border-left: 3px solid #e8a838;
}
.cn-upload-result-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 6px;
}
.cn-upload-result-section {
  margin-bottom: 6px;
}
.cn-upload-result-label {
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 2px;
}
.cn-upload-result-text {
  font-size: 12px;
  color: var(--text);
  line-height: 1.5;
}
.cn-upload-result-views {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-left: 8px;
}
.cn-upload-result-views li {
  font-size: 12px;
  color: var(--text);
  line-height: 1.4;
  list-style: disc;
}
.cn-upload-result-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.cn-upload-tag {
  padding: 1px 8px;
  font-size: 10px;
  border-radius: 4px;
  background: rgba(255,255,255,0.06);
  color: var(--text-dim);
}
.cn-research-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 0 10px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  margin-bottom: 8px;
}
.cn-filter-chip {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 12px;
  background: rgba(255,255,255,0.05);
  color: var(--text-dim);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.cn-filter-chip:hover {
  background: rgba(255,255,255,0.1);
  color: var(--text);
}
.cn-filter-chip.active {
  background: rgba(229,57,53,0.15);
  color: #e53935;
  border-color: rgba(229,57,53,0.3);
}
.cn-report-card {
  padding: 10px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.cn-report-card:last-child {
  border-bottom: none;
}
.cn-report-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.cn-report-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  flex: 1;
  line-height: 1.4;
  cursor: pointer;
}
.cn-report-title:hover {
  color: #e53935;
  text-decoration: underline;
}
.cn-report-title .bi {
  font-size: 11px;
  color: var(--text-dim);
  transition: transform 0.2s;
}
.cn-report-title.expanded .bi {
  transform: rotate(180deg);
}
.cn-report-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-dim);
}
.cn-report-institution {
  font-weight: 500;
  color: var(--text);
  opacity: 0.8;
}
.cn-report-date {
  font-variant-numeric: tabular-nums;
}
.cn-report-stock {
  color: #ef5350;
  font-weight: 500;
}
.cn-rating-badge {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}
.cn-rating-buy {
  background: rgba(229,57,53,0.15);
  color: #e53935;
}
.cn-rating-overweight {
  background: rgba(255,152,0,0.15);
  color: #ff9800;
}
.cn-rating-neutral {
  background: rgba(158,158,158,0.15);
  color: #9e9e9e;
}
.cn-rating-underweight {
  background: rgba(33,150,243,0.15);
  color: #2196f3;
}
.cn-rating-sell {
  background: rgba(67,160,71,0.15);
  color: #43a047;
}
.cn-report-summary-toggle {
  font-size: 11px;
  color: var(--text-dim);
  cursor: pointer;
  margin-top: 4px;
  display: inline-block;
}
.cn-report-summary-toggle:hover {
  color: var(--text);
}
.cn-report-summary {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.5;
  margin-top: 6px;
  padding: 8px 10px;
  background: rgba(255,255,255,0.02);
  border-radius: 6px;
  border-left: 2px solid rgba(255,255,255,0.08);
  display: none;
}
.cn-report-summary.expanded {
  display: block;
}
.cn-upload-report-title:hover span {
  color: #e8a838;
  text-decoration: underline;
}
.cn-upload-delete-btn {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 2px 4px;
  font-size: 13px;
  opacity: 0.5;
  transition: opacity 0.15s, color 0.15s;
}
.cn-upload-delete-btn:hover {
  opacity: 1;
  color: #e53935;
}
.cn-confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: cn-fade-in 0.15s ease;
}
@keyframes cn-fade-in { from { opacity: 0 } to { opacity: 1 } }
.cn-confirm-box {
  background: #1e1e24;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  padding: 20px 24px;
  max-width: 360px;
  width: 90%;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
.cn-confirm-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}
.cn-confirm-msg {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.5;
  margin-bottom: 16px;
}
.cn-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.cn-confirm-actions button {
  padding: 6px 16px;
  font-size: 12px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid rgba(255,255,255,0.1);
  transition: all 0.15s;
}
.cn-confirm-cancel {
  background: rgba(255,255,255,0.06);
  color: var(--text-dim);
}
.cn-confirm-cancel:hover {
  background: rgba(255,255,255,0.12);
  color: var(--text);
}
.cn-confirm-danger {
  background: rgba(229,57,53,0.2);
  color: #e53935;
  border-color: rgba(229,57,53,0.3);
}
.cn-confirm-danger:hover {
  background: rgba(229,57,53,0.35);
}
.cn-toast {
  position: fixed;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 20px;
  border-radius: 8px;
  font-size: 12px;
  z-index: 10000;
  animation: cn-fade-in 0.15s ease;
  pointer-events: none;
}
.cn-toast-error {
  background: rgba(229,57,53,0.9);
  color: #fff;
}
.cn-toast-success {
  background: rgba(67,160,71,0.9);
  color: #fff;
}
.cn-no-reports {
  text-align: center;
  padding: 24px;
  color: var(--text-dim);
  font-size: 13px;
}
/* PDF list styles */
.cn-pdf-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cn-pdf-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: rgba(255,255,255,0.02);
  border-radius: 6px;
  border-left: 2px solid rgba(232,168,56,0.3);
  gap: 8px;
  transition: background 0.15s;
}
.cn-pdf-item:hover {
  background: rgba(255,255,255,0.05);
}
.cn-pdf-info {
  flex: 1;
  min-width: 0;
}
.cn-pdf-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cn-pdf-date {
  font-size: 10px;
  color: var(--text-dim);
  margin-top: 2px;
}
.cn-pdf-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.cn-pdf-btn {
  padding: 3px 10px;
  font-size: 10px;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid;
  transition: all 0.15s;
  white-space: nowrap;
}
.cn-pdf-btn-view {
  background: rgba(255,255,255,0.05);
  color: var(--text-dim);
  border-color: rgba(255,255,255,0.1);
}
.cn-pdf-btn-view:hover {
  background: rgba(255,255,255,0.1);
  color: var(--text);
}
.cn-pdf-btn-analyze {
  background: rgba(232,168,56,0.1);
  color: #e8a838;
  border-color: rgba(232,168,56,0.25);
}
.cn-pdf-btn-analyze:hover {
  background: rgba(232,168,56,0.2);
}
.cn-pdf-btn-analyze.loading {
  opacity: 0.5;
  pointer-events: none;
}
.cn-pdf-loading {
  text-align: center;
  padding: 16px;
  color: var(--text-dim);
  font-size: 12px;
}
/* Database research tab */
.cn-db-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.cn-db-search {
  flex: 1;
  padding: 5px 10px;
  font-size: 12px;
  border-radius: 6px;
  background: rgba(255,255,255,0.05);
  color: var(--text);
  border: 1px solid rgba(255,255,255,0.1);
  outline: none;
}
.cn-db-search:focus {
  border-color: rgba(229,57,53,0.4);
  background: rgba(255,255,255,0.08);
}
.cn-db-search::placeholder {
  color: var(--text-dim);
  opacity: 0.6;
}
.cn-db-total {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  flex-shrink: 0;
}
.cn-db-source-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.cn-db-source-chip {
  padding: 2px 8px;
  font-size: 10px;
  border-radius: 10px;
  background: rgba(255,255,255,0.05);
  color: var(--text-dim);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.cn-db-source-chip:hover {
  background: rgba(255,255,255,0.1);
  color: var(--text);
}
.cn-db-source-chip.active {
  background: rgba(229,57,53,0.15);
  color: #e53935;
  border-color: rgba(229,57,53,0.3);
}
.cn-db-doctype-chip {
  padding: 3px 12px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 12px;
  background: rgba(255,255,255,0.05);
  color: var(--text-dim);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.cn-db-doctype-chip:hover {
  background: rgba(255,255,255,0.1);
  color: var(--text);
}
.cn-db-doctype-chip.active {
  background: rgba(232,168,56,0.15);
  color: #e8a838;
  border-color: rgba(232,168,56,0.3);
}
.cn-db-report-card {
  padding: 10px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.cn-db-report-card:last-child {
  border-bottom: none;
}
.cn-db-report-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.4;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.cn-db-report-title:hover {
  color: #e53935;
  text-decoration: underline;
}
.cn-db-report-title .bi {
  font-size: 11px;
  color: var(--text-dim);
  flex-shrink: 0;
  margin-top: 3px;
  transition: transform 0.2s;
}
.cn-db-report-title.expanded .bi {
  transform: rotate(180deg);
}
.cn-pdf-view-link {
  font-size: 11px; color: #e8a838; text-decoration: none; white-space: nowrap;
  padding: 2px 8px; border-radius: 4px; border: 1px solid rgba(232,168,56,0.3);
  background: rgba(232,168,56,0.1); flex-shrink: 0;
}
.cn-pdf-view-link:hover { background: rgba(232,168,56,0.2); }
.cn-db-report-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #e8a838;
  text-decoration: none;
  margin-top: 6px;
  padding: 3px 8px;
  border-radius: 4px;
  background: rgba(232,168,56,0.08);
  border: 1px solid rgba(232,168,56,0.2);
  transition: all 0.15s;
}
.cn-db-report-link:hover {
  background: rgba(232,168,56,0.15);
  color: #d4922e;
}
.cn-db-report-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-dim);
  flex-wrap: wrap;
}
.cn-db-report-source {
  font-weight: 500;
  color: #e8a838;
}
.cn-db-report-industry {
  color: var(--text-dim);
  font-size: 10px;
  padding: 1px 6px;
  background: rgba(255,255,255,0.05);
  border-radius: 3px;
}
.cn-db-report-stocks {
  color: #ef5350;
  font-weight: 500;
}
.cn-db-report-emotion {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 500;
}
.cn-db-emotion-pos {
  background: rgba(229,57,53,0.12);
  color: #e53935;
}
.cn-db-emotion-neg {
  background: rgba(67,160,71,0.12);
  color: #43a047;
}
.cn-db-emotion-neu {
  background: rgba(158,158,158,0.12);
  color: #9e9e9e;
}
.cn-db-report-summary {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.6;
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.04);
  max-height: 400px;
  overflow-y: auto;
}
.cn-db-report-summary.expanded {
  display: block;
}
/* Content area for full report HTML */
.cn-db-report-content {
  font-size: 12px;
  color: var(--text);
  line-height: 1.7;
  opacity: 0.9;
  word-break: break-word;
}
.cn-db-report-content p {
  margin: 6px 0;
}
.cn-db-report-content a {
  color: #e8a838;
  text-decoration: none;
}
.cn-db-report-content a:hover {
  text-decoration: underline;
}
.cn-db-report-content ul, .cn-db-report-content ol {
  padding-left: 18px;
  margin: 4px 0;
}
.cn-db-report-content li {
  margin: 2px 0;
}
.cn-db-report-content img {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  margin: 4px 0;
}
.cn-db-report-content strong {
  color: var(--text);
  font-weight: 600;
}
.cn-db-report-summary::-webkit-scrollbar {
  width: 3px;
}
.cn-db-report-summary::-webkit-scrollbar-thumb {
  background: rgba(232,168,56,0.2);
  border-radius: 2px;
}
.cn-db-report-summary::-webkit-scrollbar-track {
  background: transparent;
}
.cn-db-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid rgba(255,255,255,0.06);
}
.cn-db-pager-btn {
  padding: 4px 12px;
  font-size: 11px;
  border-radius: 4px;
  background: rgba(255,255,255,0.05);
  color: var(--text-dim);
  border: 1px solid rgba(255,255,255,0.1);
  cursor: pointer;
  transition: all 0.15s;
}
.cn-db-pager-btn:hover:not(:disabled) {
  background: rgba(255,255,255,0.1);
  color: var(--text);
}
.cn-db-pager-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.cn-db-pager-info {
  font-size: 11px;
  color: var(--text-dim);
}
} /* @layer base */
</style>
`;

interface UploadAnalysis {
  title?: string;
  institution?: string;
  date?: string;
  reportType?: string;
  coreViews?: string[];
  rating?: string;
  targetPrice?: string;
  keyData?: string[];
  industryChain?: string;
  competitiveAnalysis?: string;
  catalysts?: string[];
  riskFactors?: string[];
  relatedStocks?: string[];
  valuation?: string;
  summary?: string;
  actionSuggestion?: string;
}

interface UploadedReport {
  fileId: string;
  filename: string;
  uploadTime: string | null;
  analysis: UploadAnalysis | null;
  plainText?: string;
}

export class CnResearchPanel extends Panel {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeTab: 'db' | 'eastmoney' | 'uploads' = 'db';
  private data: CnResearchData | null = null;
  private dbData: DbResearchData | null = null;
  private dbPage = 1;
  private dbKeyword = '';
  private dbSourceFilter = '';
  private dbDocType: 'all' | '04' | '05' = 'all';
  private activeFilter = '全部';
  private uploadResult: UploadAnalysis | null = null;
  private selectedUploadId: string | null = null;
  private uploading = false;
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  private uploadedReports: UploadedReport[] = [];
  private drawer: ResearchDrawer;
  private lastFetchTime = 0;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super({ id: 'cn-research', title: '券商研报 <span class="spark-subtitle">RESEARCH</span>' });
    this.drawer = new ResearchDrawer();
    this.content.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest('.cn-research-tab') as HTMLElement | null;
      if (tab?.dataset.tab) {
        this.activeTab = tab.dataset.tab as 'db' | 'eastmoney' | 'uploads';
        if (this.activeTab === 'eastmoney' && !this.data) {
          void this.fetchEastmoney();
        }
        if (this.activeTab === 'uploads') {
          void this.fetchUploadedReports();
        }
        this.renderPanel();
        return;
      }

      const chip = (e.target as HTMLElement).closest('.cn-db-source-chip') as HTMLElement | null;
      if (chip?.dataset.source !== undefined) {
        this.dbSourceFilter = this.dbSourceFilter === chip.dataset.source ? '' : chip.dataset.source;
        this.dbKeyword = this.dbSourceFilter;
        this.dbPage = 1;
        void this.fetchDbReports();
        return;
      }

      // Doc type filter chips (全部/研报/自媒体)
      const dtChip = (e.target as HTMLElement).closest('.cn-db-doctype-chip') as HTMLElement | null;
      if (dtChip?.dataset.doctype) {
        this.dbDocType = dtChip.dataset.doctype as 'all' | '04' | '05';
        this.dbPage = 1;
        void this.fetchDbReports();
        return;
      }

      const filterChip = (e.target as HTMLElement).closest('.cn-filter-chip') as HTMLElement | null;
      if (filterChip?.dataset.industry) {
        this.activeFilter = filterChip.dataset.industry;
        this.renderPanel();
        return;
      }

      // DB report title click → open drawer
      const dbTitle = (e.target as HTMLElement).closest('.cn-db-report-title[data-report-id]') as HTMLElement | null;
      if (dbTitle?.dataset.reportId) {
        const id = dbTitle.dataset.reportId;
        const report = this.dbData?.reports.find(r => r.id === id);
        if (report) {
          this.drawer.open(report);
        }
        return;
      }

      // Eastmoney report title click → open drawer (same as DB reports)
      const emTitle = (e.target as HTMLElement).closest('.cn-report-title[data-report-id]') as HTMLElement | null;
      if (emTitle?.dataset.reportId) {
        const id = emTitle.dataset.reportId;
        const report = this.data?.reports?.find(r => r.id === id);
        if (report) {
          // Convert eastmoney ResearchReport to DrawerReport format
          const drawerReport = {
            id: report.id,
            title: report.title,
            institution: report.institution,
            date: report.date,
            summary: report.summary || '',
            industry: report.industry,
            type: '04' as string,
            typeLabel: '研报',
          };
          this.drawer.open(drawerReport);
        }
        return;
      }

      // Delete uploaded report
      const deleteBtn = (e.target as HTMLElement).closest('.cn-upload-delete-btn[data-delete-id]') as HTMLElement | null;
      if (deleteBtn?.dataset.deleteId) {
        e.stopPropagation();
        void this.deleteUploadedReport(deleteBtn.dataset.deleteId);
        return;
      }

      // Uploaded report title click → open drawer
      const uploadTitle = (e.target as HTMLElement).closest('.cn-upload-report-title[data-upload-id]') as HTMLElement | null;
      if (uploadTitle?.dataset.uploadId) {
        const fid = uploadTitle.dataset.uploadId;
        const report = this.uploadedReports.find(r => r.fileId === fid);
        if (report) {
          const a = report.analysis;
          const dateStr = report.uploadTime ? new Date(report.uploadTime).toLocaleDateString('zh-CN') : '';
          // Show selected report's summary card in uploads tab
          this.selectedUploadId = report.fileId;
          this.renderPanel();
          this.drawer.open({
            id: `upload_${report.fileId}`,
            title: a?.title || report.filename,
            institution: a?.institution || 'PDF上传',
            date: dateStr,
            summary: a?.summary || '',
            content: report.plainText || '',
            // No link — PDF endpoint requires auth which new tabs can't provide
            type: '04' as string,
            typeLabel: 'PDF研报',
          });
        }
        return;
      }

      const uploadBtn = (e.target as HTMLElement).closest('.cn-research-upload-btn') as HTMLElement | null;
      if (uploadBtn && !this.uploading) {
        this.triggerUpload();
        return;
      }

      const prevBtn = (e.target as HTMLElement).closest('.cn-db-pager-prev') as HTMLElement | null;
      if (prevBtn && this.dbPage > 1) {
        this.dbPage--;
        void this.fetchDbReports();
        return;
      }

      const nextBtn = (e.target as HTMLElement).closest('.cn-db-pager-next') as HTMLElement | null;
      if (nextBtn && this.dbData && this.dbPage * this.dbData.pageSize < this.dbData.total) {
        this.dbPage++;
        void this.fetchDbReports();
        return;
      }
    });

    this.content.addEventListener('input', (e) => {
      const searchInput = (e.target as HTMLElement).closest('.cn-db-search') as HTMLInputElement | null;
      if (searchInput) {
        if (this.searchDebounce) clearTimeout(this.searchDebounce);
        this.searchDebounce = setTimeout(() => {
          this.dbKeyword = searchInput.value.trim();
          this.dbSourceFilter = '';
          this.dbPage = 1;
          void this.fetchDbReports();
        }, 500);
      }
    });

    void this.fetchDbReports();
    this.timer = setInterval(() => void this.fetchDbReports(), POLL_INTERVAL);
    this.freshnessTimer = setInterval(() => this.updateFreshness(), 30_000);
  }

  private triggerUpload(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      this.uploading = true;
      this.renderPanel();

      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/research/upload`, {
          method: 'POST',
          body: formData,
          signal: this.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.success && data.analysis) {
          this.uploadResult = data.analysis;
          // Auto-select the newly uploaded report when list refreshes
          if (data.fileId) this.selectedUploadId = data.fileId;
        }
      } catch (err) {
        if (!this.isAbortError(err)) {
          this.uploadResult = { title: '上传失败', summary: '请稍后重试' };
          this.selectedUploadId = null;
        }
      } finally {
        this.uploading = false;
        // Refresh uploads list after upload
        void this.fetchUploadedReports();
        this.renderPanel();
      }
    };
    input.click();
  }

  private async fetchUploadedReports(): Promise<void> {
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/research/uploads`, { signal: this.signal });
      if (!res.ok) return;
      const data = await res.json();
      this.uploadedReports = data.uploads || [];
      this.renderPanel();
    } catch (err) {
      if (this.isAbortError(err)) return;
    }
  }

  private showToast(msg: string, type: 'success' | 'error' = 'success'): void {
    const toast = document.createElement('div');
    toast.className = `cn-toast cn-toast-${type}`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  private showConfirm(title: string, msg: string): Promise<boolean> {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'cn-confirm-overlay';
      overlay.innerHTML = `
        <div class="cn-confirm-box">
          <div class="cn-confirm-title">${escapeHtml(title)}</div>
          <div class="cn-confirm-msg">${escapeHtml(msg)}</div>
          <div class="cn-confirm-actions">
            <button class="cn-confirm-cancel">取消</button>
            <button class="cn-confirm-danger">删除</button>
          </div>
        </div>`;
      const cleanup = (val: boolean) => { overlay.remove(); resolve(val); };
      overlay.querySelector('.cn-confirm-cancel')!.addEventListener('click', () => cleanup(false));
      overlay.querySelector('.cn-confirm-danger')!.addEventListener('click', () => cleanup(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
      document.body.appendChild(overlay);
    });
  }

  private async deleteUploadedReport(fileId: string): Promise<void> {
    const report = this.uploadedReports.find(r => r.fileId === fileId);
    const name = report?.analysis?.title || report?.filename || fileId;
    const confirmed = await this.showConfirm('删除研报', `确定删除「${name}」？删除后无法恢复。`);
    if (!confirmed) return;

    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/research/uploads/${encodeURIComponent(fileId)}`, {
        method: 'DELETE',
        signal: this.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (this.selectedUploadId === fileId) {
        this.selectedUploadId = null;
        this.uploadResult = null;
      }
      this.showToast('已删除');
      void this.fetchUploadedReports();
    } catch (err) {
      if (!this.isAbortError(err)) {
        this.showToast('删除失败，请重试', 'error');
      }
    }
  }

  public async fetchData(): Promise<void> {
    return this.fetchDbReports();
  }

  private async fetchEastmoney(): Promise<void> {
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/research`, { signal: this.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json();
      this.renderPanel();
    } catch (err) {
      if (this.isAbortError(err)) return;
    }
  }

  private async fetchDbReports(): Promise<void> {
    if (!this.dbData) this.showLoading('加载研报数据...');
    try {
      const params = new URLSearchParams({
        page: String(this.dbPage),
        pageSize: '30',
        type: this.dbDocType,
      });
      if (this.dbKeyword) params.set('keyword', this.dbKeyword);
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/research/db?${params}`, { signal: this.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.dbData = await res.json();
      this.lastFetchTime = Date.now();
      if ((this.dbData as any)?._stale) {
        this.setDataBadge('cached', '数据可能过时');
      } else {
        this.updateFreshness();
      }
      this.renderPanel();
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.showError('研报数据加载失败');
    }
  }

  private renderPanel(): void {
    const tabsHtml = `
      <div class="cn-research-tabs">
        <button class="cn-research-tab ${this.activeTab === 'db' ? 'active' : ''}" data-tab="db">研报库</button>
        <button class="cn-research-tab ${this.activeTab === 'eastmoney' ? 'active' : ''}" data-tab="eastmoney">东财研报</button>
        <button class="cn-research-tab ${this.activeTab === 'uploads' ? 'active' : ''}" data-tab="uploads">我的研报</button>
      </div>
    `;

    if (this.activeTab === 'eastmoney') {
      this.renderEastmoneyTab(tabsHtml);
    } else if (this.activeTab === 'uploads') {
      this.renderUploadsTab(tabsHtml);
    } else {
      this.renderDbTab(tabsHtml);
    }
  }

  private renderDbTab(tabsHtml: string): void {
    if (!this.dbData) {
      this.setContent(`${STYLE}
        <div class="cn-research-container">
          ${tabsHtml}
          <div class="cn-pdf-loading">加载研报库数据...</div>
        </div>
      `);
      return;
    }

    const d = this.dbData;

    // Doc type filter chips
    const docTypeChipsHtml = `
      <div class="cn-db-source-chips" style="margin-bottom:4px">
        <button class="cn-db-doctype-chip ${this.dbDocType === 'all' ? 'active' : ''}" data-doctype="all">全部</button>
        <button class="cn-db-doctype-chip ${this.dbDocType === '04' ? 'active' : ''}" data-doctype="04">研报</button>
        <button class="cn-db-doctype-chip ${this.dbDocType === '05' ? 'active' : ''}" data-doctype="05">自媒体</button>
      </div>
    `;

    // Source filter chips (top 8 sources)
    const topSources = (d.sources || []).slice(0, 8);
    const sourceChipsHtml = topSources.length ? `
      <div class="cn-db-source-chips">
        ${topSources.map(s => `
          <button class="cn-db-source-chip ${this.dbSourceFilter === s.name ? 'active' : ''}"
                  data-source="${escapeHtml(s.name)}">${escapeHtml(s.name)} (${s.count})</button>
        `).join('')}
      </div>
    ` : '';

    // Search + total
    const toolbarHtml = `
      <div class="cn-db-toolbar">
        <input class="cn-db-search" type="text" placeholder="搜索研报标题、机构、摘要..."
               value="${escapeHtml(this.dbSourceFilter ? '' : this.dbKeyword)}">
        <span class="cn-db-total">共 ${d.total} 篇</span>
      </div>
    `;

    const reports = d.reports || [];
    if (reports.length === 0) {
      this.setContent(`${STYLE}
        <div class="cn-research-container">
          ${tabsHtml}
          ${docTypeChipsHtml}
          ${toolbarHtml}
          ${sourceChipsHtml}
          <div class="cn-no-reports">暂无匹配研报</div>
        </div>
      `);
      return;
    }

    const reportsHtml = reports.map(r => {
      const industryTag = r.industry ? `<span class="cn-db-report-industry">${escapeHtml(r.industry)}</span>` : '';
      const stocksTag = r.stocks ? `<span class="cn-db-report-stocks">${escapeHtml(r.stocks)}</span>` : '';

      let emotionTag = '';
      if (r.emotion) {
        const cls = r.emotion === '负面' ? 'cn-db-emotion-neg' : r.emotion === '正面' ? 'cn-db-emotion-pos' : 'cn-db-emotion-neu';
        emotionTag = `<span class="cn-db-report-emotion ${cls}">${escapeHtml(r.emotion)}</span>`;
      }

      // Type badge (研报 vs 自媒体)
      const isMedia = r.type === '05';
      const typeIcon = isMedia ? 'bi-link-45deg' : 'bi-file-text';
      const typeBadge = r.typeLabel && this.dbDocType === 'all'
        ? `<span class="cn-db-report-industry" style="${isMedia ? 'background:rgba(232,168,56,0.12);color:#e8a838' : ''}">${escapeHtml(r.typeLabel)}</span>`
        : '';

      const summarySnippet = r.summary && r.summary !== r.title
        ? `<div style="font-size:11px;color:var(--text-dim);margin-top:4px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.summary.slice(0, 80))}${r.summary.length > 80 ? '...' : ''}</div>`
        : '';

      return `
        <div class="cn-db-report-card">
          <div class="cn-db-report-title" data-report-id="${escapeHtml(r.id)}"><i class="bi ${typeIcon}"></i><span>${escapeHtml(r.title)}</span></div>
          <div class="cn-db-report-meta">
            <span class="cn-db-report-source">${escapeHtml(r.institution)}</span>
            ${typeBadge}
            ${industryTag}
            ${stocksTag}
            ${emotionTag}
            <span class="cn-report-date">${escapeHtml(r.date)}</span>
          </div>
          ${summarySnippet}
        </div>
      `;
    }).join('');

    // Pager
    const totalPages = Math.ceil(d.total / d.pageSize);
    const pagerHtml = totalPages > 1 ? `
      <div class="cn-db-pager">
        <button class="cn-db-pager-btn cn-db-pager-prev" ${this.dbPage <= 1 ? 'disabled' : ''}>上一页</button>
        <span class="cn-db-pager-info">${this.dbPage} / ${totalPages}</span>
        <button class="cn-db-pager-btn cn-db-pager-next" ${this.dbPage >= totalPages ? 'disabled' : ''}>下一页</button>
      </div>
    ` : '';

    this.setContent(`${STYLE}
      <div class="cn-research-container">
        ${tabsHtml}
        ${docTypeChipsHtml}
        ${toolbarHtml}
        ${sourceChipsHtml}
        ${reportsHtml}
        ${pagerHtml}
      </div>
    `);
  }

  private renderUploadsTab(tabsHtml: string): void {
    const uploadBtnText = this.uploading ? '分析中...' : '上传PDF分析';
    const uploadBtnClass = this.uploading ? 'cn-research-upload-btn loading' : 'cn-research-upload-btn';

    // Summary card: show selected report's analysis, or fallback to latest upload result
    let uploadHtml = '';
    const selectedReport = this.selectedUploadId
      ? this.uploadedReports.find(r => r.fileId === this.selectedUploadId)
      : null;
    const displayAnalysis = selectedReport?.analysis || this.uploadResult;
    if (displayAnalysis) {
      const r = displayAnalysis;
      const ratingHtml = r.rating && r.rating !== '未评级'
        ? `<span class="cn-rating-badge ${ratingBadgeClass(r.rating)}" style="margin-left:8px">${escapeHtml(r.rating)}</span>`
        : '';
      const metaLine = [r.institution, r.reportType, r.date].filter(Boolean).join(' | ');

      const coreViewsHtml = r.coreViews?.length
        ? `<div class="cn-upload-result-section"><div class="cn-upload-result-label">核心观点</div><ul style="margin:0;padding-left:16px;color:var(--text-dim);font-size:12px;line-height:1.7">${r.coreViews.map((v: string) => `<li>${escapeHtml(v)}</li>`).join('')}</ul></div>`
        : '';

      const keyDataHtml = r.keyData?.length
        ? `<div class="cn-upload-result-section"><div class="cn-upload-result-label">关键数据</div><ul style="margin:0;padding-left:16px;color:var(--text-dim);font-size:12px;line-height:1.7">${r.keyData.map((v: string) => `<li>${escapeHtml(v)}</li>`).join('')}</ul></div>`
        : '';

      const riskHtml = r.riskFactors?.length
        ? `<div class="cn-upload-result-section"><div class="cn-upload-result-label">风险因素</div><ul style="margin:0;padding-left:16px;color:#e57373;font-size:12px;line-height:1.7">${r.riskFactors.map((v: string) => `<li>${escapeHtml(v)}</li>`).join('')}</ul></div>`
        : '';

      const actionHtml = r.actionSuggestion
        ? `<div class="cn-upload-result-section"><div class="cn-upload-result-label">操作建议</div><div class="cn-upload-result-text" style="color:#e8a838">${escapeHtml(r.actionSuggestion)}</div></div>`
        : '';

      const targetHtml = r.targetPrice
        ? `<span style="margin-left:8px;font-size:11px;color:#4caf50">目标价: ${escapeHtml(r.targetPrice)}</span>`
        : '';

      uploadHtml = `<div class="cn-upload-result">
        <div class="cn-upload-result-title">${escapeHtml(r.title || '研报分析')}${ratingHtml}${targetHtml}</div>
        ${metaLine ? `<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">${escapeHtml(metaLine)}</div>` : ''}
        ${r.summary ? `<div class="cn-upload-result-section"><div class="cn-upload-result-label">摘要</div><div class="cn-upload-result-text">${escapeHtml(r.summary)}</div></div>` : ''}
        ${coreViewsHtml}
        ${keyDataHtml}
        ${riskHtml}
        ${actionHtml}
      </div>`;
    }

    const reports = this.uploadedReports;
    let reportsHtml = '';
    if (reports.length === 0) {
      reportsHtml = '<div class="cn-no-reports">暂无上传研报，点击上方按钮上传PDF</div>';
    } else {
      reportsHtml = reports.map(r => {
        const dateStr = r.uploadTime ? new Date(r.uploadTime).toLocaleDateString('zh-CN') : '';
        const a = r.analysis;
        const isSelected = r.fileId === this.selectedUploadId;
        const cardStyle = isSelected ? 'border-color:rgba(232,168,56,0.4);background:rgba(232,168,56,0.04)' : '';

        return `<div class="cn-db-report-card" style="${cardStyle}">
          <div class="cn-upload-report-title" data-upload-id="${escapeHtml(r.fileId)}" style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <i class="bi bi-file-earmark-pdf" style="color:#e8a838;flex-shrink:0"></i>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;color:var(--text)">${escapeHtml(a?.title || r.filename)}</span>
            <button class="cn-upload-delete-btn" data-delete-id="${escapeHtml(r.fileId)}" title="删除"><i class="bi bi-trash3"></i></button>
          </div>
          <div class="cn-db-report-meta">
            ${a?.institution ? `<span class="cn-db-report-source">${escapeHtml(a.institution)}</span>` : ''}
            <span class="cn-report-date">${escapeHtml(dateStr)}</span>
            ${a?.rating ? `<span class="cn-rating-badge ${ratingBadgeClass(a.rating)}">${escapeHtml(a.rating)}</span>` : ''}
          </div>
          ${a?.summary ? `<div style="font-size:11px;color:var(--text-dim);margin-top:4px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(a.summary.slice(0, 80))}${a.summary.length > 80 ? '...' : ''}</div>` : ''}
        </div>`;
      }).join('');
    }

    this.setContent(`${STYLE}
      <div class="cn-research-container">
        ${tabsHtml}
        <div class="cn-research-toolbar">
          <button class="${uploadBtnClass}">${uploadBtnText}</button>
        </div>
        ${uploadHtml}
        ${reportsHtml}
      </div>
    `);
  }

  private renderEastmoneyTab(tabsHtml: string): void {
    if (!this.data) {
      this.setContent(`${STYLE}
        <div class="cn-research-container">
          ${tabsHtml}
          <div class="cn-no-reports">加载中...</div>
        </div>
      `);
      return;
    }

    const d = this.data;
    const industries = ['全部', ...(d.industries || [])];

    const chipsHtml = industries.map(ind => `
      <button class="cn-filter-chip ${ind === this.activeFilter ? 'active' : ''}" data-industry="${escapeHtml(ind)}">${escapeHtml(ind)}</button>
    `).join('');

    const filtered = this.activeFilter === '全部'
      ? (d.reports || [])
      : (d.reports || []).filter(r => r.industry === this.activeFilter);

    if (filtered.length === 0) {
      this.setContent(`${STYLE}
        <div class="cn-research-container">
          ${tabsHtml}
          <div class="cn-research-filters">${chipsHtml}</div>
          <div class="cn-no-reports">暂无${this.activeFilter === '全部' ? '' : this.activeFilter}相关研报</div>
        </div>
      `);
      return;
    }

    const reportsHtml = filtered.map(r => {
      const stockInfo = r.stockCode && r.stockName
        ? `<span class="cn-report-stock">${escapeHtml(r.stockName)}(${escapeHtml(r.stockCode)})</span>`
        : '';

      return `
        <div class="cn-report-card">
          <div class="cn-report-header">
            <span class="cn-report-title cn-report-clickable" data-report-id="${escapeHtml(r.id)}">${escapeHtml(r.title)}</span>
            <span class="cn-rating-badge ${ratingBadgeClass(r.rating)}">${escapeHtml(r.rating)}</span>
          </div>
          <div class="cn-report-meta">
            <span class="cn-report-institution">${escapeHtml(r.institution)}</span>
            ${stockInfo}
            <span class="cn-report-date">${escapeHtml(r.date)}</span>
          </div>
        </div>
      `;
    }).join('');

    this.setContent(`${STYLE}
      <div class="cn-research-container">
        ${tabsHtml}
        <div class="cn-research-filters">${chipsHtml}</div>
        ${reportsHtml}
      </div>
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
    if (this.searchDebounce) {
      clearTimeout(this.searchDebounce);
    }
    this.drawer.destroy();
    super.destroy();
  }
}

import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { openNewsDrawer } from './NewsDetailDrawer';
import { openPolicyDrawer } from './PolicyDetailDrawer';
import * as d3 from 'd3';
import { cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';
const POLL_INTERVAL = 600_000; // 600s

type PlatformKey = string;  // Dynamic — backend can add platforms via NewsNow

/* ---- Co-occurrence network types ---- */
interface CoOccurrenceNode {
  id: string;
  name: string;
  type: 'stock' | 'index' | 'sector' | 'policy_body';
  sector: string;
  mentions: number;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

interface CoOccurrenceEdge {
  source: string | CoOccurrenceNode;
  target: string | CoOccurrenceNode;
  weight: number;
}

interface CoOccurrenceData {
  nodes: CoOccurrenceNode[];
  edges: CoOccurrenceEdge[];
  total_texts: number;
}

/* ---- Entity sentiment types ---- */
interface EntitySentimentItem {
  name: string;
  code: string;
  sentimentScore: number;
  sentimentLabel: string;
  positive: number;
  negative: number;
  neutral: number;
  total: number;
}

interface EntitySentimentData {
  entities: EntitySentimentItem[];
  total_posts_analyzed: number;
  timestamp: string;
}

interface MoodPost {
  id: string;
  content: string;
  sentiment: '正面' | '负面' | '中性';
  engagement: number;
  author?: string;
  platform?: string;
  category?: string;
  age_group?: string;
  url?: string;
  excerpt?: string;
}

interface SentimentDistribution {
  positive: number;
  negative: number;
  neutral: number;
}

interface CategoryData {
  positive: number;
  negative: number;
  neutral: number;
  total: number;
}

interface KeywordItem {
  word: string;
  count: number;
}

interface TrendData {
  direction: 'improving' | 'worsening' | 'stable';
  data: { date: string; score: number }[];
}

interface PlatformBreakdown {
  [key: string]: { pos: number; neg: number; neu: number; total: number };
}

interface CnMoodData {
  // Legacy 3-platform
  weibo: MoodPost[];
  zhihu: MoodPost[];
  xiaohongshu: MoodPost[];
  // New multi-platform
  platforms?: Record<string, MoodPost[]>;
  distribution: SentimentDistribution;
  categories?: Record<string, CategoryData>;
  keywords?: KeywordItem[];
  trend?: TrendData;
  platformBreakdown?: PlatformBreakdown;
  timestamp: string;
}

const PLATFORM_LABELS: Record<string, string> = {
  // Core 8 (direct fetchers)
  weibo: '微博',
  zhihu: '知乎',
  baidu: '百度',
  toutiao: '头条',
  xueqiu: '雪球',
  eastmoney: '东财',
  bilibili: 'B站',
  xiaohongshu: '小红书',
  // NewsNow: Social
  douyin: '抖音',
  tieba: '贴吧',
  coolapk: '酷安',
  // NewsNow: Finance
  cls: '财联社',
  'cls-depth': '财联社深度',
  wallstreetcn: '华尔街见闻',
  'wallstreetcn-hot': '华尔街热门',
  jin10: '金十',
  gelonghui: '格隆汇',
  'mktnews-flash': 'MKTNews',
  // NewsNow: News
  ifeng: '凤凰网',
  'tencent-hot': '腾讯新闻',
  thepaper: '澎湃',
  cankaoxiaoxi: '参考消息',
  zaobao: '联合早报',
  sputniknewscn: '卫星通讯社',
  kaopu: '靠谱新闻',
  // NewsNow: Tech
  '36kr': '36氪',
  ithome: 'IT之家',
  sspai: '少数派',
  juejin: '掘金',
  'v2ex-share': 'V2EX',
  'chongbuluo-hot': '虫部落',
  // DB: news database (0/01/02/03)
  'db-news': '新闻数据库',
  // Gov: official media
  'gov-news': '官方媒体',
};

const PLATFORM_CATEGORIES: Record<string, string[]> = {
  '社交': ['weibo', 'zhihu', 'baidu', 'toutiao', 'bilibili', 'xiaohongshu', 'douyin', 'tieba', 'coolapk'],
  '财经': ['xueqiu', 'eastmoney', 'cls', 'cls-depth', 'wallstreetcn', 'wallstreetcn-hot', 'jin10', 'gelonghui', 'mktnews-flash'],
  '新闻': ['ifeng', 'tencent-hot', 'thepaper', 'cankaoxiaoxi', 'zaobao', 'sputniknewscn', 'kaopu'],
  '科技': ['36kr', 'ithome', 'sspai', 'juejin', 'v2ex-share', 'chongbuluo-hot'],
  '新闻数据库': ['db-news'],  // DB news types 0/01/02/03
  // '官媒' moved to dedicated CnPolicyPanel (4th main tab)
};
const PLATFORM_CATEGORY_KEYS = Object.keys(PLATFORM_CATEGORIES);
const ALL_CATEGORIZED = new Set(Object.values(PLATFORM_CATEGORIES).flat());

const CATEGORY_LIST = ['全部', '股市', '科技', '政策', '消费', '房地产', '能源', '宏观', '就业', '医疗', '其他'];

// Red=positive, Green=negative (Chinese 红涨绿跌 convention)
const SENTIMENT_COLORS = {
  '正面': '#E53935',
  '负面': '#43A047',
  '中性': '#9E9E9E',
} as const;

function sentimentBgColor(s: string): string {
  switch (s) {
    case '正面': return 'rgba(229,57,53,0.12)';
    case '负面': return 'rgba(67,160,71,0.12)';
    default: return 'rgba(158,158,158,0.12)';
  }
}

function formatEngagement(val: number): string {
  if (val >= 10000) return `${(val / 10000).toFixed(1)}万`;
  if (val >= 1000) return `${(val / 1000).toFixed(1)}k`;
  return String(val);
}

// Overview section: sentiment bar + hot topics (replaces ring + word cloud)
function buildOverviewSection(
  dist: SentimentDistribution,
  trend: TrendData | undefined,
  keywords: KeywordItem[],
): string {
  const total = dist.positive + dist.negative + dist.neutral;
  if (total === 0) return '';

  const posPct = Math.round((dist.positive / total) * 100);
  const negPct = Math.round((dist.negative / total) * 100);
  const neuPct = 100 - posPct - negPct;

  // Sentiment bar (horizontal stacked)
  const sentBarHtml = `<div class="cn-ov-sentbar-wrap">
    <div class="cn-ov-sentbar">
      ${posPct > 0 ? `<div class="cn-ov-sentbar-seg" style="width:${posPct}%;background:${SENTIMENT_COLORS['正面']}" title="正面 ${posPct}%"></div>` : ''}
      ${neuPct > 0 ? `<div class="cn-ov-sentbar-seg" style="width:${neuPct}%;background:${SENTIMENT_COLORS['中性']}" title="中性 ${neuPct}%"></div>` : ''}
      ${negPct > 0 ? `<div class="cn-ov-sentbar-seg" style="width:${negPct}%;background:${SENTIMENT_COLORS['负面']}" title="负面 ${negPct}%"></div>` : ''}
    </div>
    <div class="cn-ov-sentbar-labels">
      <span style="color:${SENTIMENT_COLORS['正面']}"><i class="bi bi-caret-up-fill"></i> ${posPct}%</span>
      <span style="color:${SENTIMENT_COLORS['中性']}">${neuPct}%</span>
      <span style="color:${SENTIMENT_COLORS['负面']}"><i class="bi bi-caret-down-fill"></i> ${negPct}%</span>
    </div>
  </div>`;

  // Trend indicator
  let trendHtml = '';
  if (trend) {
    const arrow = trend.direction === 'improving' ? 'bi-arrow-up-right' : trend.direction === 'worsening' ? 'bi-arrow-down-right' : 'bi-arrow-right';
    const trendLabel = trend.direction === 'improving' ? '情绪改善' : trend.direction === 'worsening' ? '情绪恶化' : '情绪平稳';
    const trendColor = trend.direction === 'improving' ? '#E53935' : trend.direction === 'worsening' ? '#43A047' : '#9E9E9E';
    // Sparkline
    let sparkSvg = '';
    if (trend.data && trend.data.length >= 2) {
      const w = 60, h = 16, pad = 1;
      const scores = trend.data.map(d => d.score);
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const range = max - min || 1;
      const pts = trend.data.map((d, idx) => {
        const x = pad + (idx / (trend.data.length - 1)) * (w - 2 * pad);
        const y = pad + (1 - (d.score - min) / range) * (h - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      sparkSvg = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="flex-shrink:0;vertical-align:middle"><polyline points="${pts}" fill="none" stroke="${trendColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    trendHtml = `<div class="cn-ov-trend"><i class="bi ${arrow}" style="color:${trendColor}"></i> <span style="color:${trendColor}">${trendLabel}</span> ${sparkSvg}</div>`;
  }

  // Hot topics (from keywords)
  let hotTopicsHtml = '';
  if (keywords && keywords.length > 0) {
    const topKw = keywords.slice(0, 12);
    const maxCount = topKw[0]?.count || 1;
    const tags = topKw.map((kw, i) => {
      const heat = kw.count / maxCount;
      // Color: top 3 = accent, 4-6 = warm, rest = subtle
      const color = i < 3 ? '#e8a838' : i < 6 ? '#90CAF9' : 'var(--text-dim)';
      const weight = i < 3 ? '600' : '400';
      const bg = i < 3 ? 'rgba(232,168,56,0.12)' : i < 6 ? 'rgba(144,202,249,0.08)' : 'rgba(255,255,255,0.04)';
      const opacity = 0.6 + heat * 0.4;
      return `<span class="cn-ov-tag" style="background:${bg};color:${color};font-weight:${weight};opacity:${opacity.toFixed(2)}">${escapeHtml(kw.word)}</span>`;
    }).join('');
    hotTopicsHtml = `<div class="cn-ov-tags-section">
      <div class="cn-ov-tags-title"><i class="bi bi-fire"></i> 热点话题</div>
      <div class="cn-ov-tags">${tags}</div>
    </div>`;
  }

  return `<div class="cn-mood-overview">
    <div class="cn-ov-top-row">
      <div class="cn-ov-score-block">
        <span class="cn-ov-score-num" style="color:${posPct >= 60 ? '#E53935' : posPct <= 40 ? '#43A047' : '#FFB74D'}">${total.toLocaleString()}</span>
        <span class="cn-ov-score-label">条舆情</span>
      </div>
      ${sentBarHtml}
      ${trendHtml}
    </div>
    ${hotTopicsHtml}
  </div>`;
}

// (word cloud removed — replaced by hot topic tags in overview section)

function buildPlatformCompare(breakdown: PlatformBreakdown): string {
  if (!breakdown) return '';
  // Sort by total descending, take top 8
  const platformKeys = Object.keys(breakdown)
    .sort((a, b) => (breakdown[b]?.total || 0) - (breakdown[a]?.total || 0))
    .slice(0, 8);
  if (platformKeys.length === 0) return '';
  const maxTotal = Math.max(...platformKeys.map(k => breakdown[k]!.total)) || 1;

  const rows = platformKeys.map(key => {
    const d = breakdown[key]!;
    const label = PLATFORM_LABELS[key as PlatformKey] || key;
    const total = d.total || 1;
    const posPct = Math.round((d.pos / total) * 100);
    const negPct = Math.round((d.neg / total) * 100);
    const neuPct = 100 - posPct - negPct;
    const barScale = Math.max(15, Math.round((d.total / maxTotal) * 100));
    const icon = PLATFORM_ICONS[key] || 'bi-chat-left';
    return `<div class="cn-plat-row" title="正面${d.pos} 负面${d.neg} 中性${d.neu}">
      <span class="cn-plat-icon"><i class="bi ${icon}"></i></span>
      <span class="cn-plat-name">${escapeHtml(label)}</span>
      <div class="cn-plat-bar-track">
        <div class="cn-plat-bar" style="width:${barScale}%">
          ${posPct > 0 ? `<div class="cn-plat-seg plat-pos" style="width:${posPct}%"></div>` : ''}
          ${neuPct > 0 ? `<div class="cn-plat-seg plat-neu" style="width:${neuPct}%"></div>` : ''}
          ${negPct > 0 ? `<div class="cn-plat-seg plat-neg" style="width:${negPct}%"></div>` : ''}
        </div>
      </div>
      <span class="cn-plat-total">${d.total}</span>
    </div>`;
  }).join('');

  return `<div class="cn-platform-compare">
    <div class="cn-platform-compare-title"><i class="bi bi-bar-chart"></i> 平台情绪对比</div>
    ${rows}
  </div>`;
}

function buildStatsBar(dist: SentimentDistribution): string {
  const total = dist.positive + dist.negative + dist.neutral;
  if (total === 0) return '';
  const posPct = ((dist.positive / total) * 100).toFixed(0);
  const negPct = ((dist.negative / total) * 100).toFixed(0);
  const neuPct = ((dist.neutral / total) * 100).toFixed(0);

  return `<div class="cn-mood-stats-bar">
    <div class="cn-mood-stat"><i class="bi bi-chat-text"></i> <span class="stat-val">${total.toLocaleString()}</span> 条</div>
    <div class="cn-mood-stat positive"><i class="bi bi-arrow-up-circle-fill"></i> ${posPct}%</div>
    <div class="cn-mood-stat negative"><i class="bi bi-arrow-down-circle-fill"></i> ${negPct}%</div>
    <div class="cn-mood-stat neutral"><i class="bi bi-dash-circle"></i> ${neuPct}%</div>
  </div>`;
}

function buildCategoryHeatmap(categories: Record<string, CategoryData> | undefined): string {
  if (!categories) return '';
  // Sort by total descending, take top 8
  const entries = Object.entries(categories)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 8);
  if (entries.length === 0) return '';
  const maxTotal = Math.max(...entries.map(([, c]) => c.total)) || 1;

  const rows = entries.map(([name, cat]) => {
    const total = cat.total || 1;
    const posPct = Math.round((cat.positive / total) * 100);
    const negPct = Math.round((cat.negative / total) * 100);
    const neuPct = 100 - posPct - negPct;
    // Scale bar width relative to max category
    const barScale = Math.max(20, Math.round((cat.total / maxTotal) * 100));
    return `<div class="cn-mood-heatrow">
      <span class="cn-mood-heatrow-label">${escapeHtml(name)}</span>
      <div class="cn-mood-heatbar-track">
        <div class="cn-mood-heatbar" style="width:${barScale}%">
          ${posPct > 0 ? `<div class="cn-mood-heatbar-seg hb-pos" style="width:${posPct}%" title="正面 ${cat.positive}"></div>` : ''}
          ${neuPct > 0 ? `<div class="cn-mood-heatbar-seg hb-neu" style="width:${neuPct}%" title="中性 ${cat.neutral}"></div>` : ''}
          ${negPct > 0 ? `<div class="cn-mood-heatbar-seg hb-neg" style="width:${negPct}%" title="负面 ${cat.negative}"></div>` : ''}
        </div>
      </div>
      <span class="cn-mood-heatrow-total">${cat.total}</span>
    </div>`;
  }).join('');

  return `<div class="cn-mood-category-heatmap">
    <div class="cn-mood-heatmap-title"><i class="bi bi-bar-chart-steps"></i> 话题情绪分布</div>
    ${rows}
  </div>`;
}

const PLATFORM_ICONS: Record<string, string> = {
  weibo: 'bi-sina-weibo',
  zhihu: 'bi-question-circle',
  baidu: 'bi-search',
  toutiao: 'bi-newspaper',
  xueqiu: 'bi-snow',
  eastmoney: 'bi-currency-yen',
  bilibili: 'bi-play-btn',
  douyin: 'bi-music-note-beamed',
  tieba: 'bi-chat-left-text',
  cls: 'bi-broadcast',
  wallstreetcn: 'bi-globe',
  jin10: 'bi-lightning',
  gelonghui: 'bi-graph-up-arrow',
  '36kr': 'bi-rocket',
  ithome: 'bi-laptop',
  'db-news': 'bi-newspaper',
  'gov-news': 'bi-flag-fill',
};

const STYLE = `
<style>
@layer base {
.cn-mood-container {
  display: flex;
  flex-direction: column;
  gap: 0;
}
/* ---- Platform category chips ---- */
.cn-mood-platform-cats {
  display: flex;
  gap: 4px;
  padding: 4px 0 6px;
  flex-wrap: wrap;
}
.cn-mood-pcat-chip {
  padding: 3px 10px;
  font-size: 10px;
  font-weight: 500;
  border-radius: 12px;
  background: rgba(255,255,255,0.05);
  color: var(--text-dim);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.cn-mood-pcat-chip:hover { background: rgba(255,255,255,0.1); color: var(--text); }
.cn-mood-pcat-chip.active { background: rgba(232,168,56,0.15); color: #e8a838; border-color: rgba(232,168,56,0.3); }
.cn-mood-pcat-chip .pcat-count { font-size: 9px; opacity: 0.6; margin-left: 2px; }
/* ---- Platform tabs ---- */
.cn-mood-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  margin-bottom: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}
.cn-mood-tabs::-webkit-scrollbar { height: 0; }
.cn-mood-tab {
  padding: 5px 6px;
  font-size: 10px;
  font-weight: 500;
  text-align: center;
  color: var(--text-dim);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.cn-mood-tab:hover { color: var(--text); }
.cn-mood-tab.active { color: #e53935; border-bottom-color: #e53935; }
.cn-mood-tab .tab-count { font-size: 8px; opacity: 0.5; margin-left: 2px; }
/* ---- Category chips ---- */
.cn-mood-category-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 0 6px;
}
.cn-mood-cat-chip {
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
.cn-mood-cat-chip:hover { background: rgba(255,255,255,0.1); color: var(--text); }
.cn-mood-cat-chip.active { background: rgba(229,57,53,0.15); color: #e53935; border-color: rgba(229,57,53,0.3); }
/* ---- Overview: sentiment bar + hot topics ---- */
.cn-mood-overview {
  padding: 8px 10px;
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px;
  background: rgba(255,255,255,0.015);
  overflow: hidden;
  margin-bottom: 8px;
}
/* ---- Overview: top row (score + bar + trend) ---- */
.cn-ov-top-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.cn-ov-score-block {
  display: flex;
  align-items: baseline;
  gap: 3px;
  flex-shrink: 0;
}
.cn-ov-score-num {
  font-size: 18px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
}
.cn-ov-score-label {
  font-size: 9px;
  color: var(--text-dim);
}
/* Sentiment bar */
.cn-ov-sentbar-wrap {
  flex: 1;
  min-width: 0;
}
.cn-ov-sentbar {
  display: flex;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  gap: 1px;
}
.cn-ov-sentbar-seg {
  height: 100%;
  min-width: 2px;
  border-radius: 2px;
  opacity: 0.85;
}
.cn-ov-sentbar-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 2px;
  font-size: 9px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.cn-ov-sentbar-labels i { font-size: 8px; }
/* Trend */
.cn-ov-trend {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
}
.cn-ov-trend i { font-size: 10px; }
/* Hot topic tags */
.cn-ov-tags-section {
  border-top: 1px solid rgba(255,255,255,0.04);
  padding-top: 6px;
}
.cn-ov-tags-title {
  font-size: 9px;
  color: var(--text-dim);
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 3px;
  font-weight: 500;
}
.cn-ov-tags-title i { color: #e8a838; font-size: 10px; }
.cn-ov-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.cn-ov-tag {
  padding: 2px 8px;
  font-size: 10px;
  border-radius: 4px;
  white-space: nowrap;
  transition: opacity 0.15s;
}
.cn-ov-tag:hover { opacity: 1 !important; }
/* ---- Stats bar ---- */
.cn-mood-stats-bar {
  display: flex;
  gap: 5px;
  padding: 4px 0 6px;
  flex-wrap: wrap;
}
.cn-mood-stat {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px 8px;
  border-radius: 12px;
  background: rgba(255,255,255,0.04);
  font-size: 10px;
  font-weight: 500;
  color: var(--text-dim);
}
.cn-mood-stat .stat-val { font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.cn-mood-stat.positive { background: rgba(229,57,53,0.08); color: #E53935; }
.cn-mood-stat.negative { background: rgba(67,160,71,0.08); color: #43A047; }
.cn-mood-stat.neutral { background: rgba(158,158,158,0.08); color: #9E9E9E; }
.cn-mood-stat i { font-size: 11px; }
/* ---- Category heatmap (horizontal stacked bars) ---- */
.cn-mood-category-heatmap {
  padding: 6px 0 8px;
}
.cn-mood-heatmap-title {
  font-size: 10px;
  color: var(--text-dim);
  margin-bottom: 5px;
  display: flex;
  align-items: center;
  gap: 4px;
  font-weight: 500;
}
.cn-mood-heatmap-title i { font-size: 11px; }
.cn-mood-heatrow {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.cn-mood-heatrow:hover { background: rgba(255,255,255,0.015); border-radius: 3px; }
.cn-mood-heatrow-label {
  font-size: 10px;
  color: var(--text);
  width: 42px;
  flex-shrink: 0;
  text-align: right;
  opacity: 0.85;
}
.cn-mood-heatbar-track {
  flex: 1;
  background: rgba(255,255,255,0.025);
  border-radius: 3px;
  height: 8px;
  overflow: hidden;
}
.cn-mood-heatbar {
  display: flex;
  height: 100%;
  border-radius: 3px;
  overflow: hidden;
  transition: width 0.3s ease;
}
.cn-mood-heatbar-seg { height: 100%; min-width: 1px; }
.cn-mood-heatbar-seg.hb-pos { background: #E53935; opacity: 0.8; }
.cn-mood-heatbar-seg.hb-neu { background: #78909C; opacity: 0.35; }
.cn-mood-heatbar-seg.hb-neg { background: #43A047; opacity: 0.8; }
.cn-mood-heatrow-total {
  font-size: 9px;
  color: var(--text-dim);
  width: 28px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}
/* ---- Platform comparison (horizontal rows) ---- */
.cn-platform-compare {
  padding: 6px 0 8px;
}
.cn-platform-compare-title {
  font-size: 10px;
  color: var(--text-dim);
  margin-bottom: 5px;
  display: flex;
  align-items: center;
  gap: 4px;
  font-weight: 500;
}
.cn-platform-compare-title i { font-size: 11px; }
.cn-plat-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 0;
}
.cn-plat-row:hover { background: rgba(255,255,255,0.015); border-radius: 3px; }
.cn-plat-icon { font-size: 10px; color: var(--text-dim); width: 14px; text-align: center; flex-shrink: 0; opacity: 0.7; }
.cn-plat-name { font-size: 10px; color: var(--text); width: 32px; flex-shrink: 0; opacity: 0.85; }
.cn-plat-bar-track {
  flex: 1;
  background: rgba(255,255,255,0.025);
  border-radius: 3px;
  height: 8px;
  overflow: hidden;
}
.cn-plat-bar {
  display: flex;
  height: 100%;
  border-radius: 3px;
  overflow: hidden;
  transition: width 0.3s ease;
}
.cn-plat-seg { height: 100%; min-width: 1px; }
.cn-plat-seg.plat-pos { background: #E53935; opacity: 0.8; }
.cn-plat-seg.plat-neu { background: #78909C; opacity: 0.35; }
.cn-plat-seg.plat-neg { background: #43A047; opacity: 0.8; }
.cn-plat-total { font-size: 9px; color: var(--text-dim); width: 28px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.7; }
/* ---- Posts ---- */
.cn-mood-posts {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin-top: 4px;
}
.cn-mood-post {
  padding: 5px 0;
  border-bottom: 1px solid rgba(255,255,255,0.035);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.cn-mood-post:last-child { border-bottom: none; }
.cn-mood-post-content {
  font-size: 11px;
  color: var(--text);
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  opacity: 0.92;
}
.cn-mood-post-footer {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 9px;
  flex-wrap: wrap;
}
.cn-mood-sentiment-tag {
  padding: 0 5px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 600;
  line-height: 16px;
}
.cn-mood-platform-tag {
  padding: 0 5px;
  border-radius: 3px;
  font-size: 8px;
  background: rgba(232,168,56,0.15);
  color: #e8a838;
  line-height: 16px;
}
.cn-mood-category-tag {
  padding: 0 5px;
  border-radius: 3px;
  font-size: 8px;
  background: rgba(33,150,243,0.12);
  color: #64B5F6;
  line-height: 16px;
}
.cn-mood-post-engagement { color: var(--text-dim); font-variant-numeric: tabular-nums; font-size: 9px; }
.cn-mood-post-author { color: var(--text-dim); opacity: 0.6; font-size: 9px; }
.cn-mood-post-hot { color: #E53935; font-size: 10px; }
.cn-mood-post-platform-icon { font-size: 10px; color: var(--text-dim); opacity: 0.6; }
.cn-mood-post-url {
  color: #e8a838;
  text-decoration: none;
  font-size: 9px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.cn-mood-post-url:hover { text-decoration: underline; }
.cn-mood-post-has-content { color: #64B5F6; font-size: 10px; }
.cn-mood-post[data-news-id]:hover { background: rgba(255,255,255,0.03); border-radius: 4px; }
.cn-mood-post[data-post-url]:hover { background: rgba(255,255,255,0.03); border-radius: 4px; }
/* ---- New item highlight animation (uses shared spark-new-item from spark-theme.css) ---- */
/* ---- Gov report drawer ---- */
.cn-gov-report-drawer {
  border: 1px solid rgba(232,168,56,0.2);
  border-radius: 8px;
  background: rgba(232,168,56,0.03);
  margin-bottom: 10px;
  overflow: hidden;
}
.cn-gov-report-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: #e8a838;
  border-bottom: 1px solid rgba(232,168,56,0.12);
  background: rgba(232,168,56,0.06);
}
.cn-gov-report-header i { margin-right: 5px; }
.cn-gov-report-close {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 2px 4px;
  font-size: 13px;
}
.cn-gov-report-close:hover { color: var(--text); }
.cn-gov-report-body {
  padding: 10px 14px;
  font-size: 12px;
  line-height: 1.75;
  color: var(--text);
  max-height: 70vh;
  overflow-y: auto;
}
.cn-gov-report-body::-webkit-scrollbar { width: 4px; }
.cn-gov-report-body::-webkit-scrollbar-thumb { background: rgba(232,168,56,0.3); border-radius: 2px; }
.cn-report-h2 {
  font-size: 13px;
  font-weight: 700;
  color: #e8a838;
  margin: 14px 0 6px;
  padding: 4px 0 3px;
  border-bottom: 1px solid rgba(232,168,56,0.15);
}
.cn-report-h2:first-child { margin-top: 0; }
.cn-report-h3 {
  font-size: 12px;
  font-weight: 600;
  color: #d4a24a;
  margin: 10px 0 4px;
}
.cn-report-para {
  margin: 4px 0;
  color: rgba(255,255,255,0.85);
}
.cn-report-bullet {
  padding-left: 12px;
  position: relative;
  margin: 3px 0;
  color: rgba(255,255,255,0.82);
}
.cn-report-bullet::before {
  content: '•';
  position: absolute;
  left: 2px;
  color: #e8a838;
}
.cn-report-strong { color: #f0d080; font-weight: 600; }
.cn-mood-empty {
  text-align: center;
  padding: 14px;
  color: var(--text-dim);
  font-size: 11px;
}
.cn-mood-report-btn {
  padding: 4px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
  border: 1px solid rgba(232,168,56,0.3); background: rgba(232,168,56,0.15); color: #e8a838;
  transition: all .15s; white-space: nowrap;
}
.cn-mood-report-btn:hover { background: rgba(232,168,56,0.25); }
.cn-mood-ai-drawer {
  border: 1px solid rgba(232,168,56,0.2);
  border-radius: 8px;
  margin-bottom: 10px;
  background: rgba(232,168,56,0.03);
  overflow: hidden;
}
.cn-mood-ai-drawer-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px; font-size: 12px; font-weight: 600; color: #e8a838;
  border-bottom: 1px solid rgba(232,168,56,0.12); background: rgba(232,168,56,0.06);
}
.cn-mood-ai-drawer-body {
  padding: 10px 14px; font-size: 12px; line-height: 1.75; color: var(--text);
  max-height: 70vh; overflow-y: auto;
}
.cn-mood-ai-drawer-body::-webkit-scrollbar { width: 4px; }
.cn-mood-ai-drawer-body::-webkit-scrollbar-thumb { background: rgba(232,168,56,0.3); border-radius: 2px; }
@keyframes spin { to { transform: rotate(360deg); } }
/* ---- Co-occurrence network ---- */
.cn-cooccurrence-container {
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  background: rgba(0,0,0,0.2);
  overflow: visible;
  margin-bottom: 8px;
  position: relative;
}
.cn-cooccurrence-svg { width: 100%; min-height: 280px; height: 360px; display: block; }
.co-edge { stroke: rgba(255,255,255,0.25); }
.co-node { cursor: pointer; transition: opacity 0.15s; }
.co-label { fill: var(--text); font-size: 11px; pointer-events: none; text-anchor: middle; font-weight: 500; text-shadow: 0 1px 3px rgba(0,0,0,0.8); }
.cn-cooccurrence-legend {
  display: flex; gap: 10px; padding: 6px 10px; font-size: 10px; color: var(--text-dim);
  border-top: 1px solid rgba(255,255,255,0.06);
}
.cn-cooccurrence-legend span { display: flex; align-items: center; gap: 3px; }
.cn-cooccurrence-legend i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.cn-cooccurrence-tooltip {
  position: absolute;
  padding: 6px 12px;
  border-radius: 6px;
  background: rgba(20,20,20,0.95);
  border: 1px solid rgba(255,255,255,0.15);
  font-size: 11px;
  color: var(--text);
  pointer-events: none;
  white-space: nowrap;
  z-index: 10;
  opacity: 0;
  transition: opacity 0.15s;
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
.cn-cooccurrence-tooltip.visible { opacity: 1; }
.cn-mood-network-btn {
  padding: 3px 10px; font-size: 10px; font-weight: 500; border-radius: 12px;
  background: rgba(232,168,56,0.08); color: var(--text-dim); border: 1px solid transparent;
  cursor: pointer; transition: all 0.15s; white-space: nowrap;
}
.cn-mood-network-btn:hover { background: rgba(232,168,56,0.15); color: #e8a838; }
.cn-mood-network-btn.active { background: rgba(232,168,56,0.18); color: #e8a838; border-color: rgba(232,168,56,0.3); }
/* ---- Entity sentiment ---- */
.cn-entity-sentiment {
  padding: 6px 0 8px;
  margin-bottom: 8px;
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px;
  background: rgba(255,255,255,0.015);
  overflow: hidden;
}
.cn-entity-sentiment-title {
  font-size: 10px; color: var(--text-dim); margin-bottom: 5px; padding: 4px 10px 0;
  display: flex; align-items: center; gap: 4px; font-weight: 500;
}
.cn-entity-sentiment-title i { font-size: 11px; }
.cn-entity-row {
  display: flex; align-items: center; gap: 5px; padding: 2px 10px;
  cursor: pointer; transition: background 0.1s;
}
.cn-entity-row:hover { background: rgba(255,255,255,0.025); }
.cn-entity-row-name { font-size: 10px; color: var(--text); width: 56px; flex-shrink: 0; text-align: right; opacity: 0.9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cn-entity-sentiment-bar-track { flex: 1; background: rgba(255,255,255,0.025); border-radius: 3px; height: 8px; overflow: hidden; display: flex; }
.cn-entity-sentiment-bar-seg { height: 100%; min-width: 1px; }
.cn-entity-sentiment-bar-seg.es-pos { background: #E53935; opacity: 0.8; }
.cn-entity-sentiment-bar-seg.es-neu { background: #78909C; opacity: 0.35; }
.cn-entity-sentiment-bar-seg.es-neg { background: #43A047; opacity: 0.8; }
.cn-entity-row-score { font-size: 9px; font-weight: 600; width: 32px; text-align: right; font-variant-numeric: tabular-nums; }
.cn-entity-row-total { font-size: 9px; color: var(--text-dim); width: 28px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.7; }
.cn-mood-sentiment-btn {
  padding: 3px 10px; font-size: 10px; font-weight: 500; border-radius: 12px;
  background: rgba(229,57,53,0.08); color: var(--text-dim); border: 1px solid transparent;
  cursor: pointer; transition: all 0.15s; white-space: nowrap;
}
.cn-mood-sentiment-btn:hover { background: rgba(229,57,53,0.15); color: #ef5350; }
.cn-mood-sentiment-btn.active { background: rgba(229,57,53,0.18); color: #ef5350; border-color: rgba(229,57,53,0.3); }
@media (max-width: 768px) {
  .cn-mood-platform-cats { flex-wrap: wrap; gap: 3px; }
  .cn-mood-tabs { max-height: 60px; overflow-x: auto; flex-wrap: nowrap; }
}
} /* @layer base */
</style>
`;

interface DbNewsArticle {
  id: string;
  title: string;
  source: string;
  date: string;
  summary: string;
  link: string;
  emotion: string | null;
  type: string;
  typeLabel: string;
  hasContent?: boolean;
}

const DB_NEWS_TYPE_FILTERS = [
  { key: 'all', label: '全部' },
  { key: '0', label: '快讯' },
  { key: '01', label: '监管' },
  { key: '02', label: '金融处罚' },
  { key: '03', label: '央行动态' },
];

const GOV_CATEGORY_FILTERS = [
  { key: 'all', label: '全部' },
  { key: '央媒', label: '央媒' },
  { key: '财政货币', label: '财政货币' },
  { key: '金融监管', label: '金融监管' },
  { key: '国务院', label: '国务院' },
  { key: '统计', label: '统计' },
  { key: '理论', label: '理论' },
  { key: '海外', label: '海外' },
  { key: '财经媒体', label: '财经媒体' },
  { key: '智库', label: '智库' },
  { key: '外贸外交', label: '外贸外交' },
];

interface GovNewsItem {
  title: string;
  url: string;
  date: string;
  source: string;
  category: string;
  icon: string;
}

interface GovNewsData {
  categories: Record<string, GovNewsItem[]>;
  all: GovNewsItem[];
  sources: Record<string, number>;
  total: number;
  category_list: string[];
  timestamp: string;
}

interface GovReportData {
  report: string;
  generated: boolean;
  news_total?: number;
  sources?: Record<string, number>;
}

export class CnMoodPanel extends Panel {
  private timer: ReturnType<typeof setInterval> | null = null;
  private data: CnMoodData | null = null;
  private activeTab = 'weibo';
  private activeCategory = '全部';
  private activePlatformCategory = '社交';
  private dbNewsData: DbNewsArticle[] = [];
  private dbNewsLoading = false;
  private dbNewsFetched = false;
  private dbNewsTypeFilter = 'all';
  // Gov news state
  private govNewsData: GovNewsData | null = null;
  private govNewsLoading = false;
  private govNewsFetched = false;
  private govNewsCategoryFilter = 'all';
  private govReportData: GovReportData | null = null;
  private govReportLoading = false;
  private govReportVisible = false;
  // Track seen items for new-item animation
  private seenDbNewsIds = new Set<string>();
  private seenPostKeys = new Set<string>();
  private lastFetchTime = 0;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;
  private retryAttempt = 0;
  // AI analysis report state
  private moodReportData: { report: string; generated: boolean } | null = null;
  private moodReportLoading = false;
  private moodReportVisible = false;
  // Co-occurrence network state
  private coOccurrenceData: CoOccurrenceData | null = null;
  private coOccurrenceLoading = false;
  private coOccurrenceVisible = false;
  private simulation: d3.Simulation<CoOccurrenceNode, CoOccurrenceEdge> | null = null;
  // Entity sentiment state
  private entitySentimentData: EntitySentimentData | null = null;
  private entitySentimentLoading = false;
  private entitySentimentVisible = false;

  constructor() {
    super({ id: 'cn-mood', title: '舆情监控 <span class="spark-subtitle">SOCIAL MOOD</span>' });
    this.content.addEventListener('click', (e) => {
      const pcatChip = (e.target as HTMLElement).closest('.cn-mood-pcat-chip') as HTMLElement | null;
      if (pcatChip?.dataset.pcat) {
        this.activePlatformCategory = pcatChip.dataset.pcat;
        // Reset active tab to first in this category
        const catPlatforms = PLATFORM_CATEGORIES[this.activePlatformCategory] || [];
        if (catPlatforms.length > 0) this.activeTab = catPlatforms[0]!;
        // Lazy-load DB news when 新闻数据库 category is selected
        if (this.activePlatformCategory === '新闻数据库' && !this.dbNewsFetched) {
          void this.fetchDbNews();
        }
        // Lazy-load gov news when 官媒 category is selected
        if (this.activePlatformCategory === '官媒' && !this.govNewsFetched) {
          void this.fetchGovNews();
        }
        this.renderPanel();
        return;
      }
      const tab = (e.target as HTMLElement).closest('.cn-mood-tab') as HTMLElement | null;
      if (tab?.dataset.tab) {
        this.activeTab = tab.dataset.tab as PlatformKey;
        this.renderPanel();
        return;
      }
      const chip = (e.target as HTMLElement).closest('.cn-mood-cat-chip') as HTMLElement | null;
      if (chip?.dataset.category) {
        this.activeCategory = chip.dataset.category;
        this.renderPanel();
        return;
      }
      // DB news type filter chip
      const typeChip = (e.target as HTMLElement).closest('.cn-mood-newstype-chip') as HTMLElement | null;
      if (typeChip?.dataset.newstype) {
        this.dbNewsTypeFilter = typeChip.dataset.newstype;
        this.dbNewsFetched = false;
        void this.fetchDbNews();
        return;
      }
      // Gov news category filter chip
      const govCatChip = (e.target as HTMLElement).closest('.cn-mood-govcat-chip') as HTMLElement | null;
      if (govCatChip?.dataset.govcat) {
        this.govNewsCategoryFilter = govCatChip.dataset.govcat;
        this.renderPanel();
        return;
      }
      // Gov AI report button
      const reportBtn = (e.target as HTMLElement).closest('.cn-gov-report-btn') as HTMLElement | null;
      if (reportBtn) {
        if (this.govReportVisible && this.govReportData) {
          this.govReportVisible = false;
          this.renderPanel();
        } else {
          void this.fetchGovReport();
        }
        return;
      }
      // Gov report close button
      const reportClose = (e.target as HTMLElement).closest('.cn-gov-report-close') as HTMLElement | null;
      if (reportClose) {
        this.govReportVisible = false;
        this.renderPanel();
        return;
      }
      // DB news post click → open detail drawer
      const newsPost = (e.target as HTMLElement).closest('.cn-mood-post[data-news-id]') as HTMLElement | null;
      if (newsPost?.dataset.newsId) {
        const article = this.dbNewsData.find(a => a.id === newsPost.dataset.newsId);
        if (article) {
          openNewsDrawer(article);
        }
        return;
      }
      // Gov news post click → open policy detail drawer
      const govPost = (e.target as HTMLElement).closest('.cn-mood-post[data-gov-idx]') as HTMLElement | null;
      if (govPost?.dataset.govIdx) {
        const idx = parseInt(govPost.dataset.govIdx, 10);
        const items = this.getGovVisibleItems();
        const item = items[idx];
        if (item && item.url) {
          openPolicyDrawer(item);
        }
        return;
      }
      // Platform post click → open policy drawer (with jsSpa flag for known JS-SPA domains)
      const platPost = (e.target as HTMLElement).closest('.cn-mood-post[data-post-url]') as HTMLElement | null;
      if (platPost?.dataset.postUrl) {
        const url = platPost.dataset.postUrl;
        const JS_SPA_DOMAINS = [
          'cankaoxiaoxi.com', 'weibo.com',
          // wallstreetcn, ckxx.net, toutiao, bilibili removed — backend fetches via API
          'douyin.com', 'zhihu.com', 'tieba.baidu.com',
          'baidu.com', 'xueqiu.com', 'coolapk.com', 'xiaohongshu.com', 'cnstock.com',
          'chongbuluo.com',
          'kaopu.news', 'kaopu.com',
          'mktnews.com', 'mktnews.net', 'jin10.com',
          // Removed (verified SSR): v2ex, gelonghui, zaobao, sputniknews, ifeng, sspai, juejin, 36kr, fastbull
        ];
        const urlLower = url.toLowerCase();
        const isSpa = JS_SPA_DOMAINS.some(d => urlLower.includes(d));
        const content = platPost.querySelector('.cn-mood-post-content')?.textContent || '';
        const postExcerpt = platPost.dataset.postExcerpt || '';
        openPolicyDrawer({
          title: content.slice(0, 100),
          url,
          date: '',
          source: platPost.dataset.postPlatform || '',
          category: '舆情',
          icon: 'bi-chat-left',
          jsSpa: isSpa || undefined,
          excerpt: postExcerpt || content || undefined,
        });
        return;
      }

      // Co-occurrence network button
      const networkBtn = (e.target as HTMLElement).closest('.cn-mood-network-btn') as HTMLElement | null;
      if (networkBtn) {
        if (this.coOccurrenceVisible) {
          this.coOccurrenceVisible = false;
          this.renderPanel();
        } else if (this.coOccurrenceData) {
          this.coOccurrenceVisible = true;
          this.renderPanel();
        } else {
          void this.fetchCoOccurrence();
        }
        return;
      }
      // Entity sentiment button
      const sentimentBtn = (e.target as HTMLElement).closest('.cn-mood-sentiment-btn') as HTMLElement | null;
      if (sentimentBtn) {
        if (this.entitySentimentVisible) {
          this.entitySentimentVisible = false;
          this.renderPanel();
        } else if (this.entitySentimentData) {
          this.entitySentimentVisible = true;
          this.renderPanel();
        } else {
          void this.fetchEntitySentiment();
        }
        return;
      }
      // Entity row click → dispatch entity event
      const entityRow = (e.target as HTMLElement).closest('.cn-entity-row') as HTMLElement | null;
      if (entityRow?.dataset.entityName) {
        window.dispatchEvent(new CustomEvent('cn-entity-click', {
          detail: { name: entityRow.dataset.entityName, type: entityRow.dataset.entityType || 'stock' },
        }));
        return;
      }

      // AI mood report button
      const moodReportBtn = (e.target as HTMLElement).closest('.cn-mood-report-btn') as HTMLElement | null;
      if (moodReportBtn) {
        if (this.moodReportVisible && this.moodReportData) {
          this.moodReportVisible = false;
          this.renderPanel();
        } else {
          void this.fetchMoodReport();
        }
        return;
      }
      // Mood report close
      if ((e.target as HTMLElement).closest('.cn-mood-report-close')) {
        this.moodReportVisible = false;
        this.renderPanel();
        return;
      }
    });

    void this.fetchData();
    this.timer = setInterval(() => void this.fetchData(), POLL_INTERVAL);
    this.freshnessTimer = setInterval(() => this.updateFreshness(), 30_000);

    // Load delta banner (Phase 2)
    import('@/components/CnDeltaBanner').then(m => {
      const wrap = this.content;
      if (wrap) m.mountDeltaBanner(wrap);
    }).catch(() => {});
  }

  public async fetchData(): Promise<void> {
    if (!this.data) this.showLoading('加载舆情数据...');
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/mood`, { signal: this.signal, timeout: 120_000 });
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
      // Auto-load mood report if not yet fetched (backend pre-caches it)
      if (!this.moodReportData && !this.moodReportLoading) {
        void this.fetchMoodReport();
      }
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      if (this.retryAttempt < 5) {
        this.retryAttempt++;
        this.showRetrying(`加载舆情数据...重试 ${this.retryAttempt}/5`);
        setTimeout(() => void this.fetchData(), 20_000);
        return;
      }
      this.showError('舆情数据加载失败');
    }
  }

  private async fetchMoodReport(): Promise<void> {
    if (this.moodReportLoading) return;
    this.moodReportLoading = true;
    this.moodReportVisible = true;
    this.renderPanel();
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/mood/report`, { signal: this.signal, timeout: 120_000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.moodReportData = await res.json();
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.moodReportData = { report: '加载失败，请稍后重试。', generated: false };
    } finally {
      this.moodReportLoading = false;
      this.renderPanel();
    }
  }


  private async fetchDbNews(): Promise<void> {
    if (this.dbNewsLoading || this.dbNewsFetched) return;
    this.dbNewsLoading = true;
    this.renderPanel();
    try {
      const typeParam = this.dbNewsTypeFilter !== 'all' ? `&type=${this.dbNewsTypeFilter}` : '';
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/news/db?pageSize=80${typeParam}`, { signal: this.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.dbNewsData = data.articles || [];
      this.dbNewsFetched = true;
    } catch (err) {
      if (this.isAbortError(err)) return;
    } finally {
      this.dbNewsLoading = false;
      this.renderPanel();
    }
  }

  private async fetchGovNews(): Promise<void> {
    if (this.govNewsLoading || this.govNewsFetched) return;
    this.govNewsLoading = true;
    this.renderPanel();
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
      this.govNewsData = data;
      this.govNewsFetched = true;
    } catch (err) {
      if (this.isAbortError(err)) return;
    } finally {
      this.govNewsLoading = false;
      this.renderPanel();
      // Auto-load gov report if not yet fetched (backend pre-caches it)
      if (this.govNewsFetched && !this.govReportData && !this.govReportLoading) {
        void this.fetchGovReport();
      }
    }
  }

  private async fetchGovReport(): Promise<void> {
    if (this.govReportLoading) return;
    this.govReportLoading = true;
    this.govReportVisible = true;
    this.renderPanel();
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/gov-news/report`, { signal: this.signal, timeout: 120_000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.govReportData = await res.json();
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.govReportData = { report: '加载失败，请稍后重试。', generated: false };
    } finally {
      this.govReportLoading = false;
      this.renderPanel();
    }
  }

  /* ---- Co-occurrence network ---- */
  private async fetchCoOccurrence(): Promise<void> {
    if (this.coOccurrenceLoading) return;
    this.coOccurrenceLoading = true;
    this.coOccurrenceVisible = true;
    this.renderPanel();
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/mood/co-occurrence?min_weight=2&max_nodes=25`, { signal: this.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.coOccurrenceData = await res.json();
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.coOccurrenceData = { nodes: [], edges: [], total_texts: 0 };
    } finally {
      this.coOccurrenceLoading = false;
      this.renderPanel(); // renderPanel auto-remounts D3 graph when visible
    }
  }

  private mountForceGraph(): void {
    const container = this.content.querySelector('.cn-cooccurrence-container') as HTMLElement | null;
    const svgEl = this.content.querySelector('.cn-cooccurrence-svg') as SVGSVGElement | null;
    if (!svgEl || !container || !this.coOccurrenceData) return;
    const data = this.coOccurrenceData;
    if (data.nodes.length === 0) return;

    const width = svgEl.clientWidth || 400;
    const height = Math.max(280, Math.min(400, svgEl.clientHeight || 360));
    const pad = 30; // padding to keep nodes inside
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`);
    svg.selectAll('*').remove();

    // Tooltip
    const tooltip = container.querySelector('.cn-cooccurrence-tooltip') as HTMLElement | null;

    // Scales — bigger nodes for better readability
    const maxMentions = Math.max(...data.nodes.map(n => n.mentions), 1);
    const rScale = d3.scaleSqrt().domain([1, maxMentions]).range([8, 26]);
    const maxWeight = Math.max(...data.edges.map(e => e.weight), 1);
    const wScale = d3.scaleLinear().domain([1, maxWeight]).range([1.5, 6]);

    // Node colors by type
    const typeColors: Record<string, string> = {
      stock: '#ef5350', index: '#e8a838', sector: '#64B5F6', policy_body: '#CE93D8',
    };

    // Clone nodes/edges (D3 mutates them)
    const nodes: CoOccurrenceNode[] = data.nodes.map(n => ({ ...n }));
    const edges: CoOccurrenceEdge[] = data.edges.map(e => ({ ...e }));

    // Simulation — tighter layout with bounding box
    this.simulation?.stop();
    const sim = d3.forceSimulation<CoOccurrenceNode>(nodes)
      .force('link', d3.forceLink<CoOccurrenceNode, CoOccurrenceEdge>(edges).id(d => d.id).distance(70))
      .force('charge', d3.forceManyBody().strength(-80))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide<CoOccurrenceNode>().radius(d => rScale(d.mentions) + 8))
      .force('x', d3.forceX(width / 2).strength(0.05))
      .force('y', d3.forceY(height / 2).strength(0.05));
    this.simulation = sim;

    // Edges
    const edgeG = svg.append('g');
    const edgeLines = edgeG.selectAll<SVGLineElement, CoOccurrenceEdge>('line')
      .data(edges).join('line')
      .attr('class', 'co-edge')
      .attr('stroke-width', d => wScale(d.weight));

    // Node groups
    const nodeG = svg.append('g');
    const nodeGroups = nodeG.selectAll<SVGGElement, CoOccurrenceNode>('g')
      .data(nodes).join('g')
      .attr('class', 'co-node');

    // Circle with glow effect
    nodeGroups.append('circle')
      .attr('r', d => rScale(d.mentions))
      .attr('fill', d => typeColors[d.type] || '#9E9E9E')
      .attr('opacity', 0.85)
      .attr('stroke', d => typeColors[d.type] || '#9E9E9E')
      .attr('stroke-width', 2)
      .attr('stroke-opacity', 0.3);

    // Label — show full name (up to 12 chars for Chinese names)
    nodeGroups.append('text')
      .attr('class', 'co-label')
      .attr('dy', d => rScale(d.mentions) + 13)
      .text(d => d.name.length > 12 ? d.name.slice(0, 11) + '…' : d.name);


    // Hover
    nodeGroups.on('mouseenter', (_event, d) => {
      const connectedIds = new Set<string>();
      edges.forEach(e => {
        const sId = typeof e.source === 'string' ? e.source : (e.source as CoOccurrenceNode).id;
        const tId = typeof e.target === 'string' ? e.target : (e.target as CoOccurrenceNode).id;
        if (sId === d.id) connectedIds.add(tId);
        if (tId === d.id) connectedIds.add(sId);
      });
      nodeGroups.attr('opacity', n => n.id === d.id || connectedIds.has(n.id) ? 1 : 0.2);
      edgeLines.attr('opacity', e => {
        const sId = typeof e.source === 'string' ? e.source : (e.source as CoOccurrenceNode).id;
        const tId = typeof e.target === 'string' ? e.target : (e.target as CoOccurrenceNode).id;
        return sId === d.id || tId === d.id ? 0.8 : 0.05;
      });
      if (tooltip) {
        tooltip.textContent = `${d.name} (${d.sector}) · ${d.mentions}次提及`;
        tooltip.classList.add('visible');
      }
    })
    .on('mousemove', (event) => {
      if (tooltip) {
        const rect = container.getBoundingClientRect();
        let left = event.clientX - rect.left + 10;
        let top = event.clientY - rect.top - 20;
        // Prevent tooltip overflow on right/bottom edges
        const tipW = tooltip.offsetWidth || 150;
        const tipH = tooltip.offsetHeight || 30;
        if (left + tipW > rect.width) left = rect.width - tipW - 5;
        if (top + tipH > rect.height) top = top - tipH - 10;
        if (top < 0) top = 5;
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
      }
    })
    .on('mouseleave', () => {
      nodeGroups.attr('opacity', 1);
      edgeLines.attr('opacity', 1);
      if (tooltip) tooltip.classList.remove('visible');
    });

    // Click → dispatch entity event
    nodeGroups.on('click', (_event, d) => {
      window.dispatchEvent(new CustomEvent('cn-entity-click', {
        detail: { name: d.name, type: d.type },
      }));
    });

    // Drag
    const drag = d3.drag<SVGGElement, CoOccurrenceNode>()
      .on('start', (event, d) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
    nodeGroups.call(drag);

    // Tick — clamp nodes inside viewBox
    sim.on('tick', () => {
      nodes.forEach(d => {
        const r = rScale(d.mentions);
        d.x = Math.max(pad + r, Math.min(width - pad - r, d.x ?? width / 2));
        d.y = Math.max(pad + r, Math.min(height - pad - r, d.y ?? height / 2));
      });
      edgeLines
        .attr('x1', d => (d.source as CoOccurrenceNode).x ?? 0)
        .attr('y1', d => (d.source as CoOccurrenceNode).y ?? 0)
        .attr('x2', d => (d.target as CoOccurrenceNode).x ?? 0)
        .attr('y2', d => (d.target as CoOccurrenceNode).y ?? 0);
      nodeGroups.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });
  }

  /* ---- Entity sentiment ---- */
  private async fetchEntitySentiment(): Promise<void> {
    if (this.entitySentimentLoading) return;
    this.entitySentimentLoading = true;
    this.entitySentimentVisible = true;
    this.renderPanel();
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/mood/entity-sentiment?top_n=15`, { signal: this.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.entitySentimentData = await res.json();
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.entitySentimentData = { entities: [], total_posts_analyzed: 0, timestamp: '' };
    } finally {
      this.entitySentimentLoading = false;
      this.renderPanel();
    }
  }

  private buildEntitySentimentHtml(): string {
    if (this.entitySentimentLoading) {
      return '<div class="cn-entity-sentiment"><div class="cn-mood-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 加载实体情绪中...</div></div>';
    }
    if (!this.entitySentimentData || this.entitySentimentData.entities.length === 0) {
      return '<div class="cn-entity-sentiment"><div class="cn-mood-empty">暂无实体情绪数据</div></div>';
    }
    const items = this.entitySentimentData.entities.slice(0, 12);
    const rows = items.map(ent => {
      const total = ent.total || 1;
      const posPct = Math.round((ent.positive / total) * 100);
      const negPct = Math.round((ent.negative / total) * 100);
      const neuPct = 100 - posPct - negPct;
      const scoreColor = ent.sentimentScore > 20 ? '#E53935' : ent.sentimentScore < -20 ? '#43A047' : '#9E9E9E';
      return `<div class="cn-entity-row" data-entity-name="${escapeHtml(ent.name)}" data-entity-type="stock">
        <span class="cn-entity-row-name" title="${escapeHtml(ent.name)}">${escapeHtml(ent.name)}</span>
        <div class="cn-entity-sentiment-bar-track">
          ${posPct > 0 ? `<div class="cn-entity-sentiment-bar-seg es-pos" style="width:${posPct}%" title="正面 ${ent.positive}"></div>` : ''}
          ${neuPct > 0 ? `<div class="cn-entity-sentiment-bar-seg es-neu" style="width:${neuPct}%" title="中性 ${ent.neutral}"></div>` : ''}
          ${negPct > 0 ? `<div class="cn-entity-sentiment-bar-seg es-neg" style="width:${negPct}%" title="负面 ${ent.negative}"></div>` : ''}
        </div>
        <span class="cn-entity-row-score" style="color:${scoreColor}">${ent.sentimentScore > 0 ? '+' : ''}${ent.sentimentScore}</span>
        <span class="cn-entity-row-total">${ent.total}</span>
      </div>`;
    }).join('');
    return `<div class="cn-entity-sentiment">
      <div class="cn-entity-sentiment-title"><i class="bi bi-people"></i> 实体情绪 <span style="opacity:0.5;font-size:9px;margin-left:auto">${this.entitySentimentData.total_posts_analyzed}篇分析</span></div>
      ${rows}
    </div>`;
  }

  private renderPanel(): void {
    if (!this.data) {
      // If AI report or gov report is loading, show that instead of "暂无数据"
      if (this.moodReportLoading || this.govReportLoading) {
        this.content.innerHTML = `<div style="padding:16px;text-align:center;opacity:.6">
          <i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> AI正在生成报告，请稍候...
        </div>`;
        return;
      }
      this.showError('暂无数据');
      return;
    }

    const d = this.data;
    const platforms: Record<string, MoodPost[]> = d.platforms ? { ...d.platforms } : {
      weibo: d.weibo || [],
      zhihu: d.zhihu || [],
      bilibili: d.xiaohongshu || [],
    };

    // Inject DB news as a virtual platform
    if (this.dbNewsData.length > 0) {
      platforms['db-news'] = this.dbNewsData.map(a => ({
        id: a.id,
        content: `[${a.typeLabel}] ${a.title}${a.summary ? ' — ' + a.summary.slice(0, 60) : ''}`,
        sentiment: (a.emotion === '正面' ? '正面' : a.emotion === '负面' ? '负面' : '中性') as '正面' | '负面' | '中性',
        engagement: 0,
        author: a.source,
        platform: 'db-news',
        url: a.link || undefined,
      }));
    } else if (this.activePlatformCategory === '新闻数据库') {
      // Show placeholder even if no data yet
      platforms['db-news'] = [];
    }

    // Platform category chips
    const allPlatformKeys = Object.keys(platforms) as PlatformKey[];
    const pcatChipsHtml = PLATFORM_CATEGORY_KEYS.map(cat => {
      const catPlatforms = (PLATFORM_CATEGORIES[cat] || []).filter(k => allPlatformKeys.includes(k));
      const count = catPlatforms.length;
      return `<button class="cn-mood-pcat-chip ${cat === this.activePlatformCategory ? 'active' : ''}" data-pcat="${cat}">${cat}<span class="pcat-count">${count}</span></button>`;
    }).join('');

    // Filter platform tabs by active platform category
    const visiblePlatforms = (PLATFORM_CATEGORIES[this.activePlatformCategory] || []).filter(k => allPlatformKeys.includes(k));
    // Also include uncategorized platforms if any
    const uncategorized = allPlatformKeys.filter(k => !ALL_CATEGORIZED.has(k));
    const platformKeys = [...visiblePlatforms, ...uncategorized];

    if (!platformKeys.includes(this.activeTab) && platformKeys.length > 0) {
      this.activeTab = platformKeys[0]!;
    }

    const tabsHtml = platformKeys.map(key => {
      const label = PLATFORM_LABELS[key] || key;
      const count = platforms[key]?.length || 0;
      return `<button class="cn-mood-tab ${key === this.activeTab ? 'active' : ''}" data-tab="${key}">${label}<span class="tab-count">${count}</span></button>`;
    }).join('');

    // Category chips (or DB news type filter when in 新闻数据库 mode, or gov filter when in 官媒 mode)
    const isDbNewsMode = this.activePlatformCategory === '新闻数据库';
    const isGovNewsMode = this.activePlatformCategory === '官媒';
    let chipsHtml: string;
    if (isDbNewsMode) {
      chipsHtml = DB_NEWS_TYPE_FILTERS.map(f =>
        `<button class="cn-mood-cat-chip cn-mood-newstype-chip ${f.key === this.dbNewsTypeFilter ? 'active' : ''}" data-newstype="${f.key}">${f.label}</button>`
      ).join('');
    } else if (isGovNewsMode) {
      const reportBtnLabel = this.govReportVisible ? '关闭日报' : 'AI政策日报';
      const reportBtnIcon = this.govReportLoading ? 'bi-arrow-repeat' : 'bi-file-earmark-text';
      const reportBtnSpin = this.govReportLoading ? ' style="animation:spin 1s linear infinite"' : '';
      chipsHtml = GOV_CATEGORY_FILTERS.map(f =>
        `<button class="cn-mood-cat-chip cn-mood-govcat-chip ${f.key === this.govNewsCategoryFilter ? 'active' : ''}" data-govcat="${f.key}">${f.label}</button>`
      ).join('') + `<button class="cn-mood-cat-chip cn-gov-report-btn" style="margin-left:auto;background:rgba(232,168,56,0.15);color:#e8a838;border-color:rgba(232,168,56,0.3)"><i class="bi ${reportBtnIcon}"${reportBtnSpin}></i> ${reportBtnLabel}</button>`;
    } else {
      chipsHtml = CATEGORY_LIST.map(cat =>
        `<button class="cn-mood-cat-chip ${cat === this.activeCategory ? 'active' : ''}" data-category="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`
      ).join('');
    }

    // Stats bar
    const statsHtml = buildStatsBar(d.distribution);

    // Overview: sentiment bar + hot topics
    const overviewHtml = buildOverviewSection(d.distribution, d.trend, d.keywords || []);

    // Category heatmap
    const heatmapHtml = buildCategoryHeatmap(d.categories);

    // Platform comparison — filter by active platform category
    let platformCompareHtml = '';
    if (d.platformBreakdown) {
      const catPlatformKeys = (PLATFORM_CATEGORIES[this.activePlatformCategory] || []);
      const filteredBreakdown: PlatformBreakdown = {};
      for (const k of catPlatformKeys) {
        if (d.platformBreakdown[k]) filteredBreakdown[k] = d.platformBreakdown[k];
      }
      platformCompareHtml = Object.keys(filteredBreakdown).length > 0
        ? buildPlatformCompare(filteredBreakdown)
        : buildPlatformCompare(d.platformBreakdown);
    }

    // Filter posts by category
    let posts: MoodPost[] = platforms[this.activeTab] || [];
    if (!isDbNewsMode && !isGovNewsMode && this.activeCategory !== '全部') {
      posts = posts.filter(p => p.category === this.activeCategory);
    }

    let postsHtml: string;
    if (isGovNewsMode) {
      postsHtml = this.renderGovNews();
    } else if (isDbNewsMode && this.dbNewsLoading) {
      postsHtml = '<div class="cn-mood-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 加载新闻数据中...</div>';
    } else if (isDbNewsMode) {
      // Render DB news articles with click-to-open-detail
      const articles = this.dbNewsData;
      if (articles.length === 0) {
        postsHtml = '<div class="cn-mood-empty">暂无新闻数据</div>';
      } else {
        const newIds = new Set<string>();
        postsHtml = articles.slice(0, 30).map(a => {
            const tagColor = a.emotion === '正面' ? SENTIMENT_COLORS['正面'] : a.emotion === '负面' ? SENTIMENT_COLORS['负面'] : SENTIMENT_COLORS['中性'];
            const tagBg = sentimentBgColor(a.emotion === '正面' ? '正面' : a.emotion === '负面' ? '负面' : '中性');
            const emotionLabel = a.emotion || '中性';
            const contentIcon = a.hasContent ? '<i class="bi bi-file-text cn-mood-post-has-content" title="有正文"></i>' : '';
            const isNew = this.seenDbNewsIds.size > 0 && !this.seenDbNewsIds.has(a.id);
            const newClass = isNew ? ' spark-new-item' : '';
            newIds.add(a.id);
            return `
              <div class="cn-mood-post${newClass}" data-news-id="${escapeHtml(a.id)}" style="cursor:pointer">
                <div class="cn-mood-post-content">[${escapeHtml(a.typeLabel)}] ${escapeHtml(a.title)}</div>
                <div class="cn-mood-post-footer">
                  <i class="bi bi-newspaper cn-mood-post-platform-icon"></i>
                  <span class="cn-mood-sentiment-tag" style="background:${tagBg};color:${tagColor}">${escapeHtml(emotionLabel)}</span>
                  <span class="cn-mood-category-tag">${escapeHtml(a.typeLabel)}</span>
                  ${contentIcon}
                  ${a.source ? `<span class="cn-mood-post-author">${escapeHtml(a.source)}</span>` : ''}
                  ${a.date ? `<span class="cn-mood-post-engagement">${escapeHtml(a.date)}</span>` : ''}
                </div>
              </div>
            `;
          }).join('');
        // Update seen IDs
        this.seenDbNewsIds = newIds;
      }
    } else {
      // Track new social posts
      const newPostKeys = new Set<string>();
      const allPostKeys = new Set<string>();
      posts.slice(0, 15).forEach(p => {
        const key = `${p.platform || ''}:${p.url || p.id || p.content.slice(0, 40)}`;
        allPostKeys.add(key);
        if (this.seenPostKeys.size > 0 && !this.seenPostKeys.has(key)) {
          newPostKeys.add(key);
        }
      });
      this.seenPostKeys = allPostKeys;

      postsHtml = posts.length === 0
        ? '<div class="cn-mood-empty">暂无数据</div>'
        : posts.slice(0, 15).map(p => {
            const tagColor = SENTIMENT_COLORS[p.sentiment] || SENTIMENT_COLORS['中性'];
            const tagBg = sentimentBgColor(p.sentiment);
            const platformIcon = PLATFORM_ICONS[p.platform || ''] || 'bi-chat-left';
            const hotBadge = (p.engagement && p.engagement >= 10000) ? '<i class="bi bi-fire cn-mood-post-hot"></i>' : '';
            const urlLink = p.url ? `<a class="cn-mood-post-url" href="${escapeHtml(p.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="bi bi-box-arrow-up-right"></i></a>` : '';
            const excerptAttr = p.excerpt ? ` data-post-excerpt="${escapeHtml(p.excerpt)}"` : '';
            const clickAttrs = p.url ? ` data-post-url="${escapeHtml(p.url)}" data-post-platform="${escapeHtml(p.platform || '')}"${excerptAttr} style="cursor:pointer"` : '';
            const postKey = `${p.platform || ''}:${p.url || p.id || p.content.slice(0, 40)}`;
            const isNewPost = newPostKeys.has(postKey);
            return `
              <div class="cn-mood-post${isNewPost ? ' spark-new-item' : ''}"${clickAttrs}>
                <div class="cn-mood-post-content">${escapeHtml(p.content)}</div>
                <div class="cn-mood-post-footer">
                  <i class="${platformIcon} cn-mood-post-platform-icon"></i>
                  <span class="cn-mood-sentiment-tag" style="background:${tagBg};color:${tagColor}">${escapeHtml(p.sentiment)}</span>
                  ${hotBadge}
                  ${p.category ? `<span class="cn-mood-category-tag">${escapeHtml(p.category)}</span>` : ''}
                  ${p.engagement ? `<span class="cn-mood-post-engagement">${formatEngagement(p.engagement)}</span>` : ''}
                  ${p.author ? `<span class="cn-mood-post-author">@${escapeHtml(p.author)}</span>` : ''}
                  ${urlLink}
                </div>
              </div>
            `;
          }).join('');
    }

    // AI report button + drawer (rendered at top, like PolicyPanel)
    const { buttonHtml: aiButtonHtml, drawerHtml: aiDrawerHtml } = this.renderAiSection();

    // Network + sentiment toggle buttons
    const networkBtnHtml = `<button class="cn-mood-network-btn ${this.coOccurrenceVisible ? 'active' : ''}"><i class="bi bi-diagram-3"></i> 图谱</button>`;
    const sentimentBtnHtml = `<button class="cn-mood-sentiment-btn ${this.entitySentimentVisible ? 'active' : ''}"><i class="bi bi-people"></i> 实体</button>`;

    // Co-occurrence graph section
    let coOccurrenceHtml = '';
    if (this.coOccurrenceVisible) {
      if (this.coOccurrenceLoading) {
        coOccurrenceHtml = '<div class="cn-cooccurrence-container"><div class="cn-mood-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 加载共现网络中...</div></div>';
      } else if (this.coOccurrenceData && this.coOccurrenceData.nodes.length > 0) {
        coOccurrenceHtml = `<div class="cn-cooccurrence-container"><svg class="cn-cooccurrence-svg"></svg><div class="cn-cooccurrence-tooltip"></div><div class="cn-cooccurrence-legend"><span><i style="background:#ef5350"></i>个股</span><span><i style="background:#e8a838"></i>指数</span><span><i style="background:#64B5F6"></i>板块</span><span><i style="background:#CE93D8"></i>政策</span></div></div>`;
      } else if (this.coOccurrenceData) {
        coOccurrenceHtml = '<div class="cn-cooccurrence-container"><div class="cn-mood-empty">暂无共现数据</div></div>';
      }
    }

    // Entity sentiment section
    const entitySentimentHtml = this.entitySentimentVisible ? this.buildEntitySentimentHtml() : '';

    this.setContent(`${STYLE}
      <div class="cn-mood-container">
        ${statsHtml}
        <div class="cn-mood-platform-cats">${pcatChipsHtml}${networkBtnHtml}${sentimentBtnHtml}${aiButtonHtml}</div>
        ${aiDrawerHtml}
        ${coOccurrenceHtml}
        ${entitySentimentHtml}
        <div class="cn-mood-tabs">${tabsHtml}</div>
        <div class="cn-mood-category-chips">${chipsHtml}</div>
        ${overviewHtml}
        ${heatmapHtml}
        ${platformCompareHtml}
        <div class="cn-mood-posts">${postsHtml}</div>
      </div>
    `);
    // Re-mount D3 force graph after setContent() destroys DOM
    if (this.coOccurrenceVisible && this.coOccurrenceData && this.coOccurrenceData.nodes.length > 0) {
      setTimeout(() => this.mountForceGraph(), 200);
    }
  }

  /** Convert AI report markdown to styled HTML */
  private reportToHtml(md: string): string {
    return md
      // Headings: # → h1 (ignored), ## → section header, ### → sub-header
      .replace(/^# (.+)$/gm, '<div class="cn-report-h2" style="font-size:14px;margin-top:0">$1</div>')
      .replace(/^## (.+)$/gm, '<div class="cn-report-h2">$1</div>')
      .replace(/^### (.+)$/gm, '<div class="cn-report-h3">$1</div>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<span class="cn-report-strong">$1</span>')
      // Italic
      .replace(/\*(.+?)\*/g, '<em style="color:rgba(255,255,255,0.7)">$1</em>')
      // Numbered lists
      .replace(/^\d+\.\s+(.+)$/gm, '<div class="cn-report-bullet">$1</div>')
      // Bullet lists (- or *)
      .replace(/^[-*]\s+(.+)$/gm, '<div class="cn-report-bullet">$1</div>')
      // Double newlines → paragraph break
      .replace(/\n\n/g, '<div style="height:6px"></div>')
      // Single newlines → line break
      .replace(/\n/g, '<br>');
  }

  private renderGovNews(): string {
    // AI Report drawer (shown above news list)
    let reportHtml = '';
    if (this.govReportVisible) {
      if (this.govReportLoading) {
        reportHtml = '<div class="cn-gov-report-drawer"><div class="cn-mood-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> AI正在生成政策日报...</div></div>';
      } else if (this.govReportData) {
        const reportContent = this.reportToHtml(this.govReportData.report);
        reportHtml = `<div class="cn-gov-report-drawer">
          <div class="cn-gov-report-header">
            <span><i class="bi bi-file-earmark-text"></i> AI政策日报</span>
            <button class="cn-gov-report-close"><i class="bi bi-x-lg"></i></button>
          </div>
          <div class="cn-gov-report-body">${reportContent}</div>
        </div>`;
      }
    }

    if (this.govNewsLoading) {
      return reportHtml + '<div class="cn-mood-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> 加载官媒新闻中...</div>';
    }
    if (!this.govNewsData) {
      return reportHtml + '<div class="cn-mood-empty">暂无数据</div>';
    }

    // Filter by category
    let items: GovNewsItem[] = [];
    if (this.govNewsCategoryFilter === 'all') {
      items = this.govNewsData.all || [];
    } else {
      items = (this.govNewsData.categories || {})[this.govNewsCategoryFilter] || [];
    }

    if (items.length === 0) {
      return reportHtml + '<div class="cn-mood-empty">该类别暂无新闻</div>';
    }

    // Source summary bar
    const sources = this.govNewsData.sources || {};
    const activeSourceCount = Object.values(sources).filter(n => n > 0).length;
    const totalSources = Object.keys(sources).length;
    const summaryHtml = `<div class="cn-mood-stats-bar">
      <div class="cn-mood-stat"><i class="bi bi-newspaper"></i> <span class="stat-val">${this.govNewsData.total}</span> 条</div>
      <div class="cn-mood-stat"><i class="bi bi-flag-fill"></i> <span class="stat-val">${activeSourceCount}/${totalSources}</span> 源</div>
    </div>`;

    const newsHtml = items.slice(0, 40).map((item, i) => {
      const catColor = this.govCategoryColor(item.category);
      const icon = item.icon || 'bi-flag-fill';
      return `
        <div class="cn-mood-post" data-gov-idx="${i}" style="cursor:pointer">
          <div class="cn-mood-post-content">${escapeHtml(item.title)}</div>
          <div class="cn-mood-post-footer">
            <i class="bi ${icon} cn-mood-post-platform-icon"></i>
            <span class="cn-mood-platform-tag">${escapeHtml(item.source)}</span>
            <span class="cn-mood-category-tag" style="background:${catColor.bg};color:${catColor.fg}">${escapeHtml(item.category)}</span>
            ${item.date ? `<span class="cn-mood-post-engagement">${escapeHtml(item.date)}</span>` : ''}
            ${item.url ? `<a class="cn-mood-post-url" href="${escapeHtml(item.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="bi bi-box-arrow-up-right"></i></a>` : ''}
          </div>
        </div>
      `;
    }).join('');

    return reportHtml + summaryHtml + newsHtml;
  }

  private renderAiSection(): { buttonHtml: string; drawerHtml: string } {
    // AI Report button (inline in platform-cats bar) + drawer (below bar)
    const reportBtnLabel = this.moodReportVisible ? '关闭分析' : 'AI舆情分析';
    const reportBtnIcon = this.moodReportLoading ? 'bi-arrow-repeat' : 'bi-graph-up';
    const reportBtnSpin = this.moodReportLoading ? ' style="animation:spin 1s linear infinite"' : '';
    const buttonHtml = `<button class="cn-mood-report-btn" style="margin-left:auto"><i class="bi ${reportBtnIcon}"${reportBtnSpin}></i> ${reportBtnLabel}</button>`;

    let drawerHtml = '';
    if (this.moodReportVisible) {
      if (this.moodReportLoading) {
        drawerHtml = '<div class="cn-mood-ai-drawer"><div class="cn-mood-empty"><i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> AI正在分析舆情...</div></div>';
      } else if (this.moodReportData) {
        const content = this.reportToHtml(this.moodReportData.report);
        drawerHtml = `<div class="cn-mood-ai-drawer">
          <div class="cn-mood-ai-drawer-header">
            <span><i class="bi bi-graph-up"></i> AI舆情分析</span>
            <button class="cn-mood-report-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:14px"><i class="bi bi-x-lg"></i></button>
          </div>
          <div class="cn-mood-ai-drawer-body">${content}</div>
        </div>`;
      }
    }

    return { buttonHtml, drawerHtml };
  }

  private getGovVisibleItems(): GovNewsItem[] {
    if (!this.govNewsData) return [];
    if (this.govNewsCategoryFilter === 'all') {
      return (this.govNewsData.all || []).slice(0, 40);
    }
    return ((this.govNewsData.categories || {})[this.govNewsCategoryFilter] || []).slice(0, 40);
  }

  private govCategoryColor(cat: string): { bg: string; fg: string } {
    switch (cat) {
      case '央媒': return { bg: 'rgba(229,57,53,0.12)', fg: '#E53935' };
      case '财政货币': return { bg: 'rgba(232,168,56,0.12)', fg: '#e8a838' };
      case '金融监管': return { bg: 'rgba(33,150,243,0.12)', fg: '#64B5F6' };
      case '国务院': return { bg: 'rgba(171,71,188,0.12)', fg: '#AB47BC' };
      case '统计': return { bg: 'rgba(67,160,71,0.12)', fg: '#43A047' };
      case '理论': return { bg: 'rgba(255,152,0,0.12)', fg: '#FF9800' };
      case '海外': return { bg: 'rgba(0,188,212,0.12)', fg: '#00BCD4' };
      case '财经媒体': return { bg: 'rgba(255,87,34,0.12)', fg: '#FF5722' };
      case '智库': return { bg: 'rgba(121,85,72,0.12)', fg: '#8D6E63' };
      case '外贸外交': return { bg: 'rgba(0,150,136,0.12)', fg: '#009688' };
      default: return { bg: 'rgba(158,158,158,0.12)', fg: '#9E9E9E' };
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
    if (this.simulation) {
      this.simulation.stop();
      this.simulation = null;
    }
    super.destroy();
  }
}

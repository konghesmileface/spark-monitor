import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';
const POLL_INTERVAL = 300_000; // 300s

interface SentimentFactor {
  name: string;
  score: number;
  description?: string;
}

interface TrendPoint {
  date: string;
  score: number;
}

interface CnSentimentData {
  score: number;
  label: string;
  trend: TrendPoint[];
  factors: SentimentFactor[];
  timestamp: string;
}

interface SentimentInsights {
  trend: 'improving' | 'worsening' | 'stable';
  topConcerns: string[];
  bullishFactors: string[];
  summary: string;
}

/* ── Color helpers ──────────────────────────────────────────────── */

function sentimentColor(score: number): string {
  if (score >= 80) return '#c62828';
  if (score >= 60) return '#ff5722';
  if (score >= 40) return '#9e9e9e';
  if (score >= 20) return '#43a047';
  return '#1b5e20';
}

function sentimentLabel(score: number): string {
  if (score >= 80) return '极度贪婪';
  if (score >= 60) return '贪婪';
  if (score >= 40) return '中性';
  if (score >= 20) return '恐惧';
  return '极度恐惧';
}

function factorBarColor(score: number): string {
  if (score >= 70) return '#e53935';
  if (score >= 50) return '#ff9800';
  if (score >= 30) return '#9e9e9e';
  return '#43a047';
}

function factorIcon(name: string): string {
  const map: Record<string, string> = {
    '涨跌比': 'bi-bar-chart-fill',
    '成交量': 'bi-graph-up-arrow',
    '北向资金': 'bi-arrow-left-right',
    '波动率': 'bi-lightning-charge-fill',
    '融资融券': 'bi-bank2',
  };
  const cls = map[name] || 'bi-circle-fill';
  return `<i class="bi ${cls}"></i>`;
}

/* ── SVG gauge with tick marks & glow ──────────────────────────── */

function buildGaugeSvg(score: number): string {
  const cx = 120;
  const cy = 95;
  const outerR = 82;
  const innerR = 68;
  const startAngle = Math.PI;
  const totalAngle = Math.PI;

  // Arc coordinates
  const arcPath = (r: number) => {
    const sx = cx + r * Math.cos(startAngle);
    const sy = cy - r * Math.sin(startAngle);
    const ex = cx + r * Math.cos(0);
    const ey = cy - r * Math.sin(0);
    return `M ${sx} ${sy} A ${r} ${r} 0 0 1 ${ex} ${ey}`;
  };

  // Tick marks (every 10 units)
  const ticks: string[] = [];
  for (let i = 0; i <= 10; i++) {
    const angle = startAngle - (i / 10) * totalAngle;
    const isMajor = i % 5 === 0;
    const r1 = outerR + 2;
    const r2 = outerR + (isMajor ? 8 : 5);
    const x1 = cx + r1 * Math.cos(angle);
    const y1 = cy - r1 * Math.sin(angle);
    const x2 = cx + r2 * Math.cos(angle);
    const y2 = cy - r2 * Math.sin(angle);
    ticks.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(255,255,255,${isMajor ? 0.25 : 0.1})" stroke-width="${isMajor ? 1.5 : 0.8}"/>`);
  }

  // Filled arc (shows progress)
  const scoreAngle = startAngle - (score / 100) * totalAngle;
  const fillEndX = cx + innerR * Math.cos(scoreAngle);
  const fillEndY = cy - innerR * Math.sin(scoreAngle);
  const fillStartX = cx + innerR * Math.cos(startAngle);
  const fillStartY = cy - innerR * Math.sin(startAngle);
  const largeArc = score > 50 ? 1 : 0;

  // Needle
  const needleLen = innerR - 12;
  const needleX = cx + needleLen * Math.cos(scoreAngle);
  const needleY = cy - needleLen * Math.sin(scoreAngle);

  const color = sentimentColor(score);
  const label = sentimentLabel(score);

  // Scale labels at 0, 25, 50, 75, 100
  const scaleLabels = [0, 25, 50, 75, 100].map(v => {
    const a = startAngle - (v / 100) * totalAngle;
    const lr = outerR + 15;
    const x = cx + lr * Math.cos(a);
    const y = cy - lr * Math.sin(a);
    return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="7">${v}</text>`;
  });

  return `
    <svg viewBox="0 0 240 125" class="cn-sentiment-gauge">
      <defs>
        <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#1b5e20"/>
          <stop offset="25%" stop-color="#43a047"/>
          <stop offset="50%" stop-color="#9e9e9e"/>
          <stop offset="75%" stop-color="#ff5722"/>
          <stop offset="100%" stop-color="#c62828"/>
        </linearGradient>
        <filter id="gaugeGlow">
          <feGaussianBlur stdDeviation="3" result="blur"/>
          <feComposite in="SourceGraphic" in2="blur" operator="over"/>
        </filter>
        <filter id="needleShadow">
          <feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="${color}" flood-opacity="0.5"/>
        </filter>
      </defs>

      <!-- Tick marks -->
      ${ticks.join('\n      ')}
      <!-- Scale labels -->
      ${scaleLabels.join('\n      ')}

      <!-- Background arc -->
      <path d="${arcPath(innerR)}"
        fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="12" stroke-linecap="round"/>

      <!-- Gradient arc -->
      <path d="${arcPath(innerR)}"
        fill="none" stroke="url(#gaugeGrad)" stroke-width="8" stroke-linecap="round" opacity="0.4"/>

      <!-- Active fill arc -->
      <path d="M ${fillStartX.toFixed(1)} ${fillStartY.toFixed(1)} A ${innerR} ${innerR} 0 ${largeArc} 1 ${fillEndX.toFixed(1)} ${fillEndY.toFixed(1)}"
        fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" opacity="0.9"
        filter="url(#gaugeGlow)"/>

      <!-- Needle -->
      <line x1="${cx}" y1="${cy}" x2="${needleX.toFixed(1)}" y2="${needleY.toFixed(1)}"
        stroke="${color}" stroke-width="2.5" stroke-linecap="round" filter="url(#needleShadow)"/>

      <!-- Center hub -->
      <circle cx="${cx}" cy="${cy}" r="5" fill="${color}" opacity="0.8"/>
      <circle cx="${cx}" cy="${cy}" r="3" fill="var(--bg-card, #1a1a2e)"/>

      <!-- Score -->
      <text x="${cx}" y="${cy - 18}" text-anchor="middle" fill="${color}" font-size="28" font-weight="800" letter-spacing="-1">${score}</text>
      <!-- Label badge -->
      <rect x="${cx - 28}" y="${cy + 2}" width="56" height="16" rx="8" fill="${color}" opacity="0.15"/>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="${color}" font-size="10" font-weight="600">${label}</text>
    </svg>
  `;
}

/* ── Trend chart with area fill ────────────────────────────────── */

function buildTrendSvg(trend: TrendPoint[]): string {
  if (!trend || trend.length === 0) {
    return `
      <div class="cn-sentiment-trend">
        <div class="cn-trend-header">
          <span class="cn-trend-label">7日趋势</span>
        </div>
        <div style="text-align:center;font-size:10px;color:var(--text-dim);padding:8px 0;opacity:0.5">
          数据积累中
        </div>
      </div>
    `;
  }
  if (trend.length < 2) return '';

  const width = 280;
  const height = 56;
  const pad = 6;
  const scores = trend.map(p => p.score);
  const min = Math.min(...scores, 0);
  const max = Math.max(...scores, 100);
  const range = max - min || 1;

  const pts = trend.map((p, i) => ({
    x: pad + (i / (trend.length - 1)) * (width - 2 * pad),
    y: pad + (1 - (p.score - min) / range) * (height - 2 * pad),
  }));

  const polyline = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  // Area fill path (polyline + bottom-right + bottom-left)
  const areaPath = `M ${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)} ` +
    pts.slice(1).map(p => `L ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') +
    ` L ${pts[pts.length - 1]!.x.toFixed(1)},${height} L ${pts[0]!.x.toFixed(1)},${height} Z`;

  const lastScore = scores[scores.length - 1] ?? 50;
  const firstScore = scores[0] ?? 50;
  const delta = lastScore - firstScore;
  const deltaSign = delta > 0 ? '+' : '';
  const deltaColor = delta > 0 ? '#e53935' : delta < 0 ? '#43a047' : '#9e9e9e';
  const color = sentimentColor(lastScore);

  const firstDate = trend[0]?.date?.slice(5) ?? '';
  const lastDate = trend[trend.length - 1]?.date?.slice(5) ?? '';

  // Zone bands
  const y50 = pad + (1 - (50 - min) / range) * (height - 2 * pad);

  return `
    <div class="cn-sentiment-trend">
      <div class="cn-trend-header">
        <span class="cn-trend-label">7日趋势</span>
        <span class="cn-trend-delta" style="color:${deltaColor}">${deltaSign}${delta}</span>
      </div>
      <svg viewBox="0 0 ${width} ${height + 14}" width="100%" height="${height + 18}">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.2"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <!-- 50-line -->
        <line x1="${pad}" y1="${y50.toFixed(1)}" x2="${width - pad}" y2="${y50.toFixed(1)}"
              stroke="rgba(255,255,255,0.06)" stroke-width="1" stroke-dasharray="3,3"/>
        <!-- Area -->
        <path d="${areaPath}" fill="url(#trendFill)"/>
        <!-- Line -->
        <polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <!-- Dots -->
        ${pts.map((p, i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${i === pts.length - 1 ? 3.5 : i === 0 ? 2.5 : 1.5}" fill="${sentimentColor(scores[i]!)}" opacity="${i === pts.length - 1 || i === 0 ? 1 : 0.5}"/>`).join('\n        ')}
        <!-- Dates -->
        <text x="${pad}" y="${height + 12}" fill="var(--text-dim)" font-size="8">${firstDate}</text>
        <text x="${width - pad}" y="${height + 12}" fill="var(--text-dim)" font-size="8" text-anchor="end">${lastDate}</text>
      </svg>
    </div>
  `;
}

/* ── Radar chart for factors ───────────────────────────────────── */

function buildRadarSvg(factors: SentimentFactor[]): string {
  if (!factors || factors.length < 3) return '';

  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = 58;
  const n = factors.length;

  // Grid rings
  const rings = [0.25, 0.5, 0.75, 1.0];
  const gridPaths = rings.map(pct => {
    const r = maxR * pct;
    const points = Array.from({ length: n }, (_, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
      return `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`;
    });
    return `<polygon points="${points.join(' ')}" fill="none" stroke="rgba(255,255,255,${pct === 1 ? 0.1 : 0.05})" stroke-width="0.5"/>`;
  });

  // Axis lines
  const axes = Array.from({ length: n }, (_, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const x = cx + maxR * Math.cos(angle);
    const y = cy + maxR * Math.sin(angle);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="0.5"/>`;
  });

  // Data polygon
  const dataPoints = factors.map((f, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const r = maxR * (f.score / 100);
    return {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    };
  });
  const dataPoly = dataPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  // Labels
  const labels = factors.map((f, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const lr = maxR + 14;
    const x = cx + lr * Math.cos(angle);
    const y = cy + lr * Math.sin(angle);
    const anchor = Math.abs(Math.cos(angle)) < 0.1 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end';
    const color = factorBarColor(f.score);
    return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="${anchor}" fill="var(--text-dim)" font-size="8">${f.name}</text>
    <text x="${x.toFixed(1)}" y="${(y + 12).toFixed(1)}" text-anchor="${anchor}" fill="${color}" font-size="8" font-weight="700">${f.score}</text>`;
  });

  // Dots on data vertices
  const dots = dataPoints.map((p, i) => {
    const color = factorBarColor(factors[i]!.score);
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${color}"/>`;
  });

  return `
    <svg viewBox="0 0 ${size} ${size}" class="cn-sentiment-radar">
      <defs>
        <linearGradient id="radarFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff5722" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#43a047" stop-opacity="0.1"/>
        </linearGradient>
      </defs>
      ${gridPaths.join('\n      ')}
      ${axes.join('\n      ')}
      <polygon points="${dataPoly}" fill="url(#radarFill)" stroke="#ff9800" stroke-width="1.5" stroke-linejoin="round" opacity="0.85"/>
      ${dots.join('\n      ')}
      ${labels.join('\n      ')}
    </svg>
  `;
}

/* ── Style ─────────────────────────────────────────────────────── */

const STYLE = `
<style>
.cn-sentiment-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.cn-sentiment-gauge {
  width: 100%;
  max-width: 240px;
  height: auto;
}
/* ── Trend ── */
.cn-sentiment-trend {
  width: 100%;
  margin: 2px 0 4px;
}
.cn-trend-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 4px;
  margin-bottom: 2px;
}
.cn-trend-label {
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.cn-trend-delta {
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
/* ── Radar ── */
.cn-sentiment-radar {
  width: 100%;
  max-width: 200px;
  height: auto;
  margin: 0 auto;
  display: block;
}
/* ── Factors section ── */
.cn-factors-title {
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 6px 0 4px;
  padding-bottom: 3px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  width: 100%;
}
.cn-factor-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  width: 100%;
}
.cn-factor-icon {
  font-size: 11px;
  width: 16px;
  text-align: center;
  flex-shrink: 0;
  color: var(--text-dim);
  opacity: 0.7;
}
.cn-factor-name {
  font-size: 11px;
  color: var(--text);
  width: 64px;
  flex-shrink: 0;
}
.cn-factor-bar-bg {
  flex: 1;
  height: 5px;
  background: rgba(255,255,255,0.06);
  border-radius: 2.5px;
  overflow: hidden;
  position: relative;
}
.cn-factor-bar-fill {
  height: 100%;
  border-radius: 2.5px;
  transition: width 0.3s ease;
}
.cn-factor-bar-bg::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  width: 1px;
  height: 100%;
  background: rgba(255,255,255,0.12);
}
.cn-factor-score {
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  width: 24px;
  text-align: right;
  flex-shrink: 0;
}
/* ── Insights ── */
.cn-insights-card {
  width: 100%;
  padding: 8px;
  border-radius: 8px;
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.04);
  margin-top: 4px;
}
.cn-insights-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.cn-insights-trend-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
}
.cn-tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
}
.cn-tag {
  padding: 1px 7px;
  font-size: 9px;
  border-radius: 3px;
  font-weight: 500;
}
.cn-tag-concern {
  background: rgba(67,160,71,0.1);
  color: #43a047;
}
.cn-tag-bullish {
  background: rgba(229,57,53,0.1);
  color: #e53935;
}
.cn-insights-summary {
  font-size: 10px;
  color: var(--text-dim);
  line-height: 1.5;
  padding-top: 4px;
  border-top: 1px solid rgba(255,255,255,0.04);
}
/* ── Pulse indicator ── */
.cn-pulse-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  margin: 2px 0;
}
.cn-pulse-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  animation: cn-pulse 2s ease-in-out infinite;
}
@keyframes cn-pulse {
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.3); }
}
.cn-pulse-text {
  font-size: 10px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
</style>
`;

/* ── Panel class ───────────────────────────────────────────────── */

export class CnSentimentPanel extends Panel {
  private timer: ReturnType<typeof setInterval> | null = null;
  private data: CnSentimentData | null = null;
  private insights: SentimentInsights | null = null;
  private lastFetchTime = 0;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super({ id: 'cn-sentiment', title: '市场情绪 <span class="spark-subtitle">SENTIMENT</span>' });
    void this.fetchData();
    this.timer = setInterval(() => void this.fetchData(), POLL_INTERVAL);
    this.freshnessTimer = setInterval(() => this.updateFreshness(), 30_000);
  }

  public async fetchData(): Promise<void> {
    if (!this.data) this.showLoading('加载情绪数据...');
    try {
      const [sentRes, geoRes] = await Promise.all([
        cnFetch(`${CN_INTEL_BASE}/api/cn/sentiment`, { signal: this.signal }),
        cnFetch(`${CN_INTEL_BASE}/api/cn/sentiment/regional`, { signal: this.signal }),
      ]);
      if (sentRes.ok) {
        this.data = await sentRes.json();
      }
      if (geoRes.ok) {
        const geoData = await geoRes.json();
        this.insights = geoData.insights || null;
      }
      this.lastFetchTime = Date.now();
      if ((this.data as any)?._stale) {
        this.setDataBadge('cached', '数据可能过时');
      } else {
        this.updateFreshness();
      }
      this.renderPanel();
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.showError('市场情绪数据加载失败');
    }
  }

  private renderPanel(): void {
    if (!this.data) {
      this.showError('暂无数据');
      return;
    }

    const d = this.data;
    const score = Math.max(0, Math.min(100, d.score));
    const color = sentimentColor(score);

    const gaugeSvg = buildGaugeSvg(score);
    const trendSvg = buildTrendSvg(d.trend);

    const defaultFactors: SentimentFactor[] = [
      { name: '涨跌比', score: 50 },
      { name: '成交量', score: 50 },
      { name: '北向资金', score: 50 },
      { name: '波动率', score: 50 },
      { name: '融资融券', score: 50 },
    ];
    const factors = d.factors && d.factors.length > 0 ? d.factors : defaultFactors;

    // Pulse indicator
    const pulseHtml = `
      <div class="cn-pulse-row">
        <div class="cn-pulse-dot" style="background:${color}"></div>
        <span class="cn-pulse-text">${sentimentLabel(score)} · 综合评分 ${score}</span>
      </div>
    `;

    // Radar chart
    const radarSvg = buildRadarSvg(factors);

    // Factor bars (compact)
    const factorsHtml = factors.map(f => `
      <div class="cn-factor-row">
        <span class="cn-factor-icon">${factorIcon(f.name)}</span>
        <span class="cn-factor-name">${escapeHtml(f.name)}</span>
        <div class="cn-factor-bar-bg">
          <div class="cn-factor-bar-fill" style="width:${f.score}%;background:${factorBarColor(f.score)}"></div>
        </div>
        <span class="cn-factor-score" style="color:${factorBarColor(f.score)}">${f.score}</span>
      </div>
    `).join('');

    // Insights
    let insightsHtml = '';
    if (this.insights) {
      const ins = this.insights;
      const trendArrow = ins.trend === 'improving' ? '↑' : ins.trend === 'worsening' ? '↓' : '→';
      const trendLabel = ins.trend === 'improving' ? '改善' : ins.trend === 'worsening' ? '恶化' : '平稳';
      const trendColor = ins.trend === 'improving' ? '#E53935' : ins.trend === 'worsening' ? '#43A047' : '#9E9E9E';
      const trendBg = ins.trend === 'improving' ? 'rgba(229,57,53,0.1)' : ins.trend === 'worsening' ? 'rgba(67,160,71,0.1)' : 'rgba(158,158,158,0.1)';

      const concernTags = (ins.topConcerns || []).map(w =>
        `<span class="cn-tag cn-tag-concern">${escapeHtml(w)}</span>`
      ).join('');

      const bullishTags = (ins.bullishFactors || []).map(w =>
        `<span class="cn-tag cn-tag-bullish">${escapeHtml(w)}</span>`
      ).join('');

      insightsHtml = `
        <div class="cn-insights-card">
          <div class="cn-insights-row">
            <span class="cn-insights-trend-badge" style="background:${trendBg};color:${trendColor}">
              ${trendArrow} ${trendLabel}
            </span>
            <span style="font-size:9px;color:var(--text-dim)">情绪走向</span>
          </div>
          ${concernTags ? `<div style="margin-bottom:4px">
            <div style="font-size:9px;color:var(--text-dim);margin-bottom:2px">市场关注</div>
            <div class="cn-tag-row">${concernTags}</div>
          </div>` : ''}
          ${bullishTags ? `<div style="margin-bottom:4px">
            <div style="font-size:9px;color:var(--text-dim);margin-bottom:2px">利好因素</div>
            <div class="cn-tag-row">${bullishTags}</div>
          </div>` : ''}
          ${ins.summary ? `<div class="cn-insights-summary">${escapeHtml(ins.summary)}</div>` : ''}
        </div>
      `;
    }

    const html = `${STYLE}
      <div class="cn-sentiment-container">
        ${gaugeSvg}
        ${pulseHtml}
        ${trendSvg}
        <div class="cn-factors-title">情绪因子雷达</div>
        ${radarSvg}
        <div class="cn-factors-title">因子分解</div>
        ${factorsHtml}
        ${insightsHtml}
      </div>
    `;

    this.setContent(html);
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

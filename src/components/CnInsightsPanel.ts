/**
 * CnInsightsPanel — Cross-domain correlation view + trade ideas.
 * Three-column signal view (Policy | Sentiment | Market) with connection lines,
 * plus trade idea cards (BUY/SELL/WATCH).
 */
import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { getUserId, cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';

interface CrossSignal {
  pattern: string;
  sector: string;
  direction: string;
  confidence: number;
  description: string;
  policy_detail: Record<string, any>;
  sentiment_detail: Record<string, any>;
  market_detail: Record<string, any>;
}

interface TradeIdea {
  action: 'BUY' | 'SELL' | 'WATCH';
  instrument: string;
  confidence: number;
  timeframe: string;
  thesis: string;
  signals: string[];
  risks: string[];
  entry_condition: string;
  exit_condition: string;
}

interface MarketRegime {
  regime: string;
  label: string;
  description: string;
}

type InsightView = 'signals' | 'ideas';

const STYLE = `<style>
.cn-insights { font-size: 13px; color: #e0e0e0; }
.cn-insights-header {
  display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap;
}
.cn-insights-view-btn {
  padding: 4px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04); color: #aaa;
  transition: all .15s;
}
.cn-insights-view-btn.active { background: rgba(232,168,56,0.15); color: #e8a838; border-color: rgba(232,168,56,0.3); }
/* Regime indicator */
.cn-regime {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600;
  margin-left: auto;
}
.cn-regime.risk_on { background: rgba(229,57,53,0.12); color: #ef5350; }
.cn-regime.risk_off { background: rgba(67,160,71,0.12); color: #43a047; }
.cn-regime.rotation { background: rgba(232,168,56,0.12); color: #e8a838; }
.cn-regime.range_bound { background: rgba(255,255,255,0.06); color: #888; }
.cn-regime-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
/* Signal cards */
.cn-signal-card {
  padding: 10px; margin-bottom: 6px; border-radius: 8px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);
  transition: all .15s;
}
.cn-signal-card:hover { border-color: rgba(232,168,56,0.2); }
.cn-signal-card-head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
}
.cn-signal-pattern {
  padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700;
}
.cn-signal-TRIPLE { background: rgba(229,57,53,0.2); color: #ef5350; }
.cn-signal-CONVERGENCE { background: rgba(232,168,56,0.2); color: #e8a838; }
.cn-signal-DIVERGENCE { background: rgba(156,39,176,0.2); color: #ab47bc; }
.cn-signal-LEADING { background: rgba(66,165,245,0.2); color: #42a5f5; }
.cn-signal-sector { font-size: 13px; font-weight: 600; color: #ddd; }
.cn-signal-conf {
  margin-left: auto; font-size: 11px; font-weight: 600;
}
.cn-signal-conf.high { color: #ef5350; }
.cn-signal-conf.med { color: #e8a838; }
.cn-signal-conf.low { color: #42a5f5; }
.cn-signal-desc { font-size: 11px; color: #999; line-height: 1.5; }
.cn-signal-domains {
  display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap;
}
.cn-signal-domain {
  padding: 2px 6px; border-radius: 4px; font-size: 10px;
  background: rgba(255,255,255,0.04); color: #aaa;
}
/* Trade idea cards */
.cn-idea-card {
  padding: 12px; margin-bottom: 8px; border-radius: 8px;
  border: 1px solid; transition: all .15s;
}
.cn-idea-card.BUY { background: rgba(229,57,53,0.04); border-color: rgba(229,57,53,0.2); }
.cn-idea-card.SELL { background: rgba(67,160,71,0.04); border-color: rgba(67,160,71,0.2); }
.cn-idea-card.WATCH { background: rgba(232,168,56,0.04); border-color: rgba(232,168,56,0.2); }
.cn-idea-header {
  display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
}
.cn-idea-action {
  padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700;
}
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
.cn-insights-empty { padding: 20px; text-align: center; color: #666; }
.cn-insights-loading { padding: 20px; text-align: center; color: #888; }
</style>`;

export class CnInsightsPanel extends Panel {
  private view: InsightView = 'signals';
  private signals: CrossSignal[] = [];
  private ideas: TradeIdea[] = [];
  private regime: MarketRegime | null = null;
  private loading = false;
  private fetched = false;

  constructor(element: HTMLElement) {
    super(element);
    this.element.addEventListener('click', (e) => this.handleClick(e));
  }

  async onMount(): Promise<void> {
    if (!this.fetched) {
      await this.fetchData();
    }
  }

  private handleClick(e: Event): void {
    const target = e.target as HTMLElement;

    const viewBtn = target.closest('.cn-insights-view-btn') as HTMLElement | null;
    if (viewBtn?.dataset.view) {
      this.view = viewBtn.dataset.view as InsightView;
      if (this.view === 'ideas' && !this.ideas.length) void this.fetchIdeas();
      this.render();
      return;
    }
  }

  private async fetchData(): Promise<void> {
    this.loading = true;
    this.showLoading('加载跨域信号...');
    try {
      const [corrRes, regimeRes] = await Promise.all([
        cnFetch(`${CN_INTEL_BASE}/api/cn/insights/correlations`, { signal: this.signal }),
        cnFetch(`${CN_INTEL_BASE}/api/cn/insights/regime`, { signal: this.signal }),
      ]);
      if (corrRes.ok) {
        const data = await corrRes.json();
        this.signals = data.signals || [];
      }
      if (regimeRes.ok) {
        this.regime = await regimeRes.json();
      }
      this.fetched = true;
    } catch (err) {
      if (!this.isAbortError(err)) {
        this.showError('跨域信号加载失败，点击重试');
        return;
      }
    } finally {
      this.loading = false;
    }
    this.render();
  }

  private async fetchIdeas(): Promise<void> {
    this.loading = true;
    this.render();
    try {
      const uid = getUserId();
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/insights/trade-ideas?user_id=${encodeURIComponent(uid)}`, { signal: this.signal });
      if (res.ok) {
        const data = await res.json();
        this.ideas = data.ideas || [];
      }
    } catch (err) {
      if (!this.isAbortError(err)) {
        this.showError('交易建议加载失败');
        return;
      }
    } finally {
      this.loading = false;
    }
    this.render();
  }

  private render(): void {
    const viewBtns = (['signals', 'ideas'] as InsightView[]).map(v => {
      const labels: Record<InsightView, string> = {
        signals: '<i class="bi bi-diagram-3"></i> 跨域信号',
        ideas: '<i class="bi bi-lightbulb"></i> 交易建议',
      };
      return `<button class="cn-insights-view-btn ${v === this.view ? 'active' : ''}" data-view="${v}">${labels[v]}</button>`;
    }).join('');

    const regimeHtml = this.regime
      ? `<span class="cn-regime ${this.regime.regime}">
           <span class="cn-regime-dot"></span>${this.regime.label}
         </span>`
      : '';

    let bodyHtml = '';
    if (this.loading) {
      bodyHtml = '<div class="cn-insights-loading">加载中...</div>';
    } else if (this.view === 'signals') {
      bodyHtml = this._renderSignals();
    } else {
      bodyHtml = this._renderIdeas();
    }

    this.content.innerHTML = STYLE + `
<div class="cn-insights">
  <div class="cn-insights-header">
    ${viewBtns}
    ${regimeHtml}
  </div>
  ${bodyHtml}
</div>`;
  }

  private _renderSignals(): string {
    if (!this.signals.length) {
      return '<div class="cn-insights-empty">暂无跨域信号</div>';
    }

    return this.signals.map(sig => {
      const confCls = sig.confidence > 0.7 ? 'high' : (sig.confidence > 0.5 ? 'med' : 'low');
      const domains: string[] = [];
      if (sig.policy_detail?.direction && sig.policy_detail.direction !== 'neutral')
        domains.push(`政策:${sig.policy_detail.direction}`);
      if (sig.sentiment_detail?.direction && sig.sentiment_detail.direction !== 'neutral')
        domains.push(`舆情:${sig.sentiment_detail.direction}`);
      if (sig.market_detail?.direction && sig.market_detail.direction !== 'neutral')
        domains.push(`市场:${sig.market_detail.direction}`);

      return `
<div class="cn-signal-card">
  <div class="cn-signal-card-head">
    <span class="cn-signal-pattern cn-signal-${sig.pattern}">${sig.pattern}</span>
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

  private _renderIdeas(): string {
    if (!this.ideas.length) {
      return '<div class="cn-insights-empty">暂无交易建议</div>';
    }

    return this.ideas.map(idea => {
      const confPct = (idea.confidence * 100).toFixed(0);
      const confColor = idea.action === 'BUY' ? '#ef5350' : (idea.action === 'SELL' ? '#43a047' : '#e8a838');

      return `
<div class="cn-idea-card ${idea.action}">
  <div class="cn-idea-header">
    <span class="cn-idea-action ${idea.action}">${idea.action}</span>
    <span class="cn-idea-instrument">${escapeHtml(idea.instrument)}</span>
    <div class="cn-idea-conf-bar">
      <div class="cn-idea-conf-fill" style="width:${confPct}%;background:${confColor}"></div>
    </div>
  </div>
  <div class="cn-idea-thesis">${escapeHtml(idea.thesis || '')}</div>
  <div class="cn-idea-meta">
    <span class="cn-idea-meta-label">时间框架:</span> ${escapeHtml(idea.timeframe || '')}
    ${idea.entry_condition ? ` | <span class="cn-idea-meta-label">入场:</span> ${escapeHtml(idea.entry_condition)}` : ''}
    ${idea.risks?.length ? `<br><span class="cn-idea-meta-label">风险:</span> ${idea.risks.map(r => escapeHtml(r)).join(', ')}` : ''}
  </div>
</div>`;
    }).join('');
  }
}

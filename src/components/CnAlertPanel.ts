/**
 * CnAlertPanel — Three-tier alert inbox (FLASH / PRIORITY / ROUTINE).
 * Shows as a dropdown/popover from the bell icon in CnPolicyPanel header.
 */
import { getAlerts, markRead, type Alert } from '@/services/cn-alerts';
import { escapeHtml } from '@/utils/sanitize';

const PANEL_STYLE = `<style>
.cn-alert-panel {
  position: absolute; top: 100%; right: 0; z-index: 100;
  width: 380px; max-height: 500px; overflow-y: auto;
  background: rgba(26,26,46,0.98); border: 1px solid rgba(232,168,56,0.2);
  border-radius: 10px; padding: 8px; font-size: 12px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.cn-alert-tabs {
  display: flex; gap: 4px; margin-bottom: 8px;
}
.cn-alert-tab {
  flex: 1; padding: 6px 8px; border-radius: 6px; text-align: center;
  cursor: pointer; font-size: 11px; font-weight: 600;
  border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.03);
  color: #888; transition: all .15s; position: relative;
}
.cn-alert-tab.active { color: #fff; }
.cn-alert-tab[data-tier="FLASH"].active { background: rgba(239,83,80,0.15); border-color: rgba(239,83,80,0.3); color: #ef5350; }
.cn-alert-tab[data-tier="PRIORITY"].active { background: rgba(232,168,56,0.15); border-color: rgba(232,168,56,0.3); color: #e8a838; }
.cn-alert-tab[data-tier="ROUTINE"].active { background: rgba(66,165,245,0.15); border-color: rgba(66,165,245,0.3); color: #42a5f5; }
.cn-alert-badge {
  position: absolute; top: -4px; right: -4px;
  min-width: 14px; height: 14px; border-radius: 7px;
  background: #ef5350; color: #fff; font-size: 9px; font-weight: 700;
  display: flex; align-items: center; justify-content: center; padding: 0 3px;
}
.cn-alert-card {
  padding: 8px; margin-bottom: 4px; border-radius: 6px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04);
  cursor: pointer; transition: all .15s;
}
.cn-alert-card:hover { background: rgba(255,255,255,0.05); }
.cn-alert-card.unread { border-left: 3px solid; }
.cn-alert-card.unread[data-tier="FLASH"] { border-left-color: #ef5350; }
.cn-alert-card.unread[data-tier="PRIORITY"] { border-left-color: #e8a838; }
.cn-alert-card.unread[data-tier="ROUTINE"] { border-left-color: #42a5f5; }
.cn-alert-card-header {
  display: flex; align-items: center; gap: 6px; margin-bottom: 4px;
}
.cn-alert-tier-badge {
  padding: 1px 6px; border-radius: 4px; font-size: 9px; font-weight: 700;
}
.cn-alert-tier-FLASH { background: rgba(239,83,80,0.2); color: #ef5350; }
.cn-alert-tier-PRIORITY { background: rgba(232,168,56,0.2); color: #e8a838; }
.cn-alert-tier-ROUTINE { background: rgba(66,165,245,0.2); color: #42a5f5; }
.cn-alert-score {
  font-size: 10px; color: #e8a838; font-weight: 600;
}
.cn-alert-time { font-size: 10px; color: #666; margin-left: auto; }
.cn-alert-title { font-size: 12px; color: #ddd; line-height: 1.5; margin-bottom: 3px; }
.cn-alert-reason { font-size: 10px; color: #888; }
.cn-alert-impact {
  margin-top: 4px; padding: 4px 6px; border-radius: 4px;
  background: rgba(255,255,255,0.02); font-size: 10px;
}
.cn-alert-impact-summary {
  color: #ccc; margin-bottom: 3px; font-weight: 500;
}
.cn-alert-impact-level {
  display: inline-block; padding: 0 5px; border-radius: 3px;
  font-size: 9px; font-weight: 700; margin-right: 4px;
}
.cn-alert-impact-HIGH { background: rgba(239,83,80,0.2); color: #ef5350; }
.cn-alert-impact-MEDIUM { background: rgba(232,168,56,0.2); color: #e8a838; }
.cn-alert-impact-LOW { background: rgba(255,255,255,0.08); color: #999; }
.cn-alert-impact-tags { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; }
.cn-alert-impact-pos { color: #66bb6a; }
.cn-alert-impact-neg { color: #ef5350; }
.cn-alert-impact-detail {
  display: none; margin-top: 3px; padding-top: 3px;
  border-top: 1px solid rgba(255,255,255,0.04);
}
.cn-alert-impact-detail.open { display: block; }
.cn-alert-impact-item { line-height: 1.6; font-size: 10px; }
.cn-alert-impact-item::before { margin-right: 4px; }
.cn-alert-impact-toggle {
  color: #64B5F6; cursor: pointer; font-size: 9px; margin-top: 2px;
}
.cn-alert-impact-toggle:hover { text-decoration: underline; }
.cn-alert-empty { text-align: center; color: #666; padding: 20px; }
.cn-alert-mark-all {
  display: block; width: 100%; padding: 6px; border: none; border-radius: 6px;
  background: rgba(255,255,255,0.04); color: #aaa; font-size: 11px; cursor: pointer;
  text-align: center; margin-top: 4px;
}
.cn-alert-mark-all:hover { background: rgba(255,255,255,0.08); }
</style>`;

export class CnAlertPanel {
  private container: HTMLElement;
  private visible = false;
  private currentTier: 'FLASH' | 'PRIORITY' | 'ROUTINE' = 'FLASH';
  private alerts: Alert[] = [];
  private unreadCounts: Record<string, number> = { FLASH: 0, PRIORITY: 0, ROUTINE: 0 };
  private loading = false;
  private loadError = false;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async toggle(): Promise<void> {
    this.visible = !this.visible;
    if (this.visible) {
      await this.loadAlerts();
    }
    this.render();
  }

  hide(): void {
    this.visible = false;
    this.render();
  }

  async loadAlerts(): Promise<void> {
    this.loading = true;
    this.loadError = false;
    this.render();
    try {
      // Load all tiers to get counts
      const [flash, priority, routine] = await Promise.all([
        getAlerts('FLASH', false, 50),
        getAlerts('PRIORITY', false, 50),
        getAlerts('ROUTINE', false, 50),
      ]);

      this.unreadCounts = {
        FLASH: flash.alerts.filter(a => !a.read).length,
        PRIORITY: priority.alerts.filter(a => !a.read).length,
        ROUTINE: routine.alerts.filter(a => !a.read).length,
      };

      // Show current tier
      if (this.currentTier === 'FLASH') this.alerts = flash.alerts;
      else if (this.currentTier === 'PRIORITY') this.alerts = priority.alerts;
      else this.alerts = routine.alerts;
    } catch {
      this.alerts = [];
      this.loadError = true;
    } finally {
      this.loading = false;
    }
  }

  getTotalUnread(): number {
    return Object.values(this.unreadCounts).reduce((a, b) => a + b, 0);
  }

  render(): void {
    let el = this.container.querySelector('.cn-alert-panel') as HTMLElement;
    if (!this.visible) {
      if (el) el.remove();
      return;
    }

    if (!el) {
      el = document.createElement('div');
      el.innerHTML = PANEL_STYLE;
      const panel = document.createElement('div');
      panel.className = 'cn-alert-panel';
      el.appendChild(panel);
      this.container.appendChild(el);
    }

    const panel = el.querySelector('.cn-alert-panel') || el;

    const tabs = (['FLASH', 'PRIORITY', 'ROUTINE'] as const).map(tier => {
      const active = tier === this.currentTier ? ' active' : '';
      const labels = { FLASH: '紧急', PRIORITY: '重要', ROUTINE: '常规' };
      const cnt = this.unreadCounts[tier] || 0;
      const badge = cnt > 0
        ? `<span class="cn-alert-badge">${cnt}</span>` : '';
      return `<div class="cn-alert-tab${active}" data-tier="${tier}">${labels[tier]}${badge}</div>`;
    }).join('');

    if (this.loading) {
      panel.innerHTML = `<div class="cn-alert-tabs">${tabs}</div><div class="cn-alert-empty">加载告警中...</div>`;
      return;
    }
    if (this.loadError) {
      panel.innerHTML = `<div class="cn-alert-tabs">${tabs}</div><div class="cn-alert-empty">告警加载失败 <button class="cn-alert-retry" style="margin-left:8px;padding:2px 10px;border-radius:4px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;font-size:12px">重试</button></div>`;
      panel.querySelector('.cn-alert-retry')?.addEventListener('click', () => {
        this.loadError = false;
        this.loading = true;
        this.render();
        void this.loadAlerts();
      });
      return;
    }

    const cards = this.alerts.length > 0
      ? this.alerts.map(a => {
          const unread = !a.read ? ' unread' : '';
          const time = a.created_at ? _formatTime(a.created_at) : '';
          let impactHtml = '';
          if (a.impact) {
            const lvl = a.impact.impact_level || 'MEDIUM';
            const lvlLabels: Record<string, string> = { HIGH: '高影响', MEDIUM: '中影响', LOW: '低影响' };
            const dir = a.impact.direction || 'neutral';
            const dirColor: Record<string, string> = { positive: '#66bb6a', negative: '#ef5350', neutral: '#999' };
            const dirIcon: Record<string, string> = { positive: '▲', negative: '▼', neutral: '●' };
            const posItems = (a.impact.positive || []).map(p => `<div class="cn-alert-impact-item cn-alert-impact-pos">+ ${escapeHtml(p)}</div>`).join('');
            const negItems = (a.impact.negative || []).map(n => `<div class="cn-alert-impact-item cn-alert-impact-neg">- ${escapeHtml(n)}</div>`).join('');
            const hasDetail = posItems || negItems;
            impactHtml = `<div class="cn-alert-impact">
  <div class="cn-alert-impact-summary" style="color:${dirColor[dir] || '#999'}">
    <span style="margin-right:3px">${dirIcon[dir] || '●'}</span>
    <span class="cn-alert-impact-level cn-alert-impact-${lvl}">${lvlLabels[lvl] || lvl}</span>
    ${escapeHtml(a.impact.summary || '')}
  </div>
  ${hasDetail ? `<div class="cn-alert-impact-toggle" data-expand="${a.id}">展开详情</div>
  <div class="cn-alert-impact-detail" data-detail="${a.id}">${posItems}${negItems}</div>` : ''}
</div>`;
          }
          return `
<div class="cn-alert-card${unread}" data-tier="${a.tier}" data-id="${a.id}">
  <div class="cn-alert-card-header">
    <span class="cn-alert-tier-badge cn-alert-tier-${a.tier}">${a.tier}</span>
    <span class="cn-alert-score">${a.score}分</span>
    <span class="cn-alert-time">${time}</span>
  </div>
  <div class="cn-alert-title">${escapeHtml(a.title)}</div>
  <div class="cn-alert-reason">${escapeHtml(a.match_reason)}</div>
  ${impactHtml}
</div>`;
        }).join('')
      : '<div class="cn-alert-empty">暂无告警</div>';

    const markAllBtn = this.alerts.some(a => !a.read)
      ? '<button class="cn-alert-mark-all">全部标记已读</button>' : '';

    panel.innerHTML = `
<div class="cn-alert-tabs">${tabs}</div>
${cards}
${markAllBtn}`;

    // Event listeners
    panel.querySelectorAll('.cn-alert-tab').forEach(tab => {
      tab.addEventListener('click', async () => {
        this.currentTier = (tab as HTMLElement).dataset.tier as any;
        await this.loadAlerts();
        this.render();
      });
    });

    panel.querySelectorAll('.cn-alert-card').forEach(card => {
      card.addEventListener('click', async () => {
        const id = (card as HTMLElement).dataset.id;
        if (id) {
          await markRead([id]);
          const alert = this.alerts.find(a => a.id === id);
          if (alert) {
            alert.read = true;
            if (alert.url) window.open(alert.url, '_blank');
          }
          this.render();
        }
      });
    });

    panel.querySelector('.cn-alert-mark-all')?.addEventListener('click', async () => {
      const ids = this.alerts.filter(a => !a.read).map(a => a.id);
      if (ids.length) {
        await markRead(ids);
        this.alerts.forEach(a => a.read = true);
        this.unreadCounts[this.currentTier] = 0;
        this.render();
      }
    });

    // Impact detail expand/collapse
    panel.querySelectorAll('.cn-alert-impact-toggle').forEach(toggle => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = (toggle as HTMLElement).dataset.expand;
        const detail = panel.querySelector(`.cn-alert-impact-detail[data-detail="${id}"]`) as HTMLElement;
        if (detail) {
          const isOpen = detail.classList.toggle('open');
          (toggle as HTMLElement).textContent = isOpen ? '收起详情' : '展开详情';
        }
      });
    });
  }
}

function _formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = (now.getTime() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    return `${Math.floor(diff / 86400)}天前`;
  } catch {
    return '';
  }
}

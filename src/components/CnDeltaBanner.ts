/**
 * CnDeltaBanner — Top banner showing "what changed since you left?"
 * Inserted at top of CnPolicyPanel/CnMoodPanel when delta is detected.
 */
import { getUserId, cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';

interface DeltaData {
  has_changes: boolean;
  first_visit: boolean;
  since: string | null;
  hours_away: number;
  new_policies: number;
  new_policy_items: Array<{ title: string; url: string; date: string; source: string }>;
  high_score_policies: number;
  mood_shifted: boolean;
  mood_shift_detail: {
    direction: string;
    negative_pct: number;
    positive_pct: number;
    neg_change: number;
    pos_change: number;
  } | null;
  emerging_keywords: string[];
  summary: string;
}

const BANNER_STYLE = `
.cn-delta-banner {
  padding: 8px 12px; border-radius: 8px; margin-bottom: 8px;
  background: rgba(100,181,246,0.08); border: 1px solid rgba(100,181,246,0.2);
  font-size: 12px; color: #90CAF9;
}
.cn-delta-banner.significant {
  background: rgba(232,168,56,0.08); border-color: rgba(232,168,56,0.2);
  color: #e8a838;
}
.cn-delta-header {
  display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-weight: 600;
}
.cn-delta-summary { line-height: 1.6; }
.cn-delta-actions {
  display: flex; gap: 8px; margin-top: 6px;
}
.cn-delta-btn {
  padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; border: none;
}
.cn-delta-btn-dismiss {
  background: rgba(255,255,255,0.06); color: #aaa;
}
.cn-delta-btn-details {
  background: rgba(232,168,56,0.15); color: #e8a838;
}
.cn-delta-detail { margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.06); }
.cn-delta-item {
  padding: 2px 0; font-size: 11px; color: #ccc; line-height: 1.5;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cn-delta-kw {
  display: inline-block; padding: 1px 6px; border-radius: 8px; margin: 1px;
  font-size: 10px; background: rgba(229,57,53,0.12); color: #ef5350; font-weight: 600;
}
`;

/** Convenience function: mount and load a delta banner into a container element */
export function mountDeltaBanner(container: HTMLElement): void {
  const banner = new CnDeltaBanner(container);
  banner.load();
}

export class CnDeltaBanner {
  private container: HTMLElement;
  private data: DeltaData | null = null;
  private expanded = false;
  private dismissed = false;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async load(): Promise<void> {
    const uid = getUserId();
    try {
      const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/sweep?user_id=${encodeURIComponent(uid)}`);
      if (!res.ok) return;
      this.data = await res.json();
      if (this.data?.has_changes) {
        this.render();
      }
    } catch {
      // Silent failure
    }
  }

  render(): void {
    if (this.dismissed || !this.data?.has_changes) {
      const existing = this.container.querySelector('.cn-delta-banner');
      if (existing) existing.remove();
      return;
    }

    const d = this.data;
    const significant = d.new_policies > 5 || d.mood_shifted || d.high_score_policies > 0;
    const cls = significant ? 'cn-delta-banner significant' : 'cn-delta-banner';

    let detailHtml = '';
    if (this.expanded) {
      const items = (d.new_policy_items || []).slice(0, 5).map(it =>
        `<div class="cn-delta-item">${it.source ? `[${it.source}] ` : ''}${it.title}</div>`
      ).join('');

      const kwHtml = (d.emerging_keywords || []).map(kw =>
        `<span class="cn-delta-kw">${kw}</span>`
      ).join('');

      detailHtml = `<div class="cn-delta-detail">
        ${items}
        ${kwHtml ? `<div style="margin-top:4px">${kwHtml}</div>` : ''}
      </div>`;
    }

    const html = `<style>${BANNER_STYLE}</style>
<div class="${cls}">
  <div class="cn-delta-header">
    <i class="bi bi-bell"></i>
    <span>${d.summary}</span>
  </div>
  <div class="cn-delta-actions">
    <button class="cn-delta-btn cn-delta-btn-dismiss">忽略</button>
    <button class="cn-delta-btn cn-delta-btn-details">${this.expanded ? '收起' : '查看详情'}</button>
  </div>
  ${detailHtml}
</div>`;

    // Insert or replace at top of container
    let el = this.container.querySelector('.cn-delta-banner-wrap') as HTMLElement;
    if (!el) {
      el = document.createElement('div');
      el.className = 'cn-delta-banner-wrap';
      this.container.prepend(el);
    }
    el.innerHTML = html;

    // Event listeners
    el.querySelector('.cn-delta-btn-dismiss')?.addEventListener('click', () => {
      this.dismissed = true;
      this._acknowledge();
      this.render();
    });

    el.querySelector('.cn-delta-btn-details')?.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.render();
    });
  }

  private async _acknowledge(): Promise<void> {
    const uid = getUserId();
    try {
      await cnFetch(`${CN_INTEL_BASE}/api/cn/sweep/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: uid }),
      });
    } catch {
      // Silent
    }
  }
}

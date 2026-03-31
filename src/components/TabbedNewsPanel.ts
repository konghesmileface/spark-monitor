import { Panel } from './Panel';
import { NewsPanel } from './NewsPanel';
import type { RelatedAsset } from '@/types';

export interface TabDef {
  feedKey: string;
  label: string;
  icon?: string;
}

/**
 * A container panel that holds multiple NewsPanel instances behind a tab bar.
 * Each tab maps to a feedKey so the data-loader can keep pushing news to the
 * correct underlying NewsPanel without any changes.
 */
export class TabbedNewsPanel extends Panel {
  private tabBar: HTMLElement;
  private contentArea: HTMLElement;
  private tabs: Map<string, { def: TabDef; panel: NewsPanel; wrapper: HTMLElement }> = new Map();
  private activeTab: string;
  private tabButtons: Map<string, HTMLButtonElement> = new Map();

  constructor(id: string, title: string, tabDefs: TabDef[]) {
    super({ id, title, showCount: false, trackActivity: false });

    // Build tab bar
    this.tabBar = document.createElement('div');
    this.tabBar.className = 'tabbed-news-tabs';

    // Content area where active tab's content is shown
    this.contentArea = document.createElement('div');
    this.contentArea.className = 'tabbed-news-content';

    // Create tabs and their hidden NewsPanel instances
    const firstKey = tabDefs[0]?.feedKey ?? '';
    this.activeTab = firstKey;

    for (const def of tabDefs) {
      const btn = document.createElement('button');
      btn.className = 'tab-btn';
      btn.dataset.feed = def.feedKey;
      const iconClass = def.icon || 'bi-geo-alt';
      btn.innerHTML = `<i class="bi ${iconClass}"></i> ${def.label}`;
      btn.addEventListener('click', () => this.switchTab(def.feedKey));
      this.tabBar.appendChild(btn);
      this.tabButtons.set(def.feedKey, btn);

      // Create a NewsPanel for this tab
      const panel = new NewsPanel(def.feedKey, def.label);

      // Wrapper holds the panel's content element
      const wrapper = document.createElement('div');
      wrapper.className = 'tabbed-news-tab-content';
      wrapper.style.display = 'none';
      wrapper.appendChild(panel.getElement());
      this.contentArea.appendChild(wrapper);

      this.tabs.set(def.feedKey, { def, panel, wrapper });
    }

    // Insert tab bar and content area into the panel element
    // (after header, replacing default content)
    this.content.style.display = 'none'; // hide default panel-content
    this.element.appendChild(this.tabBar);
    this.element.appendChild(this.contentArea);

    // Activate first tab (immediate, no transition)
    const firstBtn = this.tabButtons.get(firstKey);
    if (firstBtn) firstBtn.classList.add('active');
    const firstTab = this.tabs.get(firstKey);
    if (firstTab) {
      firstTab.wrapper.style.display = '';
      firstTab.wrapper.classList.add('tab-visible');
    }
  }

  /**
   * Switch to a different tab with smooth transition
   */
  public switchTab(feedKey: string): void {
    const tab = this.tabs.get(feedKey);
    if (!tab || feedKey === this.activeTab) return;

    // Deactivate previous
    const prevBtn = this.tabButtons.get(this.activeTab);
    if (prevBtn) prevBtn.classList.remove('active');
    const prevKey = this.activeTab;
    const prevTab = this.tabs.get(prevKey);
    if (prevTab) {
      prevTab.wrapper.classList.remove('tab-visible');
      // Hide after transition completes (only if still inactive)
      setTimeout(() => {
        if (this.activeTab === prevKey) return; // tab was re-activated, don't hide
        prevTab.wrapper.style.display = 'none';
      }, 150);
    }

    // Activate new
    this.activeTab = feedKey;
    const btn = this.tabButtons.get(feedKey);
    if (btn) btn.classList.add('active');
    tab.wrapper.style.display = '';
    // Trigger reflow then add visible class for transition
    void tab.wrapper.offsetHeight;
    tab.wrapper.classList.add('tab-visible');
  }

  /**
   * Get the NewsPanel for a given feedKey (used by data-loader)
   */
  public getNewsPanel(feedKey: string): NewsPanel | undefined {
    return this.tabs.get(feedKey)?.panel;
  }

  /**
   * Get all sub-panels for attaching handlers
   */
  public getAllNewsPanels(): NewsPanel[] {
    return Array.from(this.tabs.values()).map(t => t.panel);
  }

  /**
   * Attach related asset handlers to all sub-panels
   */
  public setRelatedAssetHandlersAll(options: {
    onRelatedAssetClick?: (asset: RelatedAsset) => void;
    onRelatedAssetsFocus?: (assets: RelatedAsset[], originLabel: string) => void;
    onRelatedAssetsClear?: () => void;
  }): void {
    for (const { panel } of this.tabs.values()) {
      panel.setRelatedAssetHandlers(options);
    }
  }

  /**
   * Clean up all sub-panels
   */
  public destroy(): void {
    for (const { panel } of this.tabs.values()) {
      panel.destroy();
    }
    this.tabs.clear();
    this.tabButtons.clear();
    super.destroy();
  }
}

/**
 * AIOverviewPanel — Merges AI Insights + AI Strategic Posture into a single tabbed panel.
 * Spark variant only.
 */
import { Panel } from './Panel';
import { InsightsPanel } from './InsightsPanel';
import { StrategicPosturePanel } from './StrategicPosturePanel';
import type { NewsItem, ClusteredEvent, MilitaryFlight } from '@/types';
import type { CachedTheaterPosture } from '@/services/cached-theater-posture';

type AITab = 'insights' | 'posture';

export class AIOverviewPanel extends Panel {
  private activeTab: AITab = 'insights';
  private insightsPanel: InsightsPanel;
  private posturePanel: StrategicPosturePanel;
  private insightsContainer: HTMLElement;
  private postureContainer: HTMLElement;
  private tabBar: HTMLElement;

  constructor(getLatestNews?: () => NewsItem[]) {
    super({ id: 'ai-overview', title: 'AI 分析' });

    // Create sub-panels
    this.insightsPanel = new InsightsPanel();
    this.posturePanel = new StrategicPosturePanel(getLatestNews);

    // Build tab bar (reuse economic-tabs styling)
    this.tabBar = document.createElement('div');
    this.tabBar.className = 'economic-tabs';
    this.tabBar.innerHTML = `
      <button class="economic-tab active" data-tab="insights">
        <i class="bi bi-lightbulb"></i> AI 洞察
      </button>
      <button class="economic-tab" data-tab="posture">
        <i class="bi bi-shield-check"></i> 战略态势
      </button>
    `;

    // Content containers
    this.insightsContainer = document.createElement('div');
    this.insightsContainer.className = 'intel-tab-content';
    this.insightsContainer.appendChild(this.insightsPanel.getElement());

    this.postureContainer = document.createElement('div');
    this.postureContainer.className = 'intel-tab-content';
    this.postureContainer.style.display = 'none';
    this.postureContainer.appendChild(this.posturePanel.getElement());

    // Assemble — clear the default loading spinner from Panel base class first
    this.content.innerHTML = '';
    this.content.style.padding = '0';
    this.content.style.display = 'flex';
    this.content.style.flexDirection = 'column';
    this.content.appendChild(this.tabBar);
    this.content.appendChild(this.insightsContainer);
    this.content.appendChild(this.postureContainer);

    // Tab click handler
    this.tabBar.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest('.economic-tab') as HTMLElement | null;
      if (!tab?.dataset.tab) return;
      this.activeTab = tab.dataset.tab as AITab;
      this.tabBar.querySelectorAll('.economic-tab').forEach(t =>
        t.classList.toggle('active', t === tab),
      );
      this.insightsContainer.style.display = this.activeTab === 'insights' ? '' : 'none';
      this.postureContainer.style.display = this.activeTab === 'posture' ? '' : 'none';
    });
  }

  /** Forward insights data */
  public updateInsights(clusters: ClusteredEvent[]): void {
    this.insightsPanel.updateInsights(clusters);
  }

  /** Forward military flight data */
  public setMilitaryFlights(flights: MilitaryFlight[]): void {
    this.insightsPanel.setMilitaryFlights(flights);
  }

  /** Forward posture data */
  public updatePostures(data: CachedTheaterPosture): void {
    this.posturePanel.updatePostures(data);
  }

  /** Access posture panel for location click handler */
  public getPosturePanel(): StrategicPosturePanel {
    return this.posturePanel;
  }

  /** Access insights panel */
  public getInsightsPanel(): InsightsPanel {
    return this.insightsPanel;
  }

  destroy(): void {
    this.insightsPanel.destroy();
    this.posturePanel.destroy();
    super.destroy();
  }
}

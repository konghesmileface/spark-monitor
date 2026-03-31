/**
 * IntelOverviewPanel — Merges Airline Intel + Telegram Intel into a single tabbed panel.
 * Spark variant only.
 */
import { Panel } from './Panel';
import { AirlineIntelPanel } from './AirlineIntelPanel';
import { TelegramIntelPanel } from './TelegramIntelPanel';
import type { TelegramFeedResponse } from '@/services/telegram-intel';
import { SecurityAdvisoriesPanel } from './SecurityAdvisoriesPanel';

type IntelTab = 'airline' | 'telegram' | 'security';

export class IntelOverviewPanel extends Panel {
  private activeTab: IntelTab = 'telegram';
  private airlinePanel: AirlineIntelPanel;
  private telegramPanel: TelegramIntelPanel;
  private securityPanel: SecurityAdvisoriesPanel;
  private airlineContainer: HTMLElement;
  private telegramContainer: HTMLElement;
  private securityContainer: HTMLElement;
  private tabBar: HTMLElement;

  constructor() {
    super({ id: 'intel-overview', title: '情报概览' });

    // Create sub-panels
    this.airlinePanel = new AirlineIntelPanel();
    this.telegramPanel = new TelegramIntelPanel();
    this.securityPanel = new SecurityAdvisoriesPanel();

    // Build tab bar (reuse economic-tabs styling)
    this.tabBar = document.createElement('div');
    this.tabBar.className = 'economic-tabs';
    this.tabBar.innerHTML = `
      <button class="economic-tab" data-tab="airline">
        <i class="bi bi-airplane"></i> 航空情报
      </button>
      <button class="economic-tab active" data-tab="telegram">
        <i class="bi bi-send"></i> Telegram
      </button>
      <button class="economic-tab" data-tab="security">
        <i class="bi bi-shield-exclamation"></i> 安全通告
      </button>
    `;

    // Content containers for each sub-panel
    this.airlineContainer = document.createElement('div');
    this.airlineContainer.className = 'intel-tab-content';
    this.airlineContainer.style.display = 'none';
    this.airlineContainer.appendChild(this.airlinePanel.getElement());

    this.telegramContainer = document.createElement('div');
    this.telegramContainer.className = 'intel-tab-content';
    this.telegramContainer.appendChild(this.telegramPanel.getElement());

    this.securityContainer = document.createElement('div');
    this.securityContainer.className = 'intel-tab-content';
    this.securityContainer.style.display = 'none';
    this.securityContainer.appendChild(this.securityPanel.getElement());

    // Assemble — clear the default loading spinner from Panel base class first
    this.content.innerHTML = '';
    this.content.style.padding = '0';
    this.content.style.display = 'flex';
    this.content.style.flexDirection = 'column';
    this.content.appendChild(this.tabBar);
    this.content.appendChild(this.airlineContainer);
    this.content.appendChild(this.telegramContainer);
    this.content.appendChild(this.securityContainer);

    // Tab click handler
    this.tabBar.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest('.economic-tab') as HTMLElement | null;
      if (!tab?.dataset.tab) return;
      this.activeTab = tab.dataset.tab as IntelTab;
      this.tabBar.querySelectorAll('.economic-tab').forEach(t =>
        t.classList.toggle('active', t === tab),
      );
      this.airlineContainer.style.display = this.activeTab === 'airline' ? '' : 'none';
      this.telegramContainer.style.display = this.activeTab === 'telegram' ? '' : 'none';
      this.securityContainer.style.display = this.activeTab === 'security' ? '' : 'none';
    });
  }

  /** Forward Telegram data to the embedded sub-panel */
  public setTelegramData(response: TelegramFeedResponse): void {
    this.telegramPanel.setData(response);
  }

  /** Access the embedded airline panel (for AviationCommandBar etc.) */
  public getAirlinePanel(): AirlineIntelPanel {
    return this.airlinePanel;
  }

  /** Access the embedded security panel for external refresh registration */
  public getSecurityPanel(): SecurityAdvisoriesPanel {
    return this.securityPanel;
  }

  destroy(): void {
    this.airlinePanel.destroy();
    this.telegramPanel.destroy();
    this.securityPanel.destroy();
    super.destroy();
  }
}

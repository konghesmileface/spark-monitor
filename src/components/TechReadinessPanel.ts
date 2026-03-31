import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { getTechReadinessRankings, type TechReadinessScore } from '@/services/economic';
import { escapeHtml } from '@/utils/sanitize';

const COUNTRY_FLAGS: Record<string, string> = {
  'USA': '🇺🇸', 'CHN': '🇨🇳', 'JPN': '🇯🇵', 'DEU': '🇩🇪', 'KOR': '🇰🇷',
  'GBR': '🇬🇧', 'IND': '🇮🇳', 'ISR': '🇮🇱', 'SGP': '🇸🇬', 'TWN': '🇹🇼',
  'FRA': '🇫🇷', 'CAN': '🇨🇦', 'SWE': '🇸🇪', 'NLD': '🇳🇱', 'CHE': '🇨🇭',
  'FIN': '🇫🇮', 'IRL': '🇮🇪', 'AUS': '🇦🇺', 'BRA': '🇧🇷', 'IDN': '🇮🇩',
  'ESP': '🇪🇸', 'ITA': '🇮🇹', 'MEX': '🇲🇽', 'RUS': '🇷🇺', 'TUR': '🇹🇷',
  'SAU': '🇸🇦', 'ARE': '🇦🇪', 'POL': '🇵🇱', 'THA': '🇹🇭', 'MYS': '🇲🇾',
  'VNM': '🇻🇳', 'PHL': '🇵🇭', 'NZL': '🇳🇿', 'AUT': '🇦🇹', 'BEL': '🇧🇪',
  'DNK': '🇩🇰', 'NOR': '🇳🇴', 'PRT': '🇵🇹', 'CZE': '🇨🇿', 'ZAF': '🇿🇦',
  'NGA': '🇳🇬', 'KEN': '🇰🇪', 'EGY': '🇪🇬', 'ARG': '🇦🇷', 'CHL': '🇨🇱',
  'COL': '🇨🇴', 'PAK': '🇵🇰', 'BGD': '🇧🇩', 'UKR': '🇺🇦', 'ROU': '🇷🇴',
  'EST': '🇪🇪', 'LVA': '🇱🇻', 'LTU': '🇱🇹', 'HUN': '🇭🇺', 'GRC': '🇬🇷',
  'QAT': '🇶🇦', 'BHR': '🇧🇭', 'KWT': '🇰🇼', 'OMN': '🇴🇲', 'JOR': '🇯🇴',
};

export class TechReadinessPanel extends Panel {
  private rankings: TechReadinessScore[] = [];
  private loading = false;
  private lastFetch = 0;
  private readonly REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

  constructor() {
    super({
      id: 'tech-readiness',
      title: t('panels.techReadiness'),
      showCount: true,
      infoTooltip: t('components.techReadiness.infoTooltip'),
    });
  }

  public async refresh(): Promise<void> {
    if (this.loading) return;
    if (Date.now() - this.lastFetch < this.REFRESH_INTERVAL && this.rankings.length > 0) {
      return;
    }

    this.loading = true;
    this.showFetchingState();

    try {
      this.rankings = await getTechReadinessRankings();
      if (!this.element?.isConnected) return;
      this.lastFetch = Date.now();
      this.setCount(this.rankings.length);
      this.render();
    } catch (error) {
      if (!this.element?.isConnected) return;
      console.error('[TechReadinessPanel] Error fetching data:', error);
      this.showError(t('common.failedTechReadiness'));
    } finally {
      this.loading = false;
    }
  }

  private showFetchingState(): void {
    this.setContent(`
      <div class="tech-fetch-progress">
        <div class="tech-fetch-icon">
          <div class="tech-globe-ring"></div>
          <span class="tech-globe"><i class="bi bi-globe"></i></span>
        </div>
        <div class="tech-fetch-title">${t('components.techReadiness.fetchingData')}</div>
        <div class="tech-fetch-indicators">
          <div class="tech-indicator-item" style="animation-delay: 0s">
            <span class="tech-indicator-icon"><i class="bi bi-globe"></i></span>
            <span class="tech-indicator-name">${t('components.techReadiness.internetUsersIndicator')}</span>
            <span class="tech-indicator-status"></span>
          </div>
          <div class="tech-indicator-item" style="animation-delay: 0.2s">
            <span class="tech-indicator-icon"><i class="bi bi-phone"></i></span>
            <span class="tech-indicator-name">${t('components.techReadiness.mobileSubscriptionsIndicator')}</span>
            <span class="tech-indicator-status"></span>
          </div>
          <div class="tech-indicator-item" style="animation-delay: 0.4s">
            <span class="tech-indicator-icon"><i class="bi bi-broadcast"></i></span>
            <span class="tech-indicator-name">${t('components.techReadiness.broadbandAccess')}</span>
            <span class="tech-indicator-status"></span>
          </div>
          <div class="tech-indicator-item" style="animation-delay: 0.6s">
            <span class="tech-indicator-icon"><i class="bi bi-search"></i></span>
            <span class="tech-indicator-name">${t('components.techReadiness.rdExpenditure')}</span>
            <span class="tech-indicator-status"></span>
          </div>
        </div>
        <div class="tech-fetch-note">${t('components.techReadiness.analyzingCountries')}</div>
      </div>
    `);
  }

  private getFlag(countryCode: string): string {
    return COUNTRY_FLAGS[countryCode] || '<i class="bi bi-globe"></i>';
  }

  private getScoreClass(score: number): string {
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  private formatComponent(value: number | null): string {
    if (value === null) return '—';
    return Math.round(value).toString();
  }

  private render(): void {
    if (this.rankings.length === 0) {
      this.showError(t('common.noDataAvailable'));
      return;
    }

    // Show top 25 countries
    const top = this.rankings.slice(0, 25);

    const html = `
      <div class="tech-readiness-list">
        ${top.map(country => {
      const scoreClass = this.getScoreClass(country.score);
      return `
            <div class="readiness-item ${scoreClass}" data-country="${escapeHtml(country.country)}">
              <div class="readiness-rank">#${country.rank}</div>
              <div class="readiness-flag">${this.getFlag(country.country)}</div>
              <div class="readiness-info">
                <div class="readiness-name">${escapeHtml(country.countryName)}</div>
                <div class="readiness-components">
                  <span title="${t('components.techReadiness.internetUsers')}"><i class="bi bi-globe"></i>${this.formatComponent(country.components.internet)}</span>
                  <span title="${t('components.techReadiness.mobileSubscriptions')}"><i class="bi bi-phone"></i>${this.formatComponent(country.components.mobile)}</span>
                  <span title="${t('components.techReadiness.rdSpending')}"><i class="bi bi-search"></i>${this.formatComponent(country.components.rdSpend)}</span>
                </div>
              </div>
              <div class="readiness-score ${scoreClass}">${country.score}</div>
            </div>
          `;
    }).join('')}
      </div>
      <div class="readiness-footer">
        <span class="readiness-source">${t('components.techReadiness.source')}</span>
        <span class="readiness-updated">${t('components.techReadiness.updated', { date: new Date(this.lastFetch).toLocaleDateString() })}</span>
      </div>
    `;

    this.setContent(html);
  }
}

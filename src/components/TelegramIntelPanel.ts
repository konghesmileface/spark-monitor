import { Panel } from './Panel';
import { sanitizeUrl } from '@/utils/sanitize';
import { t, getCurrentLanguage } from '@/services/i18n';
import { translateText } from '@/services/summarization';
import { h, replaceChildren } from '@/utils/dom-utils';
import {
  TELEGRAM_TOPICS,
  formatTelegramTime,
  type TelegramItem,
  type TelegramFeedResponse,
} from '@/services/telegram-intel';

/** Max items to auto-translate per render cycle (avoid burning API quota) */
const AUTO_TRANSLATE_LIMIT = 50;

export class TelegramIntelPanel extends Panel {
  private items: TelegramItem[] = [];
  private activeTopic = 'all';
  private tabsEl: HTMLElement | null = null;
  private relayEnabled = true;

  // Translation state
  private translationCache = new Map<string, string>(); // item.id → translated text
  private autoTranslateAbort: AbortController | null = null;
  private autoTranslateRunning = false;

  constructor() {
    super({
      id: 'telegram-intel',
      title: t('panels.telegramIntel'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.telegramIntel.infoTooltip'),
    });
    this.createTabs();
    this.showLoading(t('components.telegramIntel.loading'));
  }

  private createTabs(): void {
    this.tabsEl = h('div', { className: 'telegram-intel-tabs' },
      ...TELEGRAM_TOPICS.map(topic =>
        h('button', {
          className: `telegram-intel-tab ${topic.id === this.activeTopic ? 'active' : ''}`,
          dataset: { topicId: topic.id },
          onClick: () => this.selectTopic(topic.id),
        }, t(topic.labelKey)),
      ),
    );
    this.element.insertBefore(this.tabsEl, this.content);
  }

  private selectTopic(topicId: string): void {
    if (topicId === this.activeTopic) return;
    this.activeTopic = topicId;

    this.tabsEl?.querySelectorAll('.telegram-intel-tab').forEach(tab => {
      tab.classList.toggle('active', (tab as HTMLElement).dataset.topicId === topicId);
    });

    this.stopAutoTranslate();
    this.renderItems();
  }

  public setData(response: TelegramFeedResponse): void {
    this.relayEnabled = response.enabled;
    this.items = response.items || [];

    if (!this.relayEnabled) {
      this.setCount(0);
      this.stopAutoTranslate();
      replaceChildren(this.content,
        h('div', { className: 'empty-state' }, t('components.telegramIntel.disabled')),
      );
      return;
    }

    this.stopAutoTranslate();
    this.renderItems();
  }

  private renderItems(): void {
    const filtered = this.activeTopic === 'all'
      ? this.items
      : this.items.filter(item => item.topic === this.activeTopic);

    this.setCount(filtered.length);

    if (filtered.length === 0) {
      replaceChildren(this.content,
        h('div', { className: 'empty-state' }, t('components.telegramIntel.empty')),
      );
      return;
    }

    replaceChildren(this.content,
      h('div', { className: 'telegram-intel-items' },
        ...filtered.map(item => this.buildItem(item)),
      ),
    );

    // Auto-translate non-Latin messages (Arabic/Cyrillic/etc.) regardless of UI language
    if (!this.autoTranslateRunning) {
      this.startAutoTranslate();
    }
  }

  private buildItem(item: TelegramItem): HTMLElement {
    const timeAgo = formatTelegramTime(item.ts);
    const cached = this.translationCache.get(item.id);
    const isTranslated = item.translated || !!cached;

    const headerChildren: (HTMLElement | string)[] = [
      h('span', { className: 'telegram-intel-channel' }, item.channelTitle || item.channel),
      h('span', { className: 'telegram-intel-topic' }, item.topic),
    ];
    if (isTranslated) {
      headerChildren.push(h('span', { className: 'telegram-intel-translated' }, 'EN'));
    }
    headerChildren.push(h('span', { className: 'telegram-intel-time' }, timeAgo));

    return h('a', {
      href: sanitizeUrl(item.url),
      target: '_blank',
      rel: 'noopener noreferrer',
      className: 'telegram-intel-item',
      dataset: { itemId: item.id },
    },
      h('div', { className: 'telegram-intel-item-header' }, ...headerChildren),
      h('div', { className: 'telegram-intel-text' }, cached || item.text),
    );
  }

  /** Check if text contains significant non-Latin characters (Arabic/Farsi/Hebrew/Cyrillic). */
  private static needsTranslation(text: string): boolean {
    if (!text || text.length < 10) return false;
    let nonLatin = 0;
    let alpha = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if ((c >= 0x0590 && c <= 0x06FF) || (c >= 0x0750 && c <= 0x077F) ||
          (c >= 0x08A0 && c <= 0x08FF) || (c >= 0xFB50 && c <= 0xFDFF) ||
          (c >= 0xFE70 && c <= 0xFEFF) || (c >= 0x0400 && c <= 0x04FF)) {
        nonLatin++;
        alpha++;
      } else if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) ||
                 (c >= 0x4E00 && c <= 0x9FFF)) {
        alpha++;
      }
    }
    return alpha >= 5 && nonLatin / alpha > 0.4;
  }

  /** Serial auto-translate of non-Latin items (limited to AUTO_TRANSLATE_LIMIT) */
  private startAutoTranslate(): void {
    if (this.autoTranslateRunning) return;
    const lang = getCurrentLanguage();

    const ac = new AbortController();
    this.autoTranslateAbort = ac;
    this.autoTranslateRunning = true;

    (async () => {
      // Small delay to let DOM settle
      await new Promise(r => setTimeout(r, 500));

      const itemEls = this.content.querySelectorAll<HTMLElement>('.telegram-intel-item');
      let translated = 0;

      for (const el of itemEls) {
        if (ac.signal.aborted || !this.element?.isConnected) break;
        if (translated >= AUTO_TRANSLATE_LIMIT) break;

        const itemId = el.dataset.itemId;
        if (!itemId) continue;

        // Skip if already translated (by relay or previous auto-translate)
        if (this.translationCache.has(itemId)) continue;

        const textEl = el.querySelector('.telegram-intel-text') as HTMLElement;
        if (!textEl) continue;

        const originalText = textEl.textContent || '';
        if (!originalText.trim()) continue;

        // Only translate messages that contain non-Latin text
        if (!TelegramIntelPanel.needsTranslation(originalText)) continue;

        try {
          const targetLang = lang === 'en' ? 'en' : lang;
          const result = await translateText(originalText, targetLang);
          if (ac.signal.aborted || !this.element?.isConnected) break;

          if (result) {
            this.translationCache.set(itemId, result);
            textEl.textContent = result;
            translated++;
          }
        } catch {
          // Translation failed for this item, continue with next
        }
      }

      this.autoTranslateRunning = false;
    })();
  }

  private stopAutoTranslate(): void {
    this.autoTranslateAbort?.abort();
    this.autoTranslateAbort = null;
    this.autoTranslateRunning = false;
  }

  public async refresh(): Promise<void> {
    // Handled by DataLoader + RefreshScheduler
  }

  public destroy(): void {
    this.stopAutoTranslate();
    if (this.tabsEl) {
      this.tabsEl.remove();
      this.tabsEl = null;
    }
    super.destroy();
  }
}

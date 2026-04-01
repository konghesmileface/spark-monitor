import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { cnFetch, CN_INTEL_BASE } from '@/services/cn-profile';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  sources?: string[];
}

const EXAMPLE_QUESTIONS = [
  '今天市场为什么下跌？',
  '光伏行业最新研报观点',
  '北向资金流向分析',
  '半导体板块投资机会',
  '近期有哪些利好政策？',
];

const STYLE = `
<style>
@layer base {
.cn-rag-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 300px;
}
.cn-rag-messages {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cn-rag-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px 12px;
  flex: 1;
}
.cn-rag-empty-title {
  font-size: 14px;
  color: var(--text);
  font-weight: 600;
}
.cn-rag-empty-desc {
  font-size: 12px;
  color: var(--text-dim);
  text-align: center;
  line-height: 1.5;
}
.cn-rag-examples {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
  margin-top: 4px;
}
.cn-rag-example {
  padding: 5px 12px;
  font-size: 11px;
  border-radius: 14px;
  background: rgba(255,255,255,0.05);
  color: var(--text-dim);
  border: 1px solid rgba(255,255,255,0.08);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.cn-rag-example:hover {
  background: rgba(229,57,53,0.1);
  color: #ef5350;
  border-color: rgba(229,57,53,0.3);
}
.cn-rag-msg {
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
  max-width: 85%;
  word-wrap: break-word;
}
.cn-rag-msg.user {
  background: rgba(229,57,53,0.12);
  color: var(--text);
  align-self: flex-end;
  border-bottom-right-radius: 4px;
}
.cn-rag-msg.assistant {
  background: rgba(255,255,255,0.04);
  color: var(--text);
  align-self: flex-start;
  border-bottom-left-radius: 4px;
  border-left: 2px solid rgba(229,57,53,0.3);
}
.cn-rag-msg .cn-rag-sources {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255,255,255,0.06);
  font-size: 11px;
  color: var(--text-dim);
}
.cn-rag-msg .cn-rag-source-item {
  display: inline-block;
  color: #ef5350;
  opacity: 0.8;
  margin: 2px 4px 2px 0;
  padding: 1px 6px;
  font-size: 10px;
  border-radius: 3px;
  background: rgba(229,57,53,0.08);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.cn-rag-typing {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 8px 12px;
  align-self: flex-start;
}
.cn-rag-typing-dot {
  width: 6px;
  height: 6px;
  background: var(--text-dim);
  border-radius: 50%;
  animation: cn-rag-blink 1.4s infinite both;
}
.cn-rag-typing-dot:nth-child(2) { animation-delay: 0.2s; }
.cn-rag-typing-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes cn-rag-blink {
  0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}
.cn-rag-input-area {
  display: flex;
  gap: 6px;
  padding: 8px 0 0;
  border-top: 1px solid rgba(255,255,255,0.06);
  margin-top: 8px;
}
.cn-rag-input {
  flex: 1;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  color: var(--text);
  padding: 8px 12px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  resize: none;
  min-height: 36px;
  max-height: 80px;
}
.cn-rag-input:focus {
  border-color: rgba(229,57,53,0.5);
}
.cn-rag-input::placeholder {
  color: var(--text-dim);
  opacity: 0.6;
}
.cn-rag-send {
  background: #e53935;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 0 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.15s;
}
.cn-rag-send:hover {
  opacity: 0.85;
}
.cn-rag-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.cn-rag-new-chat {
  padding: 4px 12px;
  font-size: 11px;
  border-radius: 6px;
  background: rgba(255,255,255,0.05);
  color: var(--text-dim);
  border: 1px solid rgba(255,255,255,0.08);
  cursor: pointer;
  transition: all 0.15s;
  align-self: flex-end;
  margin-bottom: 4px;
}
.cn-rag-new-chat:hover {
  background: rgba(229,57,53,0.1);
  color: #ef5350;
  border-color: rgba(229,57,53,0.3);
}
.cn-rag-msg-time {
  font-size: 10px;
  color: var(--text-dim);
  opacity: 0.5;
  margin-top: 4px;
  text-align: right;
}
.cn-rag-cite {
  display: inline;
  font-size: 10px;
  color: #42a5f5;
  background: rgba(66,165,245,0.1);
  border-radius: 3px;
  padding: 1px 4px;
  margin: 0 1px;
  white-space: nowrap;
}
} /* @layer base */
</style>
`;

function getSessionId(): string {
  const key = 'cn_rag_session_id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = `rag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

export class CnRagPanel extends Panel {
  private messages: ChatMessage[] = [];
  private isLoading = false;
  private sessionId = getSessionId();

  constructor() {
    super({ id: 'cn-rag', title: 'AI研究助手' });
    this.content.addEventListener('click', (e) => {
      const example = (e.target as HTMLElement).closest('.cn-rag-example') as HTMLElement | null;
      if (example?.dataset.question) {
        void this.sendQuestion(example.dataset.question);
      }
      const newChatBtn = (e.target as HTMLElement).closest('.cn-rag-new-chat') as HTMLElement | null;
      if (newChatBtn) {
        this.messages = [];
        this.sessionId = `rag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        localStorage.setItem('cn_rag_session_id', this.sessionId);
        this.renderPanel();
      }
    });

    // Listen for entity clicks from CnBriefPanel / CnMoodPanel
    window.addEventListener('cn-entity-click', ((e: CustomEvent) => {
      const { name, type } = e.detail as { name: string; type: string };
      let query: string;
      switch (type) {
        case 'stock': query = `${name}最新分析`; break;
        case 'index': query = `${name}走势分析`; break;
        case 'sector': query = `${name}板块分析`; break;
        case 'policy_body': query = `${name}政策影响`; break;
        default: query = `${name}最新分析`; break;
      }
      // Open the RAG drawer if it's inside a drawer that isn't open
      const ragDrawer = document.querySelector('.cn-rag-drawer, .spark-panel[data-panel="cn-rag"]');
      if (ragDrawer && !ragDrawer.classList.contains('open')) {
        ragDrawer.classList.add('open');
      }
      // Set input and send
      const input = this.content.querySelector('#cnRagInput') as HTMLInputElement | null;
      if (input) input.value = query;
      void this.sendQuestion(query);
    }) as EventListener);

    this.renderPanel();
  }

  private renderPanel(): void {
    const messagesHtml = this.messages.length === 0 && !this.isLoading
      ? this.renderEmptyState()
      : this.renderMessages();

    const newChatBtn = this.messages.length > 0
      ? `<button class="cn-rag-new-chat">新建对话</button>`
      : '';

    const html = `${STYLE}
      <div class="cn-rag-container">
        ${newChatBtn}
        <div class="cn-rag-messages" id="cnRagMessages">
          ${messagesHtml}
        </div>
        <div class="cn-rag-input-area">
          <input type="text"
            class="cn-rag-input"
            id="cnRagInput"
            placeholder="输入你的问题..."
            ${this.isLoading ? 'disabled' : ''}
            autocomplete="off"
          />
          <button class="cn-rag-send" id="cnRagSend" ${this.isLoading ? 'disabled' : ''}>发送</button>
        </div>
      </div>
    `;

    // Use direct innerHTML to bypass debounce for interactive panel
    this.content.innerHTML = html;

    // Attach event listeners after render
    this.attachInputListeners();

    // Scroll to bottom
    const msgContainer = this.content.querySelector('#cnRagMessages') as HTMLElement;
    if (msgContainer) {
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }
  }

  private renderEmptyState(): string {
    const examplesHtml = EXAMPLE_QUESTIONS.map(q =>
      `<button class="cn-rag-example" data-question="${escapeHtml(q)}">${escapeHtml(q)}</button>`
    ).join('');

    return `
      <div class="cn-rag-empty">
        <div class="cn-rag-empty-title">AI研究助手</div>
        <div class="cn-rag-empty-desc">基于RAG(检索增强生成)技术，结合实时研报、新闻和市场数据回答你的投资问题</div>
        <div class="cn-rag-examples">${examplesHtml}</div>
      </div>
    `;
  }

  private renderMessages(): string {
    let html = this.messages.map(msg => {
      const sourcesHtml = msg.sources && msg.sources.length > 0
        ? `<div class="cn-rag-sources">
            <span>参考来源:</span>
            ${msg.sources.map(s => `<span class="cn-rag-source-item">${escapeHtml(s)}</span>`).join('')}
          </div>`
        : '';

      const contentHtml = msg.role === 'assistant'
        ? this.formatMarkdown(msg.content)
        : escapeHtml(msg.content);

      const timeStr = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

      return `
        <div class="cn-rag-msg ${msg.role}">
          ${contentHtml}
          ${msg.role === 'assistant' ? sourcesHtml : ''}
          <div class="cn-rag-msg-time">${timeStr}</div>
        </div>
      `;
    }).join('');

    if (this.isLoading) {
      html += `
        <div class="cn-rag-typing">
          <div class="cn-rag-typing-dot"></div>
          <div class="cn-rag-typing-dot"></div>
          <div class="cn-rag-typing-dot"></div>
        </div>
      `;
    }

    return html;
  }

  /** Convert common markdown patterns to HTML for assistant messages */
  private formatMarkdown(text: string): string {
    return escapeHtml(text)
      // **bold**
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // ### / ## / # headings → bold block
      .replace(/^#{1,3}\s+(.+)$/gm, '<div style="font-weight:700;margin:6px 0 2px">$1</div>')
      // numbered lists: 1. xxx
      .replace(/^\d+\.\s+(.+)$/gm, '<div style="padding-left:16px;text-indent:-14px;margin:2px 0"><span style="color:#ef5350;font-weight:600;margin-right:2px">·</span>$1</div>')
      // bullet lists: - xxx
      .replace(/^[-•]\s+(.+)$/gm, '<div style="padding-left:16px;text-indent:-14px;margin:2px 0"><span style="color:#ef5350;font-weight:600;margin-right:2px">·</span>$1</div>')
      // [来源:xxx] citation tags → styled inline badge
      .replace(/\[来源:(.+?)\]/g, '<span class="cn-rag-cite">$1</span>')
      .replace(/\[(行情|研报|政策|舆情|热点):(.+?)\]/g, '<span class="cn-rag-cite">$1:$2</span>')
      // newlines
      .replace(/\n/g, '<br>');
  }

  private attachInputListeners(): void {
    const input = this.content.querySelector('#cnRagInput') as HTMLInputElement | null;
    const sendBtn = this.content.querySelector('#cnRagSend') as HTMLButtonElement | null;

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !this.isLoading) {
          e.preventDefault();
          const question = input.value.trim();
          if (question) {
            void this.sendQuestion(question);
          }
        }
      });
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        if (this.isLoading) return;
        const question = input?.value.trim();
        if (question) {
          void this.sendQuestion(question);
        }
      });
    }
  }

  private async sendQuestion(question: string): Promise<void> {
    if (this.isLoading) return;

    this.messages.push({
      role: 'user',
      content: question,
      timestamp: Date.now(),
    });

    this.isLoading = true;
    this.renderPanel();

    // Try SSE streaming first, fallback to regular POST
    try {
      await this.sendQuestionStream(question);
    } catch (err) {
      if (this.isAbortError(err)) return;
      // Fallback to non-streaming
      try {
        const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/rag/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, session_id: this.sessionId }),
          signal: this.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        this.messages.push({
          role: 'assistant',
          content: data.answer || '抱歉，暂时无法回答这个问题。',
          timestamp: Date.now(),
          sources: data.sources,
        });
      } catch (err2) {
        if (this.isAbortError(err2)) return;
        this.messages.push({
          role: 'assistant',
          content: '请求失败，请稍后重试。',
          timestamp: Date.now(),
        });
      }
    } finally {
      this.isLoading = false;
      this.renderPanel();
    }
  }

  private async sendQuestionStream(question: string): Promise<void> {
    const res = await cnFetch(`${CN_INTEL_BASE}/api/cn/rag/ask-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, session_id: this.sessionId }),
      signal: this.signal,
    });

    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    // Add placeholder assistant message for streaming
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    this.messages.push(assistantMsg);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'chunk') {
            assistantMsg.content += event.content;
            this.renderPanel();
          } else if (event.type === 'done') {
            assistantMsg.sources = event.sources;
          }
        } catch { /* skip malformed */ }
      }
    }

    if (!assistantMsg.content) {
      throw new Error('Empty stream response');
    }
  }

  public destroy(): void {
    super.destroy();
  }
}

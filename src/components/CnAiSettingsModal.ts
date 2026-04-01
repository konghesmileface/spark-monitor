/**
 * CnAiSettingsModal — AI engine settings dialog.
 *
 * Features:
 *   1. Reorder AI provider priority (click to promote to #1)
 *   2. Enter custom API keys per provider (overrides platform default)
 *   3. Mask/unmask key display, delete individual keys
 */
import {
  getAIProviders,
  saveProfile,
  saveAIKeys,
  deleteAIKey,
  type AIProvider,
} from '@/services/cn-profile';
import { escapeHtml } from '@/utils/sanitize';

const MODAL_STYLE = `<style>
@layer base {
.cn-ai-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;
}
.cn-ai-modal {
  background: #1a1a2e; border: 1px solid rgba(232,168,56,0.3); border-radius: 12px;
  width: 520px; max-width: 95vw; max-height: 85vh; overflow-y: auto;
  padding: 20px; color: #e0e0e0; font-size: 13px;
}
.cn-ai-title {
  font-size: 16px; font-weight: 700; color: #e8a838; margin-bottom: 16px;
  display: flex; align-items: center; justify-content: space-between;
}
.cn-ai-close {
  background: none; border: none; color: #888; cursor: pointer; font-size: 18px;
}
.cn-ai-close:hover { color: #e8a838; }
.cn-ai-group {
  margin-bottom: 16px; padding: 12px; border-radius: 8px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04);
}
.cn-ai-group-title {
  font-size: 12px; font-weight: 700; color: #e8a838; margin-bottom: 10px;
  display: flex; align-items: center; gap: 6px;
}
.cn-ai-hint {
  font-size: 11px; color: #666; margin-bottom: 8px;
}
/* Provider order chips */
.cn-ai-chips {
  display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px;
}
.cn-ai-chip {
  padding: 5px 12px; border-radius: 8px; cursor: pointer; font-size: 12px;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04); color: #bbb;
  transition: all .15s; user-select: none; display: flex; align-items: center; gap: 4px;
}
.cn-ai-chip:hover { background: rgba(255,255,255,0.08); }
.cn-ai-chip.active {
  background: rgba(232,168,56,0.15); color: #e8a838; border-color: rgba(232,168,56,0.3);
}
.cn-ai-chip.disabled { opacity: 0.5; cursor: not-allowed; }
.cn-ai-chip-rank { font-size: 10px; opacity: 0.6; }
/* Key rows */
.cn-ai-key-row {
  margin-bottom: 12px;
}
.cn-ai-key-label {
  font-size: 12px; font-weight: 600; color: #ccc; margin-bottom: 4px;
}
.cn-ai-key-input-wrap {
  display: flex; align-items: center; gap: 6px;
}
.cn-ai-key-input {
  flex: 1; box-sizing: border-box;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px; padding: 6px 10px; color: #ddd; font-size: 12px;
  font-family: 'Courier New', monospace;
}
.cn-ai-key-input::placeholder { color: #555; }
.cn-ai-key-btn {
  background: none; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
  color: #888; cursor: pointer; padding: 5px 8px; font-size: 14px;
  transition: all .15s;
}
.cn-ai-key-btn:hover { color: #e8a838; border-color: rgba(232,168,56,0.3); }
.cn-ai-key-status {
  font-size: 10px; margin-top: 3px;
}
.cn-ai-key-status.custom { color: #4caf50; }
.cn-ai-key-status.default { color: #666; }
/* Footer */
.cn-ai-footer {
  display: flex; align-items: center; justify-content: space-between; margin-top: 16px;
}
.cn-ai-footer-hint {
  font-size: 11px; color: #555; display: flex; align-items: center; gap: 4px;
}
.cn-ai-actions {
  display: flex; gap: 8px;
}
.cn-ai-btn {
  padding: 6px 20px; border-radius: 6px; font-size: 12px; cursor: pointer; border: none;
}
.cn-ai-btn-save {
  background: rgba(232,168,56,0.2); color: #e8a838; border: 1px solid rgba(232,168,56,0.3);
}
.cn-ai-btn-save:hover { background: rgba(232,168,56,0.35); }
.cn-ai-btn-cancel {
  background: rgba(255,255,255,0.06); color: #aaa;
}
.cn-ai-btn-cancel:hover { background: rgba(255,255,255,0.1); }
} /* @layer base */
</style>`;

let _modalEl: HTMLElement | null = null;

// State
let _providers: AIProvider[] = [];
let _providerOrder: string[] = [];
// Tracks the raw input values (empty string = no custom key / cleared)
let _keyInputs: Record<string, string> = {};
// Tracks visibility toggle per provider
let _keyVisible: Record<string, boolean> = {};

export async function openAiSettingsModal(): Promise<void> {
  if (_modalEl) return;

  // Fetch current providers + order
  try {
    const { providers, user_order } = await getAIProviders();
    _providers = providers;
    _providerOrder = user_order.length
      ? user_order
      : providers.map((p) => p.name);
  } catch {
    _providers = [];
    _providerOrder = [];
  }

  // Init key inputs from masked keys (user will overwrite if they want to change)
  _keyInputs = {};
  _keyVisible = {};
  for (const p of _providers) {
    // We use empty string to mean "no change / use existing".
    // The masked_key is shown as placeholder.
    _keyInputs[p.name] = '';
    _keyVisible[p.name] = false;
  }

  _modalEl = document.createElement('div');
  _render();
  document.body.appendChild(_modalEl);

  // ESC to close
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') _close();
  };
  document.addEventListener('keydown', onKey);
  (_modalEl as any)._onKey = onKey;
}

function _close(): void {
  if (!_modalEl) return;
  const onKey = (_modalEl as any)._onKey;
  if (onKey) document.removeEventListener('keydown', onKey);
  _modalEl.remove();
  _modalEl = null;
}

function _render(): void {
  if (!_modalEl) return;

  const byName = new Map(_providers.map((p) => [p.name, p]));

  // Build order chips
  const chips = _providerOrder
    .map((name, i) => {
      const p = byName.get(name);
      if (!p) return '';
      const cls =
        'cn-ai-chip' +
        (i === 0 ? ' active' : '') +
        (!p.available ? ' disabled' : '');
      return `<span class="${cls}" data-provider="${p.name}"><span class="cn-ai-chip-rank">${i + 1}.</span>${_esc(p.label)}</span>`;
    })
    .join('');

  // Build key rows
  const keyRows = _providers
    .map((p) => {
      const hasCustom = p.has_custom_key;
      const masked = p.masked_key || '';
      const inputVal = _keyInputs[p.name] || '';
      const visible = _keyVisible[p.name];

      const placeholder = hasCustom ? masked : '未设置';
      const type = visible ? 'text' : 'password';
      const eyeIcon = visible ? '<i class="bi bi-eye-slash"></i>' : '<i class="bi bi-eye"></i>';
      const eyeTitle = visible ? '隐藏' : '显示';

      const statusCls = hasCustom ? 'custom' : 'default';
      const statusText = hasCustom
        ? '<i class="bi bi-check-circle" style="font-size:10px"></i> 使用自定义密钥'
        : '使用平台默认密钥';

      const deleteBtn = hasCustom
        ? `<button class="cn-ai-key-btn" data-delete="${p.name}" title="删除自定义密钥">&#128465;</button>`
        : '';

      return `<div class="cn-ai-key-row">
        <div class="cn-ai-key-label">${_esc(p.label)}</div>
        <div class="cn-ai-key-input-wrap">
          <input class="cn-ai-key-input" type="${type}" data-key="${p.name}"
                 placeholder="${_esc(placeholder)}" value="${_esc(inputVal)}"
                 autocomplete="off" spellcheck="false">
          <button class="cn-ai-key-btn" data-eye="${p.name}" title="${eyeTitle}">${eyeIcon}</button>
          ${deleteBtn}
        </div>
        <div class="cn-ai-key-status ${statusCls}">${statusText}</div>
      </div>`;
    })
    .join('');

  _modalEl!.innerHTML =
    MODAL_STYLE +
    `<div class="cn-ai-overlay" data-overlay>
    <div class="cn-ai-modal">
      <div class="cn-ai-title">
        <span><i class="bi bi-gear" style="margin-right:6px"></i>AI引擎设置</span>
        <button class="cn-ai-close" data-close>&times;</button>
      </div>

      <div class="cn-ai-group">
        <div class="cn-ai-group-title"><i class="bi bi-sort-numeric-down"></i> AI引擎优先顺序</div>
        <div class="cn-ai-hint">点击引擎名称可提升到第1位</div>
        <div class="cn-ai-chips">${chips}</div>
      </div>

      <div class="cn-ai-group">
        <div class="cn-ai-group-title"><i class="bi bi-key"></i> 自定义API密钥</div>
        <div class="cn-ai-hint">输入自定义密钥后，该引擎将优先使用您的密钥</div>
        ${keyRows}
      </div>

      <div class="cn-ai-footer">
        <div class="cn-ai-footer-hint"><i class="bi bi-info-circle"></i> 未设置时使用平台默钥</div>
        <div class="cn-ai-save-error" style="display:none;color:#ff6b6b;font-size:13px;text-align:center;margin-bottom:8px"></div>
        <div class="cn-ai-actions">
          <button class="cn-ai-btn cn-ai-btn-cancel" data-cancel>取消</button>
          <button class="cn-ai-btn cn-ai-btn-save" data-save>保存</button>
        </div>
      </div>
    </div>
  </div>`;

  _bindEvents();
}

function _bindEvents(): void {
  if (!_modalEl) return;

  _modalEl.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;

    // Close buttons
    if (target.closest('[data-close]') || target.closest('[data-cancel]')) {
      _close();
      return;
    }

    // Overlay click
    if (target.hasAttribute('data-overlay')) {
      _close();
      return;
    }

    // Provider chip click → promote
    const chip = target.closest('.cn-ai-chip') as HTMLElement | null;
    if (chip && !chip.classList.contains('disabled')) {
      const name = chip.dataset.provider;
      if (name && _providerOrder.includes(name)) {
        _providerOrder = [name, ..._providerOrder.filter((n) => n !== name)];
        _captureInputValues();
        _render();
      }
      return;
    }

    // Eye toggle
    const eyeBtn = target.closest('[data-eye]') as HTMLElement | null;
    if (eyeBtn) {
      const name = eyeBtn.dataset.eye!;
      _captureInputValues();
      _keyVisible[name] = !_keyVisible[name];
      _render();
      // Refocus the input
      setTimeout(() => {
        const input = _modalEl?.querySelector(`input[data-key="${name}"]`) as HTMLInputElement;
        if (input) input.focus();
      }, 0);
      return;
    }

    // Delete key
    const delBtn = target.closest('[data-delete]') as HTMLElement | null;
    if (delBtn) {
      const name = delBtn.dataset.delete!;
      try {
        await deleteAIKey(name);
      } catch { /* ignore */ }
      // Update local state
      const p = _providers.find((pr) => pr.name === name);
      if (p) {
        p.has_custom_key = false;
        p.masked_key = '';
      }
      _keyInputs[name] = '';
      _render();
      return;
    }

    // Save
    if (target.closest('[data-save]')) {
      await _save();
      return;
    }
  });
}

function _captureInputValues(): void {
  if (!_modalEl) return;
  for (const p of _providers) {
    const input = _modalEl.querySelector(`input[data-key="${p.name}"]`) as HTMLInputElement | null;
    if (input) {
      _keyInputs[p.name] = input.value;
    }
  }
}

async function _save(): Promise<void> {
  _captureInputValues();
  const errors: string[] = [];

  // 1. Save provider order
  try {
    await saveProfile({ ai_provider_order: _providerOrder });
  } catch (e) {
    console.warn('Failed to save provider order:', e);
    errors.push('引擎优先顺序保存失败');
  }

  // 2. Save any custom keys that were entered (non-empty input values)
  const keysToSave: Record<string, string> = {};
  for (const p of _providers) {
    const val = _keyInputs[p.name];
    if (val) {
      keysToSave[p.name] = val;
    }
  }
  if (Object.keys(keysToSave).length > 0) {
    try {
      await saveAIKeys(keysToSave);
    } catch (e) {
      console.warn('Failed to save AI keys:', e);
      errors.push('API密钥保存失败');
    }
  }

  if (errors.length > 0) {
    const errEl = _modalEl?.querySelector('.cn-ai-save-error');
    if (errEl) {
      errEl.textContent = errors.join('；') + '，请重试';
      (errEl as HTMLElement).style.display = 'block';
    } else {
      alert(errors.join('；') + '，请重试');
    }
    return;
  }

  _close();
}

const _esc = escapeHtml;

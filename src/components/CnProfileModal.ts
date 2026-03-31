/**
 * CnProfileModal — Enterprise profile configuration modal.
 * Grouped layout:
 *   1. 基本信息 (company_name locked, company_size locked, business_scope, key_products)
 *   2. 行业与供应链 (industries expanded to 16, supply_chain_up/down)
 *   3. 竞争与合规 (competitors, compliance_concerns, business_regions)
 *   4. 政策关注 (focus_policy_areas, tracked_keywords, exclude_keywords)
 *   5. 智能设置 (alert_min_score)
 */
import { loadProfile, saveProfile, type UserProfile } from '@/services/cn-profile';

const INDUSTRIES = [
  { key: '新能源', label: '新能源', bi: 'bi-lightning-charge' },
  { key: '半导体', label: '半导体', bi: 'bi-cpu' },
  { key: 'AI', label: 'AI/人工智能', bi: 'bi-robot' },
  { key: '生物医药', label: '生物医药', bi: 'bi-capsule' },
  { key: '新材料', label: '新材料', bi: 'bi-gem' },
  { key: '高端装备', label: '高端装备', bi: 'bi-gear-wide-connected' },
  { key: '汽车制造', label: '汽车制造', bi: 'bi-truck' },
  { key: '消费电子', label: '消费电子', bi: 'bi-phone' },
  { key: '金融科技', label: '金融科技', bi: 'bi-bank' },
  { key: '互联网', label: '互联网', bi: 'bi-globe' },
  { key: '军工国防', label: '军工国防', bi: 'bi-shield-check' },
  { key: '通信', label: '通信', bi: 'bi-broadcast' },
  { key: '基建', label: '基建', bi: 'bi-cone-striped' },
  { key: '机器人', label: '机器人', bi: 'bi-gpu-card' },
  { key: '环保', label: '环保', bi: 'bi-recycle' },
  { key: '化工', label: '化工', bi: 'bi-droplet-half' },
];

const COMPANY_SIZES = ['微型', '小型', '中型', '大型', '集团'];

const COMPLIANCE_OPTIONS = [
  '数据安全', 'ESG', '出口管制', '环保', '反垄断', '知识产权', '劳动法', '税务合规',
];

const REGION_OPTIONS = [
  '长三角', '珠三角', '京津冀', '中西部', '东北', '东南亚', '欧洲', '北美',
];

const POLICY_AREA_OPTIONS = [
  '产业政策', '财税政策', '金融监管', '环保政策', '贸易政策',
  '科技创新', '数字经济', '人才就业', '资本市场', '国企改革',
];

const MODAL_STYLE = `<style>
.cn-profile-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;
}
.cn-profile-modal {
  background: #1a1a2e; border: 1px solid rgba(232,168,56,0.3); border-radius: 12px;
  width: 560px; max-width: 95vw; max-height: 85vh; overflow-y: auto;
  padding: 20px; color: #e0e0e0; font-size: 13px;
}
.cn-profile-title {
  font-size: 16px; font-weight: 700; color: #e8a838; margin-bottom: 16px;
  display: flex; align-items: center; justify-content: space-between;
}
.cn-profile-close {
  background: none; border: none; color: #888; cursor: pointer; font-size: 18px;
}
.cn-profile-group {
  margin-bottom: 16px; padding: 12px; border-radius: 8px;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04);
}
.cn-profile-group-title {
  font-size: 12px; font-weight: 700; color: #e8a838; margin-bottom: 10px;
  display: flex; align-items: center; gap: 6px;
}
.cn-profile-section { margin-bottom: 12px; }
.cn-profile-section:last-child { margin-bottom: 0; }
.cn-profile-label { font-size: 11px; color: #aaa; margin-bottom: 5px; font-weight: 600; }
.cn-profile-grid {
  display: flex; flex-wrap: wrap; gap: 6px;
}
.cn-profile-chip {
  padding: 5px 10px; border-radius: 8px; cursor: pointer; font-size: 11px;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04); color: #bbb;
  transition: all .15s; user-select: none;
}
.cn-profile-chip.selected {
  background: rgba(232,168,56,0.15); color: #e8a838; border-color: rgba(232,168,56,0.3);
}
.cn-profile-chip:hover { background: rgba(255,255,255,0.08); }
.cn-profile-chip.disabled {
  opacity: 0.5; cursor: not-allowed; pointer-events: none;
}
.cn-profile-input {
  width: 100%; box-sizing: border-box;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px; padding: 6px 10px; color: #ddd; font-size: 12px;
}
.cn-profile-input.locked {
  background: rgba(255,255,255,0.02); color: #666; cursor: not-allowed;
}
.cn-profile-textarea {
  width: 100%; box-sizing: border-box;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px; padding: 6px 10px; color: #ddd; font-size: 12px;
  resize: vertical; min-height: 48px; font-family: inherit;
}
.cn-profile-input::placeholder, .cn-profile-textarea::placeholder { color: #555; }
.cn-profile-slider-wrap {
  display: flex; align-items: center; gap: 10px;
}
.cn-profile-slider {
  flex: 1; -webkit-appearance: none; height: 4px; border-radius: 2px;
  background: rgba(255,255,255,0.1); outline: none;
}
.cn-profile-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
  background: #e8a838; cursor: pointer;
}
.cn-profile-slider-val { color: #e8a838; font-weight: 600; min-width: 28px; text-align: center; }
.cn-profile-actions {
  display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;
}
.cn-profile-btn {
  padding: 6px 20px; border-radius: 6px; font-size: 12px; cursor: pointer; border: none;
}
.cn-profile-btn-save {
  background: rgba(232,168,56,0.2); color: #e8a838; border: 1px solid rgba(232,168,56,0.3);
}
.cn-profile-btn-save:hover { background: rgba(232,168,56,0.35); }
.cn-profile-btn-cancel {
  background: rgba(255,255,255,0.06); color: #aaa;
}
.cn-profile-btn-cancel:hover { background: rgba(255,255,255,0.1); }
.cn-profile-lock-hint {
  font-size: 10px; color: #555; margin-top: 3px; display: flex; align-items: center; gap: 4px;
}
</style>`;

let _modalEl: HTMLElement | null = null;
let _companyName = '';
let _companySize = '';
let _businessScope = '';
let _keyProductsInput = '';
let _selectedIndustries: Set<string> = new Set();
let _keywordsInput = '';
let _excludeKeywordsInput = '';
let _supplyChainUp = '';
let _supplyChainDown = '';
let _competitorsInput = '';
let _selectedCompliance: Set<string> = new Set();
let _selectedRegions: Set<string> = new Set();
let _selectedPolicyAreas: Set<string> = new Set();
let _alertMinScore = 60;

export async function openProfileModal(onSaved?: (p: UserProfile) => void): Promise<void> {
  if (_modalEl) return; // already open

  // Load existing profile
  const { profile } = await loadProfile();
  _companyName = profile?.company_name || '';
  _companySize = profile?.company_size || '';
  _businessScope = profile?.business_scope || '';
  _keyProductsInput = (profile?.key_products || []).join(', ');
  _selectedIndustries = new Set(profile?.industries || []);
  _keywordsInput = (profile?.tracked_keywords || []).join(', ');
  _excludeKeywordsInput = (profile?.exclude_keywords || []).join(', ');
  _supplyChainUp = (profile?.supply_chain_up || []).join(', ');
  _supplyChainDown = (profile?.supply_chain_down || []).join(', ');
  _competitorsInput = (profile?.competitors || []).join(', ');
  _selectedCompliance = new Set(profile?.compliance_concerns || []);
  _selectedRegions = new Set(profile?.business_regions || []);
  _selectedPolicyAreas = new Set(profile?.focus_policy_areas || []);
  _alertMinScore = profile?.alert_min_score ?? 60;

  _modalEl = document.createElement('div');
  _modalEl.innerHTML = MODAL_STYLE + _buildHTML();
  document.body.appendChild(_modalEl);

  // Event delegation
  _modalEl.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;

    // Close
    if (target.closest('.cn-profile-close') || target.classList.contains('cn-profile-overlay')) {
      _close();
      return;
    }

    // Industry chip toggle
    const indChip = target.closest('.cn-profile-chip[data-industry]') as HTMLElement | null;
    if (indChip?.dataset.industry) {
      const ind = indChip.dataset.industry;
      if (_selectedIndustries.has(ind)) _selectedIndustries.delete(ind);
      else _selectedIndustries.add(ind);
      indChip.classList.toggle('selected');
      return;
    }

    // Compliance chip toggle
    const compChip = target.closest('.cn-profile-chip[data-compliance]') as HTMLElement | null;
    if (compChip?.dataset.compliance) {
      const val = compChip.dataset.compliance;
      if (_selectedCompliance.has(val)) _selectedCompliance.delete(val);
      else _selectedCompliance.add(val);
      compChip.classList.toggle('selected');
      return;
    }

    // Region chip toggle
    const regChip = target.closest('.cn-profile-chip[data-region]') as HTMLElement | null;
    if (regChip?.dataset.region) {
      const val = regChip.dataset.region;
      if (_selectedRegions.has(val)) _selectedRegions.delete(val);
      else _selectedRegions.add(val);
      regChip.classList.toggle('selected');
      return;
    }

    // Policy area chip toggle
    const polChip = target.closest('.cn-profile-chip[data-policy]') as HTMLElement | null;
    if (polChip?.dataset.policy) {
      const val = polChip.dataset.policy;
      if (_selectedPolicyAreas.has(val)) _selectedPolicyAreas.delete(val);
      else _selectedPolicyAreas.add(val);
      polChip.classList.toggle('selected');
      return;
    }

    // Cancel
    if (target.closest('.cn-profile-btn-cancel')) {
      _close();
      return;
    }

    // Save
    if (target.closest('.cn-profile-btn-save')) {
      const saveBtn = _modalEl?.querySelector('.cn-profile-btn-save') as HTMLButtonElement | null;
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';
        saveBtn.style.opacity = '0.6';
      }

      const scopeEl = _modalEl?.querySelector('.cn-profile-scope') as HTMLTextAreaElement | null;
      const productsEl = _modalEl?.querySelector('.cn-profile-products') as HTMLInputElement | null;
      const kwEl = _modalEl?.querySelector('.cn-profile-keywords') as HTMLInputElement | null;
      const exKwEl = _modalEl?.querySelector('.cn-profile-exclude-keywords') as HTMLInputElement | null;
      const upEl = _modalEl?.querySelector('.cn-profile-chain-up') as HTMLInputElement | null;
      const downEl = _modalEl?.querySelector('.cn-profile-chain-down') as HTMLInputElement | null;
      const compEl = _modalEl?.querySelector('.cn-profile-competitors') as HTMLInputElement | null;
      const sliderEl = _modalEl?.querySelector('.cn-profile-slider') as HTMLInputElement | null;

      const splitInput = (val: string) => val.split(/[,，\s]+/).filter(Boolean);

      try {
        // Do NOT send locked fields (company_name, company_size) — keep existing values
        const saved = await saveProfile({
          company_name: _companyName,   // preserve, not editable
          company_size: _companySize,   // preserve, not editable
          business_scope: scopeEl?.value?.trim() || '',
          key_products: splitInput(productsEl?.value || ''),
          industries: Array.from(_selectedIndustries),
          tracked_keywords: splitInput(kwEl?.value || ''),
          exclude_keywords: splitInput(exKwEl?.value || ''),
          supply_chain_up: splitInput(upEl?.value || ''),
          supply_chain_down: splitInput(downEl?.value || ''),
          competitors: splitInput(compEl?.value || ''),
          compliance_concerns: Array.from(_selectedCompliance),
          business_regions: Array.from(_selectedRegions),
          focus_policy_areas: Array.from(_selectedPolicyAreas),
          alert_min_score: parseInt(sliderEl?.value || '60', 10),
        });
        if (saved && onSaved) onSaved(saved);
        _close();
      } catch (err) {
        console.error('[CnProfileModal] save failed:', err);
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = '保存失败，重试';
          saveBtn.style.opacity = '1';
          saveBtn.style.background = 'rgba(220,53,69,0.25)';
        }
      }
    }
  });

  // Slider live update
  _modalEl.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.classList.contains('cn-profile-slider')) {
      const valEl = _modalEl?.querySelector('.cn-profile-slider-val');
      if (valEl) valEl.textContent = target.value;
    }
  });
}

function _close(): void {
  if (_modalEl) {
    _modalEl.remove();
    _modalEl = null;
  }
}

function _buildHTML(): string {
  const industryChips = INDUSTRIES.map(ind => {
    const sel = _selectedIndustries.has(ind.key) ? ' selected' : '';
    return `<div class="cn-profile-chip${sel}" data-industry="${ind.key}"><i class="${ind.bi}"></i> ${ind.label}</div>`;
  }).join('');

  const sizeChips = COMPANY_SIZES.map(s => {
    const sel = _companySize === s ? ' selected' : '';
    return `<div class="cn-profile-chip${sel} disabled" data-size="${s}">${s}</div>`;
  }).join('');

  const complianceChips = COMPLIANCE_OPTIONS.map(c => {
    const sel = _selectedCompliance.has(c) ? ' selected' : '';
    return `<div class="cn-profile-chip${sel}" data-compliance="${c}">${c}</div>`;
  }).join('');

  const regionChips = REGION_OPTIONS.map(r => {
    const sel = _selectedRegions.has(r) ? ' selected' : '';
    return `<div class="cn-profile-chip${sel}" data-region="${r}">${r}</div>`;
  }).join('');

  const policyChips = POLICY_AREA_OPTIONS.map(p => {
    const sel = _selectedPolicyAreas.has(p) ? ' selected' : '';
    return `<div class="cn-profile-chip${sel}" data-policy="${p}">${p}</div>`;
  }).join('');

  const esc = (s: string) => s.replace(/"/g, '&quot;');

  return `
<div class="cn-profile-overlay">
<div class="cn-profile-modal">
  <div class="cn-profile-title">
    <span><i class="bi bi-building"></i> 企业画像设置</span>
    <button class="cn-profile-close"><i class="bi bi-x-lg"></i></button>
  </div>

  <!-- Group 1: 基本信息 -->
  <div class="cn-profile-group">
    <div class="cn-profile-group-title"><i class="bi bi-info-circle"></i> 基本信息</div>
    <div class="cn-profile-section">
      <div class="cn-profile-label"><i class="bi bi-lock"></i> 企业名称</div>
      <input class="cn-profile-input locked" disabled value="${esc(_companyName)}" placeholder="注册时填写">
      <div class="cn-profile-lock-hint"><i class="bi bi-lock"></i> 如需修改请联系管理员</div>
    </div>
    <div class="cn-profile-section">
      <div class="cn-profile-label"><i class="bi bi-lock"></i> 企业规模</div>
      <div class="cn-profile-grid">${sizeChips}</div>
      <div class="cn-profile-lock-hint"><i class="bi bi-lock"></i> 关联定价层级，如需修改请联系管理员</div>
    </div>
    <div class="cn-profile-section">
      <div class="cn-profile-label">主营业务</div>
      <textarea class="cn-profile-textarea cn-profile-scope" placeholder="简要描述企业核心业务，如: 新能源汽车电池PACK研发与制造">${_businessScope}</textarea>
    </div>
    <div class="cn-profile-section">
      <div class="cn-profile-label">核心产品/服务（逗号分隔）</div>
      <input class="cn-profile-input cn-profile-products" placeholder="电池PACK, BMS系统, 储能模组" value="${esc(_keyProductsInput)}">
    </div>
  </div>

  <!-- Group 2: 行业与供应链 -->
  <div class="cn-profile-group">
    <div class="cn-profile-group-title"><i class="bi bi-diagram-3"></i> 行业与供应链</div>
    <div class="cn-profile-section">
      <div class="cn-profile-label">所属行业（多选）</div>
      <div class="cn-profile-grid">${industryChips}</div>
    </div>
    <div class="cn-profile-section">
      <div class="cn-profile-label">上游供应链（逗号分隔）</div>
      <input class="cn-profile-input cn-profile-chain-up" placeholder="芯片, 稀土, 碳酸锂" value="${esc(_supplyChainUp)}">
    </div>
    <div class="cn-profile-section">
      <div class="cn-profile-label">下游客户/渠道（逗号分隔）</div>
      <input class="cn-profile-input cn-profile-chain-down" placeholder="汽车OEM, 消费电子" value="${esc(_supplyChainDown)}">
    </div>
  </div>

  <!-- Group 3: 竞争与合规 -->
  <div class="cn-profile-group">
    <div class="cn-profile-group-title"><i class="bi bi-shield-check"></i> 竞争与合规</div>
    <div class="cn-profile-section">
      <div class="cn-profile-label">主要竞争对手（逗号分隔）</div>
      <input class="cn-profile-input cn-profile-competitors" placeholder="比亚迪, 宁德时代" value="${esc(_competitorsInput)}">
    </div>
    <div class="cn-profile-section">
      <div class="cn-profile-label">合规关注点（多选）</div>
      <div class="cn-profile-grid">${complianceChips}</div>
    </div>
    <div class="cn-profile-section">
      <div class="cn-profile-label">经营区域（多选）</div>
      <div class="cn-profile-grid">${regionChips}</div>
    </div>
  </div>

  <!-- Group 4: 政策关注 -->
  <div class="cn-profile-group">
    <div class="cn-profile-group-title"><i class="bi bi-megaphone"></i> 政策关注</div>
    <div class="cn-profile-section">
      <div class="cn-profile-label">关注政策领域（多选）</div>
      <div class="cn-profile-grid">${policyChips}</div>
    </div>
    <div class="cn-profile-section">
      <div class="cn-profile-label">自定义监控关键词（逗号分隔）</div>
      <input class="cn-profile-input cn-profile-keywords" placeholder="降息, 碳中和, 芯片出口" value="${esc(_keywordsInput)}">
    </div>
    <div class="cn-profile-section">
      <div class="cn-profile-label">屏蔽关键词（逗号分隔，降噪用）</div>
      <input class="cn-profile-input cn-profile-exclude-keywords" placeholder="招聘, 培训, 广告" value="${esc(_excludeKeywordsInput)}">
    </div>
  </div>

  <!-- Group 5: 智能设置 -->
  <div class="cn-profile-group">
    <div class="cn-profile-group-title"><i class="bi bi-gear"></i> 智能设置</div>
    <div class="cn-profile-section">
      <div class="cn-profile-label">告警最低评分</div>
      <div class="cn-profile-slider-wrap">
        <input type="range" class="cn-profile-slider" min="0" max="100" step="5" value="${_alertMinScore}">
        <span class="cn-profile-slider-val">${_alertMinScore}</span>
      </div>
    </div>
  </div>

  <div class="cn-profile-actions">
    <button class="cn-profile-btn cn-profile-btn-cancel">取消</button>
    <button class="cn-profile-btn cn-profile-btn-save">保存</button>
  </div>
</div>
</div>`;
}

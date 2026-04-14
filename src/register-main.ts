// World Monitor — Register page logic

const CN_INTEL_BASE = import.meta.env.VITE_CN_INTEL_BASE || '';

// Desktop (Tauri) runtime: route API calls through the local sidecar.
const _isDesktop = import.meta.env.VITE_DESKTOP_RUNTIME === '1'
  || (typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window));

let _sidecarBase = '';
let _sidecarReady: Promise<void> | null = null;

if (_isDesktop) {
  _sidecarReady = (async () => {
    try {
      const w = window as unknown as {
        __TAURI__?: { core?: { invoke?: <T>(cmd: string) => Promise<T> } };
        __TAURI_INTERNALS__?: { invoke?: <T>(cmd: string) => Promise<T> };
      };
      const invoke = w.__TAURI__?.core?.invoke ?? w.__TAURI_INTERNALS__?.invoke;
      if (invoke) {
        const port = await invoke<number>('get_local_api_port').catch(() => 46123);
        _sidecarBase = `http://127.0.0.1:${port}`;
      } else {
        _sidecarBase = `http://127.0.0.1:46123`;
      }
    } catch {
      _sidecarBase = `http://127.0.0.1:46123`;
    }
  })();
}

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (_isDesktop && input.startsWith('/api/')) {
    if (_sidecarReady) await _sidecarReady;
    return fetch(`${_sidecarBase}${input}`, init);
  }
  return fetch(`${CN_INTEL_BASE}${input}`, init);
}

// Available industries (same as cn-intel-service AVAILABLE_INDUSTRIES)
const INDUSTRIES = [
  '新能源', '半导体', '人工智能', '生物医药', '新材料', '高端装备',
  '汽车制造', '消费电子', '金融科技', '房地产', '教育', '医疗健康',
  '互联网', '电子商务', '物流运输', '农业科技', '环保', '文化传媒',
  '军工国防', '航空航天', '化工', '钢铁', '有色金属', '食品饮料',
];

const msgBox = document.getElementById('msgBox') as HTMLDivElement;
const form = document.getElementById('registerForm') as HTMLFormElement;
const submitBtn = document.getElementById('submitBtn') as HTMLButtonElement;

// ── Industry chips ──
const chipContainer = document.getElementById('industryChips')!;
const selectedIndustries = new Set<string>();

INDUSTRIES.forEach(ind => {
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.textContent = ind;
  chip.addEventListener('click', () => {
    if (selectedIndustries.has(ind)) {
      selectedIndustries.delete(ind);
      chip.classList.remove('active');
    } else {
      selectedIndustries.add(ind);
      chip.classList.add('active');
    }
  });
  chipContainer.appendChild(chip);
});

// ── Tags input ──
function initTagsInput(containerId: string): { get: () => string[]; reset: () => void } {
  const container = document.getElementById(containerId)!;
  const input = container.querySelector('input')!;
  const tags: string[] = [];

  function addTag(text: string) {
    const t = text.trim();
    if (!t || tags.includes(t)) return;
    tags.push(t);
    const tag = document.createElement('span');
    tag.className = 'tag';
    const textNode = document.createTextNode(t);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = '&times;';
    tag.appendChild(textNode);
    tag.appendChild(btn);
    btn.addEventListener('click', () => {
      const idx = tags.indexOf(t);
      if (idx >= 0) tags.splice(idx, 1);
      tag.remove();
    });
    container.insertBefore(tag, input);
    input.value = '';
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag(input.value);
    }
    if (e.key === 'Backspace' && !input.value && tags.length) {
      tags.pop();
      container.querySelector(`.tag:last-of-type`)?.remove();
    }
  });

  container.addEventListener('click', () => input.focus());

  return {
    get: () => [...tags],
    reset: () => {
      tags.length = 0;
      container.querySelectorAll('.tag').forEach(t => t.remove());
    },
  };
}

const competitors = initTagsInput('competitorTags');
const supplyUp = initTagsInput('supplyUpTags');
const supplyDown = initTagsInput('supplyDownTags');

// ── Form submit ──
function showMsg(text: string, type: 'error' | 'success') {
  msgBox.textContent = text;
  msgBox.className = `msg msg-${type} show`;
  msgBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msgBox.className = 'msg';

  const fd = new FormData(form);
  const email = (fd.get('email') as string).trim();
  const password = fd.get('password') as string;
  const password2 = fd.get('password2') as string;

  if (password !== password2) {
    showMsg('两次输入的密码不一致', 'error');
    return;
  }
  if (password.length < 8) {
    showMsg('密码至少8位', 'error');
    return;
  }

  // Validate custom components (not covered by native required)
  if (selectedIndustries.size === 0) {
    showMsg('请至少选择一个所属行业', 'error');
    return;
  }
  if (competitors.get().length === 0) {
    showMsg('请至少添加一个竞争对手', 'error');
    return;
  }
  if (supplyUp.get().length === 0) {
    showMsg('请至少添加一个上游供应链', 'error');
    return;
  }
  if (supplyDown.get().length === 0) {
    showMsg('请至少添加一个下游客户', 'error');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = '提交中...';

  const payload = {
    email,
    password,
    contact_name: (fd.get('contact_name') as string).trim(),
    contact_phone: (fd.get('contact_phone') as string).trim(),
    company_name: (fd.get('company_name') as string).trim(),
    company_size: fd.get('company_size') as string,
    business_scope: (fd.get('business_scope') as string).trim(),
    industries: Array.from(selectedIndustries),
    competitors: competitors.get(),
    supply_chain_up: supplyUp.get(),
    supply_chain_down: supplyDown.get(),
  };

  try {
    const res = await apiFetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (res.ok) {
      showMsg('申请已提交！我们将在1-2个工作日审核并通知您。', 'success');
      form.reset();
      chipContainer.querySelectorAll('.chip.active').forEach(c => c.classList.remove('active'));
      selectedIndustries.clear();
      competitors.reset();
      supplyUp.reset();
      supplyDown.reset();
    } else {
      showMsg(data.error || '提交失败，请稍后重试', 'error');
    }
  } catch (err) {
    showMsg('网络错误，请检查服务是否启动', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '提交申请';
  }
});

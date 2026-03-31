// Spark Monitor — Admin panel logic

const CN_INTEL_BASE = import.meta.env.VITE_CN_INTEL_BASE || '';

const token = localStorage.getItem('wm_token');
const user = JSON.parse(localStorage.getItem('wm_user') || '{}');

// Auth check
if (!token || user.role !== 'admin') {
  alert('需要管理员权限');
  window.location.href = 'login.html';
}

const headers = () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${token}`,
});

// Display admin email
document.getElementById('adminEmail')!.textContent = user.email || 'Admin';

// Logout
document.getElementById('logoutBtn')!.addEventListener('click', async () => {
  try {
    await fetch(`${CN_INTEL_BASE}/api/auth/logout`, { method: 'POST', headers: headers() });
  } catch {}
  localStorage.removeItem('wm_token');
  localStorage.removeItem('wm_user');
  window.location.href = 'login.html';
});

// ── Sidebar Nav ──
const navItems = document.querySelectorAll('.nav-item');
const panels = document.querySelectorAll('.panel');
navItems.forEach(item => {
  item.addEventListener('click', () => {
    const target = (item as HTMLElement).dataset.tab!;
    navItems.forEach(n => n.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(`panel-${target}`)!.classList.add('active');
    if (target === 'users') loadUsers();
    if (target === 'applications') loadApplications();
  });
});

// Status / size labels
const STATUS_LABELS: Record<string, string> = {
  pending: '待审核', approved: '已通过', rejected: '已拒绝', suspended: '已暂停'
};
const SIZE_LABELS: Record<string, string> = {
  micro: '微型', small: '小型', medium: '中型', large: '大型', enterprise: '集团'
};

function badgeClass(status: string): string {
  return `badge badge-${status}`;
}
function formatDate(d: string | null): string {
  if (!d) return '-';
  return d.replace('T', ' ').substring(0, 16);
}
function formatExpiryDate(d: string | null): string {
  if (!d) return '-';
  return d.substring(0, 10);
}
function getInitial(name: string): string {
  return (name || '?').charAt(0).toUpperCase();
}
function expiryStatus(d: string | null): { cls: string; label: string } {
  if (!d) return { cls: 'expiry-none', label: '未设置' };
  const expires = new Date(d);
  const now = new Date();
  const daysLeft = Math.ceil((expires.getTime() - now.getTime()) / (86400000));
  if (daysLeft < 0) return { cls: 'expiry-expired', label: `已过期 ${-daysLeft}天` };
  if (daysLeft <= 30) return { cls: 'expiry-warning', label: `${daysLeft}天后到期` };
  return { cls: 'expiry-active', label: formatExpiryDate(d) };
}

// ── Stats ──
async function loadStats() {
  try {
    const [appRes, userRes] = await Promise.all([
      fetch(`${CN_INTEL_BASE}/api/admin/applications?status=pending`, { headers: headers() }),
      fetch(`${CN_INTEL_BASE}/api/admin/users`, { headers: headers() }),
    ]);
    const appData = await appRes.json();
    const userData = await userRes.json();

    const pending = appData.total || 0;
    const users = userData.users || [];
    const approved = users.filter((u: any) => u.status === 'approved').length;
    const suspended = users.filter((u: any) => u.status === 'suspended').length;
    const total = pending + approved + suspended;

    document.getElementById('statTotal')!.textContent = String(total);
    document.getElementById('statPending')!.textContent = String(pending);
    document.getElementById('statApproved')!.textContent = String(approved);
    document.getElementById('statSuspended')!.textContent = String(suspended);

    // Update pending badge in sidebar
    const badge = document.getElementById('pendingCount')!;
    if (pending > 0) {
      badge.textContent = String(pending);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  } catch {}
}

// ── Applications ──
async function loadApplications() {
  const loading = document.getElementById('appLoading')!;
  const table = document.getElementById('appTable')! as HTMLTableElement;
  const body = document.getElementById('appBody')!;
  const empty = document.getElementById('appEmpty')!;

  loading.style.display = 'block';
  table.style.display = 'none';
  empty.style.display = 'none';

  try {
    const res = await fetch(`${CN_INTEL_BASE}/api/admin/applications`, { headers: headers() });
    const data = await res.json();
    loading.style.display = 'none';

    if (!data.applications || data.applications.length === 0) {
      empty.style.display = '';
      return;
    }

    body.innerHTML = '';
    for (const app of data.applications) {
      const industries = (() => {
        try { return JSON.parse(app.industries || '[]').join(', '); } catch { return app.industries || ''; }
      })();
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div class="company-cell">
            <div class="company-avatar">${getInitial(app.company_name)}</div>
            <div>
              <div class="company-name">${app.company_name || '-'}</div>
              <div class="company-email">${app.email}</div>
            </div>
          </div>
        </td>
        <td>${app.contact_name || '-'}</td>
        <td>${app.contact_phone || '-'}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${industries || '-'}</td>
        <td>${SIZE_LABELS[app.company_size] || app.company_size || '-'}</td>
        <td style="color:var(--text-muted);font-size:12px">${formatDate(app.applied_at)}</td>
        <td style="white-space:nowrap">
          <button class="btn-action btn-detail" data-id="${app.id}" data-action="app-detail" title="详情"><i class="bi bi-eye"></i></button>
          <button class="btn-action btn-approve" data-id="${app.id}">批准</button>
          <button class="btn-action btn-reject" data-id="${app.id}" data-name="${app.company_name || app.email}">拒绝</button>
        </td>
      `;
      body.appendChild(tr);
    }
    table.style.display = 'table';

    // Approve
    body.querySelectorAll('.btn-approve').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset.id;
        if (!confirm('确认批准该申请？')) return;
        try {
          const res = await fetch(`${CN_INTEL_BASE}/api/admin/applications/${id}/approve`, {
            method: 'POST', headers: headers()
          });
          const data = await res.json();
          if (res.ok) { loadApplications(); loadStats(); }
          else alert(data.error || '操作失败');
        } catch { alert('网络错误'); }
      });
    });

    // Reject
    body.querySelectorAll('.btn-reject').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        const name = (btn as HTMLElement).dataset.name!;
        openRejectModal(id, name);
      });
    });

    // Application detail
    body.querySelectorAll('[data-action="app-detail"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const app = data.applications.find((a: any) => String(a.id) === (btn as HTMLElement).dataset.id);
        if (app) openAppDetailModal(app);
      });
    });

  } catch {
    loading.style.display = 'none';
    empty.innerHTML = '<i class="bi bi-exclamation-triangle"></i>加载失败，请检查服务状态';
    empty.style.display = '';
  }
}

// Reject modal
let rejectTargetId = '';
const rejectModal = document.getElementById('rejectModal')!;
const rejectInfo = document.getElementById('rejectInfo')!;
const rejectNote = document.getElementById('rejectNote') as HTMLTextAreaElement;

function openRejectModal(id: string, name: string) {
  rejectTargetId = id;
  rejectInfo.textContent = `拒绝 "${name}" 的申请`;
  rejectNote.value = '';
  rejectModal.classList.add('show');
}

document.getElementById('rejectCancel')!.addEventListener('click', () => {
  rejectModal.classList.remove('show');
});

document.getElementById('rejectConfirm')!.addEventListener('click', async () => {
  try {
    const res = await fetch(`${CN_INTEL_BASE}/api/admin/applications/${rejectTargetId}/reject`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ review_note: rejectNote.value.trim() }),
    });
    const data = await res.json();
    rejectModal.classList.remove('show');
    if (res.ok) { loadApplications(); loadStats(); }
    else alert(data.error || '操作失败');
  } catch { alert('网络错误'); }
});

// ── Users ──
let allUsers: any[] = [];

async function loadUsers() {
  const loading = document.getElementById('userLoading')!;
  const table = document.getElementById('userTable')! as HTMLTableElement;
  const empty = document.getElementById('userEmpty')!;

  loading.style.display = 'block';
  table.style.display = 'none';
  empty.style.display = 'none';

  try {
    const res = await fetch(`${CN_INTEL_BASE}/api/admin/users`, { headers: headers() });
    const data = await res.json();
    loading.style.display = 'none';

    allUsers = data.users || [];
    renderUsers(allUsers);
  } catch {
    loading.style.display = 'none';
    empty.innerHTML = '<i class="bi bi-exclamation-triangle"></i>加载失败';
    empty.style.display = '';
  }
}

function renderUsers(users: any[]) {
  const table = document.getElementById('userTable')! as HTMLTableElement;
  const body = document.getElementById('userBody')!;
  const empty = document.getElementById('userEmpty')!;

  if (users.length === 0) {
    table.style.display = 'none';
    empty.style.display = '';
    return;
  }

  body.innerHTML = '';
  for (const u of users) {
    const expiry = expiryStatus(u.expires_at);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="company-cell">
          <div class="company-avatar">${getInitial(u.company_name)}</div>
          <div>
            <div class="company-name">${u.company_name || '-'}</div>
            <div class="company-email">${u.email}</div>
          </div>
        </div>
      </td>
      <td>${u.contact_name || '-'}</td>
      <td>
        <span class="${expiry.cls}">${expiry.label}</span>
        <button class="btn-expiry" data-id="${u.id}" data-email="${u.email}" data-expires="${u.expires_at || ''}" data-action="sub" title="设置到期日">
          <i class="bi bi-pencil-square"></i>
        </button>
      </td>
      <td style="color:var(--text-muted);font-size:12px">${formatDate(u.created_at)}</td>
      <td style="color:var(--text-muted);font-size:12px">${formatDate(u.last_login_at)}</td>
      <td><span class="${badgeClass(u.status)}">${STATUS_LABELS[u.status] || u.status}</span></td>
      <td style="white-space:nowrap">
        <button class="btn-action btn-detail" data-id="${u.id}" data-action="user-edit" title="编辑"><i class="bi bi-pencil"></i></button>
        <button class="btn-action btn-key" data-id="${u.id}" data-email="${u.email}" data-action="reset-pw" title="重置密码"><i class="bi bi-key"></i></button>
        ${u.status === 'approved'
          ? `<button class="btn-action btn-suspend" data-id="${u.id}">暂停</button>`
          : u.status === 'suspended'
            ? `<button class="btn-action btn-approve" data-id="${u.id}" data-action="restore">恢复</button>`
            : '-'
        }
      </td>
    `;
    body.appendChild(tr);
  }
  table.style.display = 'table';
  empty.style.display = 'none';

  // Suspend
  body.querySelectorAll('.btn-suspend').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.id;
      if (!confirm('确认暂停该用户？')) return;
      try {
        const res = await fetch(`${CN_INTEL_BASE}/api/admin/users/${id}/suspend`, {
          method: 'POST', headers: headers()
        });
        if (res.ok) { loadUsers(); loadStats(); }
        else alert('操作失败');
      } catch { alert('网络错误'); }
    });
  });

  // Restore
  body.querySelectorAll('[data-action="restore"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.id;
      if (!confirm('确认恢复该用户？')) return;
      try {
        const res = await fetch(`${CN_INTEL_BASE}/api/admin/users/${id}/restore`, {
          method: 'POST', headers: headers()
        });
        if (res.ok) { loadUsers(); loadStats(); }
        else alert('操作失败');
      } catch { alert('网络错误'); }
    });
  });

  // Subscription edit
  body.querySelectorAll('[data-action="sub"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      openSubModal(el.dataset.id!, el.dataset.email!, el.dataset.expires || '');
    });
  });

  // Reset password
  body.querySelectorAll('[data-action="reset-pw"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      openPwModal(el.dataset.id!, el.dataset.email!);
    });
  });

  // Edit user
  body.querySelectorAll('[data-action="user-edit"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const u = allUsers.find((x: any) => String(x.id) === el.dataset.id);
      if (u) openEditModal(u);
    });
  });
}

// Search filter
const searchInput = document.getElementById('userSearch') as HTMLInputElement;
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) {
    renderUsers(allUsers);
    return;
  }
  const filtered = allUsers.filter((u: any) =>
    (u.company_name || '').toLowerCase().includes(q) ||
    (u.email || '').toLowerCase().includes(q) ||
    (u.contact_name || '').toLowerCase().includes(q)
  );
  renderUsers(filtered);
});

// ── Subscription Modal ──
let subTargetId = '';
const subModal = document.getElementById('subModal')!;
const subInfo = document.getElementById('subInfo')!;
const subDate = document.getElementById('subDate') as HTMLInputElement;

function openSubModal(id: string, email: string, currentExpires: string) {
  subTargetId = id;
  subInfo.textContent = email;
  subDate.value = currentExpires ? currentExpires.substring(0, 10) : '';
  subModal.classList.add('show');
}

function addYearsToSubDate(years: number) {
  const base = subDate.value ? new Date(subDate.value) : new Date();
  base.setFullYear(base.getFullYear() + years);
  subDate.value = base.toISOString().substring(0, 10);
}

document.getElementById('subQuick1y')!.addEventListener('click', () => addYearsToSubDate(1));
document.getElementById('subQuick2y')!.addEventListener('click', () => addYearsToSubDate(2));
document.getElementById('subQuick3y')!.addEventListener('click', () => addYearsToSubDate(3));

document.getElementById('subCancel')!.addEventListener('click', () => {
  subModal.classList.remove('show');
});

document.getElementById('subConfirm')!.addEventListener('click', async () => {
  if (!subDate.value) { alert('请选择到期日期'); return; }
  try {
    const res = await fetch(`${CN_INTEL_BASE}/api/admin/users/${subTargetId}/subscription`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ expires_at: subDate.value }),
    });
    const data = await res.json();
    subModal.classList.remove('show');
    if (res.ok) { loadUsers(); }
    else alert(data.error || '操作失败');
  } catch { alert('网络错误'); }
});

// ── Create Account ──
const createForm = document.getElementById('createForm') as HTMLFormElement;
const createMsg = document.getElementById('createMsg')!;
const createBtn = document.getElementById('createBtn') as HTMLButtonElement;

// Industry chips
const INDUSTRIES = [
  '新能源', '半导体', '人工智能', '生物医药', '新材料', '高端装备',
  '汽车制造', '消费电子', '金融科技', '房地产', '教育', '医疗健康',
  '互联网', '电子商务', '物流运输', '农业科技', '环保', '文化传媒',
  '军工国防', '航空航天', '化工', '钢铁', '有色金属', '食品饮料',
];
const createChipContainer = document.getElementById('createIndustryChips')!;
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
  createChipContainer.appendChild(chip);
});

// Tags input helper
function initTagsInput(containerId: string): { getTags: () => string[]; reset: () => void } {
  const container = document.getElementById(containerId)!;
  const input = container.querySelector('input')!;
  const tags: string[] = [];

  function addTag(text: string) {
    const t = text.trim();
    if (!t || tags.includes(t)) return;
    tags.push(t);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.innerHTML = `${t}<button type="button">&times;</button>`;
    tag.querySelector('button')!.addEventListener('click', () => {
      const idx = tags.indexOf(t);
      if (idx >= 0) tags.splice(idx, 1);
      tag.remove();
    });
    container.insertBefore(tag, input);
    input.value = '';
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTag(input.value); }
    if (e.key === 'Backspace' && !input.value && tags.length) {
      tags.pop();
      container.querySelector('.tag:last-of-type')?.remove();
    }
  });
  container.addEventListener('click', () => input.focus());

  return {
    getTags: () => [...tags],
    reset: () => { tags.length = 0; container.querySelectorAll('.tag').forEach(t => t.remove()); input.value = ''; },
  };
}

const competitorTags = initTagsInput('createCompetitorTags');
const supplyUpTags = initTagsInput('createSupplyUpTags');
const supplyDownTags = initTagsInput('createSupplyDownTags');

// Expiry quick buttons in create form
function setCreateExpiry(years: number) {
  const expiryInput = createForm.querySelector('input[name="expires_at"]') as HTMLInputElement;
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  expiryInput.value = d.toISOString().substring(0, 10);
}
document.getElementById('expiryQuick1y')!.addEventListener('click', () => setCreateExpiry(1));
document.getElementById('expiryQuick2y')!.addEventListener('click', () => setCreateExpiry(2));
document.getElementById('expiryQuick3y')!.addEventListener('click', () => setCreateExpiry(3));

function showCreateMsg(text: string, type: 'error' | 'success') {
  createMsg.textContent = text;
  createMsg.className = `form-msg msg-${type}`;
}

createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  createMsg.className = 'form-msg';

  const fd = new FormData(createForm);
  const email = (fd.get('email') as string).trim();
  const password = (fd.get('password') as string).trim();
  const contact_name = (fd.get('contact_name') as string).trim();

  if (!email || !password || !contact_name) {
    showCreateMsg('请填写必填项', 'error');
    return;
  }
  if (password.length < 6) {
    showCreateMsg('密码至少6位', 'error');
    return;
  }

  createBtn.disabled = true;
  createBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i> 创建中...';

  const expiresAt = (fd.get('expires_at') as string || '').trim();
  const payload: Record<string, unknown> = {
    email,
    password,
    contact_name,
    contact_phone: (fd.get('contact_phone') as string).trim(),
    company_name: (fd.get('company_name') as string).trim(),
    company_size: fd.get('company_size') as string,
    business_scope: (fd.get('business_scope') as string).trim(),
    industries: Array.from(selectedIndustries),
    competitors: competitorTags.getTags(),
    supply_chain_up: supplyUpTags.getTags(),
    supply_chain_down: supplyDownTags.getTags(),
  };
  if (expiresAt) payload.expires_at = expiresAt;

  try {
    const res = await fetch(`${CN_INTEL_BASE}/api/admin/accounts`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (res.ok) {
      showCreateMsg(`账户创建成功：${email}`, 'success');
      createForm.reset();
      // Reset chips & tags
      selectedIndustries.clear();
      createChipContainer.querySelectorAll('.chip.active').forEach(c => c.classList.remove('active'));
      competitorTags.reset();
      supplyUpTags.reset();
      supplyDownTags.reset();
      loadStats();
    } else {
      showCreateMsg(data.error || '创建失败', 'error');
    }
  } catch {
    showCreateMsg('网络错误，请检查服务状态', 'error');
  } finally {
    createBtn.disabled = false;
    createBtn.innerHTML = '<i class="bi bi-plus-circle"></i> 创建账户';
  }
});

// ── Password Reset Modal ──
let pwTargetId = '';
const pwModal = document.getElementById('pwModal')!;
const pwInfo = document.getElementById('pwInfo')!;
const pwResult = document.getElementById('pwResult')!;
const pwNewPassword = document.getElementById('pwNewPassword')!;
const pwConfirmBtn = document.getElementById('pwConfirm')!;

function openPwModal(id: string, email: string) {
  pwTargetId = id;
  pwInfo.textContent = `为 ${email} 生成新密码`;
  pwResult.style.display = 'none';
  pwConfirmBtn.style.display = '';
  pwModal.classList.add('show');
}

document.getElementById('pwCancel')!.addEventListener('click', () => {
  pwModal.classList.remove('show');
});

pwConfirmBtn.addEventListener('click', async () => {
  if (!confirm('确认重置密码？旧密码将立即失效')) return;
  try {
    const res = await fetch(`${CN_INTEL_BASE}/api/admin/users/${pwTargetId}/reset-password`, {
      method: 'POST', headers: headers()
    });
    const data = await res.json();
    if (res.ok) {
      pwNewPassword.textContent = data.new_password;
      pwResult.style.display = '';
      pwConfirmBtn.style.display = 'none';
    } else {
      alert(data.error || '重置失败');
    }
  } catch { alert('网络错误'); }
});

document.getElementById('pwCopy')!.addEventListener('click', () => {
  const pw = pwNewPassword.textContent || '';
  navigator.clipboard.writeText(pw).then(() => {
    const btn = document.getElementById('pwCopy')!;
    btn.innerHTML = '<i class="bi bi-check2"></i> 已复制';
    setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard"></i> 复制'; }, 2000);
  });
});

// ── Edit User Modal ──
let editTargetId = '';
const editModal = document.getElementById('editModal')!;
const editMsg = document.getElementById('editMsg')!;

function openEditModal(u: any) {
  editTargetId = String(u.id);
  editMsg.style.display = 'none';
  (document.getElementById('editContactName') as HTMLInputElement).value = u.contact_name || '';
  (document.getElementById('editContactPhone') as HTMLInputElement).value = u.contact_phone || '';
  (document.getElementById('editCompanyName') as HTMLInputElement).value = u.company_name || '';
  (document.getElementById('editCompanySize') as HTMLSelectElement).value = u.company_size || '';
  (document.getElementById('editBusinessScope') as HTMLTextAreaElement).value = u.business_scope || '';
  editModal.classList.add('show');
}

document.getElementById('editCancel')!.addEventListener('click', () => {
  editModal.classList.remove('show');
});

document.getElementById('editConfirm')!.addEventListener('click', async () => {
  const payload: Record<string, string> = {
    contact_name: (document.getElementById('editContactName') as HTMLInputElement).value.trim(),
    contact_phone: (document.getElementById('editContactPhone') as HTMLInputElement).value.trim(),
    company_name: (document.getElementById('editCompanyName') as HTMLInputElement).value.trim(),
    company_size: (document.getElementById('editCompanySize') as HTMLSelectElement).value,
    business_scope: (document.getElementById('editBusinessScope') as HTMLTextAreaElement).value.trim(),
  };

  try {
    const res = await fetch(`${CN_INTEL_BASE}/api/admin/users/${editTargetId}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      editModal.classList.remove('show');
      loadUsers();
      loadStats();
    } else {
      editMsg.textContent = data.error || '保存失败';
      editMsg.className = 'form-msg msg-error';
      editMsg.style.display = 'block';
    }
  } catch {
    editMsg.textContent = '网络错误';
    editMsg.className = 'form-msg msg-error';
    editMsg.style.display = 'block';
  }
});

// ── Application Detail Modal ──
const appDetailModal = document.getElementById('appDetailModal')!;
const appDetailContent = document.getElementById('appDetailContent')!;

function openAppDetailModal(app: any) {
  const parseField = (val: string | null) => {
    if (!val) return '-';
    try { const arr = JSON.parse(val); return Array.isArray(arr) ? arr.join(', ') : val; } catch { return val; }
  };

  appDetailContent.innerHTML = `
    <div style="display:grid;grid-template-columns:100px 1fr;gap:8px 12px;color:var(--text-sec)">
      <div style="color:var(--text-muted)">企业名称</div><div style="color:var(--text);font-weight:600">${app.company_name || '-'}</div>
      <div style="color:var(--text-muted)">邮箱</div><div>${app.email}</div>
      <div style="color:var(--text-muted)">联系人</div><div>${app.contact_name || '-'}</div>
      <div style="color:var(--text-muted)">电话</div><div>${app.contact_phone || '-'}</div>
      <div style="color:var(--text-muted)">企业规模</div><div>${SIZE_LABELS[app.company_size] || app.company_size || '-'}</div>
      <div style="color:var(--text-muted)">主营业务</div><div>${app.business_scope || '-'}</div>
      <div style="color:var(--text-muted)">行业</div><div>${parseField(app.industries)}</div>
      <div style="color:var(--text-muted)">竞争对手</div><div>${parseField(app.competitors)}</div>
      <div style="color:var(--text-muted)">上游供应链</div><div>${parseField(app.supply_chain_up)}</div>
      <div style="color:var(--text-muted)">下游客户</div><div>${parseField(app.supply_chain_down)}</div>
      <div style="color:var(--text-muted)">申请时间</div><div>${formatDate(app.applied_at)}</div>
      <div style="color:var(--text-muted)">状态</div><div><span class="${badgeClass(app.status)}">${STATUS_LABELS[app.status] || app.status}</span></div>
      ${app.review_note ? `<div style="color:var(--text-muted)">审核备注</div><div>${app.review_note}</div>` : ''}
    </div>
  `;
  appDetailModal.classList.add('show');
}

document.getElementById('appDetailClose')!.addEventListener('click', () => {
  appDetailModal.classList.remove('show');
});

// Initial load
loadApplications();
loadStats();

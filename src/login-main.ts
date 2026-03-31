// World Monitor — Login page logic (with forgot-password flow)

const CN_INTEL_BASE = import.meta.env.VITE_CN_INTEL_BASE || '';

// Desktop (Tauri) runtime: route API calls through the local sidecar.
const _isDesktop = import.meta.env.VITE_DESKTOP_RUNTIME === '1'
  || (typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window));

let _sidecarBase = '';
let _sidecarToken = '';

if (_isDesktop) {
  const port = 46123;
  _sidecarBase = `http://127.0.0.1:${port}`;

  // Obtain LOCAL_API_TOKEN via Tauri IPC (no external module dependency)
  (async () => {
    try {
      const w = window as unknown as {
        __TAURI__?: { core?: { invoke?: <T>(cmd: string) => Promise<T> } };
        __TAURI_INTERNALS__?: { invoke?: <T>(cmd: string) => Promise<T> };
      };
      const invoke = w.__TAURI__?.core?.invoke ?? w.__TAURI_INTERNALS__?.invoke;
      if (invoke) {
        _sidecarToken = await invoke<string>('get_local_api_token');
      }
    } catch { /* token stays empty */ }
  })();
}

// Wrap fetch for desktop: prepend sidecar base + inject auth token
function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (_isDesktop && input.startsWith('/api/')) {
    const headers = new Headers(init?.headers);
    if (_sidecarToken) {
      headers.set('Authorization', `Bearer ${_sidecarToken}`);
    }
    return fetch(`${_sidecarBase}${input}`, { ...init, headers });
  }
  return fetch(`${CN_INTEL_BASE}${input}`, init);
}

const form = document.getElementById('loginForm') as HTMLFormElement;
const msgBox = document.getElementById('msgBox') as HTMLDivElement;
const submitBtn = document.getElementById('submitBtn') as HTMLButtonElement;

// Forgot password elements
const forgotForm = document.getElementById('forgotForm') as HTMLDivElement;
const forgotStep1 = document.getElementById('forgotStep1') as HTMLDivElement;
const forgotStep2 = document.getElementById('forgotStep2') as HTMLDivElement;
const showForgotLink = document.getElementById('showForgot') as HTMLAnchorElement;
const backToLoginBtn = document.getElementById('backToLogin') as HTMLButtonElement;
const sendCodeBtn = document.getElementById('sendCodeBtn') as HTMLButtonElement;
const resendBtn = document.getElementById('resendBtn') as HTMLButtonElement;
const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement;
const resetEmailInput = document.getElementById('resetEmail') as HTMLInputElement;
const resetCodeInput = document.getElementById('resetCode') as HTMLInputElement;
const newPasswordInput = document.getElementById('newPassword') as HTMLInputElement;
const loginFooter = document.getElementById('loginFooter') as HTMLDivElement;

function showMsg(text: string, type: 'error' | 'success' | 'info') {
  msgBox.textContent = text;
  msgBox.className = `msg msg-${type} show`;
}

function clearMsg() {
  msgBox.className = 'msg';
}

// ─── Login ────────────────────────────────────────────────────────────────────

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  submitBtn.disabled = true;
  submitBtn.textContent = '登录中...';
  clearMsg();

  const email = (document.getElementById('email') as HTMLInputElement).value.trim();
  const password = (document.getElementById('password') as HTMLInputElement).value;

  try {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (res.ok && data.token) {
      localStorage.setItem('wm_token', data.token);
      localStorage.setItem('wm_user', JSON.stringify(data.user));

      if (data.profile_user_id) {
        localStorage.setItem('cn_user_profile_id', data.profile_user_id);
      }

      const status = data.user?.status;
      if (status === 'approved') {
        submitBtn.disabled = true;
        showMsg('登录成功，正在跳转...', 'success');
        setTimeout(() => { window.location.href = '/'; }, 500);
        return;
      } else if (status === 'pending') {
        showMsg('您的申请正在审核中，我们将在1-2个工作日内回复。', 'info');
      } else if (status === 'rejected') {
        const note = data.user?.review_note || '';
        showMsg(`您的申请未通过。${note ? '原因: ' + note : '请联系管理员了解详情。'}`, 'error');
      } else if (status === 'suspended') {
        showMsg('您的账号已被暂停，请联系管理员。', 'error');
      }
    } else {
      showMsg(data.error || '登录失败，请检查邮箱和密码', 'error');
    }
  } catch (err) {
    showMsg('网络错误，请检查服务是否启动', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '登录';
  }
});

// ─── Forgot Password ──────────────────────────────────────────────────────────

let countdownTimer: ReturnType<typeof setInterval> | null = null;

function startCountdown(btn: HTMLButtonElement, seconds: number) {
  btn.disabled = true;
  let remaining = seconds;
  btn.textContent = `${remaining}s`;
  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownTimer!);
      countdownTimer = null;
      btn.disabled = false;
      btn.textContent = '重新发送';
    } else {
      btn.textContent = `${remaining}s`;
    }
  }, 1000);
}

// Show forgot password form
showForgotLink.addEventListener('click', () => {
  form.classList.add('hidden');
  loginFooter.classList.add('hidden');
  forgotForm.classList.remove('hidden');
  forgotStep1.classList.remove('hidden');
  forgotStep2.classList.add('hidden');
  clearMsg();
  // Pre-fill email from login form
  const loginEmail = (document.getElementById('email') as HTMLInputElement).value.trim();
  if (loginEmail) resetEmailInput.value = loginEmail;
});

// Back to login
backToLoginBtn.addEventListener('click', () => {
  forgotForm.classList.add('hidden');
  form.classList.remove('hidden');
  loginFooter.classList.remove('hidden');
  clearMsg();
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
});

// Send verification code
sendCodeBtn.addEventListener('click', async () => {
  const email = resetEmailInput.value.trim();
  if (!email) { showMsg('请输入邮箱地址', 'error'); return; }

  sendCodeBtn.disabled = true;
  sendCodeBtn.textContent = '发送中...';
  clearMsg();

  try {
    const res = await apiFetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      showMsg(data.message || '验证码已发送', 'success');
      // Switch to step 2
      forgotStep1.classList.add('hidden');
      forgotStep2.classList.remove('hidden');
      startCountdown(resendBtn, 60);
    } else {
      showMsg(data.error || '发送失败', 'error');
      sendCodeBtn.disabled = false;
      sendCodeBtn.textContent = '发送验证码';
    }
  } catch {
    showMsg('网络错误，请稍后重试', 'error');
    sendCodeBtn.disabled = false;
    sendCodeBtn.textContent = '发送验证码';
  }
});

// Resend code
resendBtn.addEventListener('click', async () => {
  const email = resetEmailInput.value.trim();
  resendBtn.disabled = true;
  clearMsg();

  try {
    const res = await apiFetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      showMsg('验证码已重新发送', 'success');
      startCountdown(resendBtn, 60);
    } else {
      showMsg(data.error || '发送失败', 'error');
      resendBtn.disabled = false;
      resendBtn.textContent = '重新发送';
    }
  } catch {
    showMsg('网络错误', 'error');
    resendBtn.disabled = false;
    resendBtn.textContent = '重新发送';
  }
});

// Reset password
resetBtn.addEventListener('click', async () => {
  const email = resetEmailInput.value.trim();
  const code = resetCodeInput.value.trim();
  const newPassword = newPasswordInput.value.trim();

  if (!code) { showMsg('请输入验证码', 'error'); return; }
  if (!newPassword || newPassword.length < 6) { showMsg('新密码至少 6 个字符', 'error'); return; }

  resetBtn.disabled = true;
  resetBtn.textContent = '重置中...';
  clearMsg();

  try {
    const res = await apiFetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, new_password: newPassword }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      showMsg(data.message || '密码重置成功', 'success');
      // Switch back to login after 2s
      setTimeout(() => {
        forgotForm.classList.add('hidden');
        form.classList.remove('hidden');
        loginFooter.classList.remove('hidden');
        clearMsg();
        showMsg('密码已重置，请使用新密码登录', 'success');
        // Pre-fill email
        (document.getElementById('email') as HTMLInputElement).value = email;
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      }, 1500);
    } else {
      showMsg(data.error || '重置失败', 'error');
    }
  } catch {
    showMsg('网络错误', 'error');
  } finally {
    resetBtn.disabled = false;
    resetBtn.textContent = '重置密码';
  }
});

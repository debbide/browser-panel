// 登录页 / 首次设置引导。
//
// 同一个页面三种状态，靠 GET /api/auth/state 的 needsSetup 决定：
//   needsSetup=true  → 首次设置（多一个"确认密码"框，提交到 /api/auth/setup）
//   needsSetup=false → 普通登录（提交到 /api/auth/login）
//
// 登录时若账号开了两步验证，/api/auth/login 会返回 twoFactor.required +
// 一次性票据，页面切到 TOTP 动态码步（提交到 /api/auth/totp/verify）。
// 另外支持通行密钥免密直登：走 /passkey/login/challenge → navigator.credentials.get()
// → /passkey/login/verify，登录后会话固定 30 天（不看"记住我"）。

const els = {
  form: document.getElementById('login-form'),
  title: document.getElementById('login-title'),
  subtitle: document.getElementById('login-subtitle'),
  error: document.getElementById('login-error'),
  normal: document.getElementById('login-normal'),
  username: document.getElementById('login-username'),
  password: document.getElementById('login-password'),
  passwordLabel: document.getElementById('login-password-label'),
  confirmField: document.getElementById('login-confirm-field'),
  confirm: document.getElementById('login-confirm'),
  rememberField: document.getElementById('login-remember-field'),
  remember: document.getElementById('login-remember'),
  submit: document.getElementById('login-submit'),
  submitText: document.getElementById('login-submit-text'),
  passkeyBtn: document.getElementById('login-passkey-btn'),
  passkeyText: document.getElementById('login-passkey-text'),
  totpStep: document.getElementById('login-totp-step'),
  totpCode: document.getElementById('login-totp-code'),
  totpSubmit: document.getElementById('login-totp-submit'),
  totpText: document.getElementById('login-totp-text'),
  totpBack: document.getElementById('login-totp-back'),
  note: document.getElementById('login-note'),
};

let setupMode = false;
// 非空即处于 TOTP 二步步（存的是 /api/auth/login 给的一次性票据）
let twoFactorTicket = null;

function showError(msg) {
  els.error.textContent = String(msg || '操作失败');
  els.error.classList.add('show');
}

function clearError() {
  els.error.textContent = '';
  els.error.classList.remove('show');
}

// 登录成功后回到用户原本想去的地方。只接受站内相对路径，
// 避免 ?next=//evil.com 变成开放重定向。
function nextTarget() {
  const raw = new URLSearchParams(location.search).get('next') || '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

// WebAuthn 只在安全上下文（HTTPS / localhost）可用；公网面板走 CF Tunnel 是 https，
// 局域网直连是 http，后者不支持通行密钥，按钮藏起来。
function passkeySupported() {
  return Boolean(window.isSecureContext && navigator.credentials && window.PublicKeyCredential);
}

function updatePasskeyVisibility() {
  els.passkeyBtn.hidden = setupMode || !passkeySupported();
}

function applySetupMode(on) {
  setupMode = on;
  if (on) {
    els.title.textContent = '首次设置';
    els.subtitle.textContent = '面板还没有账号，请先创建一个管理员账号。';
    els.passwordLabel.textContent = '密码（至少 8 位）';
    els.confirmField.hidden = false;
    els.confirm.required = true;
    els.rememberField.hidden = true;
    els.password.autocomplete = 'new-password';
    els.submitText.textContent = '创建并登录';
    els.note.hidden = false;
    els.note.textContent = '提示：面板通过明文 HTTP 传输密码。若面板暴露在公网，'
      + '建议改绑 127.0.0.1 走 SSH 隧道，或在前面挂 nginx + HTTPS。';
  } else {
    els.title.textContent = '登录面板';
    els.subtitle.textContent = '请输入用户名和密码。';
    els.passwordLabel.textContent = '密码';
    els.confirmField.hidden = true;
    els.confirm.required = false;
    els.rememberField.hidden = false;
    els.password.autocomplete = 'current-password';
    els.submitText.textContent = '登录';
    els.note.hidden = true;
  }
  updatePasskeyVisibility();
  if (window.lucide) window.lucide.createIcons();
}

// —— TOTP 二步步 ——

function enterTotpStep(ticket) {
  twoFactorTicket = ticket;
  els.normal.hidden = true;
  els.totpStep.hidden = false;
  els.subtitle.textContent = '该账号已开启两步验证，请输入身份验证器 App 里的 6 位动态码。';
  els.totpCode.value = '';
  els.totpCode.focus();
  if (window.lucide) window.lucide.createIcons();
}

function exitTotpStep() {
  twoFactorTicket = null;
  els.totpStep.hidden = true;
  els.normal.hidden = false;
  els.totpCode.value = '';
  applySetupMode(setupMode); // 恢复标题/副标题文案
  els.password.focus();
}

// —— base64url ↔ ArrayBuffer（WebAuthn 收发的二进制都要这层转换） ——

function bufferToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) throw new Error(data.message || `请求失败 (${res.status})`);
  return data;
}

async function loadState() {
  try {
    const res = await fetch('/api/auth/state');
    const json = await res.json();
    const state = json.data || {};
    // 已经登录了就别停在登录页
    if (state.authenticated) {
      location.replace(nextTarget());
      return;
    }
    applySetupMode(Boolean(state.needsSetup));
  } catch {
    applySetupMode(false);
    showError('无法连接后端，请确认面板服务已启动。');
  }
}

// —— 通行密钥免密直登 ——

els.passkeyBtn.addEventListener('click', async () => {
  clearError();
  if (!passkeySupported()) {
    showError('当前环境不支持通行密钥（需要 HTTPS 或 localhost），请用账号密码登录。');
    return;
  }
  els.passkeyBtn.disabled = true;
  els.passkeyText.textContent = '正在唤起系统提示…';
  try {
    const challengeRes = await postJson('/api/auth/passkey/login/challenge', {});
    const options = challengeRes.data;
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: base64urlToBuffer(options.challenge),
        rpId: options.rpId,
        userVerification: options.userVerification || 'preferred',
        timeout: options.timeout || 60000,
      },
    });
    await postJson('/api/auth/passkey/login/verify', {
      challenge: options.challenge,
      response: {
        id: assertion.id || bufferToBase64url(assertion.rawId),
        rawId: bufferToBase64url(assertion.rawId),
        type: assertion.type,
        response: {
          clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
          authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
          signature: bufferToBase64url(assertion.response.signature),
          userHandle: assertion.response.userHandle
            ? bufferToBase64url(assertion.response.userHandle)
            : null,
        },
      },
    });
    location.replace(nextTarget());
  } catch (err) {
    const msg = String((err && err.message) || err || '');
    // 用户主动取消 / 浏览器弹窗被关掉是正常路径，不刷红
    if (msg && !/NotAllowedError|NotFoundError|abort|cancel|取消/i.test(msg)) {
      showError('通行密钥登录失败：' + msg);
    }
    els.passkeyBtn.disabled = false;
    els.passkeyText.textContent = '通行密钥登录';
  }
});

els.totpBack.addEventListener('click', (event) => {
  event.preventDefault();
  clearError();
  exitTotpStep();
});

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  // 已拿到票据 → 提交 TOTP 动态码
  if (twoFactorTicket) {
    const code = els.totpCode.value.trim();
    if (!/^\d{6}$/.test(code)) {
      showError('请输入 6 位数字验证码');
      els.totpCode.focus();
      return;
    }
    els.totpSubmit.disabled = true;
    els.totpText.textContent = '验证中…';
    try {
      await postJson('/api/auth/totp/verify', {
        ticket: twoFactorTicket,
        code,
        remember: els.remember.checked,
      });
      location.replace(nextTarget());
    } catch (err) {
      showError(err.message);
      els.totpSubmit.disabled = false;
      els.totpText.textContent = '验证并登录';
      els.totpCode.value = '';
      els.totpCode.focus();
    }
    return;
  }

  const username = els.username.value.trim();
  const password = els.password.value;
  if (!username || !password) {
    showError('请填写用户名和密码');
    return;
  }
  if (setupMode && password !== els.confirm.value) {
    showError('两次输入的密码不一致');
    return;
  }

  els.submit.disabled = true;
  els.submitText.textContent = setupMode ? '创建中…' : '登录中…';
  try {
    if (setupMode) {
      await postJson('/api/auth/setup', {
        username,
        password,
        confirmPassword: els.confirm.value,
      });
    } else {
      const res = await postJson('/api/auth/login', {
        username,
        password,
        remember: els.remember.checked,
      });
      if (res.data && res.data.twoFactor && res.data.twoFactor.required) {
        // 账号开了两步验证：切到动态码步，账号密码先留着不校验了
        enterTotpStep(res.data.twoFactor.ticket);
        return;
      }
    }
    location.replace(nextTarget());
  } catch (err) {
    showError(err.message);
    els.submit.disabled = false;
    els.submitText.textContent = setupMode ? '创建并登录' : '登录';
    els.password.value = '';
    if (setupMode) els.confirm.value = '';
    els.password.focus();
  }
});

loadState();
if (window.lucide) window.lucide.createIcons();

// 登录页 / 首次设置引导。
//
// 同一个页面两种模式，靠 GET /api/auth/state 的 needsSetup 决定：
//   needsSetup=true  → 首次设置（多一个"确认密码"框，提交到 /api/auth/setup）
//   needsSetup=false → 普通登录（提交到 /api/auth/login）

const els = {
  form: document.getElementById('login-form'),
  title: document.getElementById('login-title'),
  subtitle: document.getElementById('login-subtitle'),
  error: document.getElementById('login-error'),
  username: document.getElementById('login-username'),
  password: document.getElementById('login-password'),
  passwordLabel: document.getElementById('login-password-label'),
  confirmField: document.getElementById('login-confirm-field'),
  confirm: document.getElementById('login-confirm'),
  submit: document.getElementById('login-submit'),
  submitText: document.getElementById('login-submit-text'),
  note: document.getElementById('login-note'),
};

let setupMode = false;

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

function applySetupMode(on) {
  setupMode = on;
  if (on) {
    els.title.textContent = '首次设置';
    els.subtitle.textContent = '面板还没有账号，请先创建一个管理员账号。';
    els.passwordLabel.textContent = '密码（至少 8 位）';
    els.confirmField.hidden = false;
    els.confirm.required = true;
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
    els.password.autocomplete = 'current-password';
    els.submitText.textContent = '登录';
    els.note.hidden = true;
  }
  if (window.lucide) window.lucide.createIcons();
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

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

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
      await postJson('/api/auth/login', { username, password });
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

(function initUiFeedback(global) {
global.toast = function(msg, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  let icon = 'info';
  if (type === 'success') icon = 'check-circle';
  if (type === 'error') icon = 'alert-triangle';
  if (type === 'warn') icon = 'alert-circle';

  el.innerHTML = `<i data-lucide="${icon}" class="icon-sm"></i> <span>${global.escapeHtml(msg)}</span>`;
  container.appendChild(el);
  if (window.lucide) window.lucide.createIcons({ root: el });

  setTimeout(() => {
    el.classList.add('toast-fade-out');
    el.addEventListener('animationend', () => el.remove());
  }, 4000);
};

global.dialogConfirm = function(msg, onConfirm) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '9999';

  const dialog = document.createElement('div');
  dialog.className = 'modal open';
  dialog.style.alignItems = 'center';
  dialog.style.justifyContent = 'center';
  dialog.style.zIndex = '10000';
  dialog.innerHTML = `
    <div class="modal-panel" style="max-width: 320px; width: 100%; text-align: center; padding: 24px;">
      <div style="color: var(--accent-color); margin-bottom: 16px;"><i data-lucide="help-circle" style="width: 48px; height: 48px;"></i></div>
      <h3 style="margin-bottom: 8px;">操作确认</h3>
      <p class="muted" style="margin-bottom: 24px;">${global.escapeHtml(msg)}</p>
      <div class="row" style="justify-content: center;">
        <button id="cd-cancel" class="alt">取消</button>
        <button id="cd-confirm" style="background: #ef4444; box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2);">确定</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);
  document.body.appendChild(dialog);
  if (window.lucide) window.lucide.createIcons({ root: dialog });

  const close = () => { mask.remove(); dialog.remove(); };
  dialog.querySelector('#cd-cancel').addEventListener('click', close);
  dialog.querySelector('#cd-confirm').addEventListener('click', () => { close(); onConfirm(); });
};

function dialogPassphrase(msg, onConfirm, allowEmpty = false) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '9999';

  const dialog = document.createElement('div');
  dialog.className = 'modal open';
  dialog.style.alignItems = 'center';
  dialog.style.justifyContent = 'center';
  dialog.style.zIndex = '10000';
  dialog.innerHTML = `
    <div class="modal-panel" style="max-width: 360px; width: 100%; padding: 24px;">
      <h3 style="margin-bottom: 8px;">设置密码</h3>
      <p class="muted" style="margin-bottom: 16px;">${global.escapeHtml(msg)}</p>
      <label style="display:block; margin-bottom:4px; font-size:0.85em; font-weight:600;">密码</label>
      <input id="bp-pp-input" type="password" autocomplete="off" placeholder="输入密码" style="width:100%; box-sizing:border-box; margin-bottom:8px;" />
      <label style="display:block; margin-bottom:4px; font-size:0.85em; font-weight:600;">确认密码</label>
      <input id="bp-pp-confirm" type="password" autocomplete="off" placeholder="再次输入" style="width:100%; box-sizing:border-box; margin-bottom:18px;" />
      <p id="bp-pp-error" class="muted" style="color:#ef4444; margin-bottom:12px; display:none;"></p>
      <div class="row" style="justify-content: flex-end;">
        <button id="bp-pp-cancel" class="alt">取消</button>
        <button id="bp-pp-confirm-btn">确定</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);
  document.body.appendChild(dialog);
  if (window.lucide) window.lucide.createIcons({ root: dialog });

  const input = dialog.querySelector('#bp-pp-input');
  const confirm = dialog.querySelector('#bp-pp-confirm');
  const error = dialog.querySelector('#bp-pp-error');
  const close = () => { mask.remove(); dialog.remove(); };

  const validate = () => {
    const pw = input.value;
    const pw2 = confirm.value;
    if (!allowEmpty && !pw.trim()) return '密码不能为空';
    if (!allowEmpty && pw.length < 8) return '密码至少需要 8 个字符';
    if (pw !== pw2) return '两次输入的密码不一致';
    return null;
  };

  dialog.querySelector('#bp-pp-cancel').addEventListener('click', close);
  dialog.querySelector('#bp-pp-confirm-btn').addEventListener('click', () => {
    const err = validate();
    if (err) { error.textContent = err; error.style.display = 'block'; return; }
    close();
    onConfirm(input.value || null);
  });

  // Enter in either field submits
  const submit = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const err = validate();
      if (err) { error.textContent = err; error.style.display = 'block'; return; }
      close();
      onConfirm(input.value || null);
    }
  };
  input.addEventListener('keydown', submit);
  confirm.addEventListener('keydown', submit);
  // Focus first input
  setTimeout(() => input.focus(), 100);
}

global.dialogPassphrase = dialogPassphrase;

/** 导入用：只问一次密码，不需要确认输入（错了会被解密直接顶回来）。 */
function dialogPassphraseOnce(msg, onConfirm) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '9999';

  const dialog = document.createElement('div');
  dialog.className = 'modal open';
  dialog.style.alignItems = 'center';
  dialog.style.justifyContent = 'center';
  dialog.style.zIndex = '10000';
  dialog.innerHTML = `
    <div class="modal-panel" style="max-width: 360px; width: 100%; padding: 24px;">
      <h3 style="margin-bottom: 8px;">输入密码</h3>
      <p class="muted" style="margin-bottom: 16px;">${global.escapeHtml(msg)}</p>
      <input id="bp-pp1-input" type="password" autocomplete="off" placeholder="导出时设置的密码" style="width:100%; box-sizing:border-box; margin-bottom:18px;" />
      <p id="bp-pp1-error" class="muted" style="color:#ef4444; margin-bottom:12px; display:none;"></p>
      <div class="row" style="justify-content: flex-end;">
        <button id="bp-pp1-cancel" class="alt">取消</button>
        <button id="bp-pp1-ok">确定</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);
  document.body.appendChild(dialog);

  const input = dialog.querySelector('#bp-pp1-input');
  const error = dialog.querySelector('#bp-pp1-error');
  const close = () => { mask.remove(); dialog.remove(); };
  const go = () => {
    if (!input.value) { error.textContent = '密码不能为空'; error.style.display = 'block'; return; }
    close();
    onConfirm(input.value);
  };
  dialog.querySelector('#bp-pp1-cancel').addEventListener('click', close);
  dialog.querySelector('#bp-pp1-ok').addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  setTimeout(() => input.focus(), 100);
}

  global.UiFeedback = {
    dialogPassphrase,
    dialogPassphraseOnce,
  };
}(window));

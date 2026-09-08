(function exposeAuthUi(global) {
  function create(deps = {}) {
    const requestJson = deps.fetchJson;
    const notify = deps.toast || (() => {});
    const base64urlToBytes = deps.base64urlToBytes;
    const bytesToBase64url = deps.bytesToBase64url;

    function openChangePasswordDialog() {
      const mask = document.createElement('div');
      mask.className = 'modal-mask open';
      mask.style.zIndex = '10050';
      const dialog = document.createElement('div');
      dialog.className = 'modal open';
      dialog.style.cssText = 'z-index:10051; max-width:420px; width:min(420px,92vw);';
      dialog.innerHTML = `
        <div class="modal-header">
          <div>
            <h2>修改密码</h2>
            <p class="muted" style="margin:4px 0 0;font-size:13px;">改完会退出其他设备上的登录</p>
          </div>
          <button type="button" class="icon-btn cp-close" aria-label="关闭"><i data-lucide="x" class="icon-md"></i></button>
        </div>
        <div class="modal-body">
          <form class="stack-form cp-form">
            <div>
              <label class="field-label" for="cp-current">当前密码</label>
              <input id="cp-current" type="password" autocomplete="current-password" style="width:100%" />
            </div>
            <div>
              <label class="field-label" for="cp-new">新密码（至少 8 位）</label>
              <input id="cp-new" type="password" autocomplete="new-password" style="width:100%" />
            </div>
            <div>
              <label class="field-label" for="cp-confirm">确认新密码</label>
              <input id="cp-confirm" type="password" autocomplete="new-password" style="width:100%" />
            </div>
            <div class="row" style="margin-top:12px; gap:8px; justify-content:flex-end;">
              <button type="button" class="alt cp-cancel">取消</button>
              <button type="submit" class="btn-primary cp-ok">保存</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(mask);
      document.body.appendChild(dialog);
      if (window.lucide) window.lucide.createIcons({ root: dialog });

      const close = () => { mask.remove(); dialog.remove(); };
      dialog.querySelector('.cp-close').addEventListener('click', close);
      dialog.querySelector('.cp-cancel').addEventListener('click', close);
      mask.addEventListener('click', close);

      const passwordForm = dialog.querySelector('.cp-form');
      const okBtn = dialog.querySelector('.cp-ok');
      passwordForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const currentPassword = dialog.querySelector('#cp-current').value;
        const newPassword = dialog.querySelector('#cp-new').value;
        const confirmPassword = dialog.querySelector('#cp-confirm').value;
        if (!currentPassword || !newPassword) {
          notify('请填写当前密码和新密码', 'error');
          return;
        }
        if (newPassword !== confirmPassword) {
          notify('两次输入的新密码不一致', 'error');
          return;
        }
        okBtn.disabled = true;
        try {
          await requestJson('/api/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
          });
          close();
          notify('密码已修改', 'success');
        } catch (err) {
          notify(err.message || '修改失败', 'error');
          okBtn.disabled = false;
        }
      });
      setTimeout(() => dialog.querySelector('#cp-current').focus(), 40);
    }

    // —— 两步验证管理弹窗（TOTP 开关 + 通行密钥增删） ——

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

    // 所有 /api/auth/2fa/* 接口都要验当前密码（require2faAccess），所以先做一道密码门：
    // 输对密码才加载管理界面，拿到的 currentPassword 存闭包里，后续操作复用。
    function open2faDialog() {
      const mask = document.createElement('div');
      mask.className = 'modal-mask open';
      mask.style.zIndex = '10050';
      const dialog = document.createElement('div');
      dialog.className = 'modal open';
      dialog.style.cssText = 'z-index:10051; max-width:520px; width:min(520px,94vw);';

      dialog.innerHTML = `
        <div class="modal-header">
          <div>
            <h2>两步验证</h2>
            <p class="muted" style="margin:4px 0 0;font-size:13px;">TOTP 动态码 + 通行密钥免密登录</p>
          </div>
          <button type="button" class="icon-btn t2-close" aria-label="关闭"><i data-lucide="x" class="icon-md"></i></button>
        </div>
        <div class="modal-body">
          <div id="t2-lock">
            <p class="muted" style="margin-top:0;font-size:13px;line-height:1.7;">
              两步验证的管理操作都需要先验证当前密码，防止别人趁会话未过期偷改你的安全设置。
            </p>
            <div class="stack-form">
              <div>
                <label class="field-label" for="t2-password">当前密码</label>
                <input id="t2-password" type="password" autocomplete="current-password" style="width:100%" />
              </div>
              <div class="row" style="gap:8px; justify-content:flex-end;">
                <button type="button" class="alt t2-cancel">取消</button>
                <button type="button" class="btn-primary t2-unlock">验证并进入</button>
              </div>
            </div>
          </div>

          <div id="t2-manage" hidden>
            <div class="twofa-section">
              <h3><i data-lucide="smartphone" class="icon-sm"></i> 身份验证器（TOTP）</h3>
              <div id="t2-totp"></div>
            </div>
            <div class="twofa-section">
              <h3><i data-lucide="fingerprint" class="icon-sm"></i> 通行密钥（Passkey）</h3>
              <div id="t2-passkey"></div>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(mask);
      document.body.appendChild(dialog);
      if (window.lucide) window.lucide.createIcons({ root: dialog });

      const close = () => { mask.remove(); dialog.remove(); };
      dialog.querySelector('.t2-close').addEventListener('click', close);
      dialog.querySelector('.t2-cancel').addEventListener('click', close);
      mask.addEventListener('click', close);

      const lockEl = dialog.querySelector('#t2-lock');
      const manageEl = dialog.querySelector('#t2-manage');
      const passwordInput = dialog.querySelector('#t2-password');
      let currentPassword = '';

      dialog.querySelector('.t2-unlock').addEventListener('click', async () => {
        currentPassword = passwordInput.value;
        if (!currentPassword) { notify('请输入当前密码', 'error'); return; }
        const unlockBtn = dialog.querySelector('.t2-unlock');
        unlockBtn.disabled = true;
        try {
          await requestJson('/api/auth/2fa/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword }),
          });
          lockEl.hidden = true;
          manageEl.hidden = false;
          await load2faStatus();
        } catch {
          // 401 已被 requestJson 踢去登录页；剩的是密码错误之类，恢复按钮让用户重试
          unlockBtn.disabled = false;
          passwordInput.value = '';
          passwordInput.focus();
        }
      });

      async function load2faStatus() {
        try {
          const res = await requestJson('/api/auth/2fa/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword }),
          });
          renderTotp(res.data);
          renderPasskeys(res.data);
        } catch { /* 401 已处理，其余错误进 notify */ }
      }

      function renderTotp(status) {
        const el = dialog.querySelector('#t2-totp');
        if (status.totpEnabled) {
          el.innerHTML = `
            <div class="twofa-row">
              <div>
                <strong>已开启</strong>
                <p>登录时需输入身份验证器里的 6 位动态码。</p>
              </div>
              <button type="button" class="danger t2-totp-off">关闭 TOTP</button>
            </div>`;
          el.querySelector('.t2-totp-off').addEventListener('click', async () => {
            try {
              await requestJson('/api/auth/2fa/totp/disable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword }),
              });
              notify('两步验证已关闭', 'success');
              await load2faStatus();
            } catch (err) { notify(err.message || '关闭失败', 'error'); }
          });
        } else {
          el.innerHTML = `
            <div class="twofa-row">
              <div>
                <strong>未开启</strong>
                <p>开启后，输入密码后还要再输一个动态码才能登录。</p>
              </div>
              <button type="button" class="alt t2-totp-on">开启</button>
            </div>`;
          el.querySelector('.t2-totp-on').addEventListener('click', startTotpSetup);
        }
      }

      async function startTotpSetup() {
        const el = dialog.querySelector('#t2-totp');
        let setup;
        try {
          setup = (await requestJson('/api/auth/2fa/totp/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword }),
          })).data;
        } catch (err) { notify(err.message || '生成秘钥失败', 'error'); return; }

        el.innerHTML = `
          <div class="totp-setup">
            <p class="muted" style="margin:0;font-size:13px;line-height:1.7;">
              用身份验证器 App（如 Google Authenticator / 1Password）扫下面的二维码，
              或手动输入秘钥，然后填上 App 里显示的 6 位动态码完成开启。
            </p>
            <div class="totp-qr-wrap"><div id="t2-qr"></div></div>
            <div class="totp-secret-row">
              <code id="t2-secret">${escapeHtml(setup.secret)}</code>
              <button type="button" class="alt t2-copy">复制</button>
            </div>
            <div>
              <label class="field-label" for="t2-code">动态验证码</label>
              <input id="t2-code" type="text" inputmode="numeric" maxlength="6"
                     placeholder="6 位数字" style="width:100%;font:600 18px/1.2 var(--font-mono);letter-spacing:0.3em;text-align:center;" />
            </div>
            <div class="row" style="gap:8px; justify-content:flex-end;">
              <button type="button" class="alt t2-setup-cancel">取消</button>
              <button type="button" class="btn-primary t2-setup-ok">确认开启</button>
            </div>
          </div>`;
        if (window.lucide) window.lucide.createIcons({ root: el });

        renderTotpQr(setup.otpauthUrl, el);

        el.querySelector('.t2-copy').addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(setup.secret);
            notify('秘钥已复制', 'success');
          } catch {
            // 剪贴板权限被拒就选中文本，让用户自己 Ctrl+C
            const code = el.querySelector('#t2-secret');
            const range = document.createRange();
            range.selectNodeContents(code);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
        });

        el.querySelector('.t2-setup-cancel').addEventListener('click', load2faStatus);

        el.querySelector('.t2-setup-ok').addEventListener('click', async () => {
          const code = el.querySelector('#t2-code').value.trim();
          if (!/^\d{6}$/.test(code)) { notify('请输入 6 位数字验证码', 'error'); return; }
          try {
            await requestJson('/api/auth/2fa/totp/confirm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ currentPassword, code }),
            });
            notify('两步验证已开启', 'success');
            await load2faStatus();
          } catch (err) { notify(err.message || '开启失败', 'error'); }
        });
      }

      // 二维码本地生成（qrcode-generator，CDN 懒加载，只在开启 TOTP 时拉一次）；
      // 加载失败就退化为手动输入秘钥——二维码没了但功能不丢。
      let qrLibPromise = null;
      function loadQrLib() {
        if (window.qrcode) return Promise.resolve();
        if (!qrLibPromise) {
          qrLibPromise = new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
            script.onload = () => resolve();
            script.onerror = () => resolve(); // 失败也走完，draw 里会兜底
            document.head.appendChild(script);
          });
        }
        return qrLibPromise;
      }

      function renderTotpQr(otpauthUrl, root) {
        const wrap = root.querySelector('#t2-qr');
        loadQrLib().then(() => {
          if (!window.qrcode) {
            wrap.innerHTML = '<p class="muted" style="margin:0;text-align:center;font-size:12px;">二维码组件加载失败，请手动输入下方秘钥。</p>';
            return;
          }
          try {
            const qr = window.qrcode(0, 'L');
            qr.addData(otpauthUrl);
            qr.make();
            const img = document.createElement('img');
            img.src = qr.createDataURL(4, 12);
            img.alt = 'TOTP 二维码';
            img.width = 180;
            img.height = 180;
            wrap.innerHTML = '';
            wrap.appendChild(img);
          } catch {
            wrap.innerHTML = '<p class="muted" style="margin:0;text-align:center;font-size:12px;">二维码生成失败，请手动输入下方秘钥。</p>';
          }
        });
      }

      function fmtTime(iso) {
        if (!iso) return '从未';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return String(iso);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }

      function renderPasskeys(status) {
        const el = dialog.querySelector('#t2-passkey');
        const list = status.passkeys || [];
        const rows = list.length
          ? list.map((pk) => `
              <div class="passkey-item">
                <div>
                  <strong>${escapeHtml(pk.name || '未命名通行密钥')}</strong>
                  <p>注册于 ${fmtTime(pk.created_at)} · 上次使用 ${fmtTime(pk.last_used_at)}</p>
                </div>
                <button type="button" class="danger passkey-del" data-id="${pk.id}">删除</button>
              </div>`).join('')
          : '<p class="muted" style="font-size:13px;margin:0;">还没有通行密钥。</p>';

        const supported = Boolean(window.isSecureContext && navigator.credentials && window.PublicKeyCredential);
        el.innerHTML = `
          <div class="passkey-list">${rows}</div>
          <div class="twofa-add-row">
            <input id="t2-passkey-name" type="text" maxlength="60" placeholder="名称（可选）" />
            <button type="button" class="alt t2-passkey-add" ${supported ? '' : 'disabled'}>添加</button>
          </div>
          ${supported ? '' : '<p class="muted" style="font-size:12px;margin:8px 0 0;">当前环境不支持 WebAuthn（需 HTTPS 或 localhost），无法注册通行密钥。</p>'}`;
        if (window.lucide) window.lucide.createIcons({ root: el });

        el.querySelectorAll('.passkey-del').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = Number(btn.dataset.id);
            if (!id) return;
            if (!confirm('确定删除这把通行密钥？删除后该设备将无法用它免密登录。')) return;
            try {
              await requestJson('/api/auth/2fa/passkey/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, id }),
              });
              notify('通行密钥已删除', 'success');
              await load2faStatus();
            } catch (err) { notify(err.message || '删除失败', 'error'); }
          });
        });

        const addBtn = el.querySelector('.t2-passkey-add');
        if (addBtn) {
          addBtn.addEventListener('click', () => {
            registerPasskey(el.querySelector('#t2-passkey-name').value);
          });
        }
      }

      async function registerPasskey(name) {
        if (!window.PublicKeyCredential || !navigator.credentials) {
          notify('当前环境不支持通行密钥（需要 HTTPS 或 localhost）', 'error');
          return;
        }
        let options;
        try {
          options = (await requestJson('/api/auth/2fa/passkey/register/challenge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, name: String(name || '').trim() }),
          })).data;
        } catch (err) { notify(err.message || '获取注册凭证失败', 'error'); return; }

        try {
          const cred = await navigator.credentials.create({
            publicKey: {
              challenge: base64urlToBuffer(options.challenge),
              rp: options.rp,
              user: {
                id: base64urlToBuffer(options.user.id),
                name: options.user.name,
                displayName: options.user.displayName,
              },
              pubKeyCredParams: options.pubKeyCredParams,
              timeout: options.timeout,
              attestation: options.attestation || 'none',
              authenticatorSelection: options.authenticatorSelection,
              excludeCredentials: (options.excludeCredentials || []).map((c) => ({
                ...c,
                id: base64urlToBuffer(c.id),
              })),
            },
          });
          const transports = cred.response.getTransports
            ? cred.response.getTransports()
            : (cred.response.transports || []);
          await requestJson('/api/auth/2fa/passkey/register/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              currentPassword,
              challenge: options.challenge,
              response: {
                id: cred.id,
                rawId: bufferToBase64url(cred.rawId),
                type: cred.type,
                response: {
                  clientDataJSON: bufferToBase64url(cred.response.clientDataJSON),
                  attestationObject: bufferToBase64url(cred.response.attestationObject),
                  transports,
                },
              },
            }),
          });
          notify('通行密钥已添加', 'success');
          await load2faStatus();
        } catch (err) {
          const msg = String((err && err.message) || err || '');
          // 用户主动取消是正常路径，不弹错
          if (msg && !/NotAllowedError|abort|cancel|取消/i.test(msg)) {
            notify('添加通行密钥失败：' + msg, 'error');
          }
        }
      }

      setTimeout(() => passwordInput.focus(), 40);
    }

    function wire(username) {
      const box = document.getElementById('topbar-user');
      const nameEl = document.getElementById('topbar-username');
      if (nameEl) nameEl.textContent = username || '';
      if (box) box.hidden = false;

      // 版本号显示在侧边栏 brand 旁边。走独立小接口，失败就藏起来 ——
      // 一个装饰性的标签不值得报错打断启动。
      fetch('/api/version')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          const el = document.getElementById('app-version');
          const label = data && data.data && data.data.label;
          if (el && label) {
            el.textContent = label;
            el.title = `版本 ${label}${data.data.describe ? `（${data.data.describe}）` : ''}`;
            el.hidden = false;
          }
        })
        .catch(() => {});

      const logoutBtn = document.getElementById('logout-btn');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
          try {
            await fetch('/api/auth/logout', { method: 'POST' });
          } catch {
            // 退出失败也照样跳登录页：Cookie 可能已经没了，留在面板上没意义
          }
          location.replace('/login.html');
        });
      }

      const cpBtn = document.getElementById('change-password-btn');
      if (cpBtn) cpBtn.addEventListener('click', openChangePasswordDialog);

      const twofaBtn = document.getElementById('twofa-btn');
      if (twofaBtn) twofaBtn.addEventListener('click', open2faDialog);
    }


    return { wire };
  }

  global.AuthUi = { create };
})(window);

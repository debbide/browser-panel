(() => {
  const form = document.getElementById('managed-proxy-form');
  const nameInput = document.getElementById('managed-proxy-name');
  const upstreamInput = document.getElementById('managed-proxy-upstream-url');
  const addButton = document.getElementById('managed-proxy-add-btn');
  const refreshButton = document.getElementById('managed-proxy-refresh-btn');
  const message = document.getElementById('managed-proxy-message');
  const list = document.getElementById('managed-proxy-list');

  if (!form || !list) return;

  let proxies = [];
  const editing = new Set();

  function setMessage(text, isError = false) {
    const value = String(text == null ? '' : text);
    message.textContent = value;
    message.classList.toggle('managed-proxy-message-error', Boolean(isError) && value !== '');
    // The node ships with `hidden`; without clearing it every success/error note
    // stayed invisible and the page looked like the buttons did nothing.
    message.hidden = value === '';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function maskUpstreamUrl(value) {
    try {
      const url = new URL(value);
      if (url.password) url.password = '********';
      return url.toString();
    } catch {
      return value || '';
    }
  }

  function statusText(status) {
    return {
      starting: '启动中',
      running: '运行中',
      stopped: '已停止',
      error: '错误',
    }[status] || status || '未知';
  }

  function render(items) {
    proxies = Array.isArray(items) ? items : [];
    if (proxies.length === 0) {
      list.innerHTML = '<div class="managed-proxy-empty muted">尚未添加代理。</div>';
      return;
    }

    list.innerHTML = proxies.map((proxy) => {
      const id = String(proxy.id);
      const running = proxy.status === 'running';
      const busy = proxy.status === 'starting';
      const isEditing = editing.has(id);
      const localUrl = proxy.localUrl || '未运行';
      return `
        <article class="managed-proxy-card" data-proxy-id="${escapeHtml(id)}">
          <div class="managed-proxy-card-head">
            <div>
              <strong>${escapeHtml(proxy.name)}</strong>
              <span class="managed-proxy-status managed-proxy-status-${escapeHtml(proxy.status)}">${escapeHtml(statusText(proxy.status))}</span>
            </div>
            <div class="row">
              <button type="button" class="alt" data-action="edit" ${busy || isEditing ? 'disabled' : ''}>编辑</button>
              <button type="button" class="alt managed-proxy-delete" data-action="delete" ${busy || isEditing ? 'disabled' : ''}>删除</button>
            </div>
          </div>
          ${isEditing ? `
            <form class="managed-proxy-edit-form" data-edit-form>
              <label>代理名称<input name="name" type="text" value="${escapeHtml(proxy.name)}" required></label>
              <label>上游地址<input name="upstreamUrl" type="text" value="${escapeHtml(proxy.upstreamUrl)}" required></label>
              <p class="muted">运行中的代理保存时会安全重启；失败时自动恢复旧配置。</p>
              <div class="row managed-proxy-actions">
                <button type="submit" class="btn-primary">保存</button>
                <button type="button" class="alt" data-action="cancel-edit">取消</button>
              </div>
            </form>` : `
            <dl class="managed-proxy-details">
              <dt>上游地址</dt><dd><code>${escapeHtml(maskUpstreamUrl(proxy.upstreamUrl))}</code></dd>
              <dt>本地 HTTP</dt><dd><code>${escapeHtml(localUrl)}</code></dd>
            </dl>
            ${proxy.lastError ? `<p class="managed-proxy-error">${escapeHtml(proxy.lastError)}</p>` : ''}
            <div class="row managed-proxy-actions">
              <button type="button" class="btn-primary" data-action="start" ${running || busy ? 'disabled' : ''}>启动</button>
              <button type="button" class="alt" data-action="stop" ${!running && !busy ? 'disabled' : ''}>停止</button>
              <button type="button" class="alt" data-action="test" ${busy ? 'disabled' : ''}>测试 HTTPS</button>
              ${proxy.localUrl ? `<button type="button" class="alt" data-action="copy" data-copy-value="${escapeHtml(proxy.localUrl)}">复制地址</button>` : ''}
            </div>`}
        </article>`;
    }).join('');
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `请求失败 (${response.status})`);
    return payload.data;
  }

  async function load({ clearMessage = true } = {}) {
    refreshButton.disabled = true;
    try {
      render(await request('/api/managed-proxies'));
      if (clearMessage) setMessage('');
    } catch (error) {
      setMessage(error.message || String(error), true);
    } finally {
      refreshButton.disabled = false;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    addButton.disabled = true;
    setMessage('正在添加代理…');
    try {
      await request('/api/managed-proxies', {
        method: 'POST',
        body: JSON.stringify({
          name: nameInput.value.trim(),
          upstreamUrl: upstreamInput.value.trim(),
        }),
      });
      form.reset();
      await load({ clearMessage: false });
      setMessage('代理已添加。');
    } catch (error) {
      setMessage(error.message || String(error), true);
    } finally {
      addButton.disabled = false;
    }
  });

  refreshButton.addEventListener('click', load);

  list.addEventListener('submit', async (event) => {
    const editForm = event.target.closest('[data-edit-form]');
    if (!editForm) return;
    event.preventDefault();
    const card = editForm.closest('[data-proxy-id]');
    const id = card && card.dataset.proxyId;
    if (!id) return;
    const submitButton = editForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    setMessage('正在保存并验证代理配置…');
    try {
      await request(`/api/managed-proxies/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editForm.elements.name.value.trim(),
          upstreamUrl: editForm.elements.upstreamUrl.value.trim(),
        }),
      });
      editing.delete(id);
      await load({ clearMessage: false });
      setMessage('代理配置已保存。');
    } catch (error) {
      setMessage(error.message || String(error), true);
      submitButton.disabled = false;
    }
  });

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const card = button.closest('[data-proxy-id]');
    const id = card && card.dataset.proxyId;
    const action = button.dataset.action;

    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(button.dataset.copyValue || '');
        setMessage('本地代理地址已复制。');
      } catch {
        setMessage('复制失败，请手动复制地址。', true);
      }
      return;
    }

    if (!id) return;
    if (action === 'edit') {
      editing.add(id);
      render(proxies);
      return;
    }
    if (action === 'cancel-edit') {
      editing.delete(id);
      render(proxies);
      return;
    }

    button.disabled = true;
    const progressText = {
      delete: '正在删除代理…',
      start: '正在启动代理…',
      stop: '正在停止代理…',
      test: '正在执行真实 HTTPS CONNECT 测试…',
    }[action] || '正在处理代理…';
    setMessage(progressText);
    try {
      let doneText = '';
      if (action === 'delete') {
        await request(`/api/managed-proxies/${encodeURIComponent(id)}`, { method: 'DELETE' });
        doneText = '代理已删除。';
      } else {
        const result = await request(`/api/managed-proxies/${encodeURIComponent(id)}/${action}`, {
          method: 'POST',
          body: JSON.stringify(action === 'stop' ? { force: true } : {}),
        });
        if (action === 'test') {
          doneText = `HTTPS 测试通过：状态 ${result.statusCode}，延迟 ${result.latencyMs} ms。`;
        } else if (action === 'start') {
          doneText = '代理已启动。';
        } else if (action === 'stop') {
          doneText = '代理已停止。';
        }
      }
      await load({ clearMessage: false });
      if (doneText) setMessage(doneText);
    } catch (error) {
      setMessage(error.message || String(error), true);
      button.disabled = false;
    }
  });

  window.ManagedProxies = { load };
  load();
})();

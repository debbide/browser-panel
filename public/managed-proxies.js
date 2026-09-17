(() => {
  const form = document.getElementById('managed-proxy-form');
  const nameInput = document.getElementById('managed-proxy-name');
  const upstreamInput = document.getElementById('managed-proxy-upstream-url');
  const addButton = document.getElementById('managed-proxy-add-btn');
  const refreshButton = document.getElementById('managed-proxy-refresh-btn');
  const message = document.getElementById('managed-proxy-message');
  const list = document.getElementById('managed-proxy-list');

  if (!form || !list) return;

  function setMessage(text, isError = false) {
    message.textContent = text || '';
    message.classList.toggle('managed-proxy-message-error', isError);
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

  function render(proxies) {
    if (!Array.isArray(proxies) || proxies.length === 0) {
      list.innerHTML = '<div class="managed-proxy-empty muted">尚未添加代理。</div>';
      return;
    }

    list.innerHTML = proxies.map((proxy) => {
      const running = proxy.status === 'running';
      const busy = proxy.status === 'starting';
      const localUrl = proxy.localUrl || '未运行';
      return `
        <article class="managed-proxy-card" data-proxy-id="${escapeHtml(proxy.id)}">
          <div class="managed-proxy-card-head">
            <div>
              <strong>${escapeHtml(proxy.name)}</strong>
              <span class="managed-proxy-status managed-proxy-status-${escapeHtml(proxy.status)}">${escapeHtml(statusText(proxy.status))}</span>
            </div>
            <button type="button" class="alt managed-proxy-delete" data-action="delete" ${busy ? 'disabled' : ''}>删除</button>
          </div>
          <dl class="managed-proxy-details">
            <dt>上游地址</dt><dd><code>${escapeHtml(maskUpstreamUrl(proxy.upstreamUrl))}</code></dd>
            <dt>本地 HTTP</dt><dd><code>${escapeHtml(localUrl)}</code></dd>
          </dl>
          ${proxy.lastError ? `<p class="managed-proxy-error">${escapeHtml(proxy.lastError)}</p>` : ''}
          <div class="row managed-proxy-actions">
            <button type="button" class="btn-primary" data-action="start" ${running || busy ? 'disabled' : ''}>启动</button>
            <button type="button" class="alt" data-action="stop" ${!running && !busy ? 'disabled' : ''}>停止</button>
            ${proxy.localUrl ? `<button type="button" class="alt" data-action="copy" data-copy-value="${escapeHtml(proxy.localUrl)}">复制地址</button>` : ''}
          </div>
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

  async function load() {
    refreshButton.disabled = true;
    try {
      render(await request('/api/managed-proxies'));
      setMessage('');
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
      setMessage('代理已添加。');
      await load();
    } catch (error) {
      setMessage(error.message || String(error), true);
    } finally {
      addButton.disabled = false;
    }
  });

  refreshButton.addEventListener('click', load);

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
    button.disabled = true;
    setMessage(action === 'delete' ? '正在删除代理…' : `正在${action === 'start' ? '启动' : '停止'}代理…`);
    try {
      if (action === 'delete') {
        await request(`/api/managed-proxies/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } else {
        await request(`/api/managed-proxies/${encodeURIComponent(id)}/${action}`, {
          method: 'POST',
          body: JSON.stringify(action === 'stop' ? { force: true } : {}),
        });
      }
      await load();
    } catch (error) {
      setMessage(error.message || String(error), true);
      button.disabled = false;
    }
  });

  window.ManagedProxies = { load };
  load();
})();

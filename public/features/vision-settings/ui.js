(function exposeVisionSettingsUi(global) {
  function create(dependencies = {}) {
    const SettingsApi = dependencies.api;
    const visionForm = dependencies.elements?.form || null;
    const visionStatusText = dependencies.elements?.status || null;
    const visionChannelsList = dependencies.elements?.channelsList || null;
    const visionAddChannelBtn = dependencies.elements?.addButton || null;
    const toast = dependencies.actions?.toast || (() => {});
    const escapeHtml = dependencies.actions?.escapeHtml || ((value) => String(value || ""));
    const openVisionTestModalForCard = dependencies.actions?.openTestModalForCard || (() => {});
function makeVisionChannelCard(channel = {}, index = 0) {
  const isPrimary = index === 0;
  const card = document.createElement('div');
  card.className = 'vision-channel-card' + (isPrimary ? ' is-primary' : '');
  card.dataset.visionChannel = '1';
  card.dataset.channelId = channel.id || '';

  const masked = channel.apiKeyMasked || '';
  const keyPlaceholder = masked ? `已保存 ${masked}` : 'API Key';
  const label = isPrimary ? '主' : String(index);

  // 记录初始值，用于判断卡片是否干净（未编辑）
  card.dataset.initialBase = channel.baseUrl || '';
  card.dataset.initialModel = channel.model || '';
  card.dataset.initialHasKey = channel.hasKey ? '1' : '0';

  card.innerHTML = `
    <div class="vision-channel-row">
      <span class="vision-channel-badge">${label}</span>
      <input type="text" class="vision-ch-base" placeholder="Base URL" value="${(channel.baseUrl || '').replace(/"/g, '&quot;')}" />
      <input type="password" class="vision-ch-key" placeholder="${keyPlaceholder.replace(/"/g, '&quot;')}" autocomplete="new-password" />
      <div class="vision-model-input-group">
        <input type="text" class="vision-ch-model" placeholder="Model" value="${(channel.model || '').replace(/"/g, '&quot;')}" />
        <button type="button" class="icon-btn vision-ch-model-toggle" title="选择模型">
          <i data-lucide="chevron-down" class="icon-sm"></i>
        </button>
      </div>
      <div class="vision-channel-actions">
        <button type="button" class="alt btn-with-icon vision-channel-test" title="测试此通道">
          <i data-lucide="radar" class="icon-sm"></i> 测试
        </button>
        <button type="button" class="alt btn-with-icon vision-channel-make-primary" title="设为主通道" ${isPrimary ? 'disabled' : ''}>
          <i data-lucide="star" class="icon-sm"></i> 主通道
        </button>
        <button type="button" class="icon-btn vision-channel-remove" title="删除" ${isPrimary ? 'disabled' : ''}>
          <i data-lucide="trash-2" class="icon-sm"></i>
        </button>
      </div>
    </div>
  `;

  const removeBtn = card.querySelector('.vision-channel-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      const cards = visionChannelsList
        ? visionChannelsList.querySelectorAll('[data-vision-channel]')
        : [];
      if (cards.length <= 1) {
        toast('至少保留一个通道', 'warn');
        return;
      }
      card.remove();
      renumberVisionChannels();
    });
  }

  const primaryBtn = card.querySelector('.vision-channel-make-primary');
  if (primaryBtn) {
    primaryBtn.addEventListener('click', () => {
      promoteVisionChannelCard(card);
    });
  }

  const testBtn = card.querySelector('.vision-channel-test');
  if (testBtn) {
    testBtn.addEventListener('click', () => {
      openVisionTestModalForCard(card);
    });
  }

  const modelToggle = card.querySelector('.vision-ch-model-toggle');
  if (modelToggle) {
    modelToggle.addEventListener('click', () => {
      openModelDropdown(card);
    });
  }

  return card;
}

function renumberVisionChannels() {
  if (!visionChannelsList) return;
  const cards = visionChannelsList.querySelectorAll('[data-vision-channel]');
  cards.forEach((card, i) => {
    const isPrimary = i === 0;
    card.classList.toggle('is-primary', isPrimary);
    const badge = card.querySelector('.vision-channel-badge');
    if (badge) badge.textContent = isPrimary ? '主' : String(i);
    const removeBtn = card.querySelector('.vision-channel-remove');
    if (removeBtn) {
      removeBtn.disabled = isPrimary;
      removeBtn.style.visibility = isPrimary ? 'hidden' : 'visible';
    }
    const primaryBtn = card.querySelector('.vision-channel-make-primary');
    if (primaryBtn) {
      primaryBtn.disabled = isPrimary;
      primaryBtn.title = isPrimary ? '当前已是主通道' : '设为主通道';
    }
  });
}

/** Move a channel card to index 0 (primary). Order is what save/failover uses. */
function promoteVisionChannelCard(card) {
  if (!visionChannelsList || !card) return;
  const first = visionChannelsList.querySelector('[data-vision-channel]');
  if (!first || first === card) {
    toast('已是主通道', 'success');
    return;
  }
  visionChannelsList.insertBefore(card, first);
  renumberVisionChannels();
  if (window.lucide) window.lucide.createIcons({ root: visionChannelsList });
  toast('已设为主通道（记得保存）', 'success');
}

function readVisionChannelFromCard(card) {
  if (!card) return null;
  return {
    id: card.dataset.channelId || '',
    baseUrl: card.querySelector('.vision-ch-base')?.value?.trim() || '',
    apiKey: card.querySelector('.vision-ch-key')?.value?.trim() || '',
    model: card.querySelector('.vision-ch-model')?.value?.trim() || '',
    card,
  };
}

// 模型列表缓存：key = 规范化 baseUrl，value = string[]。首次拉取后再开秒出，
// 底部「⟳ 刷新」强制重拉（换了供应商 / 新上了模型时用）。
const visionModelCache = new Map();
let visionDropdownOutsideHandler = null;
let visionDropdownKeyHandler = null;

function visionCacheKey(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
}

function updateVisionStatusText(data = {}) {
  if (!visionStatusText) return;
  const count = Number(data.channelCount || 0);
  const base = data.configured ? 'Status: configured' : 'Status: not configured';
  visionStatusText.textContent = count > 1 ? `${base} · ${count} 通道` : base;
  visionStatusText.style.color = data.configured ? '#86efac' : '#94a3b8';
}

/**
 * 卡片是否「干净」——除 model 外没有未保存的改动。
 * model 自己不算脏：切模型就是要覆盖它。
 * 顺序只检查「主通道是否还在第 1 位」；ch1/ch2 互换不算脏，因为按 id 落库不会写错通道，
 * 那个待保存的顺序改动会原样留在表单里。
 */
function isVisionCardClean(card) {
  if (!card || !card.dataset.channelId) return false; // 新增通道：还没有身份，必须走保存
  if (card.dataset.initialHasKey !== '1') return false; // 库里没 key，改 model 也存不下去
  if (card.querySelector('.vision-ch-key')?.value) return false; // 填了新 key
  const base = card.querySelector('.vision-ch-base')?.value?.trim() || '';
  if (base !== (card.dataset.initialBase || '')) return false;
  const cards = visionChannelsList
    ? Array.from(visionChannelsList.querySelectorAll('[data-vision-channel]'))
    : [];
  const at = cards.indexOf(card);
  const isPrimaryId = card.dataset.channelId === 'primary';
  if (isPrimaryId !== (at === 0)) return false; // 有待保存的「设为主通道」
  return true;
}

function closeVisionModelDropdown() {
  document.querySelectorAll('.vision-model-dropdown').forEach((el) => el.remove());
  document.querySelectorAll('.vision-model-input-group.is-open')
    .forEach((el) => el.classList.remove('is-open'));
  if (visionDropdownOutsideHandler) {
    document.removeEventListener('mousedown', visionDropdownOutsideHandler, true);
    visionDropdownOutsideHandler = null;
  }
  if (visionDropdownKeyHandler) {
    document.removeEventListener('keydown', visionDropdownKeyHandler, true);
    visionDropdownKeyHandler = null;
  }
}

function renderVisionChannels(list) {
  if (!visionChannelsList) return;
  closeVisionModelDropdown();
  visionChannelsList.innerHTML = '';
  const channels = Array.isArray(list) && list.length ? list : [{}];
  channels.forEach((ch, i) => visionChannelsList.appendChild(makeVisionChannelCard(ch, i)));
  renumberVisionChannels();
  if (window.lucide) window.lucide.createIcons();
}

function collectVisionChannels() {
  if (!visionChannelsList) return [];
  const cards = visionChannelsList.querySelectorAll('[data-vision-channel]');
  const out = [];
  cards.forEach((card) => {
    const id = card.dataset.channelId || '';
    const baseUrl = card.querySelector('.vision-ch-base')?.value?.trim() || '';
    const apiKey = card.querySelector('.vision-ch-key')?.value?.trim() || '';
    const model = card.querySelector('.vision-ch-model')?.value?.trim() || '';
    if (!baseUrl && !apiKey && !model) return;
    out.push({ id, baseUrl, apiKey, model });
  });
  return out;
}

async function loadVisionSettings() {
  if (!visionForm) return;
  try {
    const res = await SettingsApi.loadVision();
    const data = res.data || {};
    renderVisionChannels(data.channelList);
    updateVisionStatusText(data);
  } catch (error) {
    if (visionStatusText) {
      visionStatusText.textContent = 'Status: load failed';
      visionStatusText.style.color = '#ef4444';
    }
    console.error('Failed to load vision settings:', error);
  }
}

/**
 * 模型下拉：拉列表 → 搜索过滤 → 点选切换。
 * 卡片干净时点选直接落库（只改 model，不碰 key）；卡片脏时只填输入框并提示去保存，
 * 避免把用户还在编辑、并不想提交的字段一并写进去。
 */
async function openModelDropdown(card) {
  if (!card) return;
  const group = card.querySelector('.vision-model-input-group');
  const modelInput = card.querySelector('.vision-ch-model');
  if (!group || !modelInput) return;

  // 再点一次 = 关闭
  if (group.classList.contains('is-open')) {
    closeVisionModelDropdown();
    return;
  }
  closeVisionModelDropdown();

  const baseUrl = card.querySelector('.vision-ch-base')?.value?.trim() || '';
  if (!baseUrl) {
    toast('请先填写该通道 Base URL', 'warn');
    return;
  }

  group.classList.add('is-open');
  const panel = document.createElement('div');
  panel.className = 'vision-model-dropdown';
  panel.innerHTML = ''
    + '<input type="text" class="vision-model-search" placeholder="搜索模型…" autocomplete="off" />'
    + '<div class="vision-model-list" data-model-list><div class="vision-model-empty">加载中…</div></div>'
    + '<div class="vision-model-dropdown-foot">'
    + '  <span data-model-count class="muted"></span>'
    + '  <button type="button" class="vision-model-refresh" data-model-refresh>⟳ 刷新</button>'
    + '</div>';
  group.appendChild(panel);

  const searchEl = panel.querySelector('.vision-model-search');
  const listEl = panel.querySelector('[data-model-list]');
  const countEl = panel.querySelector('[data-model-count]');
  const refreshBtn = panel.querySelector('[data-model-refresh]');

  visionDropdownOutsideHandler = (e) => {
    if (!panel.contains(e.target) && !group.contains(e.target)) closeVisionModelDropdown();
  };
  visionDropdownKeyHandler = (e) => {
    if (e.key === 'Escape') {
      closeVisionModelDropdown();
      modelInput.focus();
    }
  };
  document.addEventListener('mousedown', visionDropdownOutsideHandler, true);
  document.addEventListener('keydown', visionDropdownKeyHandler, true);

  let allIds = [];
  let visibleIds = [];

  const applyModel = async (id) => {
    const channelId = card.dataset.channelId || '';
    const clean = isVisionCardClean(card);
    modelInput.value = id;
    closeVisionModelDropdown();
    if (!clean) {
      toast(`已填入 ${id} · 该通道有未保存的改动，请点「保存」生效`, 'warn');
      return;
    }
    try {
      const res = await SettingsApi.updateVisionModel({ id: channelId, model: id });
      card.dataset.initialModel = id;
      updateVisionStatusText(res.data || {});
      toast(`已切换到 ${id}`, 'success');
    } catch (error) {
      modelInput.value = card.dataset.initialModel || '';
      toast(error.message || '切换模型失败', 'error');
    }
  };

  const renderList = () => {
    const q = (searchEl?.value || '').trim().toLowerCase();
    const current = modelInput.value.trim();
    const shown = q ? allIds.filter((id) => id.toLowerCase().includes(q)) : allIds;
    visibleIds = shown;
    if (countEl) {
      countEl.textContent = q
        ? `${shown.length} / ${allIds.length}`
        : `${allIds.length} 个模型`;
    }
    if (!shown.length) {
      listEl.innerHTML = `<div class="vision-model-empty">${allIds.length ? '没有匹配的模型' : '未读到模型列表'}</div>`;
      return;
    }
    listEl.innerHTML = shown.map((id) => {
      const selected = id === current ? ' is-selected' : '';
      return `<button type="button" class="vision-model-option${selected}" data-model-id="${escapeHtml(id)}">${escapeHtml(id)}</button>`;
    }).join('');
    listEl.querySelectorAll('[data-model-id]').forEach((btn) => {
      btn.addEventListener('click', () => applyModel(btn.getAttribute('data-model-id') || ''));
    });
  };

  const load = async (force) => {
    const cacheKey = visionCacheKey(baseUrl);
    if (!force && visionModelCache.has(cacheKey)) {
      allIds = visionModelCache.get(cacheKey);
      renderList();
      return;
    }
    listEl.innerHTML = '<div class="vision-model-empty">加载中…</div>';
    if (refreshBtn) refreshBtn.disabled = true;
    try {
      const res = await SettingsApi.testVision({
        id: card.dataset.channelId || '',
        baseUrl,
        apiKey: card.querySelector('.vision-ch-key')?.value?.trim() || '',
        model: modelInput.value.trim(),
        fetchModels: true,
        testImage: false, // 只要列表，不跑识图探测
      });
      const ids = (res.data && res.data.models && res.data.models.ids) || [];
      allIds = Array.isArray(ids) ? ids : [];
      visionModelCache.set(cacheKey, allIds);
      renderList();
    } catch (error) {
      listEl.innerHTML = `<div class="vision-model-empty is-bad">${escapeHtml(error.message || '拉取模型失败')}</div>`;
      if (countEl) countEl.textContent = '';
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  };

  if (searchEl) {
    searchEl.addEventListener('input', renderList);
    // 搜索框在 <form id="vision-form"> 里，回车会误触发整表保存 —— 拦下来，
    // 顺手让回车 = 选中唯一/第一个匹配项。
    searchEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      if (visibleIds.length) applyModel(visibleIds[0]);
    });
  }
  if (refreshBtn) refreshBtn.addEventListener('click', () => load(true));
  await load(false);
  if (searchEl) searchEl.focus();
}

    return {
      mountAddButton() {
        if (!visionAddChannelBtn) return;
        visionAddChannelBtn.addEventListener("click", () => {
          if (!visionChannelsList) return;
          const count = visionChannelsList.querySelectorAll("[data-vision-channel]").length;
          visionChannelsList.appendChild(makeVisionChannelCard({}, count));
          renumberVisionChannels();
          if (global.lucide) global.lucide.createIcons();
        });
      },
      render: renderVisionChannels,
      collect: collectVisionChannels,
      updateStatus: updateVisionStatusText,
      readCard: readVisionChannelFromCard,
      promote: promoteVisionChannelCard,
      load: loadVisionSettings,
    };
  }
  global.VisionSettingsUi = { create };
})(window);

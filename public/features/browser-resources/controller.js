(function exposeBrowserResourcesController(global) {
  function createState(initial = {}) {
    const profileStore = initial.profileStore || {
      profiles: [],
      getAll() { return this.profiles; },
      replace(profiles) { this.profiles = Array.isArray(profiles) ? profiles : []; },
      find(id) { return this.profiles.find((profile) => String(profile.id) === String(id)); },
    };
    return {
      browserSessionOpen: false,
      browserOpenedAt: null,
      profileStore,
      ...initial,
    };
  }

  function create({ api, view, state = createState(), elements = {}, actions = {} }) {
    let mounted = false;
    const listeners = [];
    const on = (element, event, handler) => {
      if (!element) return;
      element.addEventListener(event, handler);
      listeners.push([element, event, handler]);
    };

    const profileStore = state.profileStore;

    function renderProfileOptions(selectEl, selectedId) {
      if (!selectEl) return;
      const prev = selectedId !== undefined ? String(selectedId) : selectEl.value;
      const emptyLabel = selectEl === elements.taskProfileSelect && actions.isTaskTempProfileMode()
        ? '\u4e0d\u7ed1\u5b9a\u914d\u7f6e\uff08\u4ec5\u7cfb\u7edf\u9ed8\u8ba4\u4ee3\u7406\uff09'
        : '\u9ed8\u8ba4\u914d\u7f6e';
      selectEl.innerHTML = `<option value="">${emptyLabel}</option>` +
        profileStore.getAll().map((p) => {
          const stack = String(p.runtime_stack || '').trim();
          const stackText = stack ? ` [${stack}]` : '';
          return `<option value="${p.id}" ${String(p.id) === prev ? 'selected' : ''}>${actions.escapeHtml(`${p.name}${stackText}`)}</option>`;
        }).join('');
    }

    function fillTaskProxyFromSelectedProfile() {
      const id = elements.taskProfileSelect?.value;
      if (!id) {
        actions.toast('\u8bf7\u5148\u9009\u62e9\u4e00\u4e2a\u6d4f\u89c8\u5668\u914d\u7f6e', 'warn');
        return;
      }
      const p = profileStore.getAll().find((x) => String(x.id) === String(id));
      if (!p) {
        actions.toast('\u672a\u627e\u5230\u8be5\u914d\u7f6e', 'error');
        return;
      }
      const value = p.proxy_value || p.proxy;
      actions.setTaskBrowserProxyInput(value, p.runtime_stack || '', p.proxy_mode || 'inherit');
      actions.toast('\u5df2\u586b\u5165\u914d\u7f6e\u7684\u6d4f\u89c8\u5668\u548c\u4ee3\u7406\uff08\u4ecd\u4f7f\u7528\u4e34\u65f6\u6570\u636e\u76ee\u5f55\uff09', 'success');
    }

    function renderProfiles() {
      renderProfileOptions(elements.browserProfileSelect);
      renderProfileOptions(elements.taskProfileSelect);
      if (!elements.profilesList) return;
      if (profileStore.getAll().length === 0) {
        elements.profilesList.innerHTML = '<p class="muted" style="padding:8px 0;">\u6682\u65e0\u914d\u7f6e\uff0c\u70b9\u51fb\u4e0a\u65b9\u201c\u65b0\u5efa\u914d\u7f6e\u201d\u6dfb\u52a0</p>';
        return;
      }
      elements.profilesList.innerHTML = profileStore.getAll().map(p => `
        <article class="profile-card">
          <div class="profile-card-head">
            <div>
              <strong class="profile-card-name">${actions.escapeHtml(p.name)}</strong>
              <div class="profile-card-id">#${p.id}</div>
            </div>
            <div class="row profile-card-actions" style="gap:8px;">
              <button class="alt btn-with-icon" onclick="editProfile(${p.id})"><i data-lucide="pencil" class="icon-sm"></i> \u7f16\u8f91</button>
              <button class="alt btn-with-icon profile-btn-danger" onclick="deleteProfile(${p.id})"><i data-lucide="trash-2" class="icon-sm"></i> \u5220\u9664</button>
            </div>
          </div>
          <div class="profile-kv-grid">
            <div class="profile-kv">
              <span class="profile-kv-label">\u6d4f\u89c8\u5668</span>
              <span class="profile-kv-value">${actions.escapeHtml((p.runtime_stack || '') === 'ruyipage' ? 'Firefox' : ((p.runtime_stack || '') ? 'Chrome' : '\u7ee7\u627f\u5168\u5c40'))}</span>
            </div>
            <div class="profile-kv">
              <span class="profile-kv-label">\u4ee3\u7406</span>
              <span class="profile-kv-value">${actions.escapeHtml(({ inherit: '\u7ee7\u627f\u5168\u5c40', direct: '\u4e0d\u4f7f\u7528\u4ee3\u7406', launch: '\u624b\u52a8\u4ee3\u7406', warp: 'Cloudflare WARP' })[p.proxy_mode || ((p.proxy_value || p.proxy) ? 'launch' : 'inherit')] || '\u7ee7\u627f\u5168\u5c40')}</span>
            </div>
            <div class="profile-kv">
              <span class="profile-kv-label">Locale</span>
              <span class="profile-kv-value">${actions.escapeHtml(p.locale || 'default')}</span>
            </div>
            <div class="profile-kv">
              <span class="profile-kv-label">Timezone</span>
              <span class="profile-kv-value">${actions.escapeHtml(p.timezone_id || 'default')}</span>
            </div>
          </div>
          <div class="profile-path-block">
            <span class="profile-kv-label">\u76ee\u5f55</span>
            <code class="profile-path-value">${actions.escapeHtml(p.user_data_dir || '\u672a\u8bbe\u7f6e')}</code>
          </div>
        </article>
      `).join('');
      if (window.lucide) window.lucide.createIcons({ root: elements.profilesList });
    }

    async function loadProfiles() {
      const res = await api.listProfiles();
      profileStore.replace(res.data || []);
      renderProfiles();
    }

    async function openProfileModal(profile) {
      const isEdit = Boolean(profile);
      let profileEnv = [];
      if (isEdit && profile?.id) {
        try {
          const res = await api.loadProfileEnv(profile.id);
          profileEnv = res.data || [];
        } catch {
          profileEnv = [];
        }
      }
      const mask = document.createElement('div');
      mask.className = 'modal-mask open';
      mask.style.zIndex = '9999';
      const dialog = document.createElement('div');
      dialog.className = 'modal open';
      dialog.style.cssText = 'align-items:center;justify-content:center;z-index:10000;';
      dialog.innerHTML = `
        <div class="modal-panel" style="max-width:560px;width:100%;padding:24px;max-height:90vh;overflow:auto;">
          <div class="section-header compact" style="margin-bottom:16px;">
            <h3>${isEdit ? '\u7f16\u8f91\u914d\u7f6e' : '\u65b0\u5efa\u6d4f\u89c8\u5668\u914d\u7f6e'}</h3>
            <button class="icon-btn" id="pmodal-close"><i data-lucide="x" class="icon-md"></i></button>
          </div>
          <form id="profile-form" class="stack-form">
            <div>
              <label class="field-label">\u914d\u7f6e\u540d\u79f0</label>
              <input name="name" placeholder="\u4f8b\u5982\uff1a\u8d26\u53f7A" required value="${actions.escapeHtml(profile?.name || '')}" />
            </div>
            <div>
              <label class="field-label">USER_DATA_DIR \u76ee\u5f55</label>
              <input name="user_data_dir" placeholder="/home/browser/browser-work/profiles/account-a" value="${actions.escapeHtml(profile?.user_data_dir || '')}" />
            </div>
            <div>
              <label class="field-label">\u6d4f\u89c8\u5668</label>
              <select name="runtime_stack">
                <option value="" ${(profile?.runtime_stack || '') === '' ? 'selected' : ''}>\u7ee7\u627f\u5168\u5c40</option>
                <option value="playwright" ${(profile?.runtime_stack || '') !== '' && (profile?.runtime_stack || '') !== 'ruyipage' ? 'selected' : ''}>Chrome</option>
                <option value="ruyipage" ${(profile?.runtime_stack || '') === 'ruyipage' ? 'selected' : ''}>Firefox</option>
              </select>
            </div>
            <div>
              <label class="field-label">\u4ee3\u7406\u6a21\u5f0f</label>
              <select name="proxy_mode" id="profile-proxy-mode">
                <option value="inherit" ${(profile?.proxy_mode || ((profile?.proxy_value || profile?.proxy) ? 'launch' : 'inherit')) === 'inherit' ? 'selected' : ''}>\u7ee7\u627f\u5168\u5c40</option>
                <option value="direct" ${profile?.proxy_mode === 'direct' ? 'selected' : ''}>\u4e0d\u4f7f\u7528\u4ee3\u7406</option>
                <option value="launch" ${(profile?.proxy_mode || ((profile?.proxy_value || profile?.proxy) ? 'launch' : 'inherit')) === 'launch' ? 'selected' : ''}>\u624b\u52a8 SOCKS / HTTP \u4ee3\u7406</option>
                <option value="warp" ${profile?.proxy_mode === 'warp' ? 'selected' : ''}>Cloudflare WARP</option>
              </select>
            </div>
            <div id="profile-proxy-value-field">
              <label class="field-label">\u4ee3\u7406\u5730\u5740</label>
              <input name="proxy_value" placeholder="socks5://127.0.0.1:7891" value="${actions.escapeHtml(profile?.proxy_value || profile?.proxy || '')}" />
            </div>
            <div class="locale-setting-grid">
              <div class="locale-setting-control">
                <label class="field-label" for="profile-locale-select">Locale</label>
                <select id="profile-locale-select" class="locale-preset-select">
                  <option value="">跟随全局默认</option>
                  ${actions.LOCALE_PRESETS.map((value) => `<option value="${value}">${value}</option>`).join('')}
                  <option value="__custom__">自定义…</option>
                </select>
                <input id="profile-locale-custom" class="locale-custom-input" type="text" placeholder="例如 fr-FR" autocomplete="off" hidden disabled />
              </div>
              <div class="locale-setting-control">
                <label class="field-label" for="profile-timezone-select">Timezone</label>
                <select id="profile-timezone-select" class="locale-preset-select">
                  <option value="">跟随全局默认</option>
                  ${actions.TIMEZONE_PRESETS.map((value) => `<option value="${value}">${value}</option>`).join('')}
                  <option value="__custom__">自定义…</option>
                </select>
                <input id="profile-timezone-custom" class="locale-custom-input" type="text" placeholder="例如 Europe/Paris" autocomplete="off" hidden disabled />
              </div>
            </div>
            <div class="config-block" style="margin-top:8px;">
              <div class="section-header compact">
                <div>
                  <h4>\u914d\u7f6e\u7ea7\u53d8\u91cf</h4>
                  <p class="muted">\u7ed1\u5b9a\u6b64\u6d4f\u89c8\u5668\u914d\u7f6e\u7684\u8d26\u53f7/\u5bc6\u94a5\uff0c\u4efb\u52a1\u9009\u7528\u8be5\u914d\u7f6e\u65f6\u6ce8\u5165</p>
                </div>
                <button type="button" class="alt btn-with-icon" id="profile-env-add" style="padding:4px 10px;">
                  <i data-lucide="plus" class="icon-sm"></i> \u6dfb\u52a0
                </button>
              </div>
              <div id="profile-env-editor" class="env-editor"></div>
            </div>
            <div class="row" style="margin-top:8px;">
              <button type="submit" class="btn-primary">${isEdit ? '\u4fdd\u5b58' : '\u521b\u5efa'}</button>
              <button type="button" class="alt" id="pmodal-cancel">\u53d6\u6d88</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(mask);
      document.body.appendChild(dialog);
      const profileLocaleSelect = dialog.querySelector('#profile-locale-select');
      const profileLocaleCustom = dialog.querySelector('#profile-locale-custom');
      const profileTimezoneSelect = dialog.querySelector('#profile-timezone-select');
      const profileTimezoneCustom = dialog.querySelector('#profile-timezone-custom');
      const profileProxyMode = dialog.querySelector('#profile-proxy-mode');
      const profileProxyValue = dialog.querySelector('[name="proxy_value"]');
      const profileProxyValueField = dialog.querySelector('#profile-proxy-value-field');
      const updateProfileProxyUI = () => actions.updateProxyModeUI(profileProxyMode, profileProxyValue, profileProxyValueField);
      profileProxyMode?.addEventListener('change', updateProfileProxyUI);
      updateProfileProxyUI();
      actions.setupPresetCustomControl(profileLocaleSelect, profileLocaleCustom, profile?.locale || '');
      actions.setupPresetCustomControl(profileTimezoneSelect, profileTimezoneCustom, profile?.timezone_id || '');
      const profileEnvUI = actions.createEnvEditor(dialog.querySelector('#profile-env-editor'));
      profileEnvUI.setRows(actions.filterManagedEnvRows(profileEnv, actions.PROFILE_MANAGED_ENV_KEYS));
      dialog.querySelector('#profile-env-add')?.addEventListener('click', () => profileEnvUI.addRow());
      if (window.lucide) window.lucide.createIcons({ root: dialog });
      const close = () => { mask.remove(); dialog.remove(); };
      dialog.querySelector('#pmodal-close').addEventListener('click', close);
      dialog.querySelector('#pmodal-cancel').addEventListener('click', close);
      mask.addEventListener('click', close);
      dialog.querySelector('#profile-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        let env;
        try {
          env = profileEnvUI.collect();
        } catch (err) {
          actions.toast(err.message || '\u53d8\u91cf\u65e0\u6548', 'error');
          return;
        }
        const proxyMode = fd.get('proxy_mode') || 'inherit';
        const proxyValue = proxyMode === 'launch' ? String(fd.get('proxy_value') || '').trim() : '';
        const body = {
          name: fd.get('name'),
          user_data_dir: fd.get('user_data_dir'),
          proxy_mode: proxyMode,
          proxy: proxyValue,
          proxy_value: proxyValue,
          runtime_stack: fd.get('runtime_stack'),
          locale: actions.getPresetCustomValue(profileLocaleSelect, profileLocaleCustom),
          timezone_id: actions.getPresetCustomValue(profileTimezoneSelect, profileTimezoneCustom),
        };
        try {
          let profileId = profile?.id;
          if (isEdit) {
            await api.updateProfile(profile.id, body);
            actions.toast('\u914d\u7f6e\u5df2\u66f4\u65b0', 'success');
          } else {
            const created = await api.createProfile(body);
            profileId = created?.data?.id;
            actions.toast('\u914d\u7f6e\u5df2\u521b\u5efa', 'success');
          }
          if (profileId) {
            await api.saveProfileEnv(profileId, { env });
          }
          close();
          await loadProfiles();
        } catch (err) {
          actions.toast(err.message || '\u4fdd\u5b58\u5931\u8d25', 'error');
        }
      });
    }

    function editProfile(id) {
      const p = profileStore.getAll().find(x => x.id === id);
      if (p) openProfileModal(p);
    }

    function deleteProfile(id) {
      const p = profileStore.getAll().find(x => x.id === id);
      actions.dialogConfirm(`\u786e\u5b9a\u8981\u5220\u9664\u914d\u7f6e\u300c${p?.name || id}\u300d\u5417\uff1f`, async () => {
        try {
          await api.deleteProfile(id);
          actions.toast('\u914d\u7f6e\u5df2\u5220\u9664', 'success');
          await loadProfiles();
        } catch (err) {
          actions.toast(err.message || '\u5220\u9664\u5931\u8d25', 'error');
        }
      });
    }

    function renderBrowserControls() {
      if (elements.openBrowserBtn) {
        elements.openBrowserBtn.disabled = state.browserSessionOpen;
        elements.openBrowserBtn.innerHTML = state.browserSessionOpen
          ? '<i data-lucide="monitor-check" class="icon-sm"></i> 已启动'
          : '<i data-lucide="monitor-play" class="icon-sm"></i> 启动';
        actions.createIcons?.(elements.openBrowserBtn);
      }
      if (elements.closeBrowserBtn) {
        elements.closeBrowserBtn.disabled = !state.browserSessionOpen;
        elements.closeBrowserBtn.innerHTML = state.browserSessionOpen
          ? '<i data-lucide="monitor-stop" class="icon-sm"></i> 关闭浏览器'
          : '<i data-lucide="monitor-off" class="icon-sm"></i> 未启动';
        actions.createIcons?.(elements.closeBrowserBtn);
      }
      if (elements.addTaskBtn) {
        elements.addTaskBtn.title = state.browserSessionOpen && state.browserOpenedAt
          ? `浏览器已打开：${actions.shortTime(state.browserOpenedAt)}`
          : '';
      }
    }

    async function loadBrowserStatus() {
      const data = await api.loadBrowser();
      state.browserSessionOpen = Boolean(data.data?.open);
      state.browserOpenedAt = data.data?.openedAt || null;
      renderBrowserControls();
    }

    async function openBrowserSession() {
      if (elements.openBrowserBtn) elements.openBrowserBtn.disabled = true;
      try {
        const profileId = elements.browserProfileSelect ? elements.browserProfileSelect.value : '';
        actions.toast('正在启动浏览器…', 'info');
        await api.openBrowser({ profile_id: profileId || null });
        await loadBrowserStatus();
        actions.toast('浏览器已成功启动（常驻，手动关闭或点「关闭浏览器」）', 'success');
      } catch (error) {
        await loadBrowserStatus().catch(() => {});
        actions.toast(error.message || '浏览器启动失败', 'error');
      } finally {
        renderBrowserControls();
      }
    }

    async function closeBrowserSession() {
      try {
        await api.closeBrowser();
        await loadBrowserStatus();
        actions.toast('浏览器会话已安全关闭', 'success');
      } catch (error) {
        actions.toast(error.message || '浏览器关闭失败', 'error');
      }
    }

    function mount() {
      if (mounted) return;
      mounted = true;
      on(elements.openBrowserBtn, 'click', openBrowserSession);
      on(elements.closeBrowserBtn, 'click', closeBrowserSession);
      on(elements.addProfileBtn, 'click', () => openProfileModal(null));
      actions.mount?.({ api, view });
    }

    function unmount() {
      if (!mounted) return;
      listeners.splice(0).forEach(([element, event, handler]) => element.removeEventListener(event, handler));
      mounted = false;
      actions.unmount?.();
    }

    function load() {
      return actions.load?.();
    }

    return {
      state,
      profileStore: state.profileStore,
      mount,
      unmount,
      load,
      renderBrowserControls,
      loadBrowserStatus,
      openBrowserSession,
      closeBrowserSession,
      renderProfileOptions,
      renderProfiles,
      loadProfiles,
      openProfileModal,
      editProfile,
      deleteProfile,
      fillTaskProxyFromSelectedProfile,
    };
  }

  global.BrowserResourcesController = { createState, create };
})(window);

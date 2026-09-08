(function exposeEnvironmentEditor(global) {
function looksLikeSecretName(name) {
  return /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|AUTH)/i.test(String(name || ''));
}

function parseEnvText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  if (raw.startsWith('{')) {
    const obj = parseParamsJson(raw);
    return Object.entries(obj).map(([name, value]) => ({
      name,
      value: value == null ? '' : String(value),
      is_secret: looksLikeSecretName(name) ? 1 : 0,
      has_value: true,
    }));
  }
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let name = trimmed.slice(0, eq).trim();
    if (name.startsWith('export ')) name = name.slice(7).trim();
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    rows.push({
      name,
      value,
      is_secret: looksLikeSecretName(name) ? 1 : 0,
      has_value: Boolean(value),
    });
  }
  return rows;
}

/**
 * GitHub-style env editor: list of variables + Add/Edit dialog (not cramped inline cells).
 * API compatible: setRows / addRow / collect / exportText / importText
 */
function createEnvEditor(container) {
  if (!container) {
    return {
      setRows() {},
      addRow() {},
      collect() { return []; },
      exportText() { return ''; },
      importText() {},
    };
  }

  /** @type {Array<{name:string,value:string,is_secret:number,has_value?:boolean,valueMasked?:string}>} */
  let items = [];

  function normalizeEntry(entry = {}) {
    const name = String(entry.name || '').trim();
    const isSecret = Boolean(entry.is_secret);
    const value = entry.value == null ? '' : String(entry.value);
    const hasValue = entry.has_value !== undefined
      ? Boolean(entry.has_value)
      : Boolean(value || entry.valueMasked);
    return {
      name,
      value: isSecret && !value ? '' : value,
      is_secret: isSecret ? 1 : 0,
      has_value: hasValue,
      valueMasked: entry.valueMasked || '',
    };
  }

  function previewValue(entry) {
    if (entry.is_secret) {
      if (entry.valueMasked) return entry.valueMasked;
      if (entry.has_value || entry.value) return '••••••••';
      return '（空）';
    }
    const v = String(entry.value || '');
    if (!v) return '（空）';
    const one = v.replace(/\s+/g, ' ').trim();
    return one.length > 72 ? `${one.slice(0, 72)}…` : one;
  }

  function renderList() {
    container.innerHTML = '';
    container.classList.add('env-editor');

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'env-list-empty muted';
      empty.textContent = '暂无变量。点击「添加变量」在弹窗中配置。';
      container.appendChild(empty);
      if (window.lucide) window.lucide.createIcons({ root: container });
      return;
    }

    const table = document.createElement('div');
    table.className = 'env-list';
    table.innerHTML = `
      <div class="env-list-head">
        <span>名称</span>
        <span>值</span>
        <span></span>
      </div>
    `;

    items.forEach((entry, index) => {
      const row = document.createElement('div');
      row.className = 'env-list-row';
      row.dataset.index = String(index);
      const badge = entry.is_secret
        ? '<span class="env-badge env-badge-secret">Secret</span>'
        : '<span class="env-badge env-badge-var">Variable</span>';
      row.innerHTML = `
        <div class="env-list-name">
          <code>${escapeHtml(entry.name)}</code>
          ${badge}
        </div>
        <div class="env-list-value muted" title="${escapeHtml(previewValue(entry))}">${escapeHtml(previewValue(entry))}</div>
        <div class="env-list-actions">
          <button type="button" class="alt env-edit-btn" data-index="${index}">编辑</button>
          <button type="button" class="icon-btn env-remove-btn" data-index="${index}" title="删除">
            <i data-lucide="trash-2" class="icon-sm"></i>
          </button>
        </div>
      `;
      table.appendChild(row);
    });

    container.appendChild(table);

    container.querySelectorAll('.env-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.getAttribute('data-index'));
        openEnvDialog(items[i], i);
      });
    });
    container.querySelectorAll('.env-remove-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.getAttribute('data-index'));
        const name = items[i]?.name || '';
        items.splice(i, 1);
        renderList();
        if (name) toast(`已移除 ${name}`, 'success');
      });
    });

    if (window.lucide) window.lucide.createIcons({ root: container });
  }

  function openEnvDialog(entry = null, editIndex = -1) {
    const isEdit = editIndex >= 0 && entry;
    const mask = document.createElement('div');
    mask.className = 'modal-mask open';
    mask.style.zIndex = '10050';
    const dialog = document.createElement('div');
    dialog.className = 'modal open env-var-dialog';
    dialog.style.cssText = 'z-index:10051; max-width:520px; width:min(520px,92vw);';
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>${isEdit ? '更新变量' : '添加变量'}</h2>
          <p class="muted" style="margin:4px 0 0;font-size:13px;">名称将作为环境变量注入脚本进程</p>
        </div>
        <button type="button" class="icon-btn env-dlg-close" aria-label="关闭">
          <i data-lucide="x" class="icon-md"></i>
        </button>
      </div>
      <div class="modal-body" style="padding-top:8px;">
        <form class="stack-form env-dlg-form">
          <div>
            <label class="field-label">名称</label>
            <input type="text" class="env-dlg-name" placeholder="例如 RENEW_URLS" spellcheck="false" autocomplete="off" ${isEdit ? 'readonly' : ''} />
          </div>
          <div>
            <label class="field-label">值</label>
            <textarea class="env-dlg-value" rows="8" placeholder="变量值（支持多行）" spellcheck="false"></textarea>
            <p class="schedule-note env-dlg-secret-hint" hidden style="margin-top:6px;">
              Secret：留空表示保留已保存的值；填写则更新。
            </p>
          </div>
          <label class="inline-check">
            <input type="checkbox" class="env-dlg-secret" />
            作为 Secret（保存后掩码显示）
          </label>
          <div class="row" style="margin-top:12px; gap:8px; justify-content:flex-end;">
            <button type="button" class="alt env-dlg-cancel">取消</button>
            <button type="submit" class="btn-primary">${isEdit ? '更新' : '添加'}</button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(mask);
    document.body.appendChild(dialog);
    if (window.lucide) window.lucide.createIcons({ root: dialog });

    const nameInput = dialog.querySelector('.env-dlg-name');
    const valueInput = dialog.querySelector('.env-dlg-value');
    const secretCb = dialog.querySelector('.env-dlg-secret');
    const secretHint = dialog.querySelector('.env-dlg-secret-hint');

    if (isEdit && entry) {
      nameInput.value = entry.name || '';
      secretCb.checked = Boolean(entry.is_secret);
      if (entry.is_secret) {
        valueInput.value = '';
        valueInput.placeholder = entry.valueMasked
          ? `已保存 ${entry.valueMasked}（留空不修改）`
          : (entry.has_value ? '已保存（留空不修改）' : 'Secret value');
        secretHint.hidden = false;
      } else {
        valueInput.value = entry.value || '';
      }
    }

    const syncSecretUi = () => {
      secretHint.hidden = !secretCb.checked;
      if (secretCb.checked && isEdit && entry?.is_secret && !valueInput.value) {
        valueInput.placeholder = entry.valueMasked
          ? `已保存 ${entry.valueMasked}（留空不修改）`
          : '已保存（留空不修改）';
      } else if (!secretCb.checked) {
        valueInput.placeholder = '变量值（支持多行）';
      }
    };
    secretCb.addEventListener('change', syncSecretUi);

    const close = () => {
      mask.remove();
      dialog.remove();
    };
    dialog.querySelector('.env-dlg-close').addEventListener('click', close);
    dialog.querySelector('.env-dlg-cancel').addEventListener('click', close);
    mask.addEventListener('click', close);

    dialog.querySelector('.env-dlg-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = String(nameInput.value || '').trim();
      if (!name) {
        toast('请填写变量名', 'warn');
        return;
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        toast(`变量名无效: ${name}（仅允许字母数字下划线）`, 'error');
        return;
      }
      const isSecret = Boolean(secretCb.checked);
      let value = String(valueInput.value ?? '');
      if (isEdit && isSecret && value === '' && entry) {
        // keep previous secret value
        value = entry.value || '';
      }
      const next = normalizeEntry({
        name,
        value,
        is_secret: isSecret ? 1 : 0,
        has_value: isSecret ? (Boolean(value) || entry?.has_value) : Boolean(value),
        valueMasked: isSecret ? (entry?.valueMasked || '') : '',
      });

      if (isEdit) {
        // name readonly on edit; replace in place
        items[editIndex] = next;
      } else {
        const exists = items.findIndex((x) => x.name === name);
        if (exists >= 0) {
          items[exists] = { ...items[exists], ...next, valueMasked: next.is_secret ? items[exists].valueMasked : '' };
          toast(`已更新已有变量 ${name}`, 'success');
        } else {
          items.push(next);
        }
      }
      renderList();
      close();
    });

    setTimeout(() => {
      if (isEdit) valueInput.focus();
      else nameInput.focus();
    }, 50);
  }

  function setRows(entries) {
    const list = Array.isArray(entries) ? entries : [];
    items = list
      .map(normalizeEntry)
      .filter((e) => e.name);
    renderList();
  }

  function addRow(entry = {}) {
    if (entry && entry.name) {
      openEnvDialog(normalizeEntry(entry), -1);
      // prefill after open — openEnvDialog with entry as new
      return;
    }
    openEnvDialog(null, -1);
  }

  function collect() {
    return items
      .filter((e) => e.name)
      .map((e) => {
        const isSecret = Boolean(e.is_secret);
        const value = e.value == null ? '' : String(e.value);
        // Secret values are blank in the form (masked server-side). Keep has_value so
        // re-sync / save does not drop EMAIL/PASSWORD-style secrets.
        const hasValue = isSecret
          ? Boolean(e.has_value || e.valueMasked || value)
          : Boolean(value);
        return {
          name: e.name,
          value,
          is_secret: isSecret ? 1 : 0,
          has_value: hasValue,
          valueMasked: e.valueMasked || '',
        };
      });
  }

  function exportText() {
    return collect()
      .map((e) => `${e.name}=${String(e.value).replace(/\n/g, '\\n')}`)
      .join('\n');
  }

  function importText(text) {
    const parsed = parseEnvText(text);
    if (!parsed.length) throw new Error('未解析到任何 KEY=value');
    const byName = new Map(items.map((e) => [e.name, e]));
    for (const item of parsed) {
      byName.set(item.name, normalizeEntry(item));
    }
    items = [...byName.values()];
    renderList();
  }

  setRows([]);
  return {
    setRows,
    /** Open add dialog (or merge named entry from templates without dialog). */
    addRow: (entry) => {
      if (entry && entry.name) {
        const n = normalizeEntry(entry);
        const exists = items.findIndex((x) => x.name === n.name);
        if (exists >= 0) {
          if (n.value && !items[exists].value) items[exists] = { ...items[exists], value: n.value, has_value: true };
        } else {
          items.push(n);
        }
        renderList();
        return;
      }
      openEnvDialog(null, -1);
    },
    collect,
    exportText,
    importText,
    el: container,
  };
}

  global.EnvironmentEditor = { createEnvEditor, parseEnvText, looksLikeSecretName };
})(window);

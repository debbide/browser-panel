async function send(command) {
  return chrome.runtime.sendMessage(command);
}

const ui = {
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  saveBtn: document.getElementById('saveBtn'),
  clearBtn: document.getElementById('clearBtn'),
  exportPwBtn: document.getElementById('exportPwBtn'),
  exportPyBtn: document.getElementById('exportPyBtn'),
  previewPwBtn: document.getElementById('previewPwBtn'),
  previewPyBtn: document.getElementById('previewPyBtn'),
  previewText: document.getElementById('previewText'),
  insertType: document.getElementById('insertType'),
  insertBtn: document.getElementById('insertBtn'),
  stateBadge: document.getElementById('stateBadge'),
  stateDot: document.getElementById('stateDot'),
  stepCount: document.getElementById('stepCount'),
  taskName: document.getElementById('taskName'),
  listCount: document.getElementById('listCount'),
  status: document.getElementById('status'),
  stepList: document.getElementById('stepList'),
  recordHoverToggle: document.getElementById('recordHoverToggle'),
  cleanHoverBtn: document.getElementById('cleanHoverBtn'),
  cleanSmartBtn: document.getElementById('cleanSmartBtn'),
  cleanWaitBtn: document.getElementById('cleanWaitBtn'),
  cleanUrlWaitBtn: document.getElementById('cleanUrlWaitBtn'),
};

let currentState = {
  recording: false,
  stepCount: 0,
  meta: null,
  steps: [],
  options: {
    record_hover: false,
  },
};

const collapsedGroups = new Set();

function shortText(value, maxLen = 80) {
  const text = String(value || '');
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function setStatus(text) {
  ui.status.textContent = text || '';
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function groupKey(step) {
  const g = String(step?.group || '').trim();
  return g || '__ungrouped__';
}

function groupLabel(group) {
  return group === '__ungrouped__' ? '未分组' : group;
}

function fieldText(step) {
  const parts = [];
  if (step.comment) parts.push(`备注=${step.comment}`);
  if (step.type === 'goto' && step.url) parts.push(`链接=${shortText(step.url, 60)}`);
  if (step.type === 'wait') {
    if (step.wait_for) parts.push(`等待=${step.wait_for}`);
    if (step.wait_for === 'timeout') parts.push(`毫秒=${step.ms ?? 0}`);
    if (step.wait_for === 'url_change' || step.wait_for === 'ready_state') parts.push(`超时=${step.timeout_ms ?? 10000}`);
    if (step.wait_for === 'selector') {
      parts.push(`选择器=${shortText(step.selector || '', 40)}`);
      parts.push(`超时=${step.timeout_ms ?? 10000}`);
      parts.push(`回退=${step.fallback_ms ?? 1200}`);
    }
    return parts.join(' | ');
  }
  if (step.type === 'scroll') parts.push(`x=${step.x ?? 0}, y=${step.y ?? 0}`);
  if (step.type === 'press') parts.push(`按键=${step.key || ''}`);
  if (step.type === 'screenshot') {
    parts.push(`文件=${step.name || ''}`);
    parts.push(`整页=${step.fullPage ? '是' : '否'}`);
  }
  if (step.value !== undefined && step.value !== '') parts.push(`值=${shortText(step.value, 60)}`);
  return parts.join(' | ');
}

function getEditFields(step) {
  const type = String(step?.type || '');
  const fields = [{ key: 'type', label: '类型', kind: 'select' }];
  fields.push({ key: 'group', label: '分组', kind: 'text' });
  fields.push({ key: 'comment', label: '备注', kind: 'text' });

  if (type === 'goto') fields.push({ key: 'url', label: '链接 URL', kind: 'text' });
  if (type === 'wait') {
    fields.push({ key: 'wait_for', label: '等待策略', kind: 'select-wait' });
    fields.push({ key: 'ms', label: '等待毫秒(ms)', kind: 'number' });
    fields.push({ key: 'timeout_ms', label: '超时(ms)', kind: 'number' });
    fields.push({ key: 'fallback_ms', label: '回退(ms)', kind: 'number' });
    fields.push({ key: 'selectorValue', label: '等待选择器', kind: 'text' });
  }

  if (!['scroll', 'wait', 'assert_url_contains', 'screenshot', 'goto'].includes(type)) {
    fields.push({ key: 'selectorValue', label: '选择器', kind: 'text' });
  }
  if (['input', 'select', 'assert_url_contains', 'assert_text'].includes(type)) {
    fields.push({ key: 'value', label: '值', kind: 'text' });
  }
  if (type === 'press') fields.push({ key: 'key', label: '按键', kind: 'text' });
  if (type === 'scroll') {
    fields.push({ key: 'x', label: '滚动 X', kind: 'number' });
    fields.push({ key: 'y', label: '滚动 Y', kind: 'number' });
  }
  if (type === 'screenshot') {
    fields.push({ key: 'name', label: '文件名', kind: 'text' });
    fields.push({ key: 'fullPage', label: '整页截图', kind: 'select-bool' });
  }
  fields.push({ key: 'enabled', label: '启用', kind: 'select-bool' });
  return fields;
}

function valueOfField(step, key) {
  if (key === 'selectorValue') return step?.selector || '';
  if (key === 'enabled') return step?.enabled !== false ? 'true' : 'false';
  if (key === 'fullPage') return step?.fullPage ? 'true' : 'false';
  if (key === 'wait_for') return step?.wait_for || 'timeout';
  if (step?.[key] === undefined || step?.[key] === null) return '';
  return step[key];
}

function renderTypeOptions(selected) {
  const types = [
    'goto',
    'click',
    'input',
    'wait',
    'scroll',
    'hover',
    'press',
    'select',
    'check',
    'uncheck',
    'assert_url_contains',
    'assert_text',
    'screenshot',
  ];
  return types.map((t) => `<option value="${t}" ${t === selected ? 'selected' : ''}>${t}</option>`).join('');
}

function renderEnabledOptions(selected) {
  return `
    <option value="true" ${selected === 'true' ? 'selected' : ''}>是</option>
    <option value="false" ${selected === 'false' ? 'selected' : ''}>否</option>
  `;
}

function renderWaitStrategyOptions(selected) {
  const items = [
    ['timeout', 'timeout'],
    ['url_change', 'url_change'],
    ['ready_state', 'ready_state'],
    ['selector', 'selector'],
  ];
  return items.map(([v, label]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function renderEditBox(step) {
  const fields = getEditFields(step);
  const body = fields.map((f) => {
    if (f.kind === 'select' && f.key === 'type') {
      return `
        <label class="muted">${f.label}</label>
        <select data-edit-field="${f.key}">${renderTypeOptions(String(valueOfField(step, f.key) || step.type || 'click'))}</select>
      `;
    }
    if (f.kind === 'select-bool') {
      return `
        <label class="muted">${f.label}</label>
        <select data-edit-field="${f.key}">${renderEnabledOptions(String(valueOfField(step, f.key)))}</select>
      `;
    }
    if (f.kind === 'select-wait' && f.key === 'wait_for') {
      return `
        <label class="muted">${f.label}</label>
        <select data-edit-field="${f.key}">${renderWaitStrategyOptions(String(valueOfField(step, f.key) || 'timeout'))}</select>
      `;
    }
    const value = htmlEscape(String(valueOfField(step, f.key)));
    const inputType = f.kind === 'number' ? 'number' : 'text';
    return `
      <label class="muted">${f.label}</label>
      <input data-edit-field="${f.key}" type="${inputType}" value="${value}">
    `;
  }).join('');

  return `
    <div class="edit-box" data-edit-box="${step.id}">
      ${body}
      <div class="edit-actions">
        <button class="mini btn-info" data-action="apply-edit" data-step-id="${step.id}">保存</button>
        <button class="mini btn-muted" data-action="close-edit" data-step-id="${step.id}">取消</button>
      </div>
    </div>
  `;
}

function renderStepItem(step, index) {
  const selector = shortText(step.selector || '', 70);
  const detail = shortText(fieldText(step), 90);
  const ts = step.ts ? step.ts.replace('T', ' ').replace('Z', '') : '';
  const editVisible = Boolean(step._editing);

  return `
    <div class="item ${step.enabled === false ? 'off' : ''}" data-step-id="${step.id}">
      <div class="item-head">
        <div class="t">#${index + 1} ${htmlEscape(step.type || 'unknown')}</div>
        <div class="muted mono">${htmlEscape(shortText(step.id || '', 18))}</div>
      </div>
      <div class="line mono">${htmlEscape(selector || '-')}</div>
      <div class="line">${htmlEscape(detail || '-')}</div>
      <div class="line">${htmlEscape(ts)}</div>
      <div class="toolbar">
        <button class="mini btn-muted" data-action="move-up" data-step-id="${step.id}">上移</button>
        <button class="mini btn-muted" data-action="move-down" data-step-id="${step.id}">下移</button>
        <button class="mini btn-info" data-action="toggle-edit" data-step-id="${step.id}">编辑</button>
        <button class="mini btn-info" data-action="toggle-enabled" data-step-id="${step.id}">${step.enabled === false ? '启用' : '禁用'}</button>
        <button class="mini btn-danger" data-action="delete-step" data-step-id="${step.id}">删除</button>
      </div>
      ${editVisible ? renderEditBox(step) : ''}
    </div>
  `;
}

function groupSteps(steps) {
  const map = new Map();
  for (const step of steps) {
    const key = groupKey(step);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(step);
  }
  return Array.from(map.entries());
}

function renderGroupSection(group, stepsInGroup, startIndex) {
  const collapsed = collapsedGroups.has(group);
  const enabledCount = stepsInGroup.filter((s) => s.enabled !== false).length;
  const label = groupLabel(group);
  const body = collapsed ? '' : stepsInGroup.map((step, idx) => renderStepItem(step, startIndex + idx)).join('');

  return `
    <div class="item">
      <div class="item-head">
        <div class="t">分组: ${htmlEscape(label)}</div>
        <div class="muted">${enabledCount}/${stepsInGroup.length} 已启用</div>
      </div>
      <div class="toolbar">
        <button class="mini btn-muted" data-action="group-toggle" data-group="${htmlEscape(group)}">${collapsed ? '展开' : '折叠'}</button>
        <button class="mini btn-info" data-action="group-enable" data-group="${htmlEscape(group)}">全部启用</button>
        <button class="mini btn-info" data-action="group-disable" data-group="${htmlEscape(group)}">全部禁用</button>
        <button class="mini btn-danger" data-action="group-delete" data-group="${htmlEscape(group)}">删除分组</button>
      </div>
      <div class="rename-row">
        <input
          data-group-target="${htmlEscape(group)}"
          placeholder="目标分组（留空=未分组）"
          value=""
        >
        <div class="toolbar" style="margin:0; justify-content:flex-end;">
          <button class="mini btn-muted" data-action="group-rename" data-group="${htmlEscape(group)}">重命名</button>
          <button class="mini btn-info" data-action="group-merge" data-group="${htmlEscape(group)}">合并</button>
        </div>
      </div>
      ${body}
    </div>
  `;
}

function renderSteps(stateSteps) {
  const steps = Array.isArray(stateSteps) ? stateSteps : [];
  ui.listCount.textContent = String(steps.length);
  if (!steps.length) {
    ui.stepList.innerHTML = '<div class="item"><div class="t">还没有步骤</div><div class="line">开始录制后在页面操作即可。</div></div>';
    return;
  }

  const grouped = groupSteps(steps);
  let cursor = 0;
  ui.stepList.innerHTML = grouped.map(([group, list]) => {
    const html = renderGroupSection(group, list, cursor);
    cursor += list.length;
    return html;
  }).join('');
}

function mergeEditingFlags(newSteps) {
  const editingIds = new Set((currentState.steps || []).filter((item) => item?._editing).map((item) => item.id));
  return (newSteps || []).map((step) => ({
    ...step,
    _editing: editingIds.has(step.id),
  }));
}

function updateStateBadge(recording) {
  ui.stateDot.className = recording ? 'dot ok' : 'dot warn';
  const text = recording ? '录制中' : '空闲';
  const nodes = Array.from(ui.stateBadge.childNodes);
  const textNode = nodes.find((node) => node.nodeType === Node.TEXT_NODE);
  if (textNode) {
    textNode.textContent = text;
  } else {
    ui.stateBadge.append(` ${text}`);
  }
}

function syncOptionsToUi() {
  ui.recordHoverToggle.checked = currentState.options.record_hover === true;
}

function renderState(payload) {
  const recording = Boolean(payload?.recording);
  const steps = Number(payload?.stepCount || 0);
  const taskName = payload?.meta?.name || '-';
  const nextSteps = mergeEditingFlags(payload?.steps || []);
  const options = payload?.options && typeof payload.options === 'object' ? payload.options : currentState.options;

  currentState = {
    recording,
    stepCount: steps,
    meta: payload?.meta || null,
    steps: nextSteps,
    options: {
      record_hover: options.record_hover === true,
    },
  };

  ui.stepCount.textContent = String(steps);
  ui.taskName.textContent = shortText(taskName, 24);
  updateStateBadge(recording);
  syncOptionsToUi();
  ui.startBtn.disabled = recording;
  ui.stopBtn.disabled = !recording;
  ui.saveBtn.disabled = steps <= 0;
  ui.exportPwBtn.disabled = steps <= 0;
  ui.exportPyBtn.disabled = steps <= 0;
  ui.previewPwBtn.disabled = steps <= 0;
  ui.previewPyBtn.disabled = steps <= 0;
  renderSteps(nextSteps);
}

async function refreshStatus() {
  const res = await send({ type: 'RECORDER_STATUS' });
  if (res?.ok) {
    renderState(res);
    setStatus(res.message || '已就绪');
  } else {
    setStatus(res?.message || '状态获取失败');
  }
}

async function action(command, fallbackText) {
  try {
    const res = await send(command);
    if (res?.ok) {
      if (res.steps || res.recentSteps || res.stepCount !== undefined) {
        renderState(res);
      } else {
        await refreshStatus();
      }
      setStatus(res.message || fallbackText);
    } else {
      setStatus(res?.message || `${fallbackText}失败`);
    }
  } catch (error) {
    setStatus(String(error?.message || error));
  }
}

function findStepById(stepId) {
  return (currentState.steps || []).find((item) => item.id === stepId) || null;
}

function toggleEdit(stepId, open) {
  currentState.steps = (currentState.steps || []).map((step) => ({
    ...step,
    _editing: step.id === stepId ? open : (step._editing && step.id !== stepId ? false : step._editing),
  }));
  renderSteps(currentState.steps);
}

function collectPatch(stepId) {
  const box = document.querySelector(`[data-edit-box="${CSS.escape(stepId)}"]`);
  if (!box) return null;
  const patch = {};
  const inputs = box.querySelectorAll('[data-edit-field]');
  for (const input of inputs) {
    const key = input.getAttribute('data-edit-field');
    if (!key) continue;
    if (key === 'enabled' || key === 'fullPage') {
      patch[key] = String(input.value) === 'true';
      continue;
    }
    if (input.type === 'number') {
      if (input.value === '') continue;
      patch[key] = Number(input.value);
    } else {
      patch[key] = input.value;
    }
  }
  return patch;
}

function getGroupTarget(group) {
  const input = document.querySelector(`[data-group-target="${CSS.escape(group)}"]`);
  if (!input) return '';
  return String(input.value || '').trim();
}

async function previewTarget(target) {
  try {
    const res = await send({ type: 'RECORDER_EXPORT_PREVIEW', target });
    if (!res?.ok) {
      setStatus(res?.message || `预览 ${target} 失败`);
      return;
    }
    renderState(res);
    ui.previewText.value = String(res.script || '');
    setStatus(res.message || `已生成 ${target} 预览`);
  } catch (error) {
    setStatus(String(error?.message || error));
  }
}

async function updateOptions(nextOptions, fallbackText) {
  await action({ type: 'RECORDER_SET_OPTIONS', options: nextOptions }, fallbackText);
}

async function runCleanup(targets, fallbackText) {
  await action({ type: 'RECORDER_CLEAN_STEPS', targets }, fallbackText);
}

function buildCleanupPreviewText(preview) {
  if (!preview || typeof preview !== 'object') return '预览不可用';
  const lines = [];
  lines.push('智能精简预览');
  lines.push(`规则: ${(preview.targets || []).join(', ') || '-'}`);
  lines.push(`步骤数: ${preview.total_before} -> ${preview.total_after} (减少 ${preview.removed})`);

  const summary = Array.isArray(preview.removed_summary) ? preview.removed_summary : [];
  if (summary.length) {
    lines.push('');
    lines.push('按类型统计:');
    for (const item of summary) {
      lines.push(`- ${item.type}: ${item.count}`);
    }
  }

  const details = Array.isArray(preview.removed_steps) ? preview.removed_steps : [];
  if (details.length) {
    lines.push('');
    lines.push('将移除步骤(前20条):');
    for (const item of details.slice(0, 20)) {
      const suffix = [];
      if (item.selector) suffix.push(`selector=${item.selector}`);
      if (item.wait_for) suffix.push(`wait_for=${item.wait_for}`);
      if (item.key) suffix.push(`key=${item.key}`);
      const extra = suffix.length ? ` | ${suffix.join(' | ')}` : '';
      lines.push(`#${item.index} ${item.type}${extra}`);
    }
    if (details.length > 20) {
      lines.push(`... 还有 ${details.length - 20} 条`);
    }
  }

  return lines.join('\n');
}

async function previewCleanup(targets) {
  const res = await send({ type: 'RECORDER_CLEAN_PREVIEW', targets });
  if (!res?.ok) {
    setStatus(res?.message || '精简预览失败');
    return null;
  }
  const text = buildCleanupPreviewText(res.preview);
  ui.previewText.value = text;
  return res.preview || null;
}

ui.startBtn.addEventListener('click', async () => action({ type: 'RECORDER_START' }, '开始录制'));
ui.stopBtn.addEventListener('click', async () => action({ type: 'RECORDER_STOP' }, '停止录制'));
ui.saveBtn.addEventListener('click', async () => action({ type: 'RECORDER_SAVE' }, '已保存'));
ui.clearBtn.addEventListener('click', async () => {
  ui.previewText.value = '';
  await action({ type: 'RECORDER_CLEAR' }, '已清空');
});
ui.exportPwBtn.addEventListener('click', async () => action({ type: 'RECORDER_EXPORT_SCRIPT', target: 'playwright' }, '已导出 Playwright'));
ui.exportPyBtn.addEventListener('click', async () => action({ type: 'RECORDER_EXPORT_SCRIPT', target: 'seleniumbase' }, '已导出 SeleniumBase'));
ui.previewPwBtn.addEventListener('click', async () => previewTarget('playwright'));
ui.previewPyBtn.addEventListener('click', async () => previewTarget('seleniumbase'));
ui.insertBtn.addEventListener('click', async () => {
  const stepType = String(ui.insertType.value || '').trim();
  await action({ type: 'RECORDER_STEP_INSERT', stepType }, `已插入 ${stepType}`);
});

ui.recordHoverToggle.addEventListener('change', async () => {
  await updateOptions({ record_hover: ui.recordHoverToggle.checked }, '录制选项已更新');
});

ui.cleanHoverBtn.addEventListener('click', async () => {
  await runCleanup(['hover'], '已清理 hover');
});

ui.cleanSmartBtn.addEventListener('click', async () => {
  try {
    const preview = await previewCleanup(['smart_compact']);
    if (!preview) return;
    if (!preview.removed) {
      setStatus('智能精简预览: 无可清理步骤');
      return;
    }
    const ok = window.confirm(`智能精简将移除 ${preview.removed} 条步骤，是否继续？`);
    if (!ok) {
      setStatus('已取消智能精简');
      return;
    }
    await runCleanup(['smart_compact'], '已执行智能精简');
  } catch (error) {
    setStatus(String(error?.message || error));
  }
});

ui.cleanWaitBtn.addEventListener('click', async () => {
  await runCleanup(['consecutive_wait'], '已清理重复等待');
});

ui.cleanUrlWaitBtn.addEventListener('click', async () => {
  await runCleanup(['url_change_wait'], '已清理 URL 等待');
});

ui.stepList.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const actionType = btn.getAttribute('data-action');
  const stepId = btn.getAttribute('data-step-id');
  const group = btn.getAttribute('data-group');

  if (actionType === 'group-toggle' && group !== null) {
    if (collapsedGroups.has(group)) collapsedGroups.delete(group);
    else collapsedGroups.add(group);
    renderSteps(currentState.steps);
    return;
  }
  if (actionType === 'group-enable' && group !== null) {
    await action({ type: 'RECORDER_GROUP_SET_ENABLED', group, enabled: true }, `分组 ${group} 全部启用`);
    return;
  }
  if (actionType === 'group-disable' && group !== null) {
    await action({ type: 'RECORDER_GROUP_SET_ENABLED', group, enabled: false }, `分组 ${group} 全部禁用`);
    return;
  }
  if (actionType === 'group-delete' && group !== null) {
    await action({ type: 'RECORDER_GROUP_DELETE', group }, `分组 ${group} 已删除`);
    return;
  }
  if (actionType === 'group-rename' && group !== null) {
    const toGroup = getGroupTarget(group);
    await action({ type: 'RECORDER_GROUP_RENAME', fromGroup: group, toGroup }, `分组 ${group} 已重命名`);
    return;
  }
  if (actionType === 'group-merge' && group !== null) {
    const toGroup = getGroupTarget(group);
    await action({ type: 'RECORDER_GROUP_MERGE', fromGroup: group, toGroup }, `分组 ${group} 已合并`);
    return;
  }

  if (!actionType || !stepId) return;
  if (actionType === 'move-up') return action({ type: 'RECORDER_STEP_MOVE', stepId, direction: 'up' }, '步骤已上移');
  if (actionType === 'move-down') return action({ type: 'RECORDER_STEP_MOVE', stepId, direction: 'down' }, '步骤已下移');
  if (actionType === 'delete-step') return action({ type: 'RECORDER_STEP_DELETE', stepId }, '步骤已删除');
  if (actionType === 'toggle-edit') {
    const step = findStepById(stepId);
    toggleEdit(stepId, !step?._editing);
    return;
  }
  if (actionType === 'close-edit') {
    toggleEdit(stepId, false);
    return;
  }
  if (actionType === 'apply-edit') {
    const patch = collectPatch(stepId);
    if (!patch) {
      setStatus('未找到编辑框');
      return;
    }
    await action({ type: 'RECORDER_STEP_UPDATE', stepId, patch }, '步骤已更新');
    return;
  }
  if (actionType === 'toggle-enabled') {
    const step = findStepById(stepId);
    const enabled = step?.enabled !== false;
    await action({ type: 'RECORDER_STEP_UPDATE', stepId, patch: { enabled: !enabled } }, enabled ? '步骤已禁用' : '步骤已启用');
  }
});

refreshStatus();

(function exposeTasksView(global) {
function taskCard(task, groupName = '', deps = {}) {
  const { taskIsRunning, latestRunSummary, profileStore, describeConditionValueFull, describeCondition, conditionStatusClass, describeConditionValue, describeNextRun, selectedBackupTaskIds, backupSelectionMode, escapeHtml } = deps;
  const isRunning = taskIsRunning(task);
  const latest = latestRunSummary(task.id, task);
  const isPersistent = Boolean(Number(task.use_persistent));
  const profileName = (() => {
    if (!task.browser_profile_id) return isPersistent ? '默认配置' : '每次全新';
    const p = profileStore.find(task.browser_profile_id);
    return p ? p.name : `#${task.browser_profile_id}`;
  })();
  const profileMode = isPersistent ? '持久' : '临时';
  const profileTitle = isPersistent
    ? `持久浏览器配置 · ${profileName}`
    : `临时（跑完删除）· ${profileName}`;
  const scheduleOn = Boolean(Number(task.enabled));
  const conditionOn = Boolean(Number(task.condition_enabled));
  const scheduleModeLabel = task.schedule_mode === 'daily_window'
    ? '每天时段'
    : (task.schedule_mode === 'interval' ? '随机区间' : '固定周期');
  // Schedule / HTTP / remaining-callback are treated as one "trigger" slot (mutually exclusive UI).
  // Prefer condition when enabled; otherwise show schedule. Never side-by-side.
  let triggerMetric = '';
  if (conditionOn) {
    triggerMetric = `<div class="metric-card metric-condition" title="${escapeHtml(describeConditionValueFull(task) || describeCondition(task) || '')}">
          <span class="metric-label">条件</span>
          <div class="status-indicator">
            <span class="dot ${conditionStatusClass(task)}"></span>
            <span>${escapeHtml(describeCondition(task) || '已启用')}</span>
          </div>
          <span class="metric-value">${escapeHtml(describeConditionValue(task))}</span>
        </div>`;
  } else if (scheduleOn) {
    triggerMetric = `<div class="metric-card metric-schedule" title="${escapeHtml(describeNextRun(task) || '')}">
          <span class="metric-label">定时</span>
          <div class="status-indicator">
            <span class="dot active"></span>
            <span>${escapeHtml(scheduleModeLabel)}</span>
          </div>
          <span class="metric-value">${escapeHtml(describeNextRun(task))}</span>
        </div>`;
  }
  const backupSelected = selectedBackupTaskIds.has(Number(task.id));
  const backupClass = backupSelectionMode
    ? ` backup-selectable${backupSelected ? ' backup-selected' : ''}`
    : '';
  return `
    <article class="task-card ${isRunning ? 'task-running' : ''}${backupClass}" data-testid="task-card" data-task-id="${task.id}" ${backupSelectionMode ? `onclick="toggleBackupTask(${task.id}, event)"` : ''}>
      ${backupSelectionMode ? `<input class="backup-task-check" type="checkbox" ${backupSelected ? 'checked' : ''} aria-label="选择任务 ${escapeHtml(task.name)}" />` : ''}
      <div class="task-card-top">
        <div class="task-card-head-main">
          <div class="task-title-row">
            <h3 title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</h3>
            <span class="pill pill-type">${escapeHtml(task.type)}</span>
            ${isRunning ? '<span class="pill pill-running">运行中</span>' : ''}
          </div>
          <div class="task-profile-slot" title="${escapeHtml(profileTitle)}">
            <span class="pill ${isPersistent ? 'pill-persistent' : 'pill-temp'} task-profile-pill">
              ${escapeHtml(profileMode)} · ${escapeHtml(profileName)}
            </span>
            ${groupName ? `<span class="pill pill-group task-group-pill" title="分组：${escapeHtml(groupName)}">${escapeHtml(groupName)}</span>` : ''}
          </div>
        </div>
        <div class="task-overflow" data-task-action-area>
          <button type="button" class="icon-btn task-overflow-trigger" data-task-overflow-trigger aria-expanded="false" aria-controls="task-overflow-${task.id}" aria-label="打开 ${escapeHtml(task.name)} 的更多操作" ${backupSelectionMode ? 'disabled' : ''}>
            <i data-lucide="ellipsis" class="icon-sm"></i>
          </button>
          <div id="task-overflow-${task.id}" class="task-overflow-panel" data-task-overflow-panel hidden>
            <button type="button" class="task-overflow-item" onclick="editTask(${task.id})" ${isRunning ? 'disabled' : ''} data-testid="edit-task-btn">
              <i data-lucide="pencil" class="icon-sm"></i> 编辑
            </button>
            <button type="button" class="task-overflow-item" onclick="showTaskRuns(${task.id})">
              <i data-lucide="history" class="icon-sm"></i> 记录
            </button>
            <button type="button" class="task-overflow-item task-overflow-danger" onclick="deleteTask(${task.id})" ${isRunning ? 'disabled' : ''} data-testid="delete-task-btn">
              <i data-lucide="trash-2" class="icon-sm"></i> 删除
            </button>
          </div>
        </div>
      </div>
      <div class="task-metrics">
        <div class="metric-card ${latest.className}" title="${escapeHtml(latest.detail || '')}">
          <span class="metric-label">最新结果</span>
          <div class="status-indicator">
            <span class="dot ${latest.className}"></span>
            <span data-testid="task-status">${escapeHtml(latest.status)}</span>
          </div>
          <span class="metric-value">${escapeHtml(latest.detail)}</span>
        </div>
        ${triggerMetric}
      </div>
      <div class="task-actions" data-task-action-area>
        ${isRunning
          ? `<button class="task-primary-action task-stop-action" onclick="stopTask(${task.id})" ${backupSelectionMode ? 'disabled' : ''} data-testid="stop-task-btn"><i data-lucide="square" class="icon-sm"></i> 停止</button>`
          : `<button class="task-primary-action" onclick="runTask(${task.id})" ${backupSelectionMode ? 'disabled' : ''} data-testid="run-task-btn"><i data-lucide="play" class="icon-sm"></i> 启动</button>`}
      </div>
    </article>`;
}


function renderTaskGroups(deps = {}) {
  const { taskGroupsCache, taskGroupFilter, tasksCache, taskIsRunning, taskCard, escapeHtml } = deps;
  const groupOf = new Map();
  for (const group of taskGroupsCache) groupOf.set(Number(group.id), group);
  // 分组被删掉（或分组还没加载完）时旧的筛选键会失效，本次渲染按"全部"处理。
  // 只算局部值、不回写 taskGroupFilter：加载时序导致的空缓存不应该抹掉用户的选择。
  let active = taskGroupFilter;
  if (active !== 'all' && active !== 'ungrouped'
    && !groupOf.has(Number(String(active).replace('group:', '')))) {
    active = 'all';
  }
  const ungrouped = tasksCache.filter((task) => !task.group_id);
  const chips = [`<button type="button" class="task-group-chip${active === 'all' ? ' is-active' : ''}" onclick="selectTaskGroup('all')" aria-pressed="${active === 'all'}">全部 <span>${tasksCache.length}</span></button>`];
  for (const group of taskGroupsCache) {
    const key = `group:${group.id}`;
    const tasks = tasksCache.filter((task) => Number(task.group_id) === Number(group.id));
    const running = tasks.filter(taskIsRunning).length;
    chips.push(`<button type="button" class="task-group-chip${active === key ? ' is-active' : ''}" onclick="selectTaskGroup('${key}')" aria-pressed="${active === key}" title="${escapeHtml(group.name)}：${tasks.length} 个任务，运行 ${running}">${escapeHtml(group.name)} <span>${tasks.length}</span>${running ? '<span class="task-group-dot"></span>' : ''}</button>`);
  }
  if (ungrouped.length) {
    chips.push(`<button type="button" class="task-group-chip${active === 'ungrouped' ? ' is-active' : ''}" onclick="selectTaskGroup('ungrouped')" aria-pressed="${active === 'ungrouped'}">未分组 <span>${ungrouped.length}</span></button>`);
  }
  let visible = tasksCache;
  if (active === 'ungrouped') visible = ungrouped;
  else if (active !== 'all') {
    const id = Number(String(active).replace('group:', ''));
    visible = tasksCache.filter((task) => Number(task.group_id) === id);
  }
  // 只有存在用户分组时才占用筛选栏那一行高度。
  const bar = taskGroupsCache.length
    ? `<div class="task-group-bar" role="group" aria-label="任务分组筛选">${chips.join('')}</div>`
    : '';
  // "全部"视图下给卡片补一个所属分组角标，否则混在一起看不出归属。
  const showBadge = active === 'all' && taskGroupsCache.length > 0;
  const cards = visible.map((task) => {
    const group = showBadge ? groupOf.get(Number(task.group_id)) : null;
    return taskCard(task, group ? group.name : '');
  }).join('');
  const empty = active === 'all'
    ? '<p class="empty">当前还没有任务。</p>'
    : '<p class="empty">当前分组没有任务。</p>';
  return `${bar}<div class="task-grid">${cards || empty}</div>`;
}

let lastTasksHtml = null;

  global.TasksView = { taskCard, renderTaskGroups };
})(window);

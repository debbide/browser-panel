(function initRunPresentation(global) {
  const errorCodeLabels = {
    timeout: '超时',
    permission_error: '权限错误',
    script_error: '脚本错误',
    browser_task_error: '浏览器任务错误',
    browser_launch_error: '浏览器启动错误',
    missing_result: '缺少结果文件',
    already_running: '任务已在运行',
    stopped: '已停止',
    browser_already_open: '浏览器已手动打开',
  };

  function prettyErrorCode(code) {
    return errorCodeLabels[code] || code || '';
  }

  function formatBytes(size) {
    const bytes = Number(size) || 0;
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  function logLineClass(line) {
    if (/(ERROR|FAIL|失败|异常)/i.test(line)) return 'is-error';
    if (/(WARN|警告)/i.test(line)) return 'is-warn';
    if (/(SUCCESS|成功|完成)/i.test(line)) return 'is-success';
    return '';
  }

  function classifyShotKind(name) {
    const lower = String(name || '').toLowerCase().replace(/\\/g, '/');
    if (lower.includes('yolo_hard/miss/') || /(^|\/)miss\//.test(lower)) return '漏选/未认出';
    if (lower.includes('yolo_hard/wrong/') || /(^|\/)wrong\//.test(lower)) return '认错类';
    if (lower.includes('yolo_hard/grids/')) return '难例整表';
    if (lower.includes('yolo_hard/')) return '难例';
    if (lower.includes('yolo_tile')) return '格子(全量)';
    if (lower.startsWith('instr_')) return '题目';
    if (lower.includes('_grid.png') || lower.includes('yolo_grid')) return '整表';
    if (lower.startsWith('table_')) return '题图';
    if (lower.includes('success') || lower.includes('fail') || lower.includes('host2play')) return '结果';
    return '截图';
  }

  function indexLatestRunsByTask(runs) {
    const latestByTask = new Map();
    for (const run of runs || []) {
      if (!latestByTask.has(run.task_id)) latestByTask.set(run.task_id, run);
    }
    return latestByTask;
  }

  global.RunPresentation = { classifyShotKind, formatBytes, indexLatestRunsByTask, logLineClass, prettyErrorCode };
}(window));

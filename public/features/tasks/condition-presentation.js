(function exposeTaskConditionPresentation(global) {
  function formatRemainingSec(sec) {
    const seconds = Math.floor(Number(sec));
    if (!Number.isFinite(seconds)) return '—';
    const absoluteSeconds = Math.abs(seconds);
    const sign = seconds < 0 ? '-' : '';
    if (absoluteSeconds < 60) return `${sign}${absoluteSeconds}s`;
    if (absoluteSeconds < 3600) return `${sign}${Math.floor(absoluteSeconds / 60)}m`;
    if (absoluteSeconds < 86400) {
      const hours = Math.floor(absoluteSeconds / 3600);
      const minutes = Math.floor((absoluteSeconds % 3600) / 60);
      return minutes ? `${sign}${hours}h${minutes}m` : `${sign}${hours}h`;
    }
    const days = Math.floor(absoluteSeconds / 86400);
    const hours = Math.floor((absoluteSeconds % 86400) / 3600);
    return hours ? `${sign}${days}d${hours}h` : `${sign}${days}d`;
  }

  function estimateRemainingSec(task) {
    const remainingSec = Number(task.callback_remaining_sec);
    const reportedAt = task.callback_reported_at ? new Date(task.callback_reported_at).getTime() : NaN;
    if (!Number.isFinite(reportedAt)) return remainingSec;
    return remainingSec - (Date.now() - reportedAt) / 1000;
  }

  function describeCondition(task) {
    if (!task || !Number(task.condition_enabled)) return '';
    const condition = task.condition || {};
    if (condition.type === 'remaining_callback') return '剩余时间回调';
    if (condition.type === 'http_check') return 'HTTP 检测';
    return condition.type || '条件';
  }

  function conditionStatusClass(task) {
    if (task && task.condition?.type === 'remaining_callback' && task.callback_remaining_sec != null && task.callback_remaining_sec !== '') {
      return 'active';
    }
    const status = task && task.condition_last_status;
    if (status === 'ok' || status === 'waiting' || status === 'due') return 'active';
    if (status === 'fail' || status === 'error' || status === 'expired') return 'failed';
    return 'idle';
  }

  function describeConditionValue(task) {
    if (!task || !Number(task.condition_enabled)) return '—';
    const condition = task.condition || {};
    if (condition.type === 'remaining_callback') {
      if (task.callback_trigger_at) return `下次触发 ${global.shortTime(task.callback_trigger_at)}`;
      if (task.callback_remaining_sec == null || task.callback_remaining_sec === '') return '等待上报';
      return `现余约 ${formatRemainingSec(estimateRemainingSec(task))}`;
    }
    if (task.condition_last_status === 'ok' || task.condition_last_status === 'fail' || task.condition_last_status === 'error') {
      if (task.condition_next_check_at) return `${task.condition_last_status} · 下次 ${global.shortTime(task.condition_next_check_at)}`;
      return String(task.condition_last_status);
    }
    if (task.condition_next_check_at) return `下次检测 ${global.shortTime(task.condition_next_check_at)}`;
    return '等待检测';
  }

  function describeConditionValueFull(task) {
    if (!task || !Number(task.condition_enabled)) return '';
    const condition = task.condition || {};
    if (condition.type === 'remaining_callback') {
      if (task.callback_remaining_sec == null || task.callback_remaining_sec === '') {
        return '等待脚本上报 remaining_sec（请先手动探测）';
      }
      const parts = [
        `估算剩余 ${formatRemainingSec(estimateRemainingSec(task))}`,
        `上报剩余 ${formatRemainingSec(task.callback_remaining_sec)}`,
      ];
      if (task.callback_valid_until) parts.push(`Valid until ${task.callback_valid_until}`);
      if (task.callback_trigger_at) parts.push(`预计触发 ${global.shortTime(task.callback_trigger_at)}`);
      if (task.callback_threshold_sec != null) parts.push(`阈值 ${formatRemainingSec(task.callback_threshold_sec)}`);
      if (task.callback_action) parts.push(`action=${task.callback_action}`);
      if (task.condition_next_check_at) parts.push(`下次检查 ${global.shortTime(task.condition_next_check_at)}`);
      return parts.join(' · ');
    }
    if (task.condition_last_status) {
      return `${task.condition_last_status}${task.condition_last_detail ? ` · ${task.condition_last_detail}` : ''}`;
    }
    if (task.condition_next_check_at) return `下次检测 ${global.shortTime(task.condition_next_check_at)}`;
    return '等待检测';
  }

  global.TaskConditionPresentation = {
    conditionStatusClass,
    describeCondition,
    describeConditionValue,
    describeConditionValueFull,
    formatRemainingSec,
  };
})(window);

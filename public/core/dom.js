(function exposeDomUtilities(global) {
  function escapeHtml(input) {
    return String(input ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function prettyStatus(status) {
    if (status === 'success') return '成功';
    if (status === 'failed') return '失败';
    if (status === 'running') return '运行中';
    if (status === 'stopped') return '已停止';
    return status || '-';
  }

  function prettyUnit(unit) {
    if (unit === 'minutes') return '分钟';
    if (unit === 'days') return '天';
    return '小时';
  }

  function shortTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (isNaN(date.getTime())) return String(value).replace('T', ' ').slice(0, 19);
    const pad = number => number.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  Object.assign(global, { escapeHtml, prettyStatus, prettyUnit, shortTime });
})(window);

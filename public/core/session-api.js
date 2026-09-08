(function initSessionApi(global) {
  let redirectingToLogin = false;

  function goLogin() {
    if (redirectingToLogin) return;
    redirectingToLogin = true;
    const next = global.location.pathname + global.location.search;
    const suffix = next && next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
    global.location.replace(`/login.html${suffix}`);
  }

  async function fetchJson(url, options) {
    const response = await global.fetch(url, options);
    if (response.status === 401) {
      goLogin();
      throw new Error('会话已失效，正在跳转登录页');
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      const looksLikeHtml = /^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text);
      if (looksLikeHtml) {
        throw new Error(`接口 ${url} 返回了页面内容，后端路由可能异常`);
      }
      throw new Error(`接口 ${url} 返回了非 JSON 响应`);
    }

    const data = await response.json();
    if (!response.ok) {
      const message = String(data.message || '请求失败');
      const output = data.output ? `\n${String(data.output).slice(-1200)}` : '';
      throw new Error(`${message}${output}`);
    }
    return data;
  }

  global.SessionApi = { fetchJson, goLogin };
  global.fetchJson = fetchJson;
}(window));

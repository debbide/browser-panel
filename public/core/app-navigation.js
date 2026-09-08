(function initAppNavigation(global) {
  const tabMeta = {
    'tasks-tab': ['Dashboard', '管理任务、运行状态与手动浏览器。'],
    'profiles-tab': ['Browser Profiles', '维护独立的浏览器数据与代理配置。'],
    'scripts-tab': ['Script Management', '管理任务脚本、目录与上传文件。'],
    'extensions-tab': ['插件管理', '上传、解压和管理浏览器插件目录。'],
    'profile-files-tab': ['用户目录', '管理浏览器用户数据目录与压缩包。'],
    'warp-tab': ['Cloudflare WARP', '管理 WARP 连接与双栈出口。'],
    'notifications-tab': ['TG Notifications', '配置 Telegram 通知与测试消息。'],
    'config-tab': ['Global Settings', '查找并调整面板级运行设置。'],
  };

  function create({ closeTaskOverflow, loadFileBrowser, loadBrowserResource, loadWarpStatus }) {
    const tabBtns = Array.from(global.document.querySelectorAll('.tab-btn'));
    const tabContents = Array.from(global.document.querySelectorAll('.tab-content'));
    const appShell = global.document.getElementById('app-shell');
    const appSidebar = global.document.getElementById('app-sidebar');
    const appNavToggle = global.document.getElementById('app-nav-toggle');
    const appNavMask = global.document.getElementById('app-nav-mask');
    const workspaceTitle = global.document.getElementById('workspace-title');
    const workspaceSubtitle = global.document.getElementById('workspace-subtitle');
    const workspaceHeaderActions = Array.from(global.document.querySelectorAll('[data-header-actions-for]'));
    const mobileNavQuery = global.matchMedia('(max-width: 900px)');

    function syncSidebarAccessibility() {
      if (!appSidebar) return;
      const drawerOpen = appShell?.classList.contains('is-nav-open');
      appSidebar.inert = mobileNavQuery.matches && !drawerOpen;
      appSidebar.setAttribute('aria-hidden', mobileNavQuery.matches && !drawerOpen ? 'true' : 'false');
    }

    function close({ restoreFocus = false } = {}) {
      if (!appShell || !appNavToggle || !appNavMask) return;
      appShell.classList.remove('is-nav-open');
      global.document.body.classList.remove('app-nav-open');
      appNavMask.hidden = true;
      appNavToggle.setAttribute('aria-expanded', 'false');
      appNavToggle.setAttribute('aria-label', '打开主导航');
      syncSidebarAccessibility();
      if (restoreFocus) appNavToggle.focus();
    }

    function open() {
      if (!appShell || !appNavToggle || !appNavMask) return;
      appShell.classList.add('is-nav-open');
      global.document.body.classList.add('app-nav-open');
      appNavMask.hidden = false;
      appNavToggle.setAttribute('aria-expanded', 'true');
      appNavToggle.setAttribute('aria-label', '关闭主导航');
      syncSidebarAccessibility();
      const selected = tabBtns.find((btn) => btn.getAttribute('aria-selected') === 'true');
      global.requestAnimationFrame(() => selected?.focus());
    }

    function activate(targetId, { focus = false } = {}) {
      const btn = tabBtns.find((item) => item.getAttribute('data-tab') === targetId);
      const panel = global.document.getElementById(targetId);
      if (!btn || !panel) return;

      tabBtns.forEach((item) => {
        const selected = item === btn;
        item.classList.toggle('active', selected);
        item.setAttribute('aria-selected', selected ? 'true' : 'false');
        item.tabIndex = selected ? 0 : -1;
      });
      tabContents.forEach((content) => {
        const selected = content === panel;
        content.classList.toggle('active', selected);
        content.hidden = !selected;
        content.setAttribute('aria-hidden', selected ? 'false' : 'true');
      });
      workspaceHeaderActions.forEach((actions) => {
        actions.hidden = actions.getAttribute('data-header-actions-for') !== targetId;
      });
      closeTaskOverflow();

      const meta = tabMeta[targetId] || ['', ''];
      if (workspaceTitle) workspaceTitle.textContent = meta[0];
      if (workspaceSubtitle) workspaceSubtitle.textContent = meta[1];
      close();
      if (focus) btn.focus();

      if (targetId === 'scripts-tab') loadFileBrowser();
      if (targetId === 'extensions-tab') loadBrowserResource('extensions');
      if (targetId === 'profile-files-tab') loadBrowserResource('profiles');
      if (targetId === 'warp-tab') loadWarpStatus();
      if (targetId === 'config-tab' && typeof global.__onConfigTabShow === 'function') global.__onConfigTabShow();
    }

    tabBtns.forEach((btn, index) => {
      btn.addEventListener('click', () => activate(btn.getAttribute('data-tab')));
      btn.addEventListener('keydown', (event) => {
        let nextIndex = null;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % tabBtns.length;
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + tabBtns.length) % tabBtns.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabBtns.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        activate(tabBtns[nextIndex].getAttribute('data-tab'), { focus: true });
      });
    });

    appNavToggle?.addEventListener('click', () => {
      if (appShell?.classList.contains('is-nav-open')) close({ restoreFocus: true });
      else open();
    });
    appNavMask?.addEventListener('click', () => close({ restoreFocus: true }));
    mobileNavQuery.addEventListener('change', () => close());
    syncSidebarAccessibility();
    global.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && appShell?.classList.contains('is-nav-open')) close({ restoreFocus: true });
    });

    return { activate, close, open };
  }

  global.AppNavigation = { create };
}(window));

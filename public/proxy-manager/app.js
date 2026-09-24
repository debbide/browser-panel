const { createApp } = Vue;

// ---------------------------------------------------------------------------
// 本文件来自 E:\ck\ProxyManager\frontend\app.js，代理节点的增删改查/测速/启停
// 逻辑保持原样，仅做嵌入面板所需的适配：
//   1. 去掉独立登录：面板已有自己的会话鉴权，token 用固定哨兵值跳过登录页；
//   2. request() 统一改写路径到 /api/proxy-manager 前缀，并携带面板会话 Cookie；
//   3. 去掉自带版本检查与自更新（面板统一更新），相关 UI 已移除；
//   4. 新增「上游白名单」设置块（SSRF 防护），读/写 /api/proxy-manager/settings/upstream-allowlist。
// 挂载点从原来的 #app 改为面板标签内的 #proxy-manager-app。
// ---------------------------------------------------------------------------

createApp({
  data() {
    return {
      proxyHost: '127.0.0.1',
      token: 'panel-session',
      proxies: [],
      form: { input: '' },
      addModalOpen: false,
      listLoading: false,
      addLoading: false,
      deleteLoading: false,
      testing: {},
      toggling: {},
      results: {},
      editingName: null,
      nameDraft: '',
      savingName: {},
      deleteTarget: null,
      notices: []
    };
  },
  computed: {
    runningCount() {
      return this.proxies.filter((proxy) => proxy.is_running).length;
    }
  },
  mounted() {
    this.loadProxies();
    this.loadAllowlist();
  },
  methods: {
    async request(path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (options.body) headers['Content-Type'] = 'application/json';
      // 原项目调用形如 '/api/proxies'，这里统一改写到面板挂载前缀下。
      const url = `/api/proxy-manager${path.replace(/^\/api/, '')}`;
      const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
      if (response.status === 204) return null;
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
      return payload;
    },
    async loadProxies() {
      this.listLoading = true;
      try {
        this.proxies = await this.request('/api/proxies');
      } catch (error) {
        this.notify(error.message, 'error');
      } finally {
        this.listLoading = false;
      }
    },
    openAddModal() {
      this.addModalOpen = true;
      this.$nextTick(() => this.$refs.proxyInput?.focus());
    },
    closeAddModal() {
      if (this.addLoading) return;
      this.addModalOpen = false;
      this.form.input = '';
    },
    async addProxy() {
      this.addLoading = true;
      try {
        const proxy = await this.request('/api/proxies', { method: 'POST', body: JSON.stringify({ input: this.form.input }) });
        this.proxies.unshift(proxy);
        this.form.input = '';
        this.addModalOpen = false;
        this.notify(`节点已添加，本地端口为 ${proxy.local_port}`, 'success');
      } catch (error) {
        this.notify(error.message, 'error');
      } finally {
        this.addLoading = false;
      }
    },
    busy(id) {
      return Boolean(this.testing[id] || this.toggling[id] || this.savingName[id] || (this.deleteLoading && this.deleteTarget?.id === id));
    },
    startEditName(proxy) {
      this.editingName = proxy.id;
      this.nameDraft = proxy.name;
      this.$nextTick(() => document.querySelector('.name-edit-form input')?.focus());
    },
    cancelEditName() {
      this.editingName = null;
      this.nameDraft = '';
    },
    async saveName(proxy) {
      const name = this.nameDraft.trim();
      if (!name || name === proxy.name) {
        this.cancelEditName();
        return;
      }
      this.savingName = { ...this.savingName, [proxy.id]: true };
      try {
        const updated = await this.request(`/api/proxies/${proxy.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name })
        });
        this.proxies = this.proxies.map((item) => item.id === proxy.id ? updated : item);
        this.cancelEditName();
        this.notify('节点名称已更新', 'success');
      } catch (error) {
        this.notify(error.message, 'error');
      } finally {
        this.savingName = { ...this.savingName, [proxy.id]: false };
      }
    },
    async testProxy(proxy) {
      this.testing = { ...this.testing, [proxy.id]: true };
      try {
        const result = await this.request('/api/test-proxy', { method: 'POST', body: JSON.stringify({ id: proxy.id }) });
        this.results = { ...this.results, [proxy.id]: result };
        this.notify(`${proxy.name} 测速成功`, 'success');
      } catch (error) {
        this.notify(`${proxy.name}: ${error.message}`, 'error');
      } finally {
        this.testing = { ...this.testing, [proxy.id]: false };
      }
    },
    async toggleProxy(proxy) {
      this.toggling = { ...this.toggling, [proxy.id]: true };
      try {
        const updated = await this.request('/api/toggle-port', { method: 'POST', body: JSON.stringify({ id: proxy.id }) });
        this.proxies = this.proxies.map((item) => item.id === proxy.id ? updated : item);
        this.notify(`${proxy.name} 已${updated.is_running ? '启动' : '停止'}`, 'success');
      } catch (error) {
        this.notify(`${proxy.name}: ${error.message}`, 'error');
      } finally {
        this.toggling = { ...this.toggling, [proxy.id]: false };
      }
    },
    askDelete(proxy) {
      this.deleteTarget = proxy;
    },
    async deleteProxy() {
      if (!this.deleteTarget) return;
      const target = this.deleteTarget;
      this.deleteLoading = true;
      try {
        await this.request(`/api/proxies/${target.id}`, { method: 'DELETE' });
        this.proxies = this.proxies.filter((proxy) => proxy.id !== target.id);
        this.deleteTarget = null;
        this.notify(`${target.name} 已删除`, 'success');
      } catch (error) {
        this.notify(error.message, 'error');
      } finally {
        this.deleteLoading = false;
      }
    },
    async loadAllowlist() {
      this.allowlistLoading = true;
      try {
        const payload = await this.request('/api/settings/upstream-allowlist');
        this.allowlist = (payload && payload.allowlist) || '';
      } catch (error) {
        this.notify(`上游白名单加载失败：${error.message}`, 'error');
      } finally {
        this.allowlistLoading = false;
      }
    },
    async saveAllowlist() {
      this.allowlistSaving = true;
      try {
        const payload = await this.request('/api/settings/upstream-allowlist', {
          method: 'PUT',
          body: JSON.stringify({ allowlist: this.allowlist })
        });
        this.allowlist = (payload && payload.allowlist) || '';
        this.notify('上游白名单已保存，立即生效', 'success');
      } catch (error) {
        this.notify(`上游白名单保存失败：${error.message}`, 'error');
      } finally {
        this.allowlistSaving = false;
      }
    },
    notify(message, type = 'info') {
      const id = `${Date.now()}-${Math.random()}`;
      this.notices.push({ id, message, type });
      window.setTimeout(() => { this.notices = this.notices.filter((notice) => notice.id !== id); }, 3600);
    }
  }
}).mount('#proxy-manager-app');

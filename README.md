# Browser Automation Panel

Node.js 面板：导入脚本、定时调度、浏览器任务（Playwright / DrissionPage 等），支持类似 GitHub 的 **变量 / 密钥** 注入。

- 默认端口：`3210`
- 业务脚本放 `tasks/`（**不进 git**，更新也不会覆盖）
- 配置（代理、浏览器目录、环境变量）在 **面板里** 完成

更细的说明见 [DEPLOY.md](DEPLOY.md)。

---

## 一键安装（推荐）

> 需要：`curl` `tar` `bash`，以及 **Node.js ≥ 18**、**python3**。  
> 浏览器 / 显示（Chromium、Xvfb 等）自行准备。

### 首次安装到固定目录

```bash
# 目录自己定死，以后一直用这个路径
mkdir -p /opt/browser-panel
cd /opt/browser-panel

curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install-from-release.sh | bash
```

指定目录 / 版本 / 可选依赖：

```bash
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install-from-release.sh | bash -s -- --dir /opt/browser-panel

# 安装 SeleniumBase（偏 x86）或 Playwright
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install-from-release.sh | bash -s -- --dir /opt/browser-panel --sb
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install-from-release.sh | bash -s -- --dir /opt/browser-panel --playwright

# 指定 Release 标签
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install-from-release.sh | bash -s -- --dir /opt/browser-panel --tag v1.0.0
```

启动：

```bash
cd /opt/browser-panel
node server/index.js
# 浏览器打开 http://服务器IP:3210
```

可选环境变量（也可用面板配置）：

```bash
export PORT=3210
export BROWSER_CHROME_PATH=/usr/bin/chromium-browser
export BROWSER_USER=browser
export BROWSER_DISPLAY=:1.0
export BROWSER_PROXY=socks5://127.0.0.1:1080
```

---

## 一键更新（不覆盖脚本和数据）

```bash
cd /opt/browser-panel    # 必须是原来的安装目录

bash scripts/update.sh
```

常用参数：

```bash
bash scripts/update.sh --tag v1.0.0   # 指定版本
bash scripts/update.sh --deps         # 更新代码后刷新依赖
bash scripts/update.sh --git          # 改用 git pull（若该目录是 git 仓库）
```

### 更新时不会动

| 保留 | 说明 |
|---|---|
| `tasks/` | 你的业务脚本 |
| `data/` | SQLite 等数据 |
| `logs/` `screenshots/` `runtime-data/` | 运行时文件 |
| `.env*` `.venv/` `node_modules/` | 本地环境与依赖 |

只更新面板代码（`server/` `public/` `scripts/` 等）。**目录不会被挪走。**

---

## 其它脚本

| 脚本 | 作用 |
|---|---|
| [`scripts/install-from-release.sh`](scripts/install-from-release.sh) | 从 GitHub Release **首次安装** |
| [`scripts/update.sh`](scripts/update.sh) | **原地**从 Release 更新（默认） |
| [`scripts/install-deps.sh`](scripts/install-deps.sh) | 只装 Node / Python(DP) 依赖 |
| [`scripts/install.sh`](scripts/install.sh) | 依赖安装的薄封装 |

```bash
# 仅重装依赖
bash scripts/install-deps.sh
bash scripts/install-deps.sh --sb
bash scripts/install-deps.sh --playwright
```

---

## 发版（给你自己用）

1. GitHub → **Releases** → 新建 tag（如 `v1.0.0`）  
2. 不必单独上传 zip：`update.sh` 使用 GitHub 的 tag 源码包  
3. 服务器执行：`bash scripts/update.sh`  

若还没有任何 Release，安装/更新会回退下载 `master` 归档。

---

## 面板里配置什么

1. **全局配置 → 变量与密钥**（类似 GitHub Secrets，注入脚本 env）  
2. **浏览器配置**（持久 user-data / 代理）  
3. **任务**：临时 or 持久数据目录、任务级代理、脚本 env  
4. Vision / Telegram 等  

脚本通过 `os.environ["NAME"]` / `process.env.NAME` 读取，与 GitHub Actions 同名变量兼容。

---

## 技术栈（简）

- 后端：Express、better-sqlite3、自定义调度  
- 前端：Vanilla JS  
- 浏览器任务：Playwright / DrissionPage 等（按脚本）  
- ARM 建议以 **DrissionPage** 为主；SeleniumBase 更适合 x86  

---

## License

ISC

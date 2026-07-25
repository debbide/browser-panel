# Browser Automation Panel

浏览器自动化任务面板：导入脚本、定时运行、环境变量 / 密钥注入。

- 默认端口：`3210`
- 业务脚本目录：`tasks/`（不进仓库，更新不覆盖）
- 配置：面板内完成（代理、浏览器配置、变量、Telegram、Vision 等）

脚本通过环境变量读取配置，例如 `os.environ["NAME"]` / `process.env.NAME`。

---

## 一键安装 / 更新

SSH 登录后粘贴回车即可（**没装过 → 安装，已装过 → 更新并重启面板**）：

```bash
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/bp.sh | bash
```

- 默认目录：`/opt/browser-panel`
- 换目录：`PANEL_ROOT=/data/panel curl -fsSL ... | bash`
- 更新**不会删除** `tasks/`（业务脚本）、`data/`、日志与截图
- 例外：共享库 `tasks/lib/` 会随面板版本**合并更新**（不删你放在 lib 里的其它文件）

打开：`http://服务器IP:3210`

### 浏览器 + 系统 Python 依赖（一键）

面板装好后，在服务器用 root 执行（**系统级 pip，不用 venv**；**只装一个系统 Chrome**，不装 Playwright 自带浏览器）：

```bash
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install-browser-stack.sh | bash
```

或本地：

```bash
bash /opt/browser-panel/scripts/install-browser-stack.sh
```

会安装：Chrome/Chromium、Xvfb、字体、xdotool、ffmpeg、DrissionPage、SeleniumBase、Playwright（仅 Python 库）、pyrogram、Pillow、SpeechRecognition/pydub 等（覆盖 woiden/hax 等脚本）。

---

## 运行环境依赖

### 必选（面板本身）

| 依赖 | 说明 |
|---|---|
| **Linux** | 面向 Linux 服务器 / VPS |
| **Node.js ≥ 18** | 跑面板；原生模块需与 Node 主版本匹配 |
| **npm** | 安装 `package.json` 依赖 |
| **Python 3**（建议 3.10+） | 跑 Python 任务 |
| **构建工具** | `build-essential` / 等效（编译 `better-sqlite3` 等） |
| **磁盘与权限** | 可写：`data/`、`logs/`、`screenshots/`、`runtime-data/`、任务工作目录 |

面板 Node 依赖（见 `package.json`）：`express`、`better-sqlite3`、`node-cron`、`playwright`（及可选 stealth 相关包）。

### 浏览器任务

| 依赖 | 说明 |
|---|---|
| **Google Chrome 或 Chromium** | 真实浏览器 |
| **Xvfb** | 无桌面时跑有头浏览器 |
| **字体** | 如 `fonts-liberation`、`fonts-noto-cjk` |
| **浏览器运行用户** | 可选独立 Linux 用户与工作目录 |

### 按脚本类型（Python）

**DrissionPage**（`requirements-dp.txt`）：`DrissionPage`、`requests`、`Pillow`、`urllib3`

**SeleniumBase / UC**（`requirements-sb.txt`，偏 x86）：`seleniumbase`、`selenium`；常配合 **xdotool**、**python3-tk**；chromedriver/`uc_driver` 与 Chrome 大版本一致

**Playwright Python**（`requirements-playwright.txt`）：`playwright`；自带 Chromium 或系统 Chrome

### 网络与可选

出网、HTTP/SOCKS 代理、Telegram、视觉模型 API（按脚本需要）。

### 架构提示

- **ARM**：优先 DrissionPage + 系统 Chrome  
- **x86_64**：SB / Playwright / DP 均可  
- 换 Node 主版本后需重装原生模块（如 `better-sqlite3`）

---

## License

ISC

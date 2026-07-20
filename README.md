# Browser Automation Panel

浏览器自动化任务面板：导入脚本、定时运行、环境变量 / 密钥注入。

- 默认端口：`3210`
- 业务脚本目录：`tasks/`（不进仓库）
- 配置：面板内完成（代理、浏览器配置、变量、Telegram、Vision 等）

脚本通过环境变量读取配置，例如 `os.environ["NAME"]` / `process.env.NAME`。

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

面板 Node 依赖（见 `package.json`）：

- `express`
- `better-sqlite3`
- `node-cron`
- `playwright`（及可选 `playwright-extra` / stealth 相关包）

---

### 浏览器任务（有界面自动化时）

| 依赖 | 说明 |
|---|---|
| **Google Chrome 或 Chromium** | 真实浏览器；路径由 `BROWSER_CHROME_PATH` 等配置 |
| **虚拟显示 Xvfb** | 无桌面环境跑有头浏览器时需要（如 `DISPLAY=:1`） |
| **字体** | 如 `fonts-liberation`、`fonts-noto-cjk`（减少缺字） |
| **浏览器运行用户** | 可选独立 Linux 用户与工作目录（如 `browser` + `browser-work`） |

常用相关库（随发行版提供）：`libnss3`、`libgbm1`、`libasound2` 等 Chrome/Chromium 运行时库。

---

### 按脚本类型（Python）

**DrissionPage 任务**（`requirements-dp.txt`）

- `DrissionPage`
- `requests`
- `Pillow`
- `urllib3`

**SeleniumBase / UC 任务**（`requirements-sb.txt`，偏 x86）

- `seleniumbase`
- `selenium`
- `requests`
- 常配合：**xdotool**（`uc_gui_*` 点选）
- 建议：**python3-tk**（MouseInfo 等 GUI 辅助）
- chromedriver / `uc_driver`（与本机 Chrome 大版本一致，可由 SeleniumBase 管理）

**Playwright Python 任务**（`requirements-playwright.txt`）

- `playwright`
- 浏览器：Playwright 自带 Chromium，或使用系统 Chrome（`executable_path` / 环境变量）

同一台机器可只装当前脚本需要的栈，不必三种全装。

---

### 网络与可选能力

| 依赖 | 说明 |
|---|---|
| **出网** | 访问目标站、Telegram、视觉 API 等 |
| **HTTP/SOCKS 代理** | 纯 IPv6 或需固定出口时常用；任务/配置里注入（如 `PROXY`、`BROWSER_PROXY`） |
| **Telegram** | 面板通知与脚本自推送（Bot Token + Chat ID） |
| **视觉模型 API** | 部分打码/识图脚本（如 Vision 相关配置） |

---

### 架构提示

- **ARM**：优先 DrissionPage + 系统 Chromium/Chrome；SeleniumBase/ChromeDriver 往往更麻烦  
- **x86_64**：SeleniumBase UC、Playwright、DP 均可  
- 换 Node 主版本后需重装/重建原生模块（如 `better-sqlite3`）

---

## 仓库中的依赖清单文件

| 文件 | 用途 |
|---|---|
| `package.json` | 面板 Node 依赖 |
| `requirements-dp.txt` | DrissionPage 任务 |
| `requirements-sb.txt` | SeleniumBase 任务 |
| `requirements-playwright.txt` | Playwright Python 任务 |

---

## License

ISC

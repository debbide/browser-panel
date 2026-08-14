# Browser Automation Panel

浏览器自动化任务面板：导入脚本、定时运行、环境变量 / 密钥注入。

- 默认端口：`3210`
- 业务脚本目录：`tasks/`（不进仓库，更新不覆盖）
- 配置：面板内完成（代理、浏览器配置、变量、Telegram、Vision 等）

脚本通过环境变量读取配置，例如 `os.environ["NAME"]` / `process.env.NAME`。

---

## 新服务器首次安装

在干净的 Ubuntu/Debian VPS 上用 root 按顺序执行下面两步。

### 第一步：安装完整运行环境

安装系统级 Node.js 22 + npm、Python 3 + pip、Chrome/Chromium、Xvfb、字体、构建工具及 Python 浏览器任务依赖（DrissionPage、SeleniumBase、Playwright Python 等）：

```bash
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install-browser-stack.sh | bash
```

> 这一步使用系统级 Python 依赖（Ubuntu 24.04 通过 PEP 668 兼容参数安装），不下载 Playwright 自带浏览器，只安装一个系统 Chrome/Chromium。通常只需在新服务器上执行一次。

### 第二步：安装面板

```bash
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/bp.sh | bash
```

- 默认目录：`/opt/browser-panel`
- 换目录：两步都加相同前缀，例如 `PANEL_ROOT=/data/panel curl -fsSL ... | bash`

安装完成后打开：`http://服务器IP:3210`

## 更新面板

已经安装过运行环境和面板时，只需执行：

```bash
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/bp.sh | bash
```

- 更新会重装需要的 Node 项目依赖并重启面板
- 更新**不会删除** `tasks/`（业务脚本）、`data/`、日志与截图
- 例外：共享库 `tasks/lib/` 会随面板版本**合并更新**（不删你放在 lib 里的其他文件）

### 首次登录

面板需要登录才能使用。第一次打开会自动进入**引导页**，设置管理员账号和密码（至少 8 位），设好后立刻生效。

- 登录状态存在 Cookie 里，默认 7 天
- 忘记密码：在服务器上删掉账号后重启面板，会重新进引导页

  ```bash
  sqlite3 /opt/browser-panel/data/app.db "DELETE FROM panel_users; DELETE FROM panel_sessions;"
  systemctl restart browser-automation-panel
  ```

> **不要把 3210 直接暴露到公网**：面板本身是明文 HTTP，且脚本管理功能能写文件并执行、服务又是 root 跑的 —— 端口裸奔等于把 root shell 挂在公网上。三种收口方式任选：
>
> 1. **Cloudflare Tunnel**（推荐）：`cloudflared` 从服务器内部连出去，3210 不用对公网开放，外部走 CF 的 HTTPS。在 `.env.panel` 里设 `HOST=127.0.0.1`，隧道指向 `http://127.0.0.1:3210`。
>    建议再叠一层 **CF Access**（Zero Trust → Access → Applications），这样连面板登录页都要先过 CF 的身份校验，面板自己的密码成为第二道锁。
> 2. **SSH 隧道**（最省事，适合自己用）：`.env.panel` 里设 `HOST=127.0.0.1`，本地执行
>    `ssh -L 3210:127.0.0.1:3210 root@服务器IP`，然后访问 `http://127.0.0.1:3210`
> 3. **nginx + TLS**：面板绑 `127.0.0.1`，前面挂 nginx 反代并配好证书
>
> 走隧道时 `HOST=127.0.0.1` 是关键 —— 绑 `0.0.0.0` 的话，即便有隧道，同机其它进程和内网仍能直连面板，绕过隧道那一层。防火墙上也建议保持 3210 关闭（`ufw deny 3210`）。
>
> 注意：以上都只解决"谁能连到面板"。面板与浏览器之间的那一段（CF Tunnel / nginx 到 127.0.0.1）仍是明文，同机 root 可嗅探；单机场景通常可接受。

### 两步验证与通行密钥

登录支持两种额外的验证方式，可在 **设置 → 两步验证** 里管理（所有管理操作需先输入当前密码）。

**TOTP 动态码（配合账号密码）**

1. 设置 → 两步验证 → 输入当前密码 → TOTP 区点「开启」
2. 用身份验证器 App（Google Authenticator / 1Password 等）扫二维码，或手动输入秘钥
3. 填 App 里的 6 位动态码，点「确认开启」即生效

开启后登录流程变成：账号密码 → 输动态码 → 进入面板。忘了动态码：只要还记得当前密码，就能在设置里关闭 TOTP；账号本身丢失仍走上面的「忘记密码」重置通道。

**通行密钥 Passkey（免密直登）**

- 前提：浏览器处于安全上下文（HTTPS 或 localhost）。公网通过 CF Tunnel 访问是 HTTPS，可用；局域网直连 `http://IP:3210` 不支持，登录页会隐藏通行密钥按钮
- 注册：设置 → 两步验证 → 输入当前密码 → 通行密钥区「添加」（命名可选），按系统提示完成（USB 密钥 / 手机 / Windows Hello / Bitwarden 等）
- 登录：登录页点「通行密钥登录」，免输账号密码直接进
- 会话固定 30 天（不看「记住我」）
- 通行密钥适合存放在密码管理器（如 Bitwarden）里同步使用；删除密钥在设置里对应条目点「删除」

> 两步验证是面板自身账号体系的第二道锁，与前面的 **CF Access**（面板外面多一层 CF 身份校验）互不冲突，可叠加使用。

### 单独重装/修复运行环境

如果需要重新安装 Chrome、Xvfb、Node.js、Python 或浏览器任务依赖，可以随时重新执行（**系统级 pip，不用 venv**；**只装一个系统 Chrome**，不装 Playwright 自带浏览器）：

```bash
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install-browser-stack.sh | bash
```

或本地：

```bash
bash /opt/browser-panel/scripts/install-browser-stack.sh
```

会安装：系统级 Node.js 22 + npm、Python 3 + pip、构建工具、Chrome/Chromium、**Xvfb 系统服务常驻**（`xvfb-browser.service`，显示 `:1`）、字体、xdotool、ffmpeg、DrissionPage、SeleniumBase、Playwright（仅 Python 库）、pyrogram、Pillow、SpeechRecognition/pydub 等。

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

**RuyiPage**（可选，仅跑 RuyiPage 任务时需要）：需要专用 Firefox 内核，并自行安装 `ruyipage` Python 库（`pip install ruyipage`）。普通 Chrome/Chromium 即可满足 DrissionPage / SeleniumBase / Playwright；专用 Firefox 是在 **LXC 容器**这类跑不了 Chrome 的场景下用的。安装 Firefox 151.0a1 到 `/opt/ruyipage-firefox`：

```bash
wget -O /tmp/ff151.tar.xz "https://github.com/LoseNine/ruyipage/releases/download/151-ruyi/firefox-151.0a1.en-US.linux-x86_64.tar.xz" \
  && rm -rf /opt/ruyipage-firefox \
  && mkdir -p /tmp/ff151_ext \
  && tar -xf /tmp/ff151.tar.xz -C /tmp/ff151_ext \
  && mv /tmp/ff151_ext/firefox /opt/ruyipage-firefox \
  && chmod -R 777 /opt/ruyipage-firefox \
  && rm -rf /tmp/ff151.tar.xz /tmp/ff151_ext
```

> 安装完成后 Firefox 位于 `/opt/ruyipage-firefox/firefox`（面板里也可用 `BROWSER_RUYI_PATH` 覆盖该路径）。

### 网络与可选

出网、HTTP/SOCKS 代理、Telegram、视觉模型 API（按脚本需要）。

### 架构提示

- **ARM**：优先 DrissionPage + 系统 Chrome  
- **x86_64**：SB / Playwright / DP 均可  
- 换 Node 主版本后需重装原生模块（如 `better-sqlite3`）

---

## License

ISC

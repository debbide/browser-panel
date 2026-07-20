# 部署说明（简单版）

面板自己配置：浏览器用户目录、代理、变量/密钥、临时/持久配置。  
脚本只负责 **依赖** 和 **更新代码**。

## 位置固定（重要）

- 克隆到哪，就一直在哪更新，**脚本不会改项目路径**。
- `install-deps.sh` / `update.sh` 都以 **脚本所在仓库根目录** 为唯一工作目录。
- 不要把代码拷来拷去再跑 update；在原目录 `git pull` / `bash scripts/update.sh` 即可。
- systemd 的 `WorkingDirectory` 请写成你的真实路径，装完不要换目录。

## 两个脚本

| 脚本 | 做什么 |
|---|---|
| `scripts/install-deps.sh` | 在当前仓库目录装 Node / Python(DP) 依赖 |
| `scripts/update.sh` | **原地** `git pull` + `npm install` + 重启服务（若有） |

首次也可：

```bash
bash scripts/install.sh          # = install-deps.sh
bash scripts/install.sh --sb     # 额外 SeleniumBase（x86）
bash scripts/install.sh --playwright
```

## 首次

```bash
# 路径自己定，以后就固定用这个目录
git clone https://github.com/debbide/browser-panel.git /opt/browser-panel
cd /opt/browser-panel

# 系统需已有: Node >= 18, python3, git
# 浏览器/显示按你机器自备（chromium、xvfb 等）

bash scripts/install-deps.sh

# 启动（前台）— 必须在同一目录
node server/index.js
# 默认 http://0.0.0.0:3210
```

可选环境变量（也可用面板/系统 env，不必写进安装脚本）：

```bash
export PORT=3210
export BROWSER_CHROME_PATH=/usr/bin/chromium-browser
export BROWSER_USER=abc61154321
export BROWSER_DISPLAY=:1.0
export BROWSER_PROXY=socks5://127.0.0.1:1080
```

## 更新（仍在原目录）

```bash
cd /opt/browser-panel    # 你的固定路径，别换地方
bash scripts/update.sh

# 连 Python 依赖一起刷：
bash scripts/update.sh --deps
```

## 面板里配置（不要靠安装脚本）

1. **全局配置 → 变量与密钥**  
2. **浏览器配置**（持久目录 / 代理）  
3. **任务**：临时 or 持久、任务级代理、脚本 env  
4. Vision / Telegram 等  

业务脚本自行放到 `tasks/`（默认不进 git）。

## 依赖文件

- `requirements-dp.txt` — DrissionPage（默认，ARM 友好）  
- `requirements-sb.txt` — SeleniumBase（可选）  
- `requirements-playwright.txt` — Playwright Python（可选）  

## 可选 systemd

仓库带了示例：`deploy/browser-automation-panel.service`  
需要时自己改 `WorkingDirectory` 后：

```bash
sudo cp deploy/browser-automation-panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now browser-automation-panel
```

安装脚本**不会**强制写用户、目录树或 systemd，避免和面板配置打架。

# 快速部署 — browser-automation-panel

面向 Linux VPS（x86_64 / **aarch64 ARM**）。面板默认端口 **3210**。

## 一键安装（推荐）

```bash
# 1) 上传/克隆项目
git clone <YOUR_REPO_URL> /opt/browser-automation-panel
cd /opt/browser-automation-panel

# 2) 安装（root）
# 默认：Node 依赖 + Python DP(DrissionPage) + Chromium + Xvfb + systemd
sudo bash scripts/install.sh

# 可选
sudo bash scripts/install.sh --with-playwright          # 额外 Playwright
sudo bash scripts/install.sh --with-sb                  # 额外 SeleniumBase（ARM 不推荐）
sudo bash scripts/install.sh --port 3210 --user abc61154321
```

装完后：

```bash
systemctl status browser-automation-panel
journalctl -u browser-automation-panel -f
# 浏览器打开 http://服务器IP:3210
```

## 安装脚本做了什么

| 步骤 | 说明 |
|---|---|
| 系统包 | node≥18、python3、build-essential、xvfb… |
| 浏览器用户 | 默认 `abc61154321` + `~/browser-work` |
| 浏览器 | Chromium（ARM 友好）+ Xvfb `:1` |
| Node | `npm install`，`/tmp/node-openclaw` 给 su 用 |
| Python | 项目 `.venv`（前台任务）+ 系统 python3 DP 包（浏览器 su 任务） |
| 服务 | `browser-automation-panel.service` + `xvfb-browser.service` |
| 环境 | `.env.panel`（PORT / BROWSER_*） |

## 手动安装（精简）

```bash
cd /opt/browser-automation-panel
sudo apt update
sudo apt install -y nodejs npm python3 python3-pip python3-venv \
  build-essential libsqlite3-dev xvfb chromium-browser

# 浏览器用户
sudo useradd -m -s /bin/bash abc61154321 || true
sudo mkdir -p /home/abc61154321/browser-work/{persistent,screenshots,task-results}
sudo chown -R abc61154321:abc61154321 /home/abc61154321

# 依赖
npm install
python3 -m venv .venv
. .venv/bin/activate && pip install -r requirements-dp.txt
sudo python3 -m pip install --break-system-packages -r requirements-dp.txt

# 显示
sudo Xvfb :1 -screen 0 1440x900x24 &

# 启动
export PORT=3210
export BROWSER_USER=abc61154321
export BROWSER_DISPLAY=:1.0
export BROWSER_XAUTHORITY=/home/abc61154321/.Xauthority
export BROWSER_CHROME_PATH=$(command -v chromium-browser || command -v chromium)
node server/index.js
```

## 架构建议

| 机器 | 推荐 |
|---|---|
| Oracle ARM / 纯 v6 | **DP 脚本** + 系统 Chromium；代理填任务级 `socks5://127.0.0.1:…` |
| x86 Hax | 可加 `--with-sb` 跑 CF 重的 SeleniumBase 脚本 |

## 面板首次配置

1. **全局配置 → 变量与密钥**：`VISION_API_KEY` 等  
2. **Vision Model**：填通道  
3. **新建任务**  
   - 数据模式：**临时配置**（默认，不污染登录目录）  
   - 代理：你的本地节点，如 `socks5://127.0.0.1:1080`  
   - 环境变量：与 GitHub Secrets **同名**即可  
4. 选脚本 → 运行  

## 常用运维

```bash
sudo systemctl restart browser-automation-panel
sudo systemctl restart xvfb-browser
sudo journalctl -u browser-automation-panel -n 100 --no-pager

# 改端口/代理默认
sudo nano /opt/browser-automation-panel/.env.panel
sudo systemctl restart browser-automation-panel
```

## 故障排查

| 现象 | 处理 |
|---|---|
| 页面打不开 | `ss -lntp \| grep 3210`；安全组放行 3210 |
| 浏览器起不来 | `systemctl status xvfb-browser`；`BROWSER_CHROME_PATH` 是否正确 |
| Python 缺模块 | `.venv` 与 **系统 python3** 都要装（su 路径用系统 python） |
| ARM + SB 失败 | 换 DP 脚本或换 x86 机器 |
| 纯 v6 出不了网 | 任务代理必填；先 `curl -x socks5h://127.0.0.1:端口 https://api.ip.sb/ip` |

## 目录约定（与代码一致）

```
/opt/browser-automation-panel/     # 面板代码
  server/ index.js
  public/
  tasks/
  data/app.db
  .venv/
  .env.panel

/home/abc61154321/browser-work/    # 浏览器用户工作区
  persistent/
  screenshots/
  task-results/
  node_modules -> 面板 node_modules
```

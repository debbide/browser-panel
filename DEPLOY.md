# 部署说明（简单版）

面板配置：浏览器目录、代理、变量/密钥、临时/持久。  
脚本只做 **依赖** 和 **原地更新代码**。

## 位置固定 + 数据安全

- 装到哪就一直在哪，`update` **不会改路径**。
- **永远不覆盖 / 不删除：**
  - `tasks/`（你的业务脚本）
  - `data/`（数据库）
  - `logs/` `screenshots/` `runtime-data/`
  - `.env*` `.venv/` `node_modules/`
- 只更新面板代码：`server/` `public/` `scripts/` `package.json` 等。

## 脚本

| 脚本 | 作用 |
|---|---|
| `scripts/install-from-release.sh` | 从 GitHub Release **首次安装**到当前目录 |
| `scripts/install-deps.sh` | 装 Node / Python(DP) 依赖 |
| `scripts/update.sh` | **默认从 Release 更新代码**（保护 tasks/data） |
| `scripts/update.sh --git` | 改用 `git pull`（仍不删 tasks） |
| `scripts/update.sh --deps` | 更新后再刷依赖 |

## 首次（Release，推荐）

```bash
# 路径自己定死，例如 /opt/browser-panel
mkdir -p /opt/browser-panel
cd /opt/browser-panel

# 需要: curl, tar, Node>=18, python3
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install-from-release.sh | bash

# 或指定目录
bash install-from-release.sh --dir /opt/browser-panel   # 若已下载脚本

cd /opt/browser-panel
node server/index.js
# http://0.0.0.0:3210
```

发版后服务器才会拉到带 tag 的包；若还没有 Release，脚本会回退下载 `master` 归档。

## 更新（不丢脚本和数据）

```bash
cd /opt/browser-panel    # 必须是原来的目录
bash scripts/update.sh

# 指定版本
bash scripts/update.sh --tag v1.0.0

# 同时刷新 Python/Node 依赖
bash scripts/update.sh --deps
```

流程：下载 Release 解压到临时目录 → **安全同步**代码 → `npm install` → 可选重启 systemd。

## 可选环境变量

```bash
export PORT=3210
export BROWSER_CHROME_PATH=/usr/bin/chromium-browser
export BROWSER_USER=browser
export BROWSER_DISPLAY=:1.0
export BROWSER_PROXY=socks5://127.0.0.1:1080
```

业务脚本放到 `tasks/`（不进 git / 不进更新包逻辑的覆盖范围）。

## 发 Release 建议

GitHub → Releases → 新建 tag（如 `v1.0.0`）。  
不必单独上传 zip：`update.sh` 使用 GitHub 的 **tag 源码包**（`archive/refs/tags/...`）。  
源码包里本来就没有你的本地 `tasks` 业务脚本（gitignore）。

## 依赖

- `requirements-dp.txt` — 默认（ARM 友好）  
- `requirements-sb.txt` / `requirements-playwright.txt` — 可选  

```bash
bash scripts/install-deps.sh
bash scripts/install-deps.sh --sb
bash scripts/install-deps.sh --playwright
```

## systemd（可选）

改 `deploy/browser-automation-panel.service` 里的 `WorkingDirectory` 为你的固定路径后：

```bash
sudo cp deploy/browser-automation-panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now browser-automation-panel
```

# Browser Automation Panel

浏览器自动化任务面板：导入脚本、定时运行、变量/密钥注入。

- 端口：`3210`
- 业务脚本放 `tasks/`（不进 git，**更新不会覆盖**）
- 代理、浏览器配置、变量在 **面板里** 设置

---

## 首次安装

目录装哪就固定在哪，不要换路径。

```bash
mkdir -p /opt/browser-panel && cd /opt/browser-panel
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install-from-release.sh | bash
```

需要本机已有：`curl`、`tar`、**Node ≥ 18**、**python3**。  
浏览器（Chrome/Chromium）、Xvfb 等按机器自行安装。

可选：

```bash
# 额外装 SeleniumBase / Playwright 的 Python 依赖
bash -s -- --sb --playwright < <(curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install-from-release.sh)
# 或安装后再执行：
cd /opt/browser-panel && bash scripts/install-deps.sh --sb --playwright
```

---

## 日常更新（用这个，不要再用安装脚本）

```bash
cd /opt/browser-panel
bash scripts/update.sh
systemctl restart browser-automation-panel   # 若已做成服务
```

| 命令 | 作用 |
|---|---|
| `bash scripts/update.sh` | 拉最新 Release 代码 + `npm install`，**保留 tasks/data** |
| `bash scripts/update.sh --deps` | 同上，并重装 Python 等依赖 |
| `bash scripts/update.sh --tag v1.0.2` | 更新到指定版本 |

**不要用** `install-from-release.sh` 做日常更新（会完整跑依赖安装，又慢又重）。

更新**不会动**：`tasks/`、`data/`、`logs/`、`screenshots/`、`runtime-data/`、`.env*`、`.venv/`。

---

## 启动

前台：

```bash
cd /opt/browser-panel
node server/index.js
```

systemd（可选，需本机已装 Xvfb + Chrome）：

```bash
# 示例 service 见 deploy/；按你的路径改 WorkingDirectory 后：
systemctl enable --now xvfb-browser browser-automation-panel
systemctl status browser-automation-panel
```

浏览器打开：`http://服务器IP:3210`

---

## 面板使用

1. **全局配置**：变量/密钥、Vision、Telegram  
2. **浏览器配置**：持久目录 / 代理（可选）  
3. **任务**：选脚本、临时或持久数据、任务级代理与变量 → 运行  

脚本读环境变量：`os.environ["NAME"]` / `process.env.NAME`（与 GitHub Secrets 同名即可）。

---

## 发版

GitHub → Releases → 新建 tag（如 `v1.0.3`）。  
服务器上 `bash scripts/update.sh` 会拉该 tag 的源码包。

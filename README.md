# Browser Automation Panel

任务面板：导入脚本、定时跑、变量注入。端口 `3210`。  
业务脚本放 `tasks/`（不进 git，更新不覆盖）。

## 安装（只做一次）

```bash
mkdir -p /opt/browser-panel && cd /opt/browser-panel
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install.sh | bash
```

需要：Node ≥ 18、python3、curl、tar。Chrome / Xvfb 自行安装。

## 升级

```bash
cd /opt/browser-panel
bash scripts/update.sh
```

- 不动：`tasks/`、`data/`、日志与截图  
- 会：拉最新 Release、`npm install`、有 systemd 则重启面板  

指定版本：`bash scripts/update.sh v1.0.3`

## 启动

```bash
cd /opt/browser-panel && node server/index.js
# http://IP:3210
```

## 面板

全局变量/密钥、浏览器配置、任务（临时/持久、代理）→ 运行。  
脚本读 `os.environ` / `process.env` 同名变量即可。

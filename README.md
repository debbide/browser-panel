# Browser Automation Panel

浏览器任务面板，端口 `3210`。业务脚本放服务器 `tasks/`（更新不覆盖）。

## 一条命令（安装 / 升级）

SSH 登录后粘贴回车即可。  
**没装过 → 安装；已装过 → 升级；最后自动重启面板。**

```bash
curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/bp.sh | bash
```

默认目录：`/opt/browser-panel`  
换目录：`PANEL_ROOT=/data/panel curl -fsSL ... | bash`

需要本机已有：**Node ≥ 18**、**python3**、curl、tar。  
Chrome / 代理等在系统里装好；面板里再配任务。

打开：`http://服务器IP:3210`

## 说明

- 升级**不会删** `tasks/`、`data/`
- 有 systemd 会写/重启 `browser-automation-panel`（有 Xvfb 也会带上）
- 发版：GitHub Releases 打 tag 即可

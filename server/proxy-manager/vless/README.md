# 原生 VLESS 拨号器（backend/vless）

不依赖任何第三方二进制、不引入新的 npm 依赖，用纯 Node.js 实现
**VLESS over WebSocket over TLS** 客户端，让 ProxyBridge 能直接吃下
Cloudflare CDN 中转的 VLESS 节点。

## 为什么需要它

现有的 http/socks 上游走 `proxy-chain`，而 CDN 中转的 VLESS 节点无法用
`http://` 或 `socks5://` 表示——Cloudflare 只认 HTTP 语义。把节点交给内核
（Xray / sing-box）再暴露成本地 SOCKS5 虽然可行，但需要额外部署二进制。

这个模块把「VLESS → 本地 HTTP 代理」这一段直接用 JS 实现，于是：

```text
客户端 --HTTP CONNECT--> ProxyBridge 本地端口 --> VLESS+WS+TLS --> CF 边缘 --> 落地
客户端 --明文 HTTP-----> ProxyBridge 本地端口 --> VLESS+WS+TLS --> CF 边缘 --> 落地
```

**两种请求形态都必须走隧道**，这一点很关键。`proxy-chain` 只对 CONNECT 建立
隧道，明文 HTTP 会走它自己的 `forward()` 直连出去——对 vless 上游更是直接返回
HTTP 500。所以 `http-proxy.js` 是自己写的监听器，两种形态都接管。

### 明文 HTTP 泄漏对照（实测）

```text
本机真实出口 IP：<本机 ISP 地址>

A. VlessHttpProxy（新实现，明文 HTTP）
   HTTP 200  出口 IP = <节点落地 IP>      ✓ 走了隧道

B. ProxyChain.Server（旧实现，明文 HTTP）
   HTTP 500  出口 IP = 无                 ✗ 旧实现无法承载 vless:// 上游
```

## 文件结构

| 文件 | 职责 |
|---|---|
| `uuid.js` | UUID 文本 ↔ 16 字节 |
| `vless-header.js` | VLESS 请求/响应头编解码（含 IPv4/IPv6/域名地址编码） |
| `websocket.js` | 手写 RFC 6455 客户端：握手、掩码、分片、控制帧、保活 |
| `link.js` | `vless://` 分享链接解析与能力校验 |
| `cf-edges.js` | Cloudflare 边缘地址池、延迟探测、失败冷却 |
| `dialer.js` | TLS + WS + VLESS 隧道建立与跨边缘重试 |
| `http-proxy.js` | 自建 HTTP 代理监听（CONNECT 与明文 HTTP 都走隧道，含连接复用） |
| `check.js` | 无框架自检脚本 |
| `stress.js` | 并发压力与故障切换探针 |
| `keepalive-probe.js` | 空闲保活对照实验 |
| `reuse-probe.js` | 明文 HTTP 连接复用验证 |
| `leak-proof.js` | 明文 HTTP 泄漏对照实验（新旧实现对比） |
| `leak-check.js` | 句柄泄漏检查（带对照组） |
| `proxy-e2e.js` | 代理监听端到端测试 |
| `panel-e2e.js` | 面板全链路测试（PortManager + 数据库） |
| `api-e2e.js` | 真实 Express API 端到端测试 |
| `index.js` | 统一导出 |

## 支持范围

| 能力 | 状态 |
|---|---|
| VLESS + WebSocket + TLS | ✅ 支持 |
| Cloudflare CDN 中转 | ✅ 支持 |
| 多边缘优选 / 失败切换 | ✅ 支持 |
| WebSocket 保活 | ✅ 支持 |
| VLESS + gRPC / XHTTP / mKCP | ❌ 不支持，解析时明确报错 |
| VLESS + Reality | ❌ 不支持，解析时明确报错 |
| VLESS + XTLS Vision（`flow`） | ❌ 不支持，解析时明确报错 |
| UDP / XUDP | ❌ 不支持 |
| 多路复用（mux.cool / sing-mux） | ❌ 未实现 |

> **关于多路复用**：Xray 用 mux.cool（`v1.mux.cool:666`），sing-box 用
> sing-mux（`sp.mux.sing-box.arpa:444`，smux/yamux/h2mux），两者互不兼容。
> 本模块不实现任何多路复用，因此**要求服务端未启用 multiplex**。若服务端
> 开启了 multiplex，本模块仍可工作，但不会复用连接。

## 已知限制

### 1. TLS 指纹无法伪装

分享链接里的 `fp=chrome` 要求客户端用 uTLS 伪装 Chrome 的 ClientHello
指纹。Node 的 `tls` 模块不暴露 ClientHello 原始字节，**做不到**。链接会被
正常解析并记录 `fingerprintApplied: false`，但实际握手使用 OpenSSL 默认
指纹。CF 对指纹容忍度较高，通常可正常连接；若服务端或 CF 侧开启指纹校验，
可能被拒。这是纯 JS 方案无法绕过的天花板。

### 2. TLS 指纹无法伪装（重申）

见上文「TLS 指纹无法伪装」。这是纯 JS 方案的天花板，无法通过工程手段绕过。

### 3. 明文 HTTP 由 `http-proxy.js` 接管

`dialer.js` 只负责建立到目标的隧道。明文 HTTP 请求（非 CONNECT）由
`http-proxy.js` 解析后经隧道转发，**不会直连**。若绕过该监听器直接调用
`dialer`，明文请求必须自行处理，否则会造成泄漏。

### 4. 连接复用仅对明文 HTTP 生效

明文 HTTP 走 `http.Agent` 连接池，同源请求会复用隧道（实测 6 次请求只拨号
1 次，延迟从 1354ms 降至 315ms）。CONNECT 是字节管道，无法复用，每条
CONNECT 各建一条隧道——这是协议决定的，不是缺陷。

### 5. 一连接一隧道（CONNECT 侧）

服务端未开 multiplex，所以每条 CONNECT 都会新建一条到 CF 的隧道。稳定性
由「边缘优选 + 失败切换 + 保活」保障。

## 使用方式

### 自检（不需要节点）

```bash
node backend/vless/check.js
```

验证 UUID 编解码、VLESS 头字节布局、WS 帧编码、链接解析、CIDR 抽样。

### 带节点自检

```bash
# 额外做 DNS 解析与 Cloudflare 网段校验
node backend/vless/check.js '<vless://...>' --resolve

# 额外做端到端连接：经隧道请求 api.ipify.org 并打印出口 IP
node backend/vless/check.js '<vless://...>' --connect
```

### 代理监听端到端测试

```bash
# CONNECT + 明文 HTTP 都走隧道，并验证出口 IP 与直连不同
node backend/vless/proxy-e2e.js '<vless://...>'

# 明文 HTTP 泄漏对照（新旧实现对比）
node backend/vless/leak-proof.js '<vless://...>'

# 明文 HTTP 连接复用验证
node backend/vless/reuse-probe.js '<vless://...>' 6

# 面板全链路（PortManager + 数据库 + 真实端口）
node backend/vless/panel-e2e.js '<vless://...>'

# 真实 Express API（登录/添加/启动/使用/测速/停止/删除）
node backend/vless/api-e2e.js '<vless://...>'

# 句柄泄漏检查
node backend/vless/leak-check.js '<vless://...>'
```

### 并发压力测试

```bash
node backend/vless/stress.js '<vless://...>' 16
```

## 接入面板

节点以 `vless://` 分享链接粘贴即可，无需额外配置：

```text
添加节点 → 粘贴 vless://... → 自动识别协议 vless → 启动 → 本地端口即可用
```

改动点：

| 文件 | 改动 |
|---|---|
| `port-manager.js` | `parseProxyUri` 放行 vless；`start()`/`testProxy()` 对 vless 改用 `VlessHttpProxy` |
| `server.js` | `parseProxyInput` 识别 `vless://`，名称默认取链接的 `#fragment` |
| `frontend/index.html` | 提示文案补充 VLESS |
| `vless-integration.test.js` | 新增 15 项集成测试 |

链接里的 `#名称` 会作为节点名（实测 `#🇬🇧-Example` → `🇬🇧-Example`），
手动输入的名称优先。`fp=chrome` 等无法实现的能力会在解析时记录但不报错；
Reality / XTLS / gRPC 等**不支持的能力会明确报错**并返回 400。

### 保活对照实验

```bash
# 保活开启，空闲 150s
node backend/vless/keepalive-probe.js '<vless://...>' 150000 30000

# 保活关闭，观察空闲超时
node backend/vless/keepalive-probe.js '<vless://...>' 150000 0
```

> 注意：`keepalive-probe.js` 与 `stress.js` 使用 `node <file>` 直接运行。
> 不要把它们命名成 `*-test.js`，否则 `npm test`（`node --test`）会自动
> 执行它们并因缺少参数而失败。

### 代码调用

```js
const { createVlessDialer } = require('./backend/vless');

const dialer = createVlessDialer({
  link: 'vless://uuid@host:443?encryption=none&security=tls&type=ws&host=host&path=%2Fws&sni=host',
  logger: (message) => console.log(message)
});

const { stream, address, latency } = await dialer.dial({ host: 'example.com', port: 443 });
// stream 是标准的 Duplex，直接读写目标协议即可
stream.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
```

### 自定义 Cloudflare 优选地址

```js
const { CloudflareEdgePool, createVlessDialer } = require('./backend/vless');

const edgePool = new CloudflareEdgePool({
  host: 'your.node.example',
  servername: 'your.node.example',
  extraAddresses: ['104.16.1.1', '172.64.1.1', '104.16.0.0/13'], // 支持单 IP 和 CIDR
  maxAddresses: 24,
  cooldownMs: 5 * 60 * 1000
});

const dialer = createVlessDialer({ link, edgePool });
```

`extraAddresses` 优先级最高，其次是节点域名的 DNS 解析结果，最后从内置
Cloudflare 网段随机抽样补齐。

## 验证结果

在 Node v24.13.0 上对本机实际节点做过完整实测，全部通过：

| 项目 | 结果 |
|---|---|
| 离线自检（编解码/帧/解析/CIDR） | 49/49 通过 |
| 带节点自检（含 DNS 与 CF 网段校验） | 51/51 通过 |
| 端到端（隧道内 TLS + HTTPS 请求） | 55/55 通过 |
| 并发 8 / 16 条隧道 | 全部成功，中位延迟约 1.8s |
| 大流量传输 | 30 MB / 5.55s ≈ **45 Mbps** |
| 失败切换与冷却 | 注入 2 个不可达边缘，自动跳过并成功 |
| 保活（150s 空闲对照实验） | 开启 → 可用；关闭 → 失效 |
| IPv4 / IPv6 边缘 | 均实测连通 |
| 代理监听端到端 | 7/7 通过（CONNECT + 明文 HTTP） |
| 面板全链路（PortManager + DB） | 13/13 通过 |
| 真实 Express API | 11/11 通过 |
| 明文 HTTP 连接复用 | 6 次请求只拨号 1 次 |
| 句柄泄漏 | 与对照组一致，无泄漏 |
| 项目原有测试套件 | 67/67 通过 |

### 连接复用（性能关键）

明文 HTTP 走 `http.Agent` 连接池，同源请求复用隧道：

```text
#1  1354ms   ← 建隧道
#2   920ms
#3   315ms   ← 复用后
#4   320ms
#5   317ms
#6   314ms

6 次请求只拨号 1 次，复用后延迟降至 1/4
```

这正是 `proxy-chain` 的 SOCKS 路径缺失的能力——它显式绕过了 HTTP agent
连接池，每次请求都新建连接，导致边缘 IP 被钉死、高峰期抖动。CONNECT 是
字节管道无法复用，但明文 HTTP（占比更高）的复用收益是实打实的。

### 保活对照实验（关键）

Cloudflare 会掐断空闲 WebSocket。实测对照：

```text
空闲 150s，保活关闭  → 连接失效（第 2 次请求无响应）
空闲 150s，每 30s ping → 仍然可用，出口 IP 正常
```

默认 `keepAliveMs = 30000` 是有意义的，不要关掉。

### 发现：服务端会拦截测速域名

实测中 `speed.cloudflare.com` 与 `speedtest.net` **稳定失败**，而同域名的
真实 IP 直接连接**成功**：

```text
FAIL  域名 speed.cloudflare.com
OK    IP   162.159.140.220      ← 同一目标
FAIL  域名 speedtest.net
OK    IP   151.101.2.219        ← 同一目标
```

域名长度、目标端口、本地代码均已排除（25 字符的
`developers.cloudflare.com` 正常）。结论是**服务端 sing-box 的出站规则
拦掉了测速类域名**，与本模块无关。这也意味着：**用本模块测速会得到偏低的
结果**，测速请改用 `proof.ovh.net` 这类未被拦截的站点。

## 设计要点

- **失败即冷却**：某个边缘连接失败后进入 5 分钟冷却，后续请求优先避开；
  全部处于冷却时仍会尝试，避免直接失败。
- **按延迟排序**：`ordered()` 返回的边缘按历史握手延迟升序，未测量过的
  排在已测量的后面。
- **原子写帧**：WS 写入串行化，避免并发发送把帧切开。
- **首包不丢**：与 VLESS 响应头同包到达的 payload 会在 `TunnelStream`
  构造时缓冲，不会因为监听器尚未挂载而丢失。
- **保活**：默认 30 秒发一次 WS ping，规避 Cloudflare 约 100 秒的空闲断连。

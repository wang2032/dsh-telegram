# Teleforge — DSH × Telegram 桥接插件设计

> **项目名：Teleforge**（Telegram + Forge，呼应你的 OwnForge 品牌）
> 目标：让用户在手机上通过 Telegram 随时与 DSH 里的 agent 实时对话（双向：你发我回 + agent 主动推送）。
> 技术形态：DSH Cordis 动态插件，独立仓库 `dsh-telegram`，Webhook + 自签证书 + 端口转发，自持部署。
> 参考对象：飞书（Feishu）、企业微信（WeCom）插件。

## ✅ 最终设计决策（全部已确认）

| 决策项 | 选择 |
| --- | --- |
| 参考插件 | 本地无源码，**从零基于 DSH 官方文档 + Cordis 接口设计** |
| 接入方式 | **Webhook**（实时性最好，需要公网 HTTPS 回调） |
| 公网方案 | **自签证书 + 端口转发（自持）**：webserver 绑 `0.0.0.0` + 公网端口 → `setWebhook` 上传自签证书 |
| 主动推送 | **两者都要**：实时对话 + agent 主动推送工具 |
| 会话映射 | **每个 Telegram chat 独立一个 DSH 会话** |
| 回复风格 | **整段回复 + 流式逐段推送两者都要**（可按配置切换；流式优先、长回复回落整段） |
| 部署形态 | **独立仓库 `dsh-telegram`**（不并入 web-ui 全家桶） |

### 回复策略（整段 + 流式两者都要）

设计为**可配置**，默认流式，超阈值回落整段：

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| **整段回复** | agent 跑完一个回合后，一次性 `sendMessage` 完整回复 | 稳定、简单；用于短回复 / 工具结果 / 出错兜底 |
| **流式回复** | 先 `sendChatAction('typing')`，随 agent 事件流按**自然段落/句子**分批 `sendMessage`（可编辑上一条消息攒字，或逐段追加） | 实时感强；用于长解答、代码、多步任务 |

实现要点：
- 流式按「完整段落」切块发送，避免 Telegram 4600 字符/条限制与字数割裂。
- 长回复中途断了也不怕：最终把整轮结果再发一条「完整版」兜底。
- 两条路径共用同一个 session 驱动层，只是「出站渲染」策略不同。

---

## ⚠️ 关键技术发现（Webhook 的可行性）

DSH 的 GUI 载体 **`ctx.webServer`**（`packages/host/webserver`）允许任意 Cordis 插件注册具名 HTTP 路由：

```ts
ctx.webServer.register({
  kind: 'exact',            // 或 'prefix'
  path: '/telegram/webhook', // 绝对路径
  handler: (req, res) => { /* 处理 Telegram POST 的 JSON update */ },
})
```

- 这解决了「Telegram → DSH 入站」的问题：插件在 DSH web server 上注册一个 webhook 端点，Telegram 把更新 POST 过来。
- **公网可达性**：webserver 默认绑 `127.0.0.1`，需配 `0.0.0.0` + 公网端口转发，或用 tunnel（cloudflared/ngrok）把 `/<端口>/telegram/webhook` 暴露成公网 HTTPS URL。
- **HTTPS 要求**：Telegram webhook 必须 HTTPS。可用 `setWebhook` 上传自签证书，或用 cloudflared/ngrok 提供的公网 HTTPS。

---

## ⚠️ P0 接口核实结果（已对照 DSH 源码验证）

> 以下结论全部录自 DSH 仓库源码
> （`packages/extensions/cordis-host-runner/src/sandbox.ts` / `guard.ts`、
> `docs/subsystems/{web,web-server,core,credentials,shell}.zh.md`、`packages/host/webserver`）。
> 修订于 P0 阶段，替代本文档早前「出站走 `ctx.web`」的假设。

### Host 沙箱内可用的全局/上下文（`sandbox.ts:createSandbox`）

动态包 Host 半区在 `node:vm` 里拿到：

| 符号 | 内容 |
| --- | --- |
| `ctx` | **受限只读** Cordis 上下文（`guard.ts:sandboxContext`）：仅 `ctx.get(name)` 可选查找、`ctx.on/once/provide/effect`、`timeout/interval`（需 `inject:['timer']`）、`ctx.tools.register`。**框架成员（root/fiber/registry/extend/plugin…）被刻意 withhold**。 |
| `harness` | `harness.defineTool(def)`、`harness.registerTool(ctx, tool)`、`harness.handle(method, fn)`。`registerTool` 的 `tool` **必须**来自 `defineTool`（带标记校验）。 |
| `fetch` / `require` / `setTimeout` / `setInterval` / `process` | **被 trap / 置为 undefined**，调用即抛教学错误。 |

**关键推论：**
- 插件 `apply(ctx)` 内**无法访问** `webServer` 之外的任意 `ctx.webServer` 之外的框架服务——必须通过 `inject` 声明（`inject: ['webServer']`），然后用 `ctx.get('webServer')` / 直接属性访问 `ctx.webServer`。
- 沙箱**没有通用出站 HTTP 客户端**（无 `fetch`、无 `http`/`net` 服务）。

### ① 入站 Webhook — ✅ 可用（符合设计）

`ctx.webServer`（`dsh-host-webserver`）确实支持设计预期的路由注册，签名与设计一致：

```ts
ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler: (req, res) => void | Promise<void> }) => () => void  // disposer
```

- 绑定 `host` 仅接受 `'127.0.0.1' | '0.0.0.0'`，无 TLS/鉴权——暴露 `0.0.0.0` 即网络暴露。
- 处理 HTTP 请求，非 SSE 场景按设计返回流水即可。

### ② 出站 Telegram Bot API — ❌ 设计假设不成立（关键阻塞）

设计原假设「出站调 Bot API 走 `ctx.web`」**错误**。已核实：

- `ctx.web`（`WebRuntime`）是 **Web 访问能力 seam**，只有两个方法：`search()` 与 `fetch()`。
- `ctx.web.fetch({ url })` 是**只读抓取**：请求仅携带 URL，且 `dsh-web-fetch-http/src/provider.ts` 里**硬编码 `method: 'GET'`**（`provider.ts:106`），只解码 html/text 正文。
- 因此 **无法用 `ctx.web.fetch()` 对 `api.telegram.org/bot<TOKEN>/sendMessage` 发 POST**（Telegram Bot API 出站全是 POST）。
- 全局 `fetch` 在沙箱中被 trap（`sandbox.ts`）。

→ **出站是一个未决的架构决策点**（见「可选解决路径」）。

### ③ 会话驱动 — ✅ 可通过 `ctx.agents` 实现

DSH 把「入站消息 → agent → 会话事件」的驱动能力暴露为服务，设计里的「P3 需核实 session/inbox」已有答案：

- `ctx.agents`（`AgentRegistry`）——`create(options): Promise<AgentHandle>` / `resume(options)` / `get(id)`。
  - **需要 `inject: ['agents']`**（AgentFactory 由 agent-loop 注册）。
- `AgentHandle`（即 `Agent`）提供：`send(message, target, wakeup)`、`followup(message)`（普通下一轮+唤醒）、`steer(message)`、`inject(message)`（注入上下文不唤醒）、`cancel()`、`whenIdle()`。
- 流式回复：订阅 `Session` 事件流（`assistant/chunk`、`assistant/message`、`turn/end` 等）——通过 `agent.session`（`Session`，仅追加事件日志）监听。
- 会话持久化走 `ctx.sessionPersistence`（`resume` 需要）。

→ `driver.js` 的 `sessionFor` / `runTurn` 可基于 `ctx.agents.create()` + `Agent#followup/inject` + 会话事件流实现。

### ④ 动态工具 — ✅ 可用（符合设计）

```ts
const tool = harness.defineTool({
  name: 'telegram_send',
  description: '…',
  parameters: { type:'object', properties:{ chat_id:{type:'string'}, text:{type:'string'}, parse_mode:{type:'string'} }, required:['text'] },
  output: { schema: { type:'object' }, render(args, value){ return [{ type:'text', text: String(value) }] } },
  async execute(args, exec){ … },
})
harness.registerTool(ctx, tool)   // ctx 必须是沙箱 ctx
```

- `parameters` 用统一 DSL（`type object + properties + required`），不允许 `pattern/format` 等。
- `execute` 返回值必须是纯 JSON。

### ⑤ 配置 / 凭证

- 设计 `inject:['credentials']` 可用，但 `credentials` seam 的接口是 `ctx.credentials.resolve(ref)`（`CredentialRef` = 环境变量名）——不是读任意键。**更稳妥的做法：把 token/白名单作为平台环境变量注入，在 `config.js` 里 `process.env` 读取**（沙箱里 `process` 被置 undefined，需在 define 时通过 config 或 preload 传入，而非运行时读 `process.env`）。

### ⚠️ 出站阻塞的根因与正解：换插件形态（已对照源码验证）

**先澄清「出站为什么会被堵」**：不是 Telegram 的问题，而是**插件执行形态**的问题。DSH 有**两种**插件形态，出站能力完全不同：

| 形态 | 运行位置 | 出站 HTTP | 参考对象 |
| --- | --- | --- | --- |
| **① 动态 Cordis 插件**（`cordis_define` → `code.host`） | `node:vm` 沙箱（`cordis-host-runner`） | ❌ `fetch`/`require`/`process` 全被 trap；`ctx.web` 只是 GET-only 抓取 seam | — |
| **② 普通 Host 插件包**（仓库里的真实 Node 模块） | **宿主机真实 Node 进程** | ✅ **全局 `fetch` POST 直接用** | `packages/host/frontend-static`、`packages/llm/llm-deepseek` |

**决定性证据**（DSH 源码）：
- `packages/llm/llm-deepseek/src/adapter.ts:342` 直接 `await fetch(url, { method: 'POST', headers, body })` 调 DeepSeek API——**普通 host 包本来就这么出站**，旁边注释还是 TODO「待 Cordis HTTP 服务出现后改用共享传输配置」→ 说明 cordis HTTP 出站服务**根本不存在**，host 包靠全局 fetch 是正路子。
- `packages/host/frontend-static/src/index.ts` 是**普通 host 插件包形态**：`export const inject = ['webServer']` + `apply(ctx, config)` + `ctx.effect(() => ctx.webServer.registerFallback(...))`，能自由 `import 'node:fs'`、用全局 fetch。它既能注册 webhook 路由，又有完整 Node 能力。
- 沙箱 `ctx.web` 的 fetch 提供方 `dsh-web-fetch-http/src/provider.ts:106` **硬编码 `method: 'GET'`**。

**飞书 / 企业微信插件的做法**（设计方案里的参考对象）：它们不在官方库、在本机的 **dsh-web-ui 插件全家桶仓库**（`packages/dsh-task-board` 同仓，`web-ui-all` 聚合安装），其形态是 **② 普通 Host 插件包**——「Host 权威账本、关闭浏览器后仍由 Host 执行」。所以它们**根本不受 `cordis_define` 沙箱限制**，出站直接全局 `fetch POST` 到飞书/企微 Bot API 即可。

> ✅ **结论（替代原 A/B/C 决策）**：本项目应从「动态 Cordis 插件（①）」**改为「普通 Host 插件包（②）」**——就是飞书/企微的实际形态。既保留单一插件形态，出站又是原生全局 `fetch POST`，无需 shell 套壳 `ctx.web` 或拆独立服务。原 A/B/C 三方案皆为在①约束下的绕路，不再需要。

影响：
- **入站** `ctx.webServer.register()` —— 不变，两类形态都用它。
- **出站** —— `fetch POST https://api.telegram.org/bot<TOKEN>/sendMessage` 原生可用（不再需要一个「传输层适配器」选 A/C）。
- **会话驱动** `ctx.agents.create()→AgentHandle` —— 不变。
- **动态工具** —— ① 用 `harness.defineTool/registerTool`；② 用 **`ctx.tools.register(tool)`**（`defineTool` 来自 `@deepseek-ai/dsh-tools`），跳过 `harness` 沙箱包装。
- **config** —— ② 里 `process.env` 可用（真实进程），`config.js` 无需改运行时约束注释。

> 注：② 属于「宿主组合（composition）」的一部分（随 DSH 一起加载），已 `packages/` 或插件全家桶形式落地；`@path` 仓库里保留源码即可。

---

## 1. 背景与现状分析

### 1.1 DSH 插件机制：Cordis Plugin

DSH 的插件系统是 **Cordis**（见 `packages/extensions/*`、`docs/cordis-*`）。

一个插件 = 一个 `dyn-<n>` 包，可能有两个半区：

| 半区 | 运行位置 | 能力 |
| --- | --- | --- |
| `code.host` | Host 端 `node:vm` 沙箱 | `ctx`（服务获取/事件/生命周期）、`harness`（注册动态工具、client RPC）、网络（`ctx.web`）、定时器（`ctx.timer`）、base64 |
| `code.client` | 浏览器 Web GUI 端 | React、Slot 注入、主题、页面 UI |

Host 半区**关键限制**（来自 `cordis-host-runner/src/sandbox.ts`）：
- ❌ 无 `fetch`、无 `require`、无 `process`、无裸 `setTimeout`
- ✅ 网络必须走 **`ctx.web`** 服务（`inject: ['web']`）
- ✅ 定时器走 **`ctx.timer`** 服务（`inject: ['timer']`）
- ✅ 可注册**动态工具**：`harness.registerTool(ctx, tool)` → 模型在后续回合可直接调用

### 1.2 参考插件（飞书 / 企业微信）

用户指出的飞书、企业微信插件正是这类「聊天平台 ↔ DSH 桥接」插件的范例。它们解决了本方案的核心难题：**如何把平台上的入站消息送进 agent、拿到流式回复再回发**。

> ⚠️ 我在本地未找到这两个参考插件源码（它们应在 web-ui 插件全家桶仓库 / 用户处）。实现阶段需要先拿到其 `code.host` 结构作为范式。

### 1.3 Telegram 接入方式（已选 Webhook）

| 方式 | 原理 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **getUpdates 长轮询** | 主动轮询 `api.telegram.org/bot<TOKEN>/getUpdates` | 无需公网端口 / 无需 HTTPS 回调 | 有轮询延迟；需维护 offset；DSH agent 会话驱动是异步的，轮询模型简单 |
| **Webhook（已选）** | 在 `ctx.webServer` 注册 `/telegram/webhook` 路由，Telegram 把更新 **POST** 过来 | **实时性最好**；无需轮询；推送事件流自然适配 | 需要公网 HTTPS 回调地址（自签证书上传 / tunnel） |

**方案：Webhook。** 插件用 `ctx.webServer.register()` 注册 `/telegram/webhook` 端点；DSH webserver 配 `0.0.0.0` + 端口转发，或用 cloudflared/ngrok 暴露公网 HTTPS → `setWebhook` 指向它。

---

## 2. 总体架构

```
┌─────────────── 手机 Telegram ───────────────┐
│        用户 ↔ Telegram Bot ↔ api.telegram.org │
└───────────────────┬────────────────────────┘
                    │ HTTPS webhook (POST update)
                    ▼
┌────────────  DSH Host（本机）  ─────────────┐
│   [公网 HTTPS + 端口转发 / tunnel → localhost] │
│                                              │
│   Cordis Plugin: dsh-telegram-bot            │
│   ┌────────────────────────────────────┐     │
│   │ code.host                          │     │
│   │  · ctx.webServer.register          │     │
│   │    /telegram/webhook (接收 update)  │     │
│   │  · ctx.web ←→ Telegram Bot API     │     │
│   │  · session/inbox  驱动 agent       │     │
│   │  · 流式回复 → sendMessage          │     │
│   │  · harness.registerTool            │     │
│   │    (telegram_send 主动推送)         │     │
│   └────────────────────────────────────┘     │
│              │  agent 会话/事件流             │
│              ▼                               │
│       DSH agent (session / inbox)            │
└──────────────────────────────────────────────┘
```

### 数据流（用户 → agent → 用户）

1. 用户在 Telegram 给 Bot 发消息 → Telegram 以 HTTPS webhook POST 到 DSH 的 `/telegram/webhook`。
2. 插件 `ctx.webServer` 处理器解析 update，校验 **secret token / 白名单 user_id / chat_id**（防伪造请求），MySQL 中过滤掉非 `message` 类型。
3. 按 `chat_id` 找到/创建独立 DSH session，把文本消息作为一个 task 送入该 session 驱动 agent。
4. 订阅该 session 的会话事件流（流式 token / 分段结果）。
5. 把回复（文本 + MarkdownV2/HTML）通过 `sendMessage` 回发给 Telegram 用户；处理中先发 `sendChatAction('typing')`。
6. **主动推送**：agent 在任意 DSH 会话中通过 `telegram_send` 工具，主动向指定 `chat_id` 推送消息/通知。

---

## 3. 需要实现的能力分解

### 3.1 核心：Telegram 桥接（Host）
- **初始化 / 配置**：Bot token、允许的用户 ID 与群 ID 白名单、对话模式（回复整段 vs 流式）。
- **入站接收（Webhook）**：`ctx.webServer.register` 注册 `/telegram/webhook` 路由，解析 `message` / `edited_message` / `callback_query`（按钮）；**必须校验 Telegram webhook secret token** 防伪造。
- **出站发送**：通过 `ctx.web` 调 Telegram Bot API：`sendMessage`（文本、MarkdownV2/HTML）、`sendChatAction`（"typing..."）、可选 `sendPhoto`/`sendDocument`。
- **指令处理**：`/start` 绑定、`/help`、`/status`。

### 3.2 关键：把消息送进 agent + 拿回流式回复
这是全方案的**技术要点**，复用飞书/企业微信的既定范式（从零设计）：
- 每条消息按 `chat_id` 映射到**独立 DSH session**（`session_map = per-chat`）。
- 找到 DSH 的「入站 → agent 驱动」服务（session/inbox / agent driver），把用户消息作为 task 注入。
- 订阅 `SessionEvent` 事件流，把「回复」增量地通过 `sendMessage` 推回（先 typing，再逐段发）。
- **并发控制**：同一 chat 串行处理（避免消息交错响应）；多 chat 可并行。

### 3.3 主动推送工具（Host）
- `harness.registerTool` 注册 `telegram_send(chat_id, text, parse_mode?)`：让 agent 在**任何** DSH 会话中都能主动把消息推送到用户手机（任务完成提醒、异步通知、审批请求等）。

### 3.4 配置与安全
- Bot token 存 DSH credentials/settings（不要硬编码进插件源码）。
- **白名单鉴权**：只响应预先授权的 Telegram user_id / chat_id；webhook 校验 secret token。
- 作用域/权限：插件自身遵循 DSH 权限模型，agent 需要的文件/命令权限独立配置。

### 3.5 客户端（可选）
- 因为主要交互在手机 Telegram 上，`code.client` 可选做：在 Web GUI 里显示连接/webhook 状态、白名单管理、启用/停用开关及公网 URL 配置。

## 4. 落地步骤（Phase）

| Phase | 内容 | 产出 |
| --- | --- | --- |
| **P0 调研** | 用 `cordis_inspect_list`/`query` 核实 `ctx.webServer`、`ctx.web`、session/inbox 服务的确切接口与运行时可达性 | 接口清单、路由注册范式 |
| **P1 骨架** | 建插件工程（OwnForge 下），`code.host` 空壳 + 配置加载 + credentials 读取 | 可 define/run 的空插件 |
| **P2 Telegram Webhook 连通** | `ctx.webServer.register` + `setWebhook` + `sendMessage`，先做「echo」验证收发 | 手机 ↔ DSH 互通 |
| **P3 agent 接入** | 消息→独立 session→流式回复→sendMessage；per-chat 会话隔离 | 手机里和 DSH agent 实时对话 |
| **P4 健壮性** | 白名单、secret token 校验、错误重连、typing 提示、markdown 渲染、并发控制 | 稳定可用 |
| **P5 增强（可选）** | `telegram_send` 主动推送工具、webhook 自签证书/tunnel、图片/文件、按钮交互 | 更完整 |

---

## 5. 部署形态（已定：独立仓库）

- **独立仓库 `dsh-telegram`**，自持证书 + 端口转发，不并入 web-ui 全家桶。
- 结构建议：
  ```
  dsh-telegram/
    package.json          # @dsh/telegram-bot 或自有命名
    src/
      code.host.js        # 插件 Host 半区逻辑（编译产物 / 裸 JS）
      code.client.js      # （可选）Web GUI 半区
      bridge/             # Telegram Bot API 封装、webhook 监听
      agent/              # session/inbox 驱动、per-chat 会话映射、流式出站
      tools/              # telegram_send 主动推送工具注册
      config.js           # 白名单、token、端口、回复策略
    scripts/
      gen-cert.sh         # 自签证书生成
      set-webhook.sh      # 调 Bot API setWebhook（带 cert）
    credentials/          # 敏感配置（不提交，走 DSH credentials）
    README.md
  ```

> 说明：Cordis 动态插件的 `code.host`/`code.client` 是**裸 JavaScript 函数体**（不是 TS/JSX），最终经 `cordis_define` 注册。仓库里可同时保留开发源码与打包脚本。

---

## 6. 风险与注意点

- **公网可达性**（webhook 最大依赖）：webserver 需绑 `0.0.0.0` + 路由器/服务器端口转发；**自签证书**需在 `setWebhook` 时上传给 Telegram，并让 DSH webserver 承载 TLS（或用前置 nginx 终结 TLS 后转发到本机 webServer 路由）。
- **webhook 安全**：端点暴露公网后必须校验 Telegram `X-Telegram-Bot-Api-Secret-Token` 请求头，防止任意 POST 伪造更新耗 API。
- **Host 沙箱网络**：出站只能走 `ctx.web`（Bot API 调用），入站靠 `ctx.webServer` 路由；两者接口需 P0 核实。
- **流式 + 整段双路**：需要「出站渲染策略」抽象（详见上文），流式切段要处理 4600 字符/条限制与消息编辑。
- **会话驱动 API**：把消息注入 session 并拿流式事件，需核实 DSH 是否暴露给动态插件（P0 关键点）；若无现成服务，则复用 loader/driver 范式封装。
- **权限与 API 成本**：跑 agent 消耗 API 额度，需管控并发与滥用（白名单 + 速率限制）。
- **凭证安全**：Bot token 属敏感凭证，必须走 DSH credentials 系统。

---

## 7. 交付建议

- 先 P0（核实 webServer/web/session 接口）+ P1/P2（连通性冒烟）拿到「手机能收发 echo」的最小可用闭环，再平滑接 agent。
- 每个 Phase 用 `cordis_define` → `cordis_run` 实测，符合 DSH 官方插件开发流程。
- 自签证书：生成后可先用 curl/Telegram `getWebhookInfo` 自检，再联调 agent。

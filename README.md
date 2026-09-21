# Teleforge (dsh-telegram)

让用户在手机 Telegram 上随时与 DSH 里的 agent 实时对话（双向）：

- **你发我回**：Telegram 消息 → webhook → 注入独立 DSH session → agent 回复 → 回发到手机
- **agent 主动推送**：注册 `telegram_send` 工具，agent 可在任意会话主动推送通知到你的手机
- **回复风格**：整段 + 流式两者都要，按配置切换（默认流式、长回复回落整段）
- **会话隔离**：每个 Telegram chat 对应一个独立 DSH session

## 技术形态

**Host 侧插件包**（`host-side plugin package`，与飞书/企业微信插件同形态，仿 `packages/host/frontend-static`）——运行在 DSH 宿主机真实 Node 进程，**非** `cordis_define` 沙箱插件。

> 为什么用这种形态：DSH 的**动态 Cordis 插件（`cordis_define`）**跑在 `node:vm` 沙箱里，全局 `fetch`/`require`/`process` 都被 trap，且 `ctx.web` 只是 GET-only 抓取 seam——**无法对 api.telegram.org 发 POST**（Bot API 全是 POST）。而**普通 Host 插件包**在真实进程里，原生 `fetch POST` 可用（`packages/llm/llm-deepseek` 即如此），同时也照常能注册 webhook 路由。详见 `DESIGN.md`「出站阻塞的根因与正解」。

| 项 | 值 |
| --- | --- |
| 接入 | Webhook（`ctx.webServer.register` `/telegram/webhook`） |
| 出站 | 原生 `fetch POST` → `api.telegram.org` |
| 会话 | per-chat 独立 DSH session（`ctx.agents.create`） |
| 驱动/流式 | `agent.followup` + 订阅 `session/event`（`assistant/chunk`→消息段、`turn/end`） |
| 推送工具 | `ctx.tools.register(defineTool(...))`（`telegram_send`） |
| 形态 | Host 插件包（`export { name, inject, Config, apply }`） |

## 目录结构

```
src/
  code.host.js        # 插件入口（name/inject/Config/apply 全接线）
  config.js           # 配置面 + 白名单/token 校验
  bridge/             # Telegram Bot API (fetch) + webhook 监听 + update handler
  agent/              # per-chat 会话驱动 + session/event 流式出站
  tools/              # telegram_send 主动推送工具
scripts/
  gen-cert.sh         # 自签证书生成
  set-webhook.sh      # 调 Bot API setWebhook（带证书）
  webhook-info.sh     # 查询 getWebhookInfo
credentials/          # 敏感配置（不提交）
DESIGN.md             # 完整设计方案（含 P0 接口核实结果）
```

## 快速开始

> 该插件以 Host 插件包形式挂载到 DSH 宿主组合（composition），随 DSH 一起加载。
> 开发验证：`code.host.js` 里的 `apply(ctx, config)` 导出标准 Cordis 插件接口，
> 用 `ctx.plugin` / DSH 宿主组合挂载即可。

1. 配好机器人：`@BotFather` 创建 bot，拿到 `botToken`。
2. 配置：`botToken`、`allowUsers`/`allowChats` 白名单（建议生产必设）、`webhookSecret`。
3. 暴露公网 HTTPS（`0.0.0.0` + 端口转发，或 tunnel），`setWebhook` 指向 `https://host:port/telegram/webhook`。
4. 向 bot 发消息，验证「你发我回」与 `telegram_send` 推送。

## License

MIT

// Teleforge — plugin entry (HOST-SIDE PACKAGE form, mirroring the Feishu/WeCom reference
// plugins and packages/host/frontend-static). Runs in the REAL Node process, so global
// `fetch` POST to api.telegram.org works natively — no cordis_define sandbox restrictions.
//
// Wires the full bridge:
//   - inbound : ctx.webServer.register('/telegram/webhook')  -> handleUpdate -> dispatcher
//   - driving : ctx.agents.create() per chat -> AgentHandle, followup + session/event stream
//   - outbound: fetch POST to api.telegram.org (sendMessage / sendChatAction)
//   - push    : ctx.tools.register(telegram_send)
//
// Plugin shape mirrors frontend-static: export { name, inject, Config, apply(ctx, config) }.

import { createTelegramBridge } from './bridge/telegram.js'
import { registerWebhook } from './bridge/webhook.js'
import { createDispatcher } from './bridge/handler.js'
import { createAgentDriver } from './agent/driver.js'
import { createReplyRenderer } from './agent/renderer.js'
import { createPushTool } from './tools/telegram_send.js'
import { isValidBotToken } from './config.js'

export const name = 'dsh-telegram'

// Services we depend on. 'webServer' hosts the inbound webhook; 'agents' drives
// per-chat sessions; 'tools' publishes telegram_send.
export const inject = ['webServer', 'agents', 'tools']

// Config schema (DSH/zed-compatible object schema).
export const Config = {
  type: 'object',
  properties: {
    botToken: { type: 'string' },
    webhookPath: { type: 'string', default: '/telegram/webhook' },
    webhookSecret: { type: 'string' },
    publicUrl: { type: 'string' },
    allowUsers: { type: 'array', items: { type: 'string' } },
    allowChats: { type: 'array', items: { type: 'string' } },
    parseMode: { type: 'string', enum: ['None', 'MarkdownV2', 'HTML'], default: 'None' },
    reply: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['stream', 'full'], default: 'stream' },
        streamChunk: { type: 'string', enum: ['paragraph', 'sentence'], default: 'paragraph' },
        fallbackToFull: { type: 'boolean', default: true },
        maxMessageChars: { type: 'number', default: 4096 },
        typingIntervalMs: { type: 'number', default: 5000 },
      },
    },
    workspaceCwd: { type: 'string' },
    agent: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        maxTokens: { type: 'number' },
      },
    },
  },
  required: ['botToken'],
}

export function apply(ctx, config = {}) {
  config = config ?? {}
  const webServer = ctx.get('webServer')
  const agents = ctx.get('agents')
  const tools = ctx.get('tools')
  if (webServer === undefined || agents === undefined || tools === undefined) return

  // Bot token: prefer plugin config, fall back to DSH credentials ref resolve.
  // (Host packages run in the real process, so env fallback is fine for dev.)
  const botToken = config.botToken
    ?? process.env.TELEGRAM_BOT_TOKEN
    ?? ''
  if (!isValidBotToken(botToken)) {
    console.error('[teleforge] no valid bot token configured; plugin idle')
    return
  }

  const telegram = createTelegramBridge({ botToken })

  const driver = createAgentDriver(ctx, agents, {
    cwd: config.workspaceCwd,
    agentOptions: config.agent ? {
      provider: config.agent.provider,
      model: config.agent.model,
      maxTokens: config.agent.maxTokens,
    } : undefined,
  })

  const renderer = createReplyRenderer(telegram, {
    mode: config.reply?.mode ?? 'stream',
    streamChunk: config.reply?.streamChunk ?? 'paragraph',
    fallbackToFull: config.reply?.fallbackToFull ?? true,
    maxMessageChars: config.reply?.maxMessageChars ?? 4096,
    typingIntervalMs: config.reply?.typingIntervalMs ?? 5000,
    parseMode: config.parseMode,
  })

  // Parse-mode normalization: config 'None' (default) -> undefined.
  const parseMode = config.parseMode && config.parseMode !== 'None' ? config.parseMode : undefined

  const dispatcher = createDispatcher({
    driver,
    renderer,
    telegram,
    config: {
      allowUsers: config.allowUsers ?? [],
      allowChats: config.allowChats ?? [],
      parseMode,
    },
  })

  // Register the inbound webhook route (disposer removed by ctx.effect on stop).
  const removeWebhook = registerWebhook(webServer, {
    path: config.webhookPath ?? '/telegram/webhook',
    secretToken: config.webhookSecret ?? '',
    onUpdate: dispatcher,
  })
  ctx.effect(() => removeWebhook(), 'dsh-telegram: webhook route')

  // Register the telegram_send push tool (skips the harness sandbox wrapper —
  // that's the dynamic-cordis path; host packages use ctx.tools.register directly).
  const pushTool = createPushTool(telegram, { allowUsers: config.allowUsers ?? [] })
  const removeTool = tools.register(pushTool)
  ctx.effect(() => removeTool(), 'dsh-telegram: telegram_send tool')

  // Log public URL hint (user registers setWebhook with this).
  if (config.publicUrl) {
    console.log(`[teleforge] webhook ready: set Telegram webhook to ${config.publicUrl}`)
  }

  console.log('[teleforge] plugin applied (host-side package form).')

  ctx.on('dispose', () => {
    // ctx.effect already removes webhook + tool; dispose any live agents.
    driver.disposeAll().catch(err => console.error('[teleforge] dispose error:', err))
  })
}

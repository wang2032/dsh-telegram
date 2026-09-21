// Teleforge configuration surface.
//
// ✅ Form: HOST-SIDE plugin package (real Node process, NOT the cordis_define sandbox),
// so `process.env` works here and at runtime. This file documents the config surface and
// provides helpers to load it. Real secrets belong in DSH credentials (see code.host.js).

export const config = {
  // --- Telegram Bot ---
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? '', // goes through DSH credentials at runtime
  webhook: {
    path: '/telegram/webhook',
    secretToken: process.env.TELEGRAM_WEBHOOK_SECRET ?? '', // X-Telegram-Bot-Api-Secret-Token
    publicUrl: process.env.TELEGRAM_PUBLIC_URL ?? '', // https://host:port/telegram/webhook
    publicPort: Number(process.env.TELEGRAM_PUBLIC_PORT ?? 8443),
  },

  // --- Authorization ---
  allowUsers: (process.env.TELEGRAM_ALLOW_USERS ?? '').split(',').filter(Boolean), // user_ids
  allowChats: (process.env.TELEGRAM_ALLOW_CHATS ?? '').split(',').filter(Boolean), // chat_ids

  // --- Reply policy ---
  reply: {
    mode: 'stream', // 'stream' | 'full'
    streamChunk: 'paragraph', // 'paragraph' | 'sentence'
    fallbackToFull: true, // long/interrupted replies fall back to a full message
    typingIntervalMs: 5000,
    maxMessageChars: 4096, // Telegram per-message limit (safely under 4600)
  },

  // --- WebServer binding (self-hosted) ---
  webServer: {
    host: process.env.TELEGRAM_WEB_HOST ?? '0.0.0.0', // must be 0.0.0.0 for Telegram to reach the webhook
    port: Number(process.env.TELEGRAM_WEB_PORT ?? 3080),
  },
}

/**
 * Validate a Telegram bot token shape before it reaches the API.
 * Telegram bot tokens look like `<botId>:<secret>` (e.g. `123456:ABC...`).
 */
export function isValidBotToken(token) {
  return typeof token === 'string' && /^\d+:[A-Za-z0-9_-]+$/.test(token)
}

/**
 * Decide whether an inbound update is authorized:
 * - if any user whitelist is set, the msg `from.id` must be in it;
 * - if any chat whitelist is set, the `chat.id` must be in it.
 * Empty whitelists mean "allow all" (dev default), but you should set them for production.
 */
export function isAuthorized(update, cfg) {
  const allowUsers = cfg?.allowUsers ?? []
  const allowChats = cfg?.allowChats ?? []
  if (allowUsers.length === 0 && allowChats.length === 0) return true
  const msg = update?.message ?? update?.edited_message ?? update?.callback_query?.message ?? null
  if (!msg) return false
  const fromId = String(update.message?.from?.id ?? update.edited_message?.from?.id
    ?? update.callback_query?.from?.id ?? '')
  const chatId = String(msg.chat?.id ?? '')
  const okUser = allowUsers.length === 0 || allowUsers.includes(fromId)
  const okChat = allowChats.length === 0 || allowChats.includes(chatId)
  return okUser && okChat
}

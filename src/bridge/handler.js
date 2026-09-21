// Teleforge — update handler: secret verification, whitelist check, and dispatch to
// the agent driver per chat. Host-side package form (uses ctx.web + Session events).
//
// An inbound Telegram update is a POST with a JSON `update` object. We:
//   1. verify X-Telegram-Bot-Api-Secret-Token (anti-forgery);
//   2. read & parse the JSON body, then ACK 200 immediately so Telegram won't retry;
//   3. run the rest async: whitelist gate, bot commands (/start /help /status), else
//      forward the user's text into the per-chat agent and relay the streamed reply.

export function isAuthorized(update, config) {
  const allowUsers = config?.allowUsers ?? []
  const allowChats = config?.allowChats ?? []
  if (allowUsers.length === 0 && allowChats.length === 0) return true
  const msg = update?.message ?? update?.edited_message ?? update?.callback_query?.message ?? null
  if (!msg) return false
  const fromId = String(
    update.message?.from?.id ?? update.edited_message?.from?.id
    ?? update.callback_query?.from?.id ?? '',
  )
  const chatId = String(msg.chat?.id ?? '')
  const okUser = allowUsers.length === 0 || allowUsers.includes(fromId)
  const okChat = allowChats.length === 0 || allowChats.includes(chatId)
  return okUser && okChat
}

/**
 * Build the async dispatcher wired to a driver + renderer + telegram bridge.
 * Returns a function `(update, { reply }) => Promise<void>`.
 */
export function createDispatcher({ driver, renderer, telegram, config }) {
  const commands = {
    '/start': () => 'Teleforge 已就绪 ✅ 直接发消息即可与 DSH agent 对话。',
    '/help': () => '发送任意文本与我对话；/status 查看状态。',
    '/status': () => `Teleforge 运行中。活动会话数：${driver.sizes ?? 0}`,
  }

  return async function dispatch(update) {
    // Whitelist gate: drop un-authorized senders early (before any agent work).
    if (!isAuthorized(update, config)) {
      console.log('[teleforge] rejected unauthorized update from', update.message?.from?.id)
      return
    }

    // Bot commands / command messages
    const text = update.message?.text ?? update.edited_message?.text ?? null
    if (typeof text === 'string') {
      const trimmed = text.trim()
      if (trimmed.startsWith('/')) {
        const [cmd] = trimmed.split(/\s+/, 1)
        const handler = commands[cmd]
        if (handler) {
          const reply = handler()
          await telegram.sendMessage(update.message.chat.id, reply, { parse_mode: config.parseMode })
          return
        }
      }
    }

    // Regular user message -> send to per-chat agent.
    if (typeof text === 'string' && text.trim().length > 0) {
      const chatId = update.message?.chat?.id ?? update.edited_message?.chat?.id
      if (chatId == null) return
      let handle
      try {
        handle = await driver.sessionFor(chatId)
      } catch (err) {
        console.error('[teleforge] sessionFor failed:', err)
        await telegram.sendMessage(chatId, '会话创建失败，请稍后再试。').catch(() => {})
        return
      }
      // Ensure a session-event listener exists for this chat BEFORE submitting.
      const key = `chat:${chatId}`
      if (!dispatch._subscribed?.has(key)) {
        dispatch._subscribed ??= new Set()
        dispatch._subscribed.add(key)
        driver.onSessionEvent(chatId, (event) => {
          // Return the promise so callers can await dispatch completion (prevents
          // interleaving when events are processed in a tight loop).
          return renderer.onEvent(chatId, event, driver).catch(err => {
            console.error('[teleforge] renderer error:', err)
          })
        })
      }
      driver.submit(chatId, text)
    }
  }
}

/**
 * Handle one inbound webhook request. Returns the HTTP-status/json action the
 * route should perform; we ACK 200 fast and dispatch async.
 * `onUpdate` is the dispatcher entry (async).
 */
export async function handleUpdate(req, res, { secretToken = '', onUpdate }) {
  const resJson = (code, body) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
    return Promise.resolve()
  }

  if (secretToken && req.headers['x-telegram-bot-api-secret-token'] !== secretToken) {
    return resJson(403, { ok: false, error: 'invalid secret token' })
  }

  let raw = ''
  for await (const chunk of req) raw += chunk

  let update
  try {
    update = JSON.parse(raw)
  } catch {
    return resJson(400, { ok: false, error: 'bad json' })
  }

  // ACK 200 immediately so Telegram won't retry; process the update async.
  await resJson(200, { ok: true })

  try {
    await onUpdate(update)
  } catch (err) {
    console.error('[teleforge] update handler error:', err)
  }
}

// Teleforge — Telegram Bot API wrapper (HOST-SIDE PACKAGE).
//
// P0-FORM-DECISION RESOLVED: this is an ordinary host package (real Node process,
// NOT the cordis_define sandbox). Therefore outbound is simply **global fetch POST**.
//
// (Background: dynamic cordis plugins trap global fetch and their ctx.web is a GET-only
//  fetch seam, which is why sending to api.telegram.org seemed blocked. Host packages
//  like packages/llm/llm-deepseek use global fetch POST directly — see DESIGN.md.)
//
// Telegram Bot API is base-url /bot<TOKEN>/<method>, always POST (application/json or
// multipart for media). This wrapper is thin: one fetch POST per method.

export function createTelegramBridge({ botToken }) {
  const base = `https://api.telegram.org/bot${botToken}`

  async function call(method, payload) {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))
    if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`)
    return json.result
  }

  return {
    ready: Boolean(botToken),
    sendMessage(chatId, text, { parse_mode, reply_to_message_id, edit: editMessageId } = {}) {
      const payload = { chat_id: chatId, text }
      if (parse_mode) payload.parse_mode = parse_mode
      if (reply_to_message_id != null) payload.reply_to_message_id = reply_to_message_id
      if (editMessageId != null) payload.message_id = editMessageId
      return call(editMessageId ? 'editMessageText' : 'sendMessage', payload)
    },
    sendChatAction(chatId, action = 'typing') {
      return call('sendChatAction', { chat_id: chatId, action })
    },
    // P5: sendPhoto(chatId, photo) / sendDocument(...) / answerCallbackQuery(...)
  }
}

// Repro: match the integration test EXACTLY (mock message_id grows with tgOut.length,
// parseMode HTML) to isolate why the first paragraph is sent 3x.
import { createReplyRenderer } from '../src/agent/renderer.js'

const tgOut = []
const telegram = {
  async sendMessage(chatId, text, opts) {
    // integration mock: push to tgOut, return message_id = tgOut.length
    const url = opts?.edit ? 'editMessageText' : 'sendMessage'
    tgOut.push({ url: 'https://api.telegram.org/botX/' + url, body: { chat_id: chatId, text, ...opts } })
    return { message_id: tgOut.length }
  },
  async sendChatAction() { tgOut.push({ url: 'https://api.telegram.org/botX/sendChatAction', body: {} }) },
}

const r = createReplyRenderer(telegram, {
  mode: 'stream',
  streamChunk: 'paragraph',
  fallbackToFull: true,
  maxMessageChars: 4096,
  typingIntervalMs: 5000,
  parseMode: 'HTML',
})

const chatId = 7
await r.onEvent(chatId, { type: 'turn/start', turn: 1 }, {})
await r.onEvent(chatId, { type: 'assistant/chunk', chunk: { type: 'text', text: '你好，我是你的 agent。\n\n' } }, {})
await r.onEvent(chatId, { type: 'assistant/chunk', chunk: { type: 'text', text: '这是一段流式回复。' } }, {})
await r.onEvent(chatId, { type: 'turn/end', turn: 1, reason: 'completed' }, {})

console.log(JSON.stringify(tgOut, null, 1))
console.log('sendMessage count:', tgOut.filter(x => x.url.endsWith('sendMessage')).length)

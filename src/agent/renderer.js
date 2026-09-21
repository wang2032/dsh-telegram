// Teleforge — outbound reply renderer: full vs streaming.
// Consumes Session events (assistant/chunk, assistant/message, turn/end) from the
// driver and maps them to Telegram messages through the Telegram bridge.
//
// Strategy (config-driven, default 'stream', long replies fall back to full):
//   full:
//     - wait for the turn's final assistant text, send ONE sendMessage.
//   stream:
//     - sendChatAction('typing') up front, then flush complete paragraphs/sentences as
//       they accumulate; each paragraph becomes its own sendMessage (or is appended to
//       the previous message when short). Incomplete trailing text stays buffered until
//       the next chunk or turn/end. On turn/end, anything not yet flushed is sent.

export function createReplyRenderer(telegram, options) {
  options = options ?? {}
  const mode = options.mode ?? 'stream'
  const chunkBy = options.streamChunk ?? 'paragraph'
  const fallbackToFull = options.fallbackToFull ?? true
  const maxMessageChars = options.maxMessageChars ?? 4096
  const typingIntervalMs = options.typingIntervalMs ?? 5000

  // chatId -> { id, total, buffer, lastMsgId, lastSent, sentAnything, typingTimer }
  const turns = new Map()
  // monotonic turn counter so stale/overlapping turn/end events can be ignored.
  let turnSeq = 0

  // Paragraph boundary detection: blank line ("\n\n") or end.
  function hasCompleteParagraph(buffer) {
    if (chunkBy === 'sentence') {
      return /[。．！？!?]$/.test(buffer)
    }
    return buffer.includes('\n\n')
  }

  // Extract the longest complete paragraph prefix (or final text if buffer ends clean).
  function takeCompleteChunk(buffer) {
    if (chunkBy === 'sentence') {
      const m = buffer.match(/^.*?[。．！？!?](\s*)/)
      if (m) return { chunk: m[0].trim(), rest: buffer.slice(m[0].length) }
      return { chunk: '', rest: buffer }
    }
    const idx = buffer.indexOf('\n\n')
    if (idx !== -1) {
      return { chunk: buffer.slice(0, idx).trim(), rest: buffer.slice(idx + 2) }
    }
    return { chunk: '', rest: buffer }
  }

  function startTyping(chatId) {
    const turn = turns.get(chatId)
    turn.typingTimer = setInterval(() => {
      telegram.sendChatAction(chatId, 'typing').catch(() => {})
    }, typingIntervalMs)
    telegram.sendChatAction(chatId, 'typing').catch(() => {})
  }
  function stopTyping(chatId) {
    const turn = turns.get(chatId)
    if (turn?.typingTimer) clearInterval(turn.typingTimer)
  }

  async function sendText(chatId, turn, text) {
    const trimmed = text.trim()
    if (!trimmed) return
    // Try to append to the previous message when it keeps us under the limit.
    if (turn.lastMsgId !== undefined && (turn.lastSent + '\n\n' + trimmed).length <= maxMessageChars) {
      const combined = turn.lastSent + '\n\n' + trimmed
      const result = await telegram.sendMessage(chatId, combined, {
        parse_mode: options.parseMode,
        edit: turn.lastMsgId,
      })
      turn.lastSent = combined
      turn.lastMsgId = result?.message_id ?? turn.lastMsgId
      turn.sentAnything = true
    } else {
      const result = await telegram.sendMessage(chatId, trimmed, { parse_mode: options.parseMode })
      turn.lastMsgId = result?.message_id ?? result
      turn.lastSent = trimmed
      turn.sentAnything = true
    }
  }

  async function flushBuffer(chatId, turn, force = false) {
    // Drain complete chunks from the buffer, preserving any incomplete tail.
    while (turn.buffer) {
      const { chunk, rest } = takeCompleteChunk(turn.buffer)
      if (chunk) await sendText(chatId, turn, chunk)
      if (rest === turn.buffer) break // no progress -> keep tail buffered
      turn.buffer = rest
    }
    // When forcing (assistant/message or turn/end), flush whatever tail remains as a unit.
    if (force && turn.buffer && turn.buffer.trim()) {
      await sendText(chatId, turn, turn.buffer)
      turn.buffer = ''
    }
  }

  /** Handle one SessionEvent for a chat. */
  async function onEvent(chatId, event, driver) {
    switch (event.type) {
      case 'turn/start': {
        // A turn/start is the authoritative boundary. Take the DSH turn id when
        // provided, else fall back to a renderer-local seq (events with no id are
        // still accepted for backward compatibility).
        const id = event.turn ?? ++turnSeq
        turns.set(chatId, { id, total: '', buffer: '', lastMsgId: undefined, lastSent: '', sentAnything: false, typingTimer: undefined })
        if (mode === 'stream') startTyping(chatId)
        break
      }
      case 'assistant/chunk': {
        const turn = turns.get(chatId)
        if (!turn) return
        if (event.turn != null && event.turn !== turn.id) return // stale chunk from an older turn
        const chunkText = extractChunkText(event.chunk ?? event)
        if (!chunkText) return
        turn.total += chunkText
        turn.buffer += chunkText
        if (mode === 'stream') await flushBuffer(chatId, turn, false)
        break
      }
      case 'assistant/message': {
        const turn = turns.get(chatId)
        if (!turn) return
        if (event.turn != null && event.turn !== turn.id) return // stale message from an older turn
        const full = extractAssembledText(event)
        if (full) { turn.total = full; turn.buffer = full }
        if (mode === 'full') {
          await telegram.sendMessage(chatId, full, { parse_mode: options.parseMode })
          turn.sentAnything = true
        } else {
          await flushBuffer(chatId, turn, true)
        }
        break
      }
      case 'turn/end': {
        const turn = turns.get(chatId)
        if (!turn) return
        if (event.turn != null && event.turn !== turn.id) return // stale end from an older turn
        if (mode === 'stream') {
          await flushBuffer(chatId, turn, true)
          if (fallbackToFull && turn.total && !turn.sentAnything) {
            // Nothing streamed yet — send the whole reply as one message.
            await telegram.sendMessage(chatId, turn.total, { parse_mode: options.parseMode })
            turn.sentAnything = true
          }
        }
        stopTyping(chatId)
        turns.delete(chatId)
        break
      }
      default:
        break
    }
  }

  return {
    onEvent,
    mode,
  }
}

function extractChunkText(chunk) {
  if (!chunk || typeof chunk !== 'object') return ''
  if (typeof chunk.text === 'string') return chunk.text
  if (chunk.content && typeof chunk.content === 'string') return chunk.content
  if (Array.isArray(chunk.content)) {
    return chunk.content.map(b => (b && typeof b.text === 'string') ? b.text : '').join('')
  }
  return ''
}

function extractAssembledText(event) {
  const msg = event.message ?? event.content
  if (!msg) return ''
  if (typeof msg === 'string') return msg
  if (Array.isArray(msg)) return msg.map(b => (b && typeof b.text === 'string') ? b.text : '').join('')
  if (typeof msg.text === 'string') return msg.text
  if (Array.isArray(msg.content)) return msg.content.map(b => (b && typeof b.text === 'string') ? b.text : '').join('')
  return ''
}

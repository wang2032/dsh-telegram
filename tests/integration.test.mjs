// Teleforge integration test — runs the REAL plugin tree (code.host.apply + all
// bridge/agent/tools modules) against a real node:http server, mocking ONLY the
// DSH workspace services (webServer impl, agents, tools, ctx facade) and the
// network fetch. This is how we test "without mounting into DSH".
//
// Run: bun tests/integration.test.mjs   (uses gitignored ./node_modules stubs)

import assert from 'node:assert/strict'
import http from 'node:http'

// ---- 1. Real webServer: a node:http server with a register() matching ctx.webServer ----
const routes = new Map()
const register = (route) => {
  routes.set(route.path, route.handler)
  return () => routes.delete(route.path)
}
const server = http.createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://x').pathname)
  if (!handler) { res.statusCode = 404; res.end(); return }
  handler(req, res)
})
const webServer = { register }

// ---- 2. Mock DSH services ----
const toolRegistrations = []
// Track every agents.create call so we can assert session dedup under concurrency.
const createdAgents = []
const agents = {
  async create({ sessionId }) {
    createdAgents.push(sessionId)
    // Small delay so two rapid messages to the SAME chat can interleave inside
    // sessionFor() — this is what the in-flight dedup guard must survive.
    await new Promise(r => setTimeout(r, 8))
    return { agent: { id: sessionId, followup(m) { agents._lastFollowup = { sessionId, m } }, inject() {} }, dispose: async () => {} }
  },
}
const tools = { register(t) { toolRegistrations.push(t); return () => {} } }
const ctxListeners = {}
const effectDisposers = []
const ctx = {
  get: (name) => ({ webServer, agents, tools }[name]),
  // Real ctx.effect registers a teardown disposer WITHOUT running it now.
  effect: (fn) => { effectDisposers.push(fn); return () => {} },
  on: (name, l) => { (ctxListeners[name] ??= []).push(l); return () => {} },
}

// ---- 3. Capture Telegram outbound (mock global fetch, but ONLY for api.telegram.org) ----
const realFetch = globalThis.fetch
const tgOut = []
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.telegram.org')) {
    tgOut.push({ url, method: opts.method, body: JSON.parse(opts.body) })
    return { status: 200, json: async () => ({ ok: true, result: { message_id: tgOut.length } }) }
  }
  return realFetch(url, opts) // local webhook etc. -> real network
}

// ---- 4. Mount the real plugin ----
const plugin = await import('../src/code.host.js')
plugin.apply(ctx, {
  botToken: '123456:TESTabc_SECRET_xyz',
  webhookSecret: 's3cret',
  allowUsers: ['42'],
  allowChats: [],
  parseMode: 'HTML',
  reply: { mode: 'stream', streamChunk: 'paragraph' },
  webhookPath: '/telegram/webhook',
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

// ---- 5. Helper: POST a synthetic Telegram update to the real webhook ----
async function postUpdate(update, secret = 's3cret') {
  const res = await fetch(base + '/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(update),
  })
  return res
}

// ---- T1: wrong secret -> 403 ----
{
  const res = await postUpdate({ message: { from: { id: 42 }, chat: { id: 7 }, text: 'hi' } }, 'wrong')
  assert.equal(res.status, 403, 'wrong secret must be 403')
  console.log('T1 wrong secret ->', res.status, 'OK')
}

// ---- T2: unauthorized sender acked 200, NOT submitted to agent ----
{
  agents._lastFollowup = undefined
  const res = await postUpdate({ message: { from: { id: 99 }, chat: { id: 7 }, text: 'hi' } }, 's3cret')
  assert.equal(res.status, 200)
  assert.equal(agents._lastFollowup, undefined, 'unauthorized must not be submitted')
  console.log('T2 unauthorized -> 200 + no submit OK')
}

// ---- T3: authorized text -> driver.submit received a UserMessage ----
{
  agents._lastFollowup = undefined
  const res = await postUpdate({ message: { from: { id: 42 }, chat: { id: 7 }, message_id: 1, text: '你好' } }, 's3cret')
  assert.equal(res.status, 200)
  await new Promise(r => setTimeout(r, 30)) // let the async dispatch (create+submit) settle
  // dispatcher calls driver.submit -> handle.agent.followup
  assert.ok(agents._lastFollowup, 'authorized text must be submitted')
  const msg = agents._lastFollowup.m
  assert.equal(msg.role, 'user')
  assert.equal(msg.content[0].text, '你好')
  console.log('T3 authorized text submitted:', JSON.stringify({ role: msg.role, text: msg.content[0].text }), 'OK')
}

// ---- T4: drive a full turn via session/event -> telegram_send outbound ----
{
  tgOut.length = 0
  const chatId = 7
  const sessionId = 'teleforge:chat:7'
  // Emit a turn for this chat through ctx.on('session/event') listener.
  const emit = async (event) => {
    const prom = []
    for (const l of (ctxListeners['session/event'] ?? [])) prom.push(l({ id: sessionId }, event))
    await Promise.all(prom) // await each listener's dispatched work before moving on
  }
  await emit({ type: 'turn/start', turn: 1 })
  await emit({ type: 'assistant/chunk', chunk: { type: 'text', text: '你好，我是你的 agent。\n\n' } })
  await emit({ type: 'assistant/chunk', chunk: { type: 'text', text: '这是一段流式回复。' } })
  await emit({ type: 'turn/end', turn: 1, reason: 'completed' })

  const sends = tgOut.filter(o => /sendMessage$/.test(o.url))
  assert.ok(sends.length >= 1, 'must send at least one Telegram message')
  assert.equal(sends[0].body.chat_id, chatId)
  assert.ok(sends[0].body.text.length > 0)
  console.log('T4 full turn -> Telegram sends:', sends.map(s => s.body.text).join(' | '), 'OK')
}

// ---- T5: push tool registered ----
{
  const names = toolRegistrations.map(t => t.name)
  assert.ok(names.includes('telegram_send'), 'telegram_send tool must be registered')
  console.log('T5 tools registered:', names.join(', '), 'OK')
}

// ---- T6: /status command -> Telegram reply ----
{
  tgOut.length = 0
  const res = await postUpdate({ message: { from: { id: 42 }, chat: { id: 7 }, message_id: 2, text: '/status' } }, 's3cret')
  assert.equal(res.status, 200)
  await new Promise(r => setTimeout(r, 20))
  const statusMsg = tgOut.find(o => /sendMessage$/.test(o.url) && /运行中/.test(o.body.text))
  assert.ok(statusMsg, '/status should reply')
  console.log('T6 /status reply:', statusMsg.body.text, 'OK')
}

// ---- T7: same-chat concurrent messages -> ONE session, no duplicate agent ----
{
  createdAgents.length = 0
  agents._lastFollowup = undefined
  const chatId = 77 // fresh chat: no pre-existing session
  // Fire two updates for the same chat as fast as possible (concurrent dispatches).
  const p1 = postUpdate({ message: { from: { id: 42 }, chat: { id: chatId }, message_id: 10, text: '第一条' } }, 's3cret')
  const p2 = postUpdate({ message: { from: { id: 42 }, chat: { id: chatId }, message_id: 11, text: '第二条' } }, 's3cret')
  await Promise.all([p1, p2])
  await new Promise(r => setTimeout(r, 30)) // let both dispatches settle
  const createdFor77 = createdAgents.filter(s => s === `teleforge:chat:${chatId}`)
  assert.equal(createdFor77.length, 1,
    `same-chat concurrent messages must create exactly ONE agent (got ${createdFor77.length})`)
  assert.ok(agents._lastFollowup, 'must have submitted a message')
  assert.equal(agents._lastFollowup.sessionId, `teleforge:chat:${chatId}`)
  console.log('T7 same-chat concurrent -> agents created for chat', chatId, ':', createdFor77.length, 'OK')
}

// ---- T8: multi-user isolation — user A (chat 7) and user B (chat 8) never cross ----
{
  createdAgents.length = 0
  // B posts to a fresh chat 8 -> must get its own agent session (chat 7's already exists).
  await postUpdate({ message: { from: { id: 42 }, chat: { id: 8 }, message_id: 21, text: '给B' } }, 's3cret')
  await new Promise(r => setTimeout(r, 40))
  const for8 = createdAgents.filter(s => s === 'teleforge:chat:8')
  assert.equal(for8.length, 1, 'chat 8 must create its own session')
  // Drive a turn for chat 8 and assert the reply goes to chat 8, never chat 7.
  tgOut.length = 0
  const emit = async (sessionId, events) => {
    for (const ev of events) {
      const prom = []
      for (const l of (ctxListeners['session/event'] ?? [])) prom.push(l({ id: sessionId }, ev))
      await Promise.all(prom)
    }
  }
  await emit('teleforge:chat:8', [
    { type: 'turn/start', turn: 1 },
    { type: 'assistant/chunk', chunk: { type: 'text', text: 'B的回复。\n\n' } },
    { type: 'turn/end', turn: 1, reason: 'completed' },
  ])
  const toChat8 = tgOut.filter(o => /sendMessage$/.test(o.url) && o.body.chat_id === 8)
  const toChat7 = tgOut.filter(o => /sendMessage$/.test(o.url) && o.body.chat_id === 7)
  assert.ok(toChat8.length >= 1, 'B reply must go to chat 8')
  assert.equal(toChat7.length, 0, 'cross-talk: B reply must NOT go to chat 7')
  console.log('T8 multi-user isolation -> B(8) got', toChat8.length, 'msg(s), chat7 got', toChat7.length, 'OK')
}

server.close()
console.log('\n✅ 全部集成测试通过（未接入 DSH，mock 了 DSH services + 网络 fetch）')

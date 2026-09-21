// Teleforge — session/inbox driver: inject an inbound Telegram message into a
// per-chat DSH agent and stream the reply events back. Per-chat session isolation.
//
// P0-verified surface (host-side package form):
//   - ctx.agents (AgentRegistry): await ctx.agents.create({ sessionId, meta, agentOptions })
//       -> AgentHandle { agent, dispose() }
//   - Drive: agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
//       (or agent.inject(...) to add context without waking)
//   - Stream: ctx.on('session/event', (session, event) => ...) then filter by session.id;
//       watch 'assistant/chunk', 'assistant/message', 'turn/end' (see SessionEventMap).
//   - createUserMessage from @deepseek-ai/dsh-llm.
//
// Session ids are derived deterministically from the Telegram chat id so a restarted
// Host can resume the same chat's history (when persistence is configured) — or we
// keep them in-memory only if persistence is absent.

import { createUserMessage } from '@deepseek-ai/dsh-llm'

const SESSION_PREFIX = 'teleforge:chat:'

function sessionIdForChat(chatId) {
  // Deterministic, filesystem-friendly session id per Telegram chat.
  return SESSION_PREFIX + String(chatId)
}

export function createAgentDriver(ctx, agents, options) {
  options = options ?? {}
  // chatId -> AgentHandle
  const sessions = new Map()
  // in-flight create promises keyed by session id: dedupes concurrent sessionFor()
  // calls for the SAME chat so we never create two agents for one user (a
  // check-then-act race would otherwise let two rapid messages each pass the
  // `sessions.get(id) === undefined` check and both call agents.create).
  const pending = new Map()

  /** Create (or reuse) one live Agent for a Telegram chat. */
  async function sessionFor(chatId, extraSource = {}) {
    const id = sessionIdForChat(chatId)
    const cached = sessions.get(id)
    if (cached !== undefined) return cached
    const inflight = pending.get(id)
    if (inflight) return inflight
    const p = (async () => {
      const handle = await agents.create({
        sessionId: id,
        meta: {
          cwd: options.cwd, // optional workspace root for the chat's agent
          ...(extraSource.parentSession ? { parentSession: extraSource.parentSession } : {}),
        },
        agentOptions: options.agentOptions, // { provider, model, maxTokens }
      })
      sessions.set(id, handle)
      return handle
    })()
    pending.set(id, p)
    try {
      return await p
    } finally {
      pending.delete(id)
    }
  }

  /** Submit one user message as an ordinary follow-up turn and wake the driver. */
  function submit(chatId, text) {
    const id = sessionIdForChat(chatId)
    const handle = sessions.get(id)
    if (!handle) throw new Error(`no session for chat ${chatId}: call sessionFor() first`)
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    return handle
  }

  /** Inject model-facing context without waking (for notices/notifications). */
  function inject(chatId, text) {
    const id = sessionIdForChat(chatId)
    const handle = sessions.get(id)
    if (!handle) return
    handle.agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
  }

  /** Register a listener for one chat's session events; returns an unsubscribe. */
  function onSessionEvent(chatId, listener) {
    const id = sessionIdForChat(chatId)
    // session/event is scope-filtered, but we filter by id to be explicit.
    return ctx.on('session/event', (session, event) => {
      if (session.id !== id) return
      return listener(event, session)
    })
  }

  /** Tear down every session created by this driver. */
  async function disposeAll() {
    await Promise.allSettled([...sessions.values()].map(h => h.dispose()))
    sessions.clear()
  }

  return {
    sessionFor,
    submit,
    inject,
    onSessionEvent,
    disposeAll,
    get sizes() { return sessions.size },
  }
}

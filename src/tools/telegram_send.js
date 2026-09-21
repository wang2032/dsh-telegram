// Teleforge — telegram_send push tool. Host-side package form.
//
// Builds a DSH ToolDefinition via defineTool (@deepseek-ai/dsh-tools) and the caller
// registers it with ctx.tools.register(tool). This runs inside the DSH host where the
// @deepseek-ai packages resolve; see code.host.js step 6.
//
// Lets the DSH agent actively push messages to a user's Telegram from ANY session
// (task-completion notices, async notifications, approval requests).

import { defineTool } from '@deepseek-ai/dsh-tools'

export function createPushTool(telegram, options = {}) {
  const allowUsers = options.allowUsers ?? []

  return defineTool({
    name: 'telegram_send',
    description: "Send a message to a user's Telegram via the Teleforge bridge (DSH <-> Telegram).",
    parameters: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'Telegram chat id to deliver to; if omitted, uses the caller whitelist default.',
        },
        text: { type: 'string', description: 'Message text (plain text; MarkdownV2/HTML via parse_mode).' },
        parse_mode: { type: 'string', enum: ['None', 'MarkdownV2', 'HTML'], default: 'None' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, message_id: { type: 'integer' } },
      },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value ?? {}) }]
      },
    },
    async execute({ chat_id, text, parse_mode }) {
      // Resolve target chat: explicit chat_id wins; else first whitelisted.
      let target = chat_id
      if (!target) {
        if (allowUsers.length === 0) throw new Error('telegram_send needs chat_id when no allowUsers default is set')
        target = allowUsers[0]
      }
      const pm = parse_mode && parse_mode !== 'None' ? parse_mode : undefined
      const result = await telegram.sendMessage(target, text, { parse_mode: pm })
      return { ok: true, message_id: result?.message_id ?? null }
    },
  })
}

// Teleforge — webhook route registration on ctx.webServer.
// Registered path: /telegram/webhook (exact). Streams the raw body to handleUpdate.
//
// Host-side package form: `webServer.register(...)` returns a disposer; wrap in
// ctx.effect(...) so the route is torn down when the plugin stops (mirrors
// frontend-static's registerFallback usage).

import { handleUpdate } from './handler.js'

/**
 * Register the /telegram/webhook route on the webServer.
 * @param webServer - ctx.webServer service (inject).
 * @param options - { path, secretToken, onUpdate } where onUpdate is the async dispatcher.
 * @returns a disposer removing the route.
 */
export function registerWebhook(webServer, { path = '/telegram/webhook', secretToken = '', onUpdate }) {
  return webServer.register({
    kind: 'exact',
    path,
    handler(req, res) {
      return handleUpdate(req, res, { secretToken, onUpdate })
    },
  })
}

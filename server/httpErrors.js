/**
 * Centralized HTTP error helpers for route handlers.
 *
 * Goal: stop the same `try { ... } catch (e) { console.error(...); res.status(500).json(...) }`
 * boilerplate from being hand-copied at every route. This does NOT change any existing route —
 * it's an opt-in helper for new routes and for gradually migrating old ones.
 *
 * Usage:
 *   app.get('/api/widgets', asyncRoute(async (req, res) => {
 *     const rows = await loadWidgets();
 *     res.json({ ok: true, rows });
 *   }, { context: 'widgets.list', fallbackMessage: 'Could not load widgets.' }));
 *
 * A thrown HttpError (or one returned by httpError(status, message)) is sent with its own
 * status/message. Any other thrown error is logged with `context` and sent as a generic 500
 * using `fallbackMessage` — never leaking internal error text to the client.
 */

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export function httpError(status, message, details) {
  return new HttpError(status, message, details);
}

/**
 * Wrap an async Express route handler so thrown errors produce a consistent JSON response
 * instead of an unhandled rejection or one-off try/catch.
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: Function) => Promise<any>} handler
 * @param {{ context?: string, fallbackMessage?: string }} [opts]
 */
export function asyncRoute(handler, opts = {}) {
  const context = opts.context || handler.name || 'route';
  const fallbackMessage = opts.fallbackMessage || 'Request failed.';
  return async function wrappedRoute(req, res, next) {
    try {
      await handler(req, res, next);
    } catch (e) {
      if (e instanceof HttpError) {
        return res.status(e.status).json({ ok: false, error: e.message, ...(e.details ? { details: e.details } : {}) });
      }
      console.error(`[${context}]`, e);
      return res.status(500).json({ ok: false, error: fallbackMessage });
    }
  };
}

/**
 * Middleware for money-posting routes (Phase 2.1).
 *
 * - Runs the handler inside a treasury request context: user, client `Idempotency-Key`, and
 *   the confirmations the user gave (`treasuryConfirm` in the body).
 * - Idempotency: the first request with a key is stored as in-progress; a completed success
 *   is replayed for the same (user, route, key); a concurrent repeat gets 409. Refusals and
 *   errors release the key so the user can confirm and resend with the same key.
 * - A refused posting (date reason, floor, duplicate, strict cache, correction reason) gets
 *   `code` + `confirmRequired: { code, message, details }` so the SPA knows what to ask.
 */
import {
  treasuryIdempotencyRowId,
} from '../finance/treasuryBalanceIntegrityOps.js';
import {
  runWithTreasuryContext,
  treasuryConfirmationsFromBody,
} from '../finance/treasuryRequestContext.js';

const IN_PROGRESS_STALE_MS = 2 * 60 * 1000;

function idempotencyTableReady(db) {
  try {
    db.prepare(`SELECT 1 FROM treasury_idempotency_keys LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} routeKey stable name for the route (keys are scoped per user + route)
 * @param {{ idempotent?: boolean }} [opts]
 */
export function treasuryMoneyRoute(db, routeKey, opts = {}) {
  const idempotent = opts.idempotent !== false;
  return (req, res, next) => {
    const key = String(req.get?.('Idempotency-Key') || '').trim().slice(0, 200);
    const userId = req.user?.id != null ? String(req.user.id) : '';
    const ctx = {
      actor: req.user || null,
      idempotencyKey: key,
      confirmations: treasuryConfirmationsFromBody(req.body),
    };
    runWithTreasuryContext(ctx, () => {
      let rowId = null;
      if (idempotent && key && userId && idempotencyTableReady(db)) {
        rowId = treasuryIdempotencyRowId(userId, routeKey, key);
        const existing = db.prepare(`SELECT * FROM treasury_idempotency_keys WHERE id = ?`).get(rowId);
        if (existing?.status === 'completed' && existing.response_json) {
          res.set('Idempotent-Replay', 'true');
          let body;
          try {
            body = JSON.parse(String(existing.response_json));
          } catch {
            body = { ok: true };
          }
          return res.status(Number(existing.http_status) || 200).json(body);
        }
        if (existing?.status === 'in_progress') {
          const age = Date.now() - Date.parse(String(existing.created_at_iso || ''));
          if (Number.isFinite(age) && age < IN_PROGRESS_STALE_MS) {
            return res.status(409).json({
              ok: false,
              code: 'IDEMPOTENCY_IN_PROGRESS',
              error: 'This payment is still being saved. Wait a moment, then refresh before trying again.',
            });
          }
          db.prepare(`DELETE FROM treasury_idempotency_keys WHERE id = ?`).run(rowId);
        }
        try {
          db.prepare(
            `INSERT INTO treasury_idempotency_keys (id, user_id, route_key, idem_key, status, created_at_iso)
             VALUES (?,?,?,?,?,?)`
          ).run(rowId, userId, routeKey, key, 'in_progress', new Date().toISOString());
        } catch {
          return res.status(409).json({
            ok: false,
            code: 'IDEMPOTENCY_IN_PROGRESS',
            error: 'This payment is still being saved. Wait a moment, then refresh before trying again.',
          });
        }
      }

      const origJson = res.json.bind(res);
      res.json = (body) => {
        let out = body;
        if (out && typeof out === 'object' && out.ok === false && ctx.lastRefusal) {
          out = { ...out, code: out.code || ctx.lastRefusal.code, confirmRequired: ctx.lastRefusal };
        }
        if (rowId) {
          const success = res.statusCode < 300 && !(out && typeof out === 'object' && out.ok === false);
          try {
            if (success) {
              db.prepare(
                `UPDATE treasury_idempotency_keys
                 SET status = 'completed', http_status = ?, response_json = ?, completed_at_iso = ?
                 WHERE id = ?`
              ).run(res.statusCode || 200, JSON.stringify(out ?? null), new Date().toISOString(), rowId);
            } else {
              db.prepare(`DELETE FROM treasury_idempotency_keys WHERE id = ?`).run(rowId);
            }
          } catch {
            /* key bookkeeping must not change the response */
          }
          rowId = null;
        }
        return origJson(out);
      };
      return next();
    });
  };
}

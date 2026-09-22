/**
 * Admin/MD branch refund lock window (quotations + receipts in a from–to date range).
 * Other branches and transactions outside the window stay refundable.
 */
import { actorId, actorName } from '../auth.js';
import { appendAuditLog } from '../controlOps.js';
import { invalidateBranchListCache } from '../branches.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { userMayBlockBranchRefunds } from '../../shared/workspaceGovernance.js';
import {
  BRANCH_REFUNDS_BLOCK_REASON_MIN_LEN,
  calendarDayFromIso,
  normalizeBranchRefundsBlockedFromIso,
  normalizeBranchRefundsBlockedToIso,
} from '../../shared/lib/branchRefundFreeze.js';
import { loadBranchRefundFreeze } from './branchRefundFreeze.js';

function freezeColumnsReady(db) {
  return hasColumn(db, 'branches', 'refunds_blocked_from_iso');
}

function toColumnReady(db) {
  return hasColumn(db, 'branches', 'refunds_blocked_to_iso');
}

/**
 * Admin sets or lifts a per-branch refund lock on quotations/receipts in a date window.
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @param {{
 *   blocked?: boolean;
 *   unblock?: boolean;
 *   fromISO?: string;
 *   from?: string;
 *   fromDate?: string;
 *   toISO?: string;
 *   to?: string;
 *   toDate?: string;
 *   reason?: string;
 *   note?: string;
 * }} payload
 * @param {object|null} actor
 */
export function setBranchRefundsBlocked(db, branchId, payload, actor) {
  if (!userMayBlockBranchRefunds(actor)) {
    return {
      ok: false,
      error: 'Blocking refunds for a branch requires Admin or Managing Director authority.',
      code: 'FORBIDDEN',
    };
  }
  const bid = String(branchId ?? '').trim();
  if (!bid) return { ok: false, error: 'Branch id is required.' };
  if (!freezeColumnsReady(db)) {
    return { ok: false, error: 'Branch refund freeze is not migrated yet. Run migrations.' };
  }
  const row = db.prepare(`SELECT id, name FROM branches WHERE id = ?`).get(bid);
  if (!row) return { ok: false, error: 'Branch not found.' };

  const unblock = payload.blocked === false || payload.blocked === 0 || payload.unblock === true;
  const reason = String(payload.reason ?? payload.note ?? '').trim();
  const now = new Date().toISOString();
  const prior = loadBranchRefundFreeze(db, bid);
  const hasTo = toColumnReady(db);

  if (!unblock) {
    const fromISO = normalizeBranchRefundsBlockedFromIso(
      payload.fromISO ?? payload.from ?? payload.fromDate
    );
    if (!fromISO) {
      return { ok: false, error: 'fromISO is required (YYYY-MM-DD), e.g. 2026-09-01.' };
    }
    const toRaw = payload.toISO ?? payload.to ?? payload.toDate;
    const toISO = toRaw == null || String(toRaw).trim() === '' ? '' : normalizeBranchRefundsBlockedToIso(toRaw);
    if (toRaw != null && String(toRaw).trim() !== '' && !toISO) {
      return { ok: false, error: 'toISO must be YYYY-MM-DD or a valid timestamp.' };
    }
    const fromDay = calendarDayFromIso(fromISO);
    const toDay = calendarDayFromIso(toISO);
    if (toDay && toDay < fromDay) {
      return { ok: false, error: 'toISO must be on or after fromISO.' };
    }
    if (reason.length < BRANCH_REFUNDS_BLOCK_REASON_MIN_LEN) {
      return {
        ok: false,
        error: `A reason of at least ${BRANCH_REFUNDS_BLOCK_REASON_MIN_LEN} characters is required when blocking refunds.`,
      };
    }
    db.transaction(() => {
      if (hasTo) {
        db.prepare(
          `UPDATE branches
           SET refunds_blocked_from_iso = ?,
               refunds_blocked_to_iso = ?,
               refunds_blocked_reason = ?,
               refunds_blocked_by_user_id = ?,
               refunds_blocked_by_name = ?,
               refunds_blocked_set_at_iso = ?
           WHERE id = ?`
        ).run(fromISO, toISO || null, reason, actorId(actor), actorName(actor), now, bid);
      } else {
        db.prepare(
          `UPDATE branches
           SET refunds_blocked_from_iso = ?,
               refunds_blocked_reason = ?,
               refunds_blocked_by_user_id = ?,
               refunds_blocked_by_name = ?,
               refunds_blocked_set_at_iso = ?
           WHERE id = ?`
        ).run(fromISO, reason, actorId(actor), actorName(actor), now, bid);
      }
      appendAuditLog(db, {
        actor,
        action: 'branch.refunds_block',
        entityKind: 'branch',
        entityId: bid,
        note: reason,
        details: {
          fromISO,
          toISO: toISO || null,
          priorFromISO: prior?.refundsBlockedFromISO || null,
          priorToISO: prior?.refundsBlockedToISO || null,
        },
      });
    })();
    invalidateBranchListCache();
    return {
      ok: true,
      blocked: true,
      branchId: bid,
      branchName: row.name,
      ...loadBranchRefundFreeze(db, bid),
    };
  }

  if (!prior?.refundsBlockedFromISO) {
    return { ok: false, error: 'Refunds are not blocked on this branch.' };
  }
  db.transaction(() => {
    if (hasTo) {
      db.prepare(
        `UPDATE branches
         SET refunds_blocked_from_iso = NULL,
             refunds_blocked_to_iso = NULL,
             refunds_blocked_reason = NULL,
             refunds_blocked_by_user_id = NULL,
             refunds_blocked_by_name = NULL,
             refunds_blocked_set_at_iso = NULL
         WHERE id = ?`
      ).run(bid);
    } else {
      db.prepare(
        `UPDATE branches
         SET refunds_blocked_from_iso = NULL,
             refunds_blocked_reason = NULL,
             refunds_blocked_by_user_id = NULL,
             refunds_blocked_by_name = NULL,
             refunds_blocked_set_at_iso = NULL
         WHERE id = ?`
      ).run(bid);
    }
    appendAuditLog(db, {
      actor,
      action: 'branch.refunds_unblock',
      entityKind: 'branch',
      entityId: bid,
      note: reason || 'Refunds unblocked',
      details: {
        priorFromISO: prior.refundsBlockedFromISO,
        priorToISO: prior.refundsBlockedToISO || null,
        priorReason: prior.refundsBlockedReason || null,
      },
    });
  })();
  invalidateBranchListCache();
  return { ok: true, blocked: false, branchId: bid, branchName: row.name };
}

export { loadBranchRefundFreeze };

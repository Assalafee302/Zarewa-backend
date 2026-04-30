/**
 * Branch-manager to branch-manager coordination requests (cross-branch).
 */
import crypto from 'node:crypto';
import { DEFAULT_BRANCH_ID, listBranches } from './branches.js';
import { actorId } from './auth.js';

function nowIso() {
  return new Date().toISOString();
}

function isBranchManagerUser(user) {
  const rk = String(user?.roleKey || '').trim().toLowerCase();
  return rk === 'sales_manager' || rk === 'branch_manager';
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function interBranchOfficeTableReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='office_inter_branch_requests'`).get()
    );
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {string} workspaceBranchId
 */
export function listInterBranchRequestsForUser(db, user, workspaceBranchId) {
  if (!interBranchOfficeTableReady(db)) return { ok: true, requests: [] };
  const bid = String(workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const rk = String(user?.roleKey || '').trim().toLowerCase();
  const all = rk === 'admin' || rk === 'md' || user?.permissions?.includes('*');
  const rows = all
    ? db
        .prepare(
          `SELECT * FROM office_inter_branch_requests ORDER BY created_at_iso DESC LIMIT 200`
        )
        .all()
    : db
        .prepare(
          `SELECT * FROM office_inter_branch_requests
           WHERE from_branch_id = ? OR to_branch_id = ?
           ORDER BY created_at_iso DESC LIMIT 200`
        )
        .all(bid, bid);
  return {
    ok: true,
    requests: rows.map((r) => ({
      id: r.id,
      fromBranchId: r.from_branch_id,
      toBranchId: r.to_branch_id,
      subject: r.subject,
      body: r.body,
      status: r.status,
      createdByUserId: r.created_by_user_id,
      createdAtIso: r.created_at_iso,
      updatedAtIso: r.updated_at_iso,
      resolvedAtIso: r.resolved_at_iso || '',
      resolvedNote: r.resolved_note || '',
    })),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ fromBranchId: string; toBranchId: string; subject: string; body: string }} payload
 * @param {object} user
 */
export function createInterBranchRequest(db, payload, user) {
  if (!interBranchOfficeTableReady(db)) {
    return { ok: false, error: 'Inter-branch requests are not available. Run migrations.' };
  }
  if (!isBranchManagerUser(user)) {
    return { ok: false, error: 'Only branch managers may create inter-branch requests.' };
  }
  const fromBranchId = String(payload?.fromBranchId || '').trim() || DEFAULT_BRANCH_ID;
  const toBranchId = String(payload?.toBranchId || '').trim();
  const subject = String(payload?.subject || '').trim();
  const body = String(payload?.body || '').trim();
  if (!toBranchId) return { ok: false, error: 'Destination branch is required.' };
  if (toBranchId === fromBranchId) return { ok: false, error: 'Choose a different branch.' };
  const branches = new Set(listBranches(db).map((b) => String(b.id || '').trim()).filter(Boolean));
  if (!branches.has(fromBranchId) || !branches.has(toBranchId)) {
    return { ok: false, error: 'Invalid branch id.' };
  }
  if (subject.length < 3) return { ok: false, error: 'Subject is required.' };
  if (body.length < 3) return { ok: false, error: 'Body is required.' };
  const uid = actorId(user);
  const t = nowIso();
  const id = `IBR-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  db.prepare(
    `INSERT INTO office_inter_branch_requests (
      id, from_branch_id, to_branch_id, subject, body, status, created_by_user_id, created_by_role_key, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    fromBranchId,
    toBranchId,
    subject,
    body,
    'open',
    uid,
    String(user?.roleKey || '').trim() || null,
    t,
    t
  );
  return { ok: true, id };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} requestId
 * @param {{ note?: string }} payload
 * @param {object} user
 * @param {string} workspaceBranchId
 */
export function resolveInterBranchRequest(db, requestId, payload, user, workspaceBranchId) {
  if (!interBranchOfficeTableReady(db)) return { ok: false, error: 'Not available.' };
  const rid = String(requestId || '').trim();
  const row = db.prepare(`SELECT * FROM office_inter_branch_requests WHERE id = ?`).get(rid);
  if (!row) return { ok: false, error: 'Request not found.' };
  const bid = String(workspaceBranchId || DEFAULT_BRANCH_ID).trim();
  const rk = String(user?.roleKey || '').trim().toLowerCase();
  const bm = isBranchManagerUser(user);
  const involved = row.from_branch_id === bid || row.to_branch_id === bid;
  if (!bm || !involved) {
    if (rk !== 'admin' && rk !== 'md') {
      return { ok: false, error: 'Only the involved branch manager may resolve this request.' };
    }
  }
  const note = String(payload?.note || '').trim();
  const t = nowIso();
  db.prepare(
    `UPDATE office_inter_branch_requests SET status = 'resolved', resolved_at_iso = ?, resolved_note = ?, updated_at_iso = ? WHERE id = ?`
  ).run(t, note || null, t, rid);
  return { ok: true };
}

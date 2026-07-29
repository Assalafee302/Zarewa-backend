/**
 * Branch shift handover notes — durable per-branch daily notes (not localStorage checklist).
 */
import crypto from 'node:crypto';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendAuditLog } from './controlOps.js';

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `BSN-${crypto.randomBytes(6).toString('hex')}`;
}

const NOTE_KINDS = new Set(['night', 'day']);

function asFlag(value) {
  return value ? 1 : 0;
}

function tableReady(db) {
  try {
    return Boolean(
      db
        .prepare(
          `SELECT 1 AS ok FROM information_schema.tables
           WHERE table_schema = DATABASE() AND table_name = 'branch_shift_notes'`
        )
        .get()
    );
  } catch {
    try {
      return Boolean(
        db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='branch_shift_notes'`).get()
      );
    } catch {
      return false;
    }
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string, shiftDate?: string, limit?: number }} [opts]
 */
export function listBranchShiftNotes(db, opts = {}) {
  if (!tableReady(db)) return [];
  const branchId = String(opts.branchId || '').trim();
  const shiftDate = String(opts.shiftDate || '').trim().slice(0, 10);
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 30));
  const args = [];
  let sql = `SELECT * FROM branch_shift_notes WHERE 1=1`;
  if (branchId) {
    sql += ` AND branch_id = ?`;
    args.push(branchId);
  }
  if (shiftDate) {
    sql += ` AND shift_date = ?`;
    args.push(shiftDate);
  }
  sql += ` ORDER BY shift_date DESC, created_at_iso DESC LIMIT ?`;
  args.push(limit);
  return db.prepare(sql).all(...args).map((row) => ({
    id: row.id,
    branchId: row.branch_id,
    shiftDate: row.shift_date,
    note: row.note,
    noteKind: row.note_kind || 'night',
    gatesOk: Boolean(row.gates_ok),
    cctvOk: Boolean(row.cctv_ok),
    cashOk: Boolean(row.cash_ok),
    keysOk: Boolean(row.keys_ok),
    incidentCode: row.incident_code || '',
    attachmentRef: row.attachment_ref || '',
    ...(String(row.note_kind || 'night') === 'night'
      ? {
          handoverChecks: {
            gatesOk: Boolean(row.gates_ok),
            cctvOk: Boolean(row.cctv_ok),
            cashOk: Boolean(row.cash_ok),
            keysOk: Boolean(row.keys_ok),
          },
        }
      : {}),
    authorUserId: row.author_user_id || '',
    authorName: row.author_name || '',
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} body
 * @param {object} actor
 * @param {string} workspaceBranchId
 */
export function createBranchShiftNote(db, body, actor, workspaceBranchId = DEFAULT_BRANCH_ID) {
  if (!tableReady(db)) return { ok: false, error: 'Shift notes table not ready — run migrate.' };
  const branchId =
    String(body?.branchId || workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const shiftDate = String(body?.shiftDate || body?.dayIso || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
    return { ok: false, error: 'shiftDate (YYYY-MM-DD) is required.' };
  }
  const note = String(body?.note || '').trim();
  if (note.length < 3) return { ok: false, error: 'note is required (min 3 characters).' };
  const noteKind = String(body?.noteKind || body?.note_kind || 'night').trim().toLowerCase();
  if (!NOTE_KINDS.has(noteKind)) return { ok: false, error: 'noteKind must be night or day.' };
  const gatesOk = asFlag(body?.gatesOk ?? body?.gates_ok);
  const cctvOk = asFlag(body?.cctvOk ?? body?.cctv_ok);
  const cashOk = asFlag(body?.cashOk ?? body?.cash_ok);
  const keysOk = asFlag(body?.keysOk ?? body?.keys_ok);
  const incidentCode = String(body?.incidentCode ?? body?.incident_code ?? '').trim() || null;
  const attachmentRef = String(body?.attachmentRef ?? body?.attachment_ref ?? '').trim() || null;

  const id = newId();
  const at = nowIso();
  const authorUserId = String(actor?.id || '').trim() || null;
  const authorName =
    String(actor?.displayName || actor?.username || actor?.email || '').trim() || null;

  db.prepare(
    `INSERT INTO branch_shift_notes (
      id, branch_id, shift_date, note, note_kind, gates_ok, cctv_ok, cash_ok, keys_ok,
      incident_code, attachment_ref, author_user_id, author_name, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, branchId, shiftDate, note, noteKind, gatesOk, cctvOk, cashOk, keysOk,
    incidentCode, attachmentRef, authorUserId, authorName, at, at
  );

  appendAuditLog(db, {
    actor,
    action: 'branch_shift_note.create',
    entityKind: 'branch_shift_note',
    entityId: id,
    note: `Shift handover note for ${branchId} ${shiftDate}`,
    details: { branchId, shiftDate, noteKind, gatesOk, cctvOk, cashOk, keysOk, incidentCode },
  });

  const created = listBranchShiftNotes(db, { branchId, shiftDate, limit: 5 }).find((n) => n.id === id);
  return {
    ok: true,
    note: created || {
      id, branchId, shiftDate, note, noteKind, gatesOk: Boolean(gatesOk), cctvOk: Boolean(cctvOk),
      cashOk: Boolean(cashOk), keysOk: Boolean(keysOk), incidentCode: incidentCode || '',
      attachmentRef: attachmentRef || '', authorUserId, authorName, createdAtIso: at,
    },
  };
}

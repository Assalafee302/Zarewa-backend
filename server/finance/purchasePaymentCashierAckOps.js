/**
 * Cashier acknowledgment of MD/Finance purchase supplier payments.
 * Payment already posts treasury; this queue is bookkeeping visibility for the branch cashier.
 */
import { appendAuditLog } from '../controlOps.js';
import { assertEntityBranchForWorkspaceWrite } from '../branchScope.js';
import { branchWhere } from '../readModel.js';

const DDL = `
CREATE TABLE IF NOT EXISTS purchase_payment_cashier_acks (
  ack_id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  treasury_movement_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  po_id TEXT,
  ap_id TEXT,
  supplier_id TEXT,
  supplier_name TEXT,
  amount_ngn INTEGER NOT NULL,
  paid_at_iso TEXT NOT NULL,
  paid_by_user_id TEXT,
  paid_by_name TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  acknowledged_at_iso TEXT,
  acknowledged_by_user_id TEXT,
  acknowledged_by_name TEXT,
  acknowledgment_note TEXT,
  created_at_iso TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ppca_branch_status
  ON purchase_payment_cashier_acks(branch_id, status, paid_at_iso);
CREATE INDEX IF NOT EXISTS idx_ppca_source
  ON purchase_payment_cashier_acks(source_kind, source_id);
`;

function nowIso() {
  return new Date().toISOString();
}

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function actorLabel(user) {
  return String(user?.displayName || user?.display_name || user?.username || user?.id || 'User').trim();
}

function newAckId() {
  return `PPCA-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function tableExists(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get('purchase_payment_cashier_acks')
    );
  } catch {
    try {
      db.prepare(`SELECT 1 FROM purchase_payment_cashier_acks LIMIT 1`).get();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Idempotent DDL for migrate + fresh schemaSql consumers.
 * @param {import('better-sqlite3').Database} db
 */
export function ensurePurchasePaymentCashierAckSchema(db) {
  db.exec(DDL);
}

/** @param {import('better-sqlite3').Database} db */
export function migratePurchasePaymentCashierAcks2026(db) {
  ensurePurchasePaymentCashierAckSchema(db);
}

/**
 * @param {object | null | undefined} row
 */
export function mapPurchasePaymentCashierAckRow(row) {
  if (!row) return null;
  return {
    ackId: row.ack_id,
    branchId: String(row.branch_id || '').trim(),
    treasuryMovementId: row.treasury_movement_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    poId: row.po_id || '',
    apId: row.ap_id || '',
    supplierId: row.supplier_id || '',
    supplierName: row.supplier_name || '',
    amountNgn: roundMoney(row.amount_ngn),
    paidAtISO: row.paid_at_iso || '',
    paidByUserId: row.paid_by_user_id || '',
    paidByName: row.paid_by_name || '',
    status: row.status || 'Pending',
    acknowledgedAtISO: row.acknowledged_at_iso || '',
    acknowledgedByUserId: row.acknowledged_by_user_id || '',
    acknowledgedByName: row.acknowledged_by_name || '',
    acknowledgmentNote: row.acknowledgment_note || '',
    createdAtISO: row.created_at_iso || '',
  };
}

/**
 * Insert Pending ack inside an open payment transaction.
 * Skips when treasury movement or branch is missing (book-only pays).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} payload
 * @returns {{ ok: true, skipped?: boolean, ackId?: string } | { ok: false, error: string }}
 */
export function insertPurchasePaymentCashierAckTx(db, payload = {}) {
  ensurePurchasePaymentCashierAckSchema(db);
  const treasuryMovementId = String(payload.treasuryMovementId || '').trim();
  const branchId = String(payload.branchId || '').trim();
  if (!treasuryMovementId || !branchId) {
    return { ok: true, skipped: true };
  }
  const amountNgn = roundMoney(payload.amountNgn);
  if (amountNgn <= 0) {
    return { ok: true, skipped: true };
  }
  const existing = db
    .prepare(`SELECT ack_id FROM purchase_payment_cashier_acks WHERE treasury_movement_id = ?`)
    .get(treasuryMovementId);
  if (existing?.ack_id) {
    return { ok: true, skipped: true, ackId: existing.ack_id };
  }

  const sourceKind = String(payload.sourceKind || '').trim();
  const sourceId = String(payload.sourceId || '').trim();
  if (!sourceKind || !sourceId) {
    return { ok: false, error: 'Purchase payment ack requires sourceKind and sourceId.' };
  }

  const ackId = newAckId();
  const paidAtIso = String(payload.paidAtISO || '').trim() || nowIso();
  const createdAtIso = nowIso();
  db.prepare(
    `INSERT INTO purchase_payment_cashier_acks (
      ack_id, branch_id, treasury_movement_id, source_kind, source_id,
      po_id, ap_id, supplier_id, supplier_name, amount_ngn, paid_at_iso,
      paid_by_user_id, paid_by_name, status, created_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    ackId,
    branchId,
    treasuryMovementId,
    sourceKind,
    sourceId,
    payload.poId ? String(payload.poId) : null,
    payload.apId ? String(payload.apId) : null,
    payload.supplierId ? String(payload.supplierId) : null,
    payload.supplierName ? String(payload.supplierName) : null,
    amountNgn,
    paidAtIso,
    payload.paidByUserId ? String(payload.paidByUserId) : null,
    payload.paidByName ? String(payload.paidByName) : null,
    'Pending',
    createdAtIso
  );
  return { ok: true, ackId };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 * @param {{ limit?: number }} [opts]
 */
export function listPurchasePaymentCashierAcksPending(db, branchScope, opts = {}) {
  if (!tableExists(db)) return [];
  const bw = branchWhere(db, 'purchase_payment_cashier_acks', branchScope);
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
  const rows = db
    .prepare(
      `SELECT * FROM purchase_payment_cashier_acks
       WHERE status = 'Pending'${bw.sql}
       ORDER BY paid_at_iso ASC, ack_id ASC
       LIMIT ?`
    )
    .all(...bw.args, limit);
  return rows.map(mapPurchasePaymentCashierAckRow);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} ackId
 */
export function getPurchasePaymentCashierAck(db, ackId) {
  ensurePurchasePaymentCashierAckSchema(db);
  const id = String(ackId || '').trim();
  if (!id) return null;
  const row = db.prepare(`SELECT * FROM purchase_payment_cashier_acks WHERE ack_id = ?`).get(id);
  return mapPurchasePaymentCashierAckRow(row);
}

/**
 * Cashier confirms they recorded the MD purchase payment in their book.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} ackId
 * @param {object} payload
 */
export function acknowledgePurchasePaymentCashierAck(db, ackId, payload = {}) {
  ensurePurchasePaymentCashierAckSchema(db);
  const id = String(ackId || '').trim();
  if (!id) return { ok: false, error: 'Acknowledgment id is required.' };
  const row = db.prepare(`SELECT * FROM purchase_payment_cashier_acks WHERE ack_id = ?`).get(id);
  if (!row) return { ok: false, error: 'Purchase payment acknowledgment not found.' };

  const gate = assertEntityBranchForWorkspaceWrite(
    payload.actor,
    row.branch_id,
    payload.workspaceBranchId,
    Boolean(payload.workspaceViewAll)
  );
  if (!gate.ok) return { ok: false, error: gate.error, status: 403 };

  if (String(row.status || '') === 'Acknowledged') {
    return { ok: true, alreadyAcknowledged: true, ack: mapPurchasePaymentCashierAckRow(row) };
  }
  if (String(row.status || '') !== 'Pending') {
    return { ok: false, error: `Cannot acknowledge status ${row.status}.` };
  }

  const at = nowIso();
  const byName = actorLabel(payload.actor);
  const note = String(payload.note || '').trim();
  db.prepare(
    `UPDATE purchase_payment_cashier_acks SET
      status = 'Acknowledged',
      acknowledged_at_iso = ?,
      acknowledged_by_user_id = ?,
      acknowledged_by_name = ?,
      acknowledgment_note = ?
     WHERE ack_id = ? AND status = 'Pending'`
  ).run(at, payload.actor?.id ? String(payload.actor.id) : null, byName, note || null, id);

  const fresh = getPurchasePaymentCashierAck(db, id);
  appendAuditLog(db, {
    actor: payload.actor,
    action: 'purchase_payment.cashier_ack',
    entityKind: 'purchase_payment_cashier_ack',
    entityId: id,
    note: note || `Cashier acknowledged purchase payment ${row.source_id}`,
    details: {
      amountNgn: roundMoney(row.amount_ngn),
      treasuryMovementId: row.treasury_movement_id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      poId: row.po_id,
      apId: row.ap_id,
      branchId: row.branch_id,
    },
  });
  return { ok: true, ack: fresh };
}

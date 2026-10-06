/**
 * Cashier acknowledgment of MD/Finance purchase supplier payments.
 * Payment already posts treasury; this queue is bookkeeping visibility for the branch cashier.
 */
import { appendAuditLog } from '../controlOps.js';
import { assertEntityBranchForWorkspaceWrite } from '../branchScope.js';
import { branchWhere } from '../readModel.js';
import { branchDisplayName } from '../branches.js';
import { poLineOrderedValueNgn } from '../../shared/lib/liveAnalytics.js';

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

function tableExists(db, tableName = 'purchase_payment_cashier_acks') {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(tableName)
    );
  } catch {
    try {
      db.prepare(`SELECT 1 FROM \`${tableName}\` LIMIT 1`).get();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Format a human-friendly concise summary of purchase order line items.
 * @param {Array<object>} lines
 * @returns {string}
 */
function buildPoItemsSummary(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  const parts = lines.map((l) => {
    const name = l.productName || l.productId || 'Item';
    const spec = [l.gauge, l.color].filter(Boolean).join(' ');
    const label = spec ? `${spec} ${name}`.trim() : name;
    const qty = Number(l.qtyOrdered) || 0;
    const isCoil = l.lineType === 'Coil' || (Number(l.unitPricePerKgNgn) || 0) > 0;
    const unit = isCoil ? 'kg' : 'pcs';
    return `${label} (${qty.toLocaleString('en-US')} ${unit})`;
  });
  if (parts.length <= 3) {
    return parts.join(', ');
  }
  return `${parts.slice(0, 2).join(', ')} and ${parts.length - 2} more item(s)`;
}

/**
 * Enrich purchase payment cashier acknowledgment rows with rich, relevant details:
 * - Treasury movement & account details (account name, type, bank, account number, payment ref, note)
 * - Branch display name
 * - Supplier contact, terms, city
 * - Purchase Order details (order date, invoice number/date, delivery dates, status, line items, line values, total amount, cumulative paid, balance remaining, transport details)
 * - Accounts Payable details (invoice ref, due date, total amount, paid, balance remaining, payment method)
 * - Formatted source label and item summaries
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<object>} acks Mapped ack rows
 * @returns {Array<object>}
 */
export function enrichPurchasePaymentCashierAcks(db, acks) {
  if (!Array.isArray(acks) || acks.length === 0) return [];

  // Collect IDs for batch querying
  const movementIds = Array.from(new Set(acks.map((a) => a.treasuryMovementId).filter(Boolean)));
  const supplierIds = Array.from(new Set(acks.map((a) => a.supplierId).filter(Boolean)));
  const poIds = Array.from(
    new Set(
      acks
        .map((a) => a.poId || (a.sourceKind === 'PURCHASE_ORDER' || a.sourceKind === 'SUPPLIER_OVERPAYMENT' ? a.sourceId : ''))
        .filter(Boolean)
    )
  );
  const apIds = Array.from(
    new Set(
      acks
        .map((a) => a.apId || (a.sourceKind === 'ACCOUNTS_PAYABLE' ? a.sourceId : ''))
        .filter(Boolean)
    )
  );

  // 1. Treasury Movements & Accounts
  const movementsMap = new Map();
  if (movementIds.length > 0 && tableExists(db, 'treasury_movements')) {
    try {
      const ph = movementIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT
          tm.id AS movement_id,
          tm.treasury_account_id,
          tm.reference AS treasury_reference,
          tm.note AS treasury_note,
          tm.posted_at_iso AS treasury_posted_at_iso,
          tm.amount_ngn AS treasury_amount_ngn,
          ta.name AS treasury_account_name,
          ta.bank_name AS treasury_bank_name,
          ta.acc_no AS treasury_account_no,
          ta.type AS treasury_account_type
        FROM treasury_movements tm
        LEFT JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
        WHERE tm.id IN (${ph})
      `).all(...movementIds);
      for (const r of rows) {
        movementsMap.set(String(r.movement_id), r);
      }
    } catch {
      /* ignore enrichment failure if schema differs */
    }
  }

  // 2. Suppliers
  const suppliersMap = new Map();
  if (supplierIds.length > 0 && tableExists(db, 'suppliers')) {
    try {
      const ph = supplierIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT supplier_id, name, city, payment_terms, notes, supplier_profile_json
        FROM suppliers
        WHERE supplier_id IN (${ph})
      `).all(...supplierIds);
      for (const r of rows) {
        let phone = '';
        if (r.supplier_profile_json) {
          try {
            const p = JSON.parse(r.supplier_profile_json);
            phone = String(p.phone || p.contactPhone || p.phoneNumber || '').trim();
          } catch {
            /* ignore JSON parse error */
          }
        }
        suppliersMap.set(String(r.supplier_id), {
          supplierCity: r.city || '',
          supplierPaymentTerms: r.payment_terms || '',
          supplierPhone: phone,
          supplierNotes: r.notes || '',
        });
      }
    } catch {
      /* ignore */
    }
  }

  // 3. Purchase Orders & PO Lines
  const posMap = new Map();
  if (poIds.length > 0 && tableExists(db, 'purchase_orders')) {
    try {
      const ph = poIds.map(() => '?').join(',');
      const poRows = db.prepare(`
        SELECT
          po_id,
          supplier_id,
          supplier_name,
          order_date_iso,
          expected_delivery_iso,
          status,
          invoice_no,
          invoice_date_iso,
          delivery_date_iso,
          transport_agent_id,
          transport_agent_name,
          transport_reference,
          transport_amount_ngn,
          transport_paid_ngn,
          supplier_paid_ngn
        FROM purchase_orders
        WHERE po_id IN (${ph})
      `).all(...poIds);

      const linesByPo = new Map();
      if (tableExists(db, 'purchase_order_lines')) {
        const lineRows = db.prepare(`
          SELECT
            po_id,
            line_key,
            product_id,
            product_name,
            color,
            gauge,
            meters_offered,
            conversion_kg_per_m,
            unit_price_per_kg_ngn,
            unit_price_ngn,
            qty_ordered,
            qty_received,
            line_type
          FROM purchase_order_lines
          WHERE po_id IN (${ph})
          ORDER BY line_key ASC
        `).all(...poIds);

        for (const l of lineRows) {
          const pid = String(l.po_id);
          if (!linesByPo.has(pid)) linesByPo.set(pid, []);
          const mappedLine = {
            lineKey: l.line_key,
            lineType: l.line_type || '',
            productId: l.product_id,
            productName: l.product_name,
            color: l.color || '',
            gauge: l.gauge || '',
            qtyOrdered: Number(l.qty_ordered) || 0,
            qtyReceived: Number(l.qty_received) || 0,
            metersOffered: l.meters_offered != null ? Number(l.meters_offered) : null,
            conversionKgPerM: l.conversion_kg_per_m != null ? Number(l.conversion_kg_per_m) : null,
            unitPriceNgn: Number(l.unit_price_ngn) || 0,
            unitPricePerKgNgn: Number(l.unit_price_per_kg_ngn) || 0,
          };
          mappedLine.lineValueNgn = poLineOrderedValueNgn(mappedLine);
          linesByPo.get(pid).push(mappedLine);
        }
      }

      for (const po of poRows) {
        const lines = linesByPo.get(String(po.po_id)) || [];
        const orderedValueNgn = lines.reduce((s, l) => s + (l.lineValueNgn || 0), 0);
        const supplierPaidNgn = roundMoney(po.supplier_paid_ngn);
        const balanceRemainingNgn = Math.max(0, orderedValueNgn - supplierPaidNgn);

        posMap.set(String(po.po_id), {
          poId: po.po_id,
          poStatus: po.status || '',
          poOrderDateISO: po.order_date_iso || '',
          poExpectedDeliveryISO: po.expected_delivery_iso || '',
          poInvoiceNo: po.invoice_no || '',
          poInvoiceDateISO: po.invoice_date_iso || '',
          poDeliveryDateISO: po.delivery_date_iso || '',
          poOrderedValueNgn: orderedValueNgn,
          poTotalAmountNgn: orderedValueNgn,
          poSupplierPaidNgn: supplierPaidNgn,
          poBalanceRemainingNgn: balanceRemainingNgn,
          poLinesCount: lines.length,
          poItemsSummary: buildPoItemsSummary(lines),
          poLines: lines,
          transportAgentName: po.transport_agent_name || '',
          transportAmountNgn: roundMoney(po.transport_amount_ngn),
          transportPaidNgn: roundMoney(po.transport_paid_ngn),
        });
      }
    } catch {
      /* ignore */
    }
  }

  // 4. Accounts Payable
  const apsMap = new Map();
  if (apIds.length > 0 && tableExists(db, 'accounts_payable')) {
    try {
      const ph = apIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT ap_id, supplier_name, po_ref, invoice_ref, amount_ngn, paid_ngn, due_date_iso, payment_method
        FROM accounts_payable
        WHERE ap_id IN (${ph})
      `).all(...apIds);
      for (const ap of rows) {
        const total = roundMoney(ap.amount_ngn);
        const paid = roundMoney(ap.paid_ngn);
        apsMap.set(String(ap.ap_id), {
          apId: ap.ap_id,
          apInvoiceRef: ap.invoice_ref || '',
          apDueDateISO: ap.due_date_iso || '',
          apTotalAmountNgn: total,
          apPaidNgn: paid,
          apBalanceRemainingNgn: Math.max(0, total - paid),
          apPaymentMethod: ap.payment_method || '',
          apPoRef: ap.po_ref || '',
        });
      }
    } catch {
      /* ignore */
    }
  }

  // 5. Merge all enrichment onto each ack
  return acks.map((ack) => {
    const tm = movementsMap.get(String(ack.treasuryMovementId)) || null;
    const sup = suppliersMap.get(String(ack.supplierId)) || null;
    const poKey = ack.poId || (ack.sourceKind === 'PURCHASE_ORDER' || ack.sourceKind === 'SUPPLIER_OVERPAYMENT' ? ack.sourceId : '');
    const po = posMap.get(String(poKey)) || null;
    const apKey = ack.apId || (ack.sourceKind === 'ACCOUNTS_PAYABLE' ? ack.sourceId : '');
    const ap = apsMap.get(String(apKey)) || null;

    const branchName = branchDisplayName(db, ack.branchId) || ack.branchId;

    let sourceLabel = '';
    if (ack.sourceKind === 'PURCHASE_ORDER') {
      sourceLabel = `Purchase Order ${ack.sourceId || ack.poId}`;
    } else if (ack.sourceKind === 'ACCOUNTS_PAYABLE') {
      sourceLabel = `Accounts Payable ${ack.sourceId || ack.apId}${ap?.apInvoiceRef ? ` (Inv: ${ap.apInvoiceRef})` : ''}`;
    } else if (ack.sourceKind === 'SUPPLIER_OVERPAYMENT') {
      sourceLabel = `Supplier Advance / Excess Payment (${ack.sourceId || ack.poId})`;
    } else {
      sourceLabel = `${ack.sourceKind} ${ack.sourceId}`;
    }

    return {
      ...ack,
      branchName,
      sourceLabel,

      // Treasury & Payment Details
      treasuryAccountId: tm?.treasury_account_id ?? null,
      treasuryAccountName: tm?.treasury_account_name || '',
      treasuryBankName: tm?.treasury_bank_name || '',
      treasuryAccountNo: tm?.treasury_account_no || '',
      treasuryAccountType: tm?.treasury_account_type || '',
      paymentReference: tm?.treasury_reference || '',
      treasuryReference: tm?.treasury_reference || '',
      paymentNote: tm?.treasury_note || '',
      treasuryNote: tm?.treasury_note || '',

      // Supplier Details
      supplierCity: sup?.supplierCity || '',
      supplierPaymentTerms: sup?.supplierPaymentTerms || '',
      supplierPhone: sup?.supplierPhone || '',
      supplierNotes: sup?.supplierNotes || '',

      // Purchase Order Details
      poStatus: po?.poStatus || '',
      poOrderDateISO: po?.poOrderDateISO || '',
      poExpectedDeliveryISO: po?.poExpectedDeliveryISO || '',
      poInvoiceNo: po?.poInvoiceNo || '',
      poInvoiceDateISO: po?.poInvoiceDateISO || '',
      poDeliveryDateISO: po?.poDeliveryDateISO || '',
      poOrderedValueNgn: po?.poOrderedValueNgn ?? 0,
      poTotalAmountNgn: po?.poTotalAmountNgn ?? 0,
      poSupplierPaidNgn: po?.poSupplierPaidNgn ?? 0,
      poBalanceRemainingNgn: po?.poBalanceRemainingNgn ?? 0,
      poLinesCount: po?.poLinesCount ?? 0,
      poItemsSummary: po?.poItemsSummary || '',
      poLines: po?.poLines || [],
      transportAgentName: po?.transportAgentName || '',
      transportAmountNgn: po?.transportAmountNgn ?? 0,
      transportPaidNgn: po?.transportPaidNgn ?? 0,

      // Accounts Payable Details
      apInvoiceRef: ap?.apInvoiceRef || '',
      apDueDateISO: ap?.apDueDateISO || '',
      apTotalAmountNgn: ap?.apTotalAmountNgn ?? 0,
      apPaidNgn: ap?.apPaidNgn ?? 0,
      apBalanceRemainingNgn: ap?.apBalanceRemainingNgn ?? 0,
      apPaymentMethod: ap?.apPaymentMethod || '',
      apPoRef: ap?.apPoRef || '',
    };
  });
}

/**
 * Enrich a single cashier ack.
 * @param {import('better-sqlite3').Database} db
 * @param {object | null} ack
 * @returns {object | null}
 */
export function enrichPurchasePaymentCashierAck(db, ack) {
  if (!ack) return null;
  const [enriched] = enrichPurchasePaymentCashierAcks(db, [ack]);
  return enriched || ack;
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
  return enrichPurchasePaymentCashierAcks(db, rows.map(mapPurchasePaymentCashierAckRow));
}

/**
 * List cashier acknowledgments with optional status, pagination, and branch filtering.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 * @param {{ status?: 'Pending' | 'Acknowledged' | 'ALL', limit?: number, offset?: number, sourceKind?: string, supplierId?: string, poId?: string }} [opts]
 */
export function listPurchasePaymentCashierAcks(db, branchScope, opts = {}) {
  if (!tableExists(db)) return [];
  const bw = branchWhere(db, 'purchase_payment_cashier_acks', branchScope);
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const clauses = [];
  const args = [...bw.args];

  const status = String(opts.status || '').trim();
  if (status && status.toUpperCase() !== 'ALL') {
    clauses.push(`status = ?`);
    args.push(status);
  }

  if (opts.sourceKind) {
    clauses.push(`source_kind = ?`);
    args.push(String(opts.sourceKind).trim());
  }

  if (opts.supplierId) {
    clauses.push(`supplier_id = ?`);
    args.push(String(opts.supplierId).trim());
  }

  if (opts.poId) {
    clauses.push(`(po_id = ? OR source_id = ?)`);
    args.push(String(opts.poId).trim(), String(opts.poId).trim());
  }

  const whereSql = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM purchase_payment_cashier_acks
       WHERE 1=1${bw.sql}${whereSql}
       ORDER BY paid_at_iso DESC, ack_id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset);

  return enrichPurchasePaymentCashierAcks(db, rows.map(mapPurchasePaymentCashierAckRow));
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
  const mapped = mapPurchasePaymentCashierAckRow(row);
  return enrichPurchasePaymentCashierAck(db, mapped);
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

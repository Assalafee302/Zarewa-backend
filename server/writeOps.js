import { isAllowedExpenseCategory } from '../shared/expenseCategories.js';
import {
  tryPostCustomerAdvanceReversalGl,
  tryPostCustomerReceiptReversalGl,
  tryPostCustomerRefundPayoutGlTx,
  tryPostGrnInventoryJournal,
  tryPostInventoryReceiptJournal,
} from './glOps.js';
import { ensureStoneProduct, isStoneMeterProductRow } from './stoneInventory.js';
import { deriveProcurementKindFromProductIds } from './procurementPoKind.js';
import { normalizeCustomerEmailKey, normalizeCustomerPhoneKey } from '../shared/customerPhoneKey.js';
import { actorId, actorName, userHasPermission } from './auth.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { mergeSupplierProfilePatch, validateAndNormalizeSupplierProfile } from './supplierProfile.js';
import {
  enrichSalesReceiptRowsWithCashFromLedger,
  listLedgerEntries,
  listSalesReceipts,
} from './readModel.js';
import { appendAuditLog, assertPeriodOpen, insertPaymentRequest } from './controlOps.js';
import { appendPaymentRequestTimelineToOfficeThreads } from './officePaymentRequestTimeline.js';
import {
  nextBankReconLineHumanId,
  nextCoilControlEventHumanId,
  nextCoilRequestHumanId,
  nextCrmInteractionHumanId,
  nextCustomerHumanId,
  nextCuttingListHumanId,
  nextDeliveryHumanId,
  nextExpenseHumanId,
  nextLedgerEntryId,
  nextProductionJobHumanId,
  nextPostingBatchHumanId,
  nextPurchaseOrderHumanId,
  nextQuotationHumanId,
  nextStockMovementHumanId,
  nextTreasuryMovementHumanId,
  nextTreasuryTransferBatchHumanId,
} from './humanId.js';

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

function normalizeCrmTagsJson(row) {
  if (Array.isArray(row?.crmTags)) return JSON.stringify(row.crmTags);
  if (typeof row?.crmTagsJson === 'string' && row.crmTagsJson.trim()) return row.crmTagsJson.trim();
  return '[]';
}

function normalizeIsoTimestamp(value) {
  if (!value) return new Date().toISOString();
  const s = String(value).trim();
  if (!s) return new Date().toISOString();
  if (s.includes('T')) return s;
  return `${s}T12:00:00.000Z`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Array<Record<string, unknown>>} planRows
 * @param {string | null} branchId
 * @param {{ allowPerRowBranchId?: boolean }} [opts] When false (default), ignore `branchId` on each row so callers cannot override booking branch.
 */
export function insertLedgerRows(db, planRows, branchId = null, opts = {}) {
  const allowPerRow = Boolean(opts.allowPerRowBranchId);
  const ins = db.prepare(`
    INSERT INTO ledger_entries (
      id, at_iso, type, customer_id, customer_name, amount_ngn, quotation_ref,
      payment_method, bank_reference, purpose, created_by_user_id, created_by_name, note, branch_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const run = db.transaction((rows) => {
    const saved = [];
    for (const r of rows) {
      if (r.quotationRef) {
        const q = db.prepare(`SELECT manager_cleared_at_iso, manager_flagged_at_iso FROM quotations WHERE id = ?`).get(r.quotationRef);
        if (q) {
          if (q.manager_cleared_at_iso) {
             throw new Error(`Quotation ${r.quotationRef} has been cleared by manager and is closed for further payments.`);
          }
          if (q.manager_flagged_at_iso) {
             throw new Error(`Quotation ${r.quotationRef} is flagged by manager for review and is closed for further payments.`);
          }
        }
        
        // Also check for refunds
        const ref = db.prepare(`SELECT refund_id FROM customer_refunds WHERE quotation_ref = ? AND status IN ('Pending', 'Approved')`).get(r.quotationRef);
        if (ref) {
          throw new Error(`Quotation ${r.quotationRef} has an active refund request (${ref.refund_id}) and is closed for further payments.`);
        }
      }

      const bid = allowPerRow
        ? r.branchId != null && String(r.branchId).trim()
          ? String(r.branchId).trim()
          : branchId
        : branchId;
      const id = nextLedgerEntryId(db, bid || DEFAULT_BRANCH_ID);
      const atIso = r.atISO || new Date().toISOString();
      ins.run(
        id,
        atIso,
        r.type,
        r.customerID,
        r.customerName ?? null,
        r.amountNgn,
        r.quotationRef || null,
        r.paymentMethod ?? null,
        r.bankReference ?? null,
        r.purpose ?? null,
        r.createdByUserId ?? null,
        r.createdByName ?? null,
        r.note ?? null,
        bid ?? null
      );
      saved.push({
        id,
        atISO: atIso,
        type: r.type,
        customerID: r.customerID,
        customerName: r.customerName,
        amountNgn: r.amountNgn,
        quotationRef: r.quotationRef || '',
        paymentMethod: r.paymentMethod,
        bankReference: r.bankReference,
        purpose: r.purpose,
        createdByUserId: r.createdByUserId ?? '',
        createdByName: r.createdByName ?? '',
        note: r.note,
        branchId: bid ?? '',
      });
    }
    return saved;
  });

  return run(planRows);
}

/**
 * Customer advance / overpay credit from ledger only (matches `advanceBalanceFromEntries` in customerLedgerCore.js).
 * @param {import('better-sqlite3').Database} db
 */
export function advanceBalanceNgnForCustomerDb(db, customerID) {
  const id = String(customerID || '').trim();
  if (!id) return 0;
  const rows = db.prepare(`SELECT type, amount_ngn FROM ledger_entries WHERE customer_id = ?`).all(id);
  let s = 0;
  for (const e of rows) {
    const n = roundMoney(e.amount_ngn);
    switch (String(e.type || '')) {
      case 'ADVANCE_IN':
      case 'OVERPAY_ADVANCE':
        s += n;
        break;
      case 'ADVANCE_APPLIED':
      case 'REFUND_ADVANCE':
      case 'ADVANCE_REVERSAL':
        s -= n;
        break;
      default:
        break;
    }
  }
  return s;
}

/**
 * Set quotations.paid_ngn and payment_status from **sales receipts** (what you record in Sales → Receipts).
 * Optionally adds ADVANCE_APPLIED ledger rows for the same quote (customer deposit applied to this job)
 * so one “paid” number drives cutting lists, production gates, refunds, and AR.
 * Bank reconciliation matches treasury to those receipt lines; it does not define quotation paid.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationId
 */
export function syncQuotationPaidFromReceipts(db, quotationId) {
  const qid = String(quotationId || '').trim();
  if (!qid) return { ok: false, error: 'Quotation id required.' };
  const row = db.prepare(`SELECT total_ngn FROM quotations WHERE id = ?`).get(qid);
  if (!row) return { ok: false, error: 'Quotation not found.' };

  const r1 = db
    .prepare(
      `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM sales_receipts
       WHERE quotation_ref = ?
         AND (status IS NULL OR TRIM(LOWER(status)) NOT IN ('reversed'))`
    )
    .get(qid);
  const receiptSum = Math.round(Number(r1?.s) || 0);

  const r2 = db
    .prepare(
      `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM ledger_entries
       WHERE type = 'ADVANCE_APPLIED' AND quotation_ref = ?`
    )
    .get(qid);
  const advanceApplied = Math.round(Number(r2?.s) || 0);

  const paidTotal = receiptSum + advanceApplied;
  const total = Math.round(Number(row.total_ngn) || 0);
  let paymentStatus;
  if (paidTotal <= 0) paymentStatus = 'Unpaid';
  else if (total > 0 && paidTotal >= total) paymentStatus = 'Paid';
  else paymentStatus = 'Partial';
  db.prepare(`UPDATE quotations SET paid_ngn = ?, payment_status = ? WHERE id = ?`).run(
    paidTotal,
    paymentStatus,
    qid
  );
  return { ok: true, paidNgn: paidTotal, paymentStatus, receiptSumNgn: receiptSum, advanceAppliedNgn: advanceApplied };
}

/** @deprecated Use syncQuotationPaidFromReceipts — kept name for existing API routes. */
export function syncQuotationPaidFromLedger(db, quotationId) {
  return syncQuotationPaidFromReceipts(db, quotationId);
}

function appendMovementTx(db, entry) {
  const id = nextStockMovementHumanId(db);
  const atISO = new Date().toISOString().slice(0, 19);
  db.prepare(
    `INSERT INTO stock_movements (id, at_iso, type, ref, product_id, qty, detail, date_iso, unit_price_ngn, value_ngn)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    atISO,
    entry.type,
    entry.ref ?? null,
    entry.productID ?? null,
    entry.qty ?? null,
    entry.detail ?? null,
    entry.dateISO ?? atISO.slice(0, 10),
    entry.unitPriceNgn ?? null,
    entry.valueNgn ?? null
  );
  return { id, atISO, ...entry };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} row
 */
function insertCoilControlEventTx(db, row) {
  const branchId = String(row.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const id = nextCoilControlEventHumanId(db, branchId);
  const createdAtIso = String(row.createdAtIso || new Date().toISOString().slice(0, 19));
  const dateIso = String(row.dateIso || createdAtIso.slice(0, 10)).trim();
  db.prepare(
    `INSERT INTO coil_control_events (
      id, branch_id, event_kind, coil_no, product_id, gauge_label, colour,
      meters, kg_coil_delta, kg_book, book_ref, cutting_list_ref, quotation_ref, customer_label,
      supplier_id, defect_m_from, defect_m_to, supplier_resolution, outbound_destination,
      credit_scrap_inventory, scrap_product_id, scrap_reason, note,
      date_iso, created_at_iso, actor_user_id, actor_display
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    branchId,
    String(row.eventKind || '').trim(),
    row.coilNo != null ? String(row.coilNo).trim() || null : null,
    row.productId != null ? String(row.productId).trim() || null : null,
    row.gaugeLabel != null ? String(row.gaugeLabel).trim() || null : null,
    row.colour != null ? String(row.colour).trim() || null : null,
    row.meters != null && Number.isFinite(Number(row.meters)) ? Number(row.meters) : null,
    Number.isFinite(Number(row.kgCoilDelta)) ? Number(row.kgCoilDelta) : 0,
    row.kgBook != null && Number.isFinite(Number(row.kgBook)) ? Number(row.kgBook) : null,
    row.bookRef != null ? String(row.bookRef).trim() || null : null,
    row.cuttingListRef != null ? String(row.cuttingListRef).trim() || null : null,
    row.quotationRef != null ? String(row.quotationRef).trim() || null : null,
    row.customerLabel != null ? String(row.customerLabel).trim() || null : null,
    row.supplierId != null ? String(row.supplierId).trim() || null : null,
    row.defectMFrom != null && Number.isFinite(Number(row.defectMFrom)) ? Number(row.defectMFrom) : null,
    row.defectMTo != null && Number.isFinite(Number(row.defectMTo)) ? Number(row.defectMTo) : null,
    row.supplierResolution != null ? String(row.supplierResolution).trim() || null : null,
    row.outboundDestination != null ? String(row.outboundDestination).trim() || null : null,
    row.creditScrapInventory ? 1 : 0,
    row.scrapProductId != null ? String(row.scrapProductId).trim() || null : null,
    row.scrapReason != null ? String(row.scrapReason).trim() || null : null,
    row.note != null ? String(row.note).trim() || null : null,
    dateIso,
    createdAtIso,
    row.actorUserId != null ? String(row.actorUserId).trim() || null : null,
    row.actorDisplay != null ? String(row.actorDisplay).trim() || null : null
  );
  return id;
}

function treasuryAccountRow(db, treasuryAccountId) {
  return db.prepare(`SELECT * FROM treasury_accounts WHERE id = ?`).get(treasuryAccountId);
}

function adjustTreasuryBalanceTx(db, treasuryAccountId, deltaNgn, opts = {}) {
  const row = treasuryAccountRow(db, treasuryAccountId);
  if (!row) throw new Error('Treasury account not found.');
  const nextBalance = roundMoney(row.balance) + roundMoney(deltaNgn);
  if (nextBalance < 0 && !opts.allowNegativeBalance) {
    throw new Error(`Insufficient balance in ${row.name}.`);
  }
  db.prepare(`UPDATE treasury_accounts SET balance = ? WHERE id = ?`).run(nextBalance, treasuryAccountId);
  return { ...row, balance: nextBalance };
}

export function insertTreasuryMovementTx(db, payload) {
  const treasuryAccountId = Number(payload.treasuryAccountId);
  if (!treasuryAccountId) throw new Error('treasuryAccountId is required.');
  const amountNgn = roundMoney(payload.amountNgn);
  if (amountNgn === 0) throw new Error('Treasury movement amount must be non-zero.');
  const allowNeg =
    payload.allowNegativeBalance === true || payload.type === 'BANK_RECON_ADJUSTMENT';
  const account = adjustTreasuryBalanceTx(db, treasuryAccountId, amountNgn, {
    allowNegativeBalance: allowNeg,
  });
  const branchForTm = String(
    payload.workspaceBranchId || payload.branchId || DEFAULT_BRANCH_ID
  ).trim();
  const id = String(payload.id ?? '').trim() || nextTreasuryMovementHumanId(db, branchForTm);
  const postedAtISO = normalizeIsoTimestamp(payload.postedAtISO);
  db.prepare(
    `INSERT INTO treasury_movements (
      id, posted_at_iso, type, treasury_account_id, amount_ngn, reference,
      counterparty_kind, counterparty_id, counterparty_name, source_kind, source_id,
      note, created_by, reverses_movement_id, batch_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    postedAtISO,
    payload.type,
    treasuryAccountId,
    amountNgn,
    payload.reference ?? null,
    payload.counterpartyKind ?? null,
    payload.counterpartyId ?? null,
    payload.counterpartyName ?? null,
    payload.sourceKind ?? null,
    payload.sourceId ?? null,
    payload.note ?? null,
    payload.createdBy ?? null,
    payload.reversesMovementId ?? null,
    payload.batchId ?? null
  );
  return {
    id,
    postedAtISO,
    treasuryAccountId,
    amountNgn,
    accountName: account.name,
    accountType: account.type,
    reference: payload.reference ?? '',
    sourceKind: payload.sourceKind ?? '',
    sourceId: payload.sourceId ?? '',
    batchId: payload.batchId ?? '',
  };
}

function insertTreasurySplitTx(db, lines, base) {
  const rows = [];
  const batchId = base.batchId || nextPostingBatchHumanId(db);
  for (const line of lines || []) {
    const amountNgn = roundMoney(line.amountNgn);
    if (!amountNgn) continue;
    rows.push(
      insertTreasuryMovementTx(db, {
        ...base,
        treasuryAccountId: line.treasuryAccountId,
        amountNgn,
        reference: line.reference ?? base.reference,
        note: line.note ?? base.note,
        batchId,
      })
    );
  }
  return rows;
}

function reverseTreasurySourceTx(db, sourceKind, sourceId, reversalType, note = '', actor = null) {
  const rows = db
    .prepare(
      `SELECT * FROM treasury_movements
       WHERE source_kind = ? AND source_id = ? AND reverses_movement_id IS NULL
       ORDER BY posted_at_iso, id`
    )
    .all(sourceKind, sourceId);
  const created = [];
  for (const row of rows) {
    const exists = db
      .prepare(`SELECT id FROM treasury_movements WHERE reverses_movement_id = ?`)
      .get(row.id);
    if (exists) continue;
    created.push(
      insertTreasuryMovementTx(db, {
        type: reversalType,
        treasuryAccountId: row.treasury_account_id,
        amountNgn: -roundMoney(row.amount_ngn),
        postedAtISO: new Date().toISOString(),
        reference: row.reference,
        counterpartyKind: row.counterparty_kind,
        counterpartyId: row.counterparty_id,
        counterpartyName: row.counterparty_name,
        sourceKind,
        sourceId,
        note: note || `Reverse ${row.type} ${sourceId}`,
        createdBy: actorName(actor),
        reversesMovementId: row.id,
        batchId: row.batch_id || null,
      })
    );
  }
  return created;
}

export function recordCustomerReceiptCash(db, payload) {
  const total = (payload.paymentLines || []).reduce((sum, line) => sum + roundMoney(line.amountNgn), 0);
  if (total <= 0) return [];
  return insertTreasurySplitTx(db, payload.paymentLines, {
    type: 'RECEIPT_IN',
    postedAtISO: payload.dateISO,
    reference: payload.reference || payload.sourceId,
    counterpartyKind: 'CUSTOMER',
    counterpartyId: payload.customerID,
    counterpartyName: payload.customerName,
    sourceKind: 'LEDGER_RECEIPT',
    sourceId: payload.sourceId,
    note: payload.note || 'Customer receipt',
    createdBy: payload.createdBy ?? 'Sales',
  });
}

export function recordCustomerAdvanceCash(db, payload) {
  const total = (payload.paymentLines || []).reduce((sum, line) => sum + roundMoney(line.amountNgn), 0);
  if (total <= 0) return [];
  return insertTreasurySplitTx(db, payload.paymentLines, {
    type: 'ADVANCE_IN',
    postedAtISO: payload.dateISO,
    reference: payload.reference || payload.sourceId,
    counterpartyKind: 'CUSTOMER',
    counterpartyId: payload.customerID,
    counterpartyName: payload.customerName,
    sourceKind: 'LEDGER_ADVANCE',
    sourceId: payload.sourceId,
    note: payload.note || 'Customer advance',
    createdBy: payload.createdBy ?? 'Sales',
  });
}

export function recordCustomerAdvanceRefundCash(db, payload) {
  const total = (payload.paymentLines || []).reduce((sum, line) => sum + roundMoney(line.amountNgn), 0);
  if (total <= 0) return [];
  return insertTreasurySplitTx(
    db,
    payload.paymentLines.map((line) => ({ ...line, amountNgn: -roundMoney(line.amountNgn) })),
    {
      type: 'ADVANCE_REFUND_OUT',
      postedAtISO: payload.dateISO,
      reference: payload.reference || payload.sourceId,
      counterpartyKind: 'CUSTOMER',
      counterpartyId: payload.customerID,
      counterpartyName: payload.customerName,
      sourceKind: 'LEDGER_ADVANCE_REFUND',
      sourceId: payload.sourceId,
      note: payload.note || 'Advance refunded to customer',
      createdBy: payload.createdBy ?? 'Finance',
    }
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {{ field: 'phone' | 'email', customerId: string } | null}
 */
export function findCustomerIdentityConflict(db, branchId, { phoneNumber, email }, excludeCustomerId) {
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
  const phoneKey = normalizeCustomerPhoneKey(phoneNumber);
  const emailKey = normalizeCustomerEmailKey(email);
  if (!phoneKey && !emailKey) return null;
  const ex = excludeCustomerId ? String(excludeCustomerId).trim() : '';
  const rows = db.prepare(`SELECT customer_id, phone_number, email FROM customers WHERE branch_id = ?`).all(bid);
  for (const r of rows) {
    if (ex && r.customer_id === ex) continue;
    if (phoneKey && normalizeCustomerPhoneKey(r.phone_number) === phoneKey) {
      return { field: 'phone', customerId: r.customer_id };
    }
    if (emailKey && normalizeCustomerEmailKey(r.email) === emailKey) {
      return { field: 'email', customerId: r.customer_id };
    }
  }
  return null;
}

function assertNoDuplicateCustomerIdentity(db, branchId, payload, excludeCustomerId) {
  const conflict = findCustomerIdentityConflict(db, branchId, payload, excludeCustomerId);
  if (!conflict) return;
  const msg =
    conflict.field === 'email'
      ? `A customer with this email is already registered (${conflict.customerId}).`
      : `A customer with this phone number is already registered (${conflict.customerId}).`;
  const e = new Error(msg);
  e.code = 'DUPLICATE_CUSTOMER_REGISTRATION';
  e.existingCustomerId = conflict.customerId;
  e.conflictField = conflict.field;
  throw e;
}

/** @param {import('better-sqlite3').Database} db */
export function insertCustomer(db, row, branchId = DEFAULT_BRANCH_ID) {
  const id = row.customerID || nextCustomerHumanId(db, String(branchId || DEFAULT_BRANCH_ID).trim());
  assertNoDuplicateCustomerIdentity(
    db,
    branchId,
    { phoneNumber: row.phoneNumber ?? '', email: row.email ?? '' },
    null
  );
  const tagsJson = normalizeCrmTagsJson(row);
  db.prepare(
    `INSERT INTO customers (
      customer_id, name, phone_number, email, address_shipping, address_billing,
      status, tier, payment_terms, created_by, created_at_iso, last_activity_iso,
      company_name, lead_source, preferred_contact, follow_up_iso, crm_tags_json, crm_profile_notes, branch_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    row.name,
    row.phoneNumber ?? '',
    row.email ?? '',
    row.addressShipping ?? '',
    row.addressBilling ?? '',
    row.status ?? 'Active',
    row.tier ?? 'Regular',
    row.paymentTerms ?? 'Due on receipt',
    row.createdBy ?? 'System',
    row.createdAtISO ?? new Date().toISOString().slice(0, 10),
    row.lastActivityISO ?? new Date().toISOString().slice(0, 10),
    String(row.companyName ?? '').trim(),
    String(row.leadSource ?? '').trim(),
    String(row.preferredContact ?? '').trim(),
    String(row.followUpISO ?? '').trim().slice(0, 10),
    tagsJson,
    String(row.crmProfileNotes ?? '').trim(),
    String(branchId || DEFAULT_BRANCH_ID).trim()
  );
  return id;
}

function countWhere(db, sql, id) {
  return Number(db.prepare(sql).get(id)?.c ?? 0);
}

/** Pre-check before DELETE customer — returns human-readable blockers when FK would fail. */
export function getCustomerDeleteBlockers(db, customerID) {
  const id = String(customerID ?? '').trim();
  if (!id) return { ok: false, error: 'Customer id required.', blockers: [] };
  if (!db.prepare(`SELECT 1 FROM customers WHERE customer_id = ?`).get(id)) {
    return { ok: false, error: 'Customer not found.', blockers: [] };
  }
  const blockers = [];
  const push = (table, n) => {
    if (n > 0) blockers.push({ table, count: n });
  };
  push('quotations', countWhere(db, `SELECT COUNT(*) AS c FROM quotations WHERE customer_id = ?`, id));
  push('ledger_entries', countWhere(db, `SELECT COUNT(*) AS c FROM ledger_entries WHERE customer_id = ?`, id));
  push('sales_receipts', countWhere(db, `SELECT COUNT(*) AS c FROM sales_receipts WHERE customer_id = ?`, id));
  push('cutting_lists', countWhere(db, `SELECT COUNT(*) AS c FROM cutting_lists WHERE customer_id = ?`, id));
  push('customer_refunds', countWhere(db, `SELECT COUNT(*) AS c FROM customer_refunds WHERE customer_id = ?`, id));
  push('deliveries', countWhere(db, `SELECT COUNT(*) AS c FROM deliveries WHERE customer_id = ?`, id));
  push('advance_in_events', countWhere(db, `SELECT COUNT(*) AS c FROM advance_in_events WHERE customer_id = ?`, id));
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_jobs'`).get()) {
    push('production_jobs', countWhere(db, `SELECT COUNT(*) AS c FROM production_jobs WHERE customer_id = ?`, id));
  }
  return { ok: true, blockers };
}

export function deleteCustomerIfAllowed(db, customerID, branchId = DEFAULT_BRANCH_ID) {
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
  const own = db
    .prepare(`SELECT customer_id FROM customers WHERE customer_id = ? AND branch_id = ?`)
    .get(String(customerID ?? '').trim(), bid);
  if (!own) return { ok: false, error: 'Customer not found in your branch.', blockers: [] };
  const check = getCustomerDeleteBlockers(db, customerID);
  if (!check.ok) return { ...check, blockers: check.blockers ?? [] };
  if (check.blockers.length > 0) {
    return {
      ok: false,
      error: 'Cannot delete customer while dependent records exist. Remove or reassign them first.',
      blockers: check.blockers.map((b) => `${b.count} in ${b.table}`),
    };
  }
  const id = String(customerID ?? '').trim();
  db.prepare(`DELETE FROM customers WHERE customer_id = ? AND branch_id = ?`).run(id, bid);
  return { ok: true };
}

function parseHrLoanPayloadJson(raw) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function syncStaffLoanDisbursementOnFullPay(db, paymentRequestId, paidAtISO) {
  const prId = String(paymentRequestId || '').trim();
  if (!prId) return;
  const day = String(paidAtISO || '').trim().slice(0, 10) || new Date().toISOString().slice(0, 10);
  const rows = db
    .prepare(`SELECT id, payload_json FROM hr_requests WHERE kind = 'loan' AND status = 'approved'`)
    .all();
  for (const r of rows) {
    const p = parseHrLoanPayloadJson(r.payload_json);
    if (String(p.financePaymentRequestId || '') !== prId) continue;
    const amountNgn = roundMoney(p.amountNgn);
    const merged = {
      ...p,
      loanDisbursedAtIso: day,
      deductionsActive: true,
      disbursementQueueStatus: 'Paid',
      principalOutstandingNgn:
        Number.isFinite(Number(p.principalOutstandingNgn)) && Number(p.principalOutstandingNgn) >= 0
          ? roundMoney(p.principalOutstandingNgn)
          : amountNgn > 0
            ? amountNgn
            : 0,
    };
    db.prepare(`UPDATE hr_requests SET payload_json = ? WHERE id = ?`).run(JSON.stringify(merged), r.id);
    return;
  }
}

/**
 * When executive approval completes on a staff loan, create expense + payment request and link on the HR row.
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {{ id: string; kind: string; title?: string; branch_id?: string; payload_json?: string }} requestRow
 */
export function provisionStaffLoanForFinanceQueue(db, actor, requestRow) {
  if (!requestRow || String(requestRow.kind) !== 'loan') {
    return { ok: false, error: 'Not a loan request.' };
  }
  const payload = parseHrLoanPayloadJson(requestRow.payload_json);
  if (payload.financePaymentRequestId) {
    return { ok: true, requestID: payload.financePaymentRequestId, already: true };
  }
  const amountNgn = roundMoney(payload.amountNgn);
  if (amountNgn <= 0) return { ok: false, error: 'Loan amount is missing or invalid.' };

  const hrId = String(requestRow.id);
  const expenseId = `EXP-HR-LOAN-${hrId}`;
  const bid = String(requestRow.branch_id || DEFAULT_BRANCH_ID).trim();
  const today = new Date().toISOString().slice(0, 10);
  let paymentReqId;

  try {
    db.transaction(() => {
      assertPeriodOpen(db, today, 'Staff loan disbursement queue');
      const ex = db.prepare(`SELECT 1 FROM expenses WHERE expense_id = ?`).get(expenseId);
      if (!ex) {
        db.prepare(
          `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
           VALUES (?,?,?,?,?,?,?,?)`
        ).run(
          expenseId,
          'Staff loan disbursement',
          amountNgn,
          today,
          'HR — staff loan',
          'Pending',
          hrId,
          bid
        );
      }
      const pr = insertPaymentRequest(
        db,
        {
          expenseID: expenseId,
          amountRequestedNgn: amountNgn,
          requestDate: today,
          description: `Staff loan: ${String(requestRow.title || hrId)}`,
        },
        actor
      );
      if (!pr.ok) throw new Error(pr.error);
      paymentReqId = pr.requestID;
      const merged = {
        ...payload,
        financePaymentRequestId: paymentReqId,
        disbursementQueueStatus: 'Pending',
        financeRejectionNote: null,
      };
      db.prepare(`UPDATE hr_requests SET payload_json = ? WHERE id = ?`).run(JSON.stringify(merged), hrId);
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  return { ok: true, requestID: paymentReqId };
}

/** @param {import('better-sqlite3').Database} db */
export function updateCustomer(db, customerID, row, branchId = DEFAULT_BRANCH_ID) {
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
  const cur = db
    .prepare(`SELECT * FROM customers WHERE customer_id = ? AND branch_id = ?`)
    .get(customerID, bid);
  if (!cur) return { ok: false, error: 'Customer not found.' };
  const name =
    row.name !== undefined ? String(row.name ?? '').trim() : String(cur.name ?? '').trim();
  if (!name) return { ok: false, error: 'Customer name is required.' };
  const phone =
    row.phoneNumber !== undefined ? String(row.phoneNumber ?? '').trim() : String(cur.phone_number ?? '').trim();
  const email = row.email !== undefined ? String(row.email ?? '').trim() : String(cur.email ?? '').trim();
  const conflict = findCustomerIdentityConflict(db, bid, { phoneNumber: phone, email }, customerID);
  if (conflict) {
    return {
      ok: false,
      error:
        conflict.field === 'email'
          ? `A customer with this email is already registered (${conflict.customerId}).`
          : `A customer with this phone number is already registered (${conflict.customerId}).`,
      code: 'DUPLICATE_CUSTOMER_REGISTRATION',
      existingCustomerId: conflict.customerId,
      conflictField: conflict.field,
    };
  }
  const pick = (key, col, def = '') =>
    row[key] !== undefined ? String(row[key] ?? '').trim() : String(cur[col] ?? def).trim();
  const tagsJson =
    row.crmTags !== undefined || row.crmTagsJson !== undefined
      ? normalizeCrmTagsJson(row)
      : cur.crm_tags_json || '[]';
  const profileNotes =
    row.crmProfileNotes !== undefined
      ? String(row.crmProfileNotes ?? '').trim()
      : String(cur.crm_profile_notes ?? '').trim();
  const r = db
    .prepare(
      `UPDATE customers
       SET name = ?, phone_number = ?, email = ?, address_shipping = ?, address_billing = ?,
           status = ?, tier = ?, payment_terms = ?, last_activity_iso = ?,
           company_name = ?, lead_source = ?, preferred_contact = ?, follow_up_iso = ?,
           crm_tags_json = ?, crm_profile_notes = ?
       WHERE customer_id = ? AND branch_id = ?`
    )
    .run(
      name,
      phone,
      email,
      String(row.addressShipping ?? cur.address_shipping ?? '').trim(),
      String(row.addressBilling ?? cur.address_billing ?? '').trim(),
      row.status ?? cur.status ?? 'Active',
      row.tier ?? cur.tier ?? 'Regular',
      row.paymentTerms ?? cur.payment_terms ?? 'Due on receipt',
      row.lastActivityISO ?? new Date().toISOString().slice(0, 10),
      pick('companyName', 'company_name'),
      pick('leadSource', 'lead_source'),
      pick('preferredContact', 'preferred_contact'),
      pick('followUpISO', 'follow_up_iso').slice(0, 10),
      tagsJson,
      profileNotes,
      customerID,
      bid
    );
  if (r.changes === 0) return { ok: false, error: 'Customer not found.' };
  db.prepare(`UPDATE quotations SET customer_name = ? WHERE customer_id = ?`).run(name, customerID);
  db.prepare(`UPDATE sales_receipts SET customer_name = ? WHERE customer_id = ?`).run(name, customerID);
  db.prepare(`UPDATE cutting_lists SET customer_name = ? WHERE customer_id = ?`).run(name, customerID);
  db.prepare(`UPDATE customer_refunds SET customer_name = ? WHERE customer_id = ?`).run(name, customerID);
  db.prepare(`UPDATE ledger_entries SET customer_name = ? WHERE customer_id = ?`).run(name, customerID);
  db.prepare(`UPDATE advance_in_events SET customer_name = ? WHERE customer_id = ?`).run(name, customerID);
  return { ok: true };
}

/** @param {import('better-sqlite3').Database} db */
export function insertPurchaseOrder(db, payload, branchId = DEFAULT_BRANCH_ID) {
  const {
    poID,
    supplierID,
    supplierName,
    orderDateISO,
    expectedDeliveryISO,
    status,
    lines,
  } = payload;
  const kind = deriveProcurementKindFromProductIds((lines || []).map((l) => l.productID));
  const insPo = db.prepare(`
    INSERT INTO purchase_orders (
      po_id, supplier_id, supplier_name, order_date_iso, expected_delivery_iso, status,
      invoice_no, invoice_date_iso, delivery_date_iso, transport_agent_id, transport_agent_name,
      transport_paid, transport_paid_at_iso, supplier_paid_ngn, branch_id, procurement_kind
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insL = db.prepare(`
    INSERT INTO purchase_order_lines (
      po_id, line_key, product_id, product_name, color, gauge, meters_offered, conversion_kg_per_m,
      unit_price_per_kg_ngn, unit_price_ngn, qty_ordered, qty_received
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  db.transaction(() => {
    insPo.run(
      poID,
      supplierID,
      supplierName,
      orderDateISO || new Date().toISOString().slice(0, 10),
      expectedDeliveryISO || '',
      status || 'Approved',
      '',
      '',
      '',
      '',
      '',
      0,
      '',
      0,
      String(branchId || DEFAULT_BRANCH_ID).trim(),
      kind
    );
    for (const l of lines || []) {
      insL.run(
        poID,
        l.lineKey,
        l.productID,
        l.productName,
        l.color ?? '',
        l.gauge ?? '',
        l.metersOffered ?? null,
        l.conversionKgPerM ?? null,
        l.unitPricePerKgNgn ?? l.unitPriceNgn,
        l.unitPriceNgn,
        l.qtyOrdered,
        l.qtyReceived ?? 0
      );
    }
    appendMovementTx(db, {
      type: 'PO_CREATED',
      ref: poID,
      detail: `${supplierName} · ${(lines || []).length} line(s)`,
    });
    syncAccountsPayableFromPurchaseOrder(db, poID);
  })();

  return { ok: true, poID };
}

/**
 * Keeps `accounts_payable` aligned with coil/PO supplier balances for Finance → Payables.
 * - Inserts a row when none exists for this PO (ap_id AP-PO-{po_id}).
 * - Updates paid_ngn from purchase_orders.supplier_paid_ngn for any row with matching po_ref.
 * - Refreshes amount from PO lines only for auto rows (ap_id LIKE 'AP-PO-%') so seeded/demo AP amounts stay intact.
 * - Removes payables when the PO is Rejected.
 * @param {import('better-sqlite3').Database} db
 */
export function syncAccountsPayableFromPurchaseOrder(db, poID) {
  const row = db.prepare(`SELECT * FROM purchase_orders WHERE po_id = ?`).get(poID);
  if (!row) return;
  const st = String(row.status || '').trim();
  if (st === 'Rejected') {
    db.prepare(`DELETE FROM accounts_payable WHERE po_ref = ?`).run(poID);
    return;
  }
  const lineRows = db
    .prepare(
      `SELECT qty_ordered, unit_price_ngn, unit_price_per_kg_ngn FROM purchase_order_lines WHERE po_id = ?`
    )
    .all(poID);
  let amountNgn = 0;
  for (const l of lineRows) {
    const qty = Number(l.qty_ordered) || 0;
    const up = roundMoney(l.unit_price_ngn ?? l.unit_price_per_kg_ngn);
    amountNgn += roundMoney(qty * up);
  }
  const paidNgn = roundMoney(row.supplier_paid_ngn);
  const inv = String(row.invoice_no || '').trim();
  const due = String(row.expected_delivery_iso || row.order_date_iso || '').slice(0, 10);
  const existing = db.prepare(`SELECT ap_id FROM accounts_payable WHERE po_ref = ? LIMIT 1`).get(poID);
  if (existing) {
    db.prepare(
      `UPDATE accounts_payable SET supplier_name = ?, paid_ngn = ?,
         invoice_ref = CASE WHEN ? != '' THEN ? ELSE invoice_ref END,
         due_date_iso = CASE WHEN ? != '' THEN ? ELSE due_date_iso END
       WHERE po_ref = ?`
    ).run(row.supplier_name, paidNgn, inv, inv, due, due, poID);
    db.prepare(`UPDATE accounts_payable SET amount_ngn = ? WHERE po_ref = ? AND ap_id LIKE 'AP-PO-%'`).run(
      amountNgn,
      poID
    );
  } else {
    db.prepare(
      `INSERT INTO accounts_payable (ap_id, supplier_name, po_ref, invoice_ref, amount_ngn, paid_ngn, due_date_iso, payment_method)
       VALUES (?,?,?,?,?,?,?,NULL)`
    ).run(`AP-PO-${poID}`, row.supplier_name, poID, inv, amountNgn, paidNgn, due);
  }
}

/**
 * Replace PO header and line rows. For each line_key that already existed, qty_received is carried
 * forward (capped by the new qty_ordered) so GRN history is not wiped.
 * @param {import('better-sqlite3').Database} db
 */
export function updatePurchaseOrderCoilDraft(db, poID, payload, branchId = DEFAULT_BRANCH_ID) {
  const id = String(poID || '').trim();
  if (!id) return { ok: false, error: 'PO id required.' };
  const row = db.prepare(`SELECT * FROM purchase_orders WHERE po_id = ?`).get(id);
  if (!row) return { ok: false, error: 'Purchase order not found.' };
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
  if (String(row.branch_id || '').trim() !== bid) {
    return { ok: false, error: 'PO is not in the current branch.' };
  }

  const prevLines = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ?`).all(id);
  const prevByKey = new Map(prevLines.map((r) => [String(r.line_key || '').trim(), r]));

  const { supplierID, supplierName, orderDateISO, expectedDeliveryISO, lines } = payload || {};
  const sid = String(supplierID || '').trim();
  const sname = String(supplierName || '').trim();
  if (!sid || !sname) {
    return { ok: false, error: 'Supplier is required.' };
  }
  const normLines = Array.isArray(lines) ? lines : [];
  if (!normLines.length) {
    return { ok: false, error: 'At least one line is required.' };
  }
  for (const l of normLines) {
    const lk = String(l.lineKey || '').trim();
    if (!lk) return { ok: false, error: 'Each line needs a lineKey.' };
    const pid = String(l.productID || '').trim();
    if (!pid) return { ok: false, error: 'Each line needs a product.' };
    const qty = Number(l.qtyOrdered);
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: 'Each line needs ordered qty > 0.' };
  }

  const insL = db.prepare(`
    INSERT INTO purchase_order_lines (
      po_id, line_key, product_id, product_name, color, gauge, meters_offered, conversion_kg_per_m,
      unit_price_per_kg_ngn, unit_price_ngn, qty_ordered, qty_received
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const nextKind = deriveProcurementKindFromProductIds(normLines.map((l) => l.productID));

  db.transaction(() => {
    db.prepare(
      `UPDATE purchase_orders SET supplier_id = ?, supplier_name = ?, order_date_iso = ?, expected_delivery_iso = ?, procurement_kind = ? WHERE po_id = ?`
    ).run(
      sid,
      sname,
      orderDateISO || row.order_date_iso || new Date().toISOString().slice(0, 10),
      expectedDeliveryISO !== undefined ? String(expectedDeliveryISO) : String(row.expected_delivery_iso || ''),
      nextKind,
      id
    );
    db.prepare(`DELETE FROM purchase_order_lines WHERE po_id = ?`).run(id);
    for (const l of normLines) {
      const lk = String(l.lineKey).trim();
      const qtyOrd = Number(l.qtyOrdered);
      const prev = prevByKey.get(lk);
      const wasRec = prev ? Number(prev.qty_received) || 0 : 0;
      const qtyRec = Math.min(qtyOrd, wasRec);
      const perKg = l.unitPricePerKgNgn ?? l.unitPriceNgn;
      const unitNgn = l.unitPriceNgn ?? perKg;
      insL.run(
        id,
        lk,
        String(l.productID).trim(),
        String(l.productName || l.productID).trim(),
        l.color ?? '',
        l.gauge ?? '',
        l.metersOffered ?? null,
        l.conversionKgPerM ?? null,
        perKg,
        unitNgn,
        qtyOrd,
        qtyRec
      );
    }
    appendMovementTx(db, {
      type: 'PO_UPDATED',
      ref: id,
      detail: `${sname} · ${normLines.length} line(s) revised`,
    });
    syncAccountsPayableFromPurchaseOrder(db, id);
  })();

  return { ok: true, poID: id };
}

/** @param {import('better-sqlite3').Database} db */
export function backfillAccountsPayableFromPurchaseOrders(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_orders'`).get()) return;
  const ids = db.prepare(`SELECT po_id FROM purchase_orders`).all().map((r) => r.po_id);
  for (const id of ids) {
    syncAccountsPayableFromPurchaseOrder(db, id);
  }
}

export function sumTransportPaymentsForPo(db, poID) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount_ngn < 0 THEN -amount_ngn ELSE amount_ngn END), 0) AS paid
       FROM treasury_movements
       WHERE type = 'TRANSPORT_PAYMENT'
         AND source_kind = 'PURCHASE_ORDER'
         AND source_id = ?
         AND reverses_movement_id IS NULL`
    )
    .get(poID);
  return roundMoney(row?.paid);
}

/**
 * Derives PO status, transport_paid, transport_paid_ngn from cumulative TRANSPORT_PAYMENT movements.
 * Advance threshold (transport_advance_ngn, defaulting to full quoted fee) moves the PO to In Transit.
 * When cumulative payments reach the full quoted fee, transport is marked settled.
 * @param {import('better-sqlite3').Database} db
 */
export function syncPurchaseOrderTransportPaymentState(db, poID, actor = null) {
  const row = db.prepare(`SELECT * FROM purchase_orders WHERE po_id = ?`).get(poID);
  if (!row) return { ok: false, error: 'PO not found.' };
  if (!String(row.transport_agent_id ?? '').trim()) return { ok: true, skipped: true };

  const total = roundMoney(row.transport_amount_ngn) || 0;
  const paid = sumTransportPaymentsForPo(db, poID);
  let adv = roundMoney(row.transport_advance_ngn) || 0;
  if (total > 0 && adv <= 0) adv = total;

  const transportPaidNgn = paid;
  const fullyPaid = total > 0 && paid >= total;
  const advanceMet = total > 0 && paid >= adv;

  const prevStatus = row.status;
  let nextStatus = prevStatus;

  if (total <= 0) {
    if (prevStatus === 'Approved' || prevStatus === 'On loading') nextStatus = 'In Transit';
  } else if (advanceMet && (prevStatus === 'Approved' || prevStatus === 'On loading')) {
    nextStatus = 'In Transit';
  }

  const transportPaid = fullyPaid ? 1 : 0;
  const paidAt = fullyPaid ? row.transport_paid_at_iso || new Date().toISOString() : null;

  const latestMv = db
    .prepare(
      `SELECT id FROM treasury_movements
       WHERE type = 'TRANSPORT_PAYMENT' AND source_kind = 'PURCHASE_ORDER' AND source_id = ?
       ORDER BY posted_at_iso DESC, id DESC LIMIT 1`
    )
    .get(poID);
  const movementId = latestMv?.id ? String(latestMv.id) : null;

  db.prepare(
    `UPDATE purchase_orders SET
       transport_paid_ngn = ?,
       transport_paid = ?,
       transport_paid_at_iso = ?,
       transport_treasury_movement_id = ?,
       status = ?
     WHERE po_id = ?`
  ).run(transportPaidNgn, transportPaid, paidAt, movementId, nextStatus, poID);

  void actor;
  return { ok: true, prevStatus, nextStatus, paid, total, fullyPaid };
}

/**
 * Link haulier to PO. Optional immediate treasury payment (legacy / API). Otherwise stores fee + advance split for Finance.
 * In transit and settlement follow cumulative treasury payments via syncPurchaseOrderTransportPaymentState.
 * @param {import('better-sqlite3').Database} db
 */
export function linkTransport(db, poID, transportAgentId, transportAgentName, opts = {}) {
  const transportReference = String(opts.transportReference ?? '').trim();
  const transportNote = String(opts.transportNote ?? '').trim();
  const transportFinanceAdvice = String(opts.transportFinanceAdvice ?? '').trim();
  const amountNgn = roundMoney(opts.transportAmountNgn);
  const treasuryAccountId = Number(opts.treasuryAccountId);
  const dateISO = String(opts.dateISO || '').trim() || new Date().toISOString().slice(0, 10);
  const wantsTreasury = treasuryAccountId > 0 && amountNgn > 0;
  const amtFromPayload =
    opts.transportAmountNgn != null && opts.transportAmountNgn !== '' ? roundMoney(opts.transportAmountNgn) : null;
  let advanceNgn = roundMoney(opts.transportAdvanceNgn);

  const row = db.prepare(`SELECT * FROM purchase_orders WHERE po_id = ?`).get(poID);
  if (!row) return { ok: false, error: 'PO not found.' };
  if (!['Approved', 'On loading'].includes(row.status)) {
    return { ok: false, error: 'PO not found or not ready for transit linking.' };
  }

  try {
    db.transaction(() => {
      let movementId = null;
      let recordedAmount = Number(row.transport_amount_ngn) || 0;

      if (wantsTreasury) {
        assertPeriodOpen(db, dateISO, 'Transport payment date');
        const reference = String(opts.reference ?? transportReference ?? poID).trim() || poID;
        const noteBase = String(opts.note ?? '').trim() || 'PO transport / haulage';
        const noteMerged = [noteBase, transportFinanceAdvice].filter(Boolean).join(' · ') || noteBase;
        const m = insertTreasuryMovementTx(db, {
          type: 'TRANSPORT_PAYMENT',
          treasuryAccountId,
          amountNgn: -amountNgn,
          postedAtISO: opts.postedAtISO || new Date().toISOString(),
          reference,
          counterpartyKind: 'TRANSPORT_AGENT',
          counterpartyId: String(transportAgentId ?? '').trim() || null,
          counterpartyName: String(transportAgentName ?? '').trim() || null,
          sourceKind: 'PURCHASE_ORDER',
          sourceId: poID,
          note: noteMerged,
          createdBy: opts.createdBy ?? 'Procurement',
        });
        movementId = m.id;
        recordedAmount = amountNgn;
      } else if (amtFromPayload != null) {
        recordedAmount = amtFromPayload;
      }

      if (advanceNgn <= 0 && recordedAmount > 0) advanceNgn = recordedAmount;

      let nextStatus = 'On loading';
      if (!wantsTreasury && recordedAmount <= 0) nextStatus = 'In Transit';

      const u = db.prepare(
        `UPDATE purchase_orders SET
          transport_agent_id = ?,
          transport_agent_name = ?,
          transport_reference = ?,
          transport_note = ?,
          transport_finance_advice = ?,
          transport_amount_ngn = ?,
          transport_advance_ngn = ?,
          transport_treasury_movement_id = ?,
          transport_paid = 0,
          transport_paid_at_iso = NULL,
          transport_paid_ngn = 0,
          status = CASE WHEN ? = 1 THEN status ELSE ? END
         WHERE po_id = ? AND status IN ('Approved', 'On loading')`
      );
      const r = u.run(
        transportAgentId,
        transportAgentName,
        transportReference || null,
        transportNote || null,
        transportFinanceAdvice || null,
        recordedAmount,
        advanceNgn,
        movementId,
        wantsTreasury ? 1 : 0,
        nextStatus,
        poID
      );
      if (r.changes === 0) throw new Error('PO not found or not ready for transit linking.');

      appendMovementTx(db, {
        type: 'PO_TRANSPORT_LINK',
        ref: poID,
        detail: `${transportAgentName}${transportReference ? ` · ${transportReference}` : ''}${
          wantsTreasury ? ' · treasury' : ''
        }`,
      });
      if (wantsTreasury) {
        appendAuditLog(db, {
          actor: opts.actor,
          action: 'purchase_order.link_transport',
          entityKind: 'purchase_order',
          entityId: poID,
          note: 'Transport linked with haulage payment',
          details: { treasuryMovementId: movementId, amountNgn, inTransit: true },
        });
      }

      syncPurchaseOrderTransportPaymentState(db, poID, opts.actor);
    })();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Records a treasury transport payment for a PO. In transit / settled state is derived via
 * syncPurchaseOrderTransportPaymentState (advance vs full fee).
 * @param {import('better-sqlite3').Database} db
 */
export function postPurchaseOrderTransport(db, poID, opts = {}) {
  const row = db.prepare(`SELECT * FROM purchase_orders WHERE po_id = ?`).get(poID);
  if (!row) return { ok: false, error: 'PO not found.' };
  if (!['Approved', 'On loading', 'In Transit'].includes(row.status)) {
    return {
      ok: false,
      error: 'PO must be Approved, On loading, or In transit with transport assigned.',
    };
  }
  if (!String(row.transport_agent_id ?? '').trim()) {
    return { ok: false, error: 'Assign a transport agent first.' };
  }
  const treasuryAccountId = Number(opts.treasuryAccountId);
  const amountNgn = roundMoney(opts.amountNgn);
  const hasTreasury = treasuryAccountId > 0 && amountNgn > 0;
  if (!hasTreasury) {
    return {
      ok: false,
      error:
        'Treasury payment is required. In transit and transport settlement follow Finance payments against this PO.',
    };
  }
  const dateISO = String(opts.dateISO || '').trim() || new Date().toISOString().slice(0, 10);
  const reference = String(opts.reference ?? row.transport_reference ?? poID).trim() || poID;
  const note = String(opts.note ?? '').trim() || 'PO transport / haulage';
  try {
    db.transaction(() => {
      assertPeriodOpen(db, dateISO, 'Transport payment date');
      const m = insertTreasuryMovementTx(db, {
        type: 'TRANSPORT_PAYMENT',
        treasuryAccountId,
        amountNgn: -amountNgn,
        postedAtISO: opts.postedAtISO || new Date().toISOString(),
        reference,
        counterpartyKind: 'TRANSPORT_AGENT',
        counterpartyId: String(row.transport_agent_id ?? '').trim() || null,
        counterpartyName: String(row.transport_agent_name ?? '').trim() || null,
        sourceKind: 'PURCHASE_ORDER',
        sourceId: poID,
        note,
        createdBy: opts.createdBy ?? 'Finance',
      });
      appendMovementTx(db, {
        type: 'PO_TRANSPORT_POSTED',
        ref: poID,
        detail: `${reference} · treasury`,
      });
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'purchase_order.post_transport',
        entityKind: 'purchase_order',
        entityId: poID,
        note: 'Transport treasury payment posted',
        details: { treasuryMovementId: m.id, amountNgn },
      });
      syncPurchaseOrderTransportPaymentState(db, poID, opts.actor);
    })();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function markTransportPaid(db, poID) {
  void poID;
  return {
    ok: false,
    error:
      'Transport settlement is recorded automatically when cumulative treasury payments reach the quoted transport fee.',
  };
}

export function recordSupplierPayment(db, poID, amountNgn, note, opts = {}) {
  const amt = Number(amountNgn);
  if (Number.isNaN(amt) || amt <= 0) return { ok: false, error: 'Invalid amount.' };
  const row = db.prepare(`SELECT * FROM purchase_orders WHERE po_id = ?`).get(poID);
  if (!row) return { ok: false, error: 'PO not found.' };
  try {
    assertPeriodOpen(db, opts.dateISO || new Date().toISOString().slice(0, 10), 'Supplier payment date');
    db.transaction(() => {
      db.prepare(`UPDATE purchase_orders SET supplier_paid_ngn = ? WHERE po_id = ?`).run(
        (row.supplier_paid_ngn || 0) + amt,
        poID
      );
      appendMovementTx(db, {
        type: 'PO_SUPPLIER_PAYMENT',
        ref: poID,
        detail: `${amt}${note ? ` — ${note}` : ''}`,
      });
      if (opts.treasuryAccountId) {
        insertTreasuryMovementTx(db, {
          type: 'SUPPLIER_PAYMENT',
          treasuryAccountId: opts.treasuryAccountId,
          amountNgn: -amt,
          postedAtISO: opts.dateISO,
          reference: opts.reference || note || poID,
          counterpartyKind: 'SUPPLIER',
          counterpartyId: row.supplier_id,
          counterpartyName: row.supplier_name,
          sourceKind: 'PURCHASE_ORDER',
          sourceId: poID,
          note: note || 'Supplier settlement',
          createdBy: opts.createdBy ?? 'Procurement',
        });
      }
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'purchase_order.pay_supplier',
        entityKind: 'purchase_order',
        entityId: poID,
        note: note || 'Supplier settlement recorded',
        details: { amountNgn: amt, treasuryAccountId: opts.treasuryAccountId ?? null },
      });
      syncAccountsPayableFromPurchaseOrder(db, poID);
    })();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function setPoStatus(db, poID, status) {
  const r = db.prepare(`UPDATE purchase_orders SET status = ? WHERE po_id = ?`).run(status, poID);
  if (r.changes === 0) return { ok: false, error: 'PO not found.' };
  appendMovementTx(db, { type: 'PO_STATUS', ref: poID, detail: status });
  syncAccountsPayableFromPurchaseOrder(db, poID);
  return { ok: true };
}

export function attachSupplierInvoice(db, poID, invoiceNo, invoiceDateISO, deliveryDateISO) {
  db.prepare(
    `UPDATE purchase_orders SET invoice_no = ?, invoice_date_iso = ?, delivery_date_iso = ? WHERE po_id = ?`
  ).run(invoiceNo?.trim() ?? '', invoiceDateISO ?? '', deliveryDateISO ?? '', poID);
  appendMovementTx(db, {
    type: 'SUPPLIER_INVOICE',
    ref: poID,
    detail: invoiceNo?.trim() || '—',
  });
  syncAccountsPayableFromPurchaseOrder(db, poID);
  return { ok: true };
}

export function confirmDelivery(db, deliveryId, payload = {}) {
  const row = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(deliveryId);
  if (!row) return { ok: false, error: 'Delivery not found.' };
  const status = payload.status?.trim() || 'Delivered';
  const deliveredDateISO = payload.deliveredDateISO || new Date().toISOString().slice(0, 10);
  const podNotes = payload.podNotes?.trim?.() ?? '';
  const courierConfirmed = payload.courierConfirmed ? 1 : 0;
  const customerSignedPod = payload.customerSignedPod ? 1 : 0;
  try {
    db.transaction(() => {
      const lines = db.prepare(`SELECT * FROM delivery_lines WHERE delivery_id = ? ORDER BY sort_order`).all(deliveryId);
      if (status === 'Delivered' && !row.fulfillment_posted) {
        for (const line of lines) {
          const qty = Number(line.qty) || 0;
          if (qty <= 0) continue;
          const product = db
            .prepare(`SELECT stock_level, name FROM products WHERE product_id = ?`)
            .get(line.product_id);
          if (!product) throw new Error(`Delivery line product ${line.product_id} not found.`);
          if (Number(product.stock_level) < qty) {
            throw new Error(`Insufficient stock for ${product.name || line.product_id}.`);
          }
        }
        for (const line of lines) {
          const qty = Number(line.qty) || 0;
          if (qty <= 0) continue;
          db.prepare(`UPDATE products SET stock_level = stock_level - ? WHERE product_id = ?`).run(
            qty,
            line.product_id
          );
          appendMovementTx(db, {
            type: 'CUSTOMER_DELIVERY',
            ref: deliveryId,
            productID: line.product_id,
            qty: -qty,
            detail: `${row.customer_name || 'Customer'} · ${line.product_name || line.product_id}`,
            dateISO: deliveredDateISO,
          });
        }
      }
      db.prepare(
        `UPDATE deliveries
         SET status = ?, delivered_date_iso = ?, pod_notes = ?, courier_confirmed = ?, customer_signed_pod = ?,
             fulfillment_posted = CASE
               WHEN ? = 'Delivered' AND fulfillment_posted = 0 THEN CASE
                 WHEN EXISTS (SELECT 1 FROM delivery_lines WHERE delivery_id = ?) THEN 1
                 ELSE fulfillment_posted
               END
               ELSE fulfillment_posted
             END
         WHERE id = ?`
      ).run(
        status,
        deliveredDateISO,
        podNotes,
        courierConfirmed,
        customerSignedPod,
        status,
        deliveryId,
        deliveryId
      );
    })();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function findPoLine(poRows, entry) {
  if (entry.lineKey) return poRows.find((l) => l.line_key === entry.lineKey);
  return poRows.find((l) => l.product_id === entry.productID);
}

/** PO line pricing → landed NGN and per-kg unit cost for a GRN line. */
export function coilLineReceiptEconomics(line, qtyReceived, effectiveWeightKg, supplierExpectedMeters) {
  const upkg = Math.round(Number(line.unit_price_per_kg_ngn ?? line.unitPricePerKgNgn) || 0);
  const up = Math.round(Number(line.unit_price_ngn ?? line.unitPriceNgn) || 0);
  const w = Number(effectiveWeightKg) || 0;
  const q = Number(qtyReceived) || 0;
  const meters = Number(supplierExpectedMeters);
  let landed = 0;
  if (upkg > 0 && w > 0) landed = Math.round(w * upkg);
  else if (up > 0 && Number.isFinite(meters) && meters > 0) landed = Math.round(meters * up);
  else if (up > 0 && q > 0) landed = Math.round(q * up);
  const baseKg = w > 0 ? w : q > 0 ? q : 0;
  const unitCost = landed > 0 && baseKg > 0 ? Math.round(landed / baseKg) : null;
  return { landedCostNgn: landed > 0 ? landed : null, unitCostNgnPerKg: unitCost };
}

function conversionRelDiff(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return 0;
  return Math.abs(x - y) / Math.max(x, y);
}

/** @param {import('better-sqlite3').Database} db */
export function confirmGrn(
  db,
  poID,
  entries,
  supplierID,
  supplierName,
  branchFallback = DEFAULT_BRANCH_ID,
  opts = {}
) {
  const po = db.prepare(`SELECT * FROM purchase_orders WHERE po_id = ?`).get(poID);
  if (!po) return { ok: false, error: 'Purchase order not found.' };
  if (!['On loading', 'In Transit', 'Approved'].includes(po.status)) {
    return { ok: false, error: 'PO not in receivable status.' };
  }

  const lines = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ?`).all(poID);
  const products = db.prepare(`SELECT * FROM products`).all();
  const sid = supplierID ?? po.supplier_id;
  const sname = supplierName ?? po.supplier_name;

  for (const e of entries) {
    const qty = Number(e.qtyReceived);
    if (Number.isNaN(qty) || qty <= 0) return { ok: false, error: 'Enter a valid quantity received.' };
    const line = findPoLine(lines, e);
    if (!line) return { ok: false, error: 'Line not on this PO.' };
    /* Allow qty above open PO balance (over-delivery / weighbridge vs paperwork). */
  }

  const allowConvSkip = Boolean(opts.allowConversionMismatch);
  if (!allowConvSkip) {
    for (const e of entries) {
      const line = findPoLine(lines, e);
      const prodRow = products.find((row) => row.product_id === e.productID);
      const isStone =
        prodRow != null
          ? isStoneMeterProductRow(prodRow)
          : /^STONE-/i.test(String(e.productID || '').trim());
      const isAcc =
        prodRow != null
          ? /^ACC-/i.test(String(prodRow.product_id || '').trim())
          : /^ACC-/i.test(String(e.productID || '').trim());
      if (isStone || isAcc) continue;
      const lc = Number(line.conversion_kg_per_m);
      const ec =
        e.supplierConversionKgPerM != null && e.supplierConversionKgPerM !== ''
          ? Number(e.supplierConversionKgPerM)
          : null;
      if (
        ec != null &&
        Number.isFinite(ec) &&
        lc > 0 &&
        Number.isFinite(lc) &&
        conversionRelDiff(lc, ec) > 0.05
      ) {
        return {
          ok: false,
          error: `GRN conversion kg/m (${ec}) does not align with PO line (${lc}). Fix the entry or use an override with purchase_orders.manage.`,
        };
      }
      const sm =
        e.supplierExpectedMeters != null && e.supplierExpectedMeters !== ''
          ? Number(e.supplierExpectedMeters)
          : line.meters_offered != null
            ? Number(line.meters_offered)
            : null;
      const wRaw = e.weightKg != null && e.weightKg !== '' ? Number(e.weightKg) : null;
      const w = wRaw != null && Number.isFinite(wRaw) && wRaw > 0 ? wRaw : null;
      const conv = ec != null && Number.isFinite(ec) && ec > 0 ? ec : lc;
      if (
        sm != null &&
        w != null &&
        conv > 0 &&
        Number.isFinite(sm) &&
        Number.isFinite(w) &&
        conversionRelDiff(w, sm * conv) > 0.1
      ) {
        return {
          ok: false,
          error:
            'GRN weight vs metres×conversion check failed. Confirm supplier metres, conversion, and weighbridge weight, or use an override.',
        };
      }
    }
  }

  const coilBranch =
    String(po.branch_id || '').trim() || String(branchFallback || DEFAULT_BRANCH_ID).trim();
  const grnDateISO = new Date().toISOString().slice(0, 10);
  const glUserId = opts?.actor?.id != null ? String(opts.actor.id) : null;

  const insLot = db.prepare(`
    INSERT INTO coil_lots (
      coil_no, product_id, line_key, qty_received, weight_kg, colour, gauge_label, material_type_name,
      supplier_expected_meters, supplier_conversion_kg_per_m, qty_remaining, qty_reserved, current_weight_kg,
      current_status, location, po_id, supplier_id, supplier_name, received_at_iso, branch_id,
      landed_cost_ngn, unit_cost_ngn_per_kg
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const updLine = db.prepare(
    `UPDATE purchase_order_lines SET qty_received = qty_received + ? WHERE po_id = ? AND line_key = ?`
  );
  const updProd = db.prepare(`UPDATE products SET stock_level = stock_level + ? WHERE product_id = ?`);
  const existingLots = db.prepare(`SELECT COUNT(*) AS c FROM coil_lots`).get().c;
  const coilYy = String(new Date().getFullYear()).slice(-2);

  const coilNumbers = [];

  db.transaction(() => {
    let seq = existingLots;
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      const line = findPoLine(lines, e);
      const qty = Number(e.qtyReceived);
      const product = products.find((row) => row.product_id === e.productID);
      const isStone =
        product != null
          ? isStoneMeterProductRow(product)
          : /^STONE-/i.test(String(e.productID || '').trim());
      const isAcc =
        product != null
          ? /^ACC-/i.test(String(product.product_id || '').trim())
          : /^ACC-/i.test(String(e.productID || '').trim());

      if (isStone) {
        const stoneRef = `ST-${String(poID).replace(/[^A-Za-z0-9-]/g, '')}-${String(line.line_key || i)}`;
        coilNumbers.push(stoneRef);
        const upM = Math.round(Number(line.unit_price_ngn) || 0);
        const landedStone = upM > 0 && qty > 0 ? Math.round(qty * upM) : null;
        updLine.run(qty, poID, line.line_key);
        appendMovementTx(db, {
          type: 'STORE_GRN_STONE',
          ref: poID,
          productID: e.productID,
          qty,
          detail: `${stoneRef} · ${qty} m · ${e.location || 'main store'}`,
          dateISO: grnDateISO,
          unitPriceNgn: upM || null,
          valueNgn: landedStone,
        });
        const glS = tryPostInventoryReceiptJournal(db, {
          entryDateISO: grnDateISO,
          sourceKind: 'STONE_GRN',
          sourceId: stoneRef,
          landedCostNgn: landedStone,
          branchId: coilBranch,
          createdByUserId: glUserId,
          memo: `Stone-coated GRN ${stoneRef}`,
        });
        if (landedStone && glS && glS.ok === false) {
          throw new Error(glS.error || 'Could not post stone GRN to general ledger.');
        }
        continue;
      }

      if (isAcc) {
        const accRef = `AC-${String(poID).replace(/[^A-Za-z0-9-]/g, '')}-${String(line.line_key || i)}`;
        coilNumbers.push(accRef);
        const upEach = Math.round(Number(line.unit_price_ngn) || 0);
        const landedAcc = upEach > 0 && qty > 0 ? Math.round(qty * upEach) : null;
        updLine.run(qty, poID, line.line_key);
        appendMovementTx(db, {
          type: 'STORE_GRN_ACCESSORY',
          ref: poID,
          productID: e.productID,
          qty,
          detail: `${accRef} · ${qty} u · ${e.location || 'main store'}`,
          dateISO: grnDateISO,
          unitPriceNgn: upEach || null,
          valueNgn: landedAcc,
        });
        const glA = tryPostInventoryReceiptJournal(db, {
          entryDateISO: grnDateISO,
          sourceKind: 'ACCESSORY_GRN',
          sourceId: accRef,
          landedCostNgn: landedAcc,
          branchId: coilBranch,
          createdByUserId: glUserId,
          memo: `Accessory GRN ${accRef}`,
        });
        if (landedAcc && glA && glA.ok === false) {
          throw new Error(glA.error || 'Could not post accessory GRN to general ledger.');
        }
        continue;
      }

      seq += 1;
      const coilNo =
        e.coilNo?.trim() || `CL-${coilYy}-${String(seq).padStart(4, '0')}`;
      coilNumbers.push(coilNo);
      const wRawLot = e.weightKg != null && e.weightKg !== '' ? Number(e.weightKg) : null;
      const w = wRawLot != null && Number.isFinite(wRawLot) && wRawLot > 0 ? wRawLot : null;
      const effectiveWeightKg = w != null ? w : qty;
      const supplierExpectedMeters =
        e.supplierExpectedMeters != null && e.supplierExpectedMeters !== ''
          ? Number(e.supplierExpectedMeters)
          : line.meters_offered;
      const supplierConversionKgPerM =
        e.supplierConversionKgPerM != null && e.supplierConversionKgPerM !== ''
          ? Number(e.supplierConversionKgPerM)
          : line.conversion_kg_per_m;
      const econ = coilLineReceiptEconomics(
        line,
        qty,
        effectiveWeightKg,
        supplierExpectedMeters != null && !Number.isNaN(supplierExpectedMeters) ? supplierExpectedMeters : null
      );
      insLot.run(
        coilNo,
        e.productID,
        line.line_key,
        qty,
        w != null && !Number.isNaN(w) ? w : null,
        String(e.colour ?? line.color ?? '').trim() || null,
        String(e.gaugeLabel ?? line.gauge ?? '').trim() || null,
        String(e.materialTypeName ?? product?.material_type ?? '').trim() || null,
        supplierExpectedMeters != null && !Number.isNaN(supplierExpectedMeters) ? supplierExpectedMeters : null,
        supplierConversionKgPerM != null && !Number.isNaN(supplierConversionKgPerM) ? supplierConversionKgPerM : null,
        effectiveWeightKg,
        0,
        effectiveWeightKg,
        'Available',
        e.location?.trim() || null,
        poID,
        sid,
        sname,
        grnDateISO,
        coilBranch,
        econ.landedCostNgn,
        econ.unitCostNgnPerKg
      );
      updLine.run(qty, poID, line.line_key);
      appendMovementTx(db, {
        type: 'STORE_GRN',
        ref: poID,
        productID: e.productID,
        qty,
        detail: `${coilNo} · ${e.location || 'main store'}`,
        dateISO: grnDateISO,
        unitPriceNgn: econ.unitCostNgnPerKg ?? null,
        valueNgn: econ.landedCostNgn ?? null,
      });
      const glR = tryPostGrnInventoryJournal(db, {
        entryDateISO: grnDateISO,
        coilNo,
        landedCostNgn: econ.landedCostNgn,
        branchId: coilBranch,
        createdByUserId: glUserId,
      });
      if (econ.landedCostNgn && glR && glR.ok === false) {
        throw new Error(glR.error || 'Could not post GRN to general ledger.');
      }
    }

    const refreshed = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ?`).all(poID);
    const allIn = refreshed.every((l) => l.qty_received >= l.qty_ordered);
    const nextStatus = allIn ? 'Received' : po.status;
    db.prepare(`UPDATE purchase_orders SET status = ? WHERE po_id = ?`).run(nextStatus, poID);

    const deltaByProduct = {};
    for (const e of entries) {
      deltaByProduct[e.productID] = (deltaByProduct[e.productID] || 0) + Number(e.qtyReceived);
    }
    for (const pid of Object.keys(deltaByProduct)) {
      const exists = db.prepare(`SELECT 1 FROM products WHERE product_id = ?`).get(pid);
      if (exists) updProd.run(deltaByProduct[pid], pid);
    }
  })();

  return { ok: true, coilNos: coilNumbers };
}

/**
 * Direct stone-coated receipt (metres) without a PO — optional supplier for traceability.
 * @param {import('better-sqlite3').Database} db
 */
export function postStoneInventoryReceipt(db, payload, branchFallback = DEFAULT_BRANCH_ID, opts = {}) {
  const designLabel = String(payload?.designLabel ?? '').trim();
  const colourLabel = String(payload?.colourLabel ?? '').trim();
  const gaugeLabel = String(payload?.gaugeLabel ?? '').trim();
  const metres = Number(payload?.metresReceived ?? payload?.qtyReceived);
  if (!designLabel || !colourLabel || !gaugeLabel) {
    return { ok: false, error: 'Design, colour, and gauge are required.' };
  }
  if (!Number.isFinite(metres) || metres <= 0) {
    return { ok: false, error: 'Enter a valid metres received.' };
  }
  const bid = String(branchFallback || DEFAULT_BRANCH_ID).trim();
  const productId = ensureStoneProduct(db, { designLabel, colourLabel, gaugeLabel, branchId: bid });
  const upM = Math.round(Number(payload?.unitPricePerMeterNgn) || 0);
  const landed = upM > 0 ? Math.round(metres * upM) : null;
  const dateISO = String(payload?.dateISO || new Date().toISOString()).slice(0, 10);
  const glUserId = opts?.actor?.id != null ? String(opts.actor.id) : null;
  const supplierNote = String(payload?.supplierName ?? payload?.supplier_name ?? '').trim();
  const detail = [supplierNote || 'Stone receipt', `${metres} m`].filter(Boolean).join(' · ');

  try {
    db.transaction(() => {
      db.prepare(`UPDATE products SET stock_level = stock_level + ? WHERE product_id = ?`).run(metres, productId);
      appendMovementTx(db, {
        type: 'STORE_STONE_DIRECT',
        ref: String(payload?.refNote ?? '').trim() || 'DIRECT',
        productID: productId,
        qty: metres,
        detail,
        dateISO,
        unitPriceNgn: upM || null,
        valueNgn: landed,
      });
      const src = `STONE-DIR-${productId}-${dateISO}-${Date.now()}`;
      const glS = tryPostInventoryReceiptJournal(db, {
        entryDateISO: dateISO,
        sourceKind: 'STONE_RECEIPT',
        sourceId: src,
        landedCostNgn: landed,
        branchId: bid,
        createdByUserId: glUserId,
        memo: `Stone-coated receipt ${productId}`,
      });
      if (landed && glS && glS.ok === false) throw new Error(glS.error || 'GL failed.');
    })();
    return { ok: true, productId, metresReceived: metres };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Accessory stock receipt (pcs / pack / tube). No supplier required.
 */
export function postAccessoryInventoryReceipt(db, payload, branchFallback = DEFAULT_BRANCH_ID, opts = {}) {
  const productID = String(payload?.productID ?? '').trim();
  const qty = Number(payload?.qtyReceived ?? payload?.qty);
  if (!productID) return { ok: false, error: 'productID is required.' };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: 'Enter a valid quantity received.' };
  const row = db.prepare(`SELECT * FROM products WHERE product_id = ?`).get(productID);
  if (!row) return { ok: false, error: 'Product not found.' };
  const up = Math.round(Number(payload?.unitCostNgn) || 0);
  const landed = up > 0 ? Math.round(qty * up) : null;
  const dateISO = String(payload?.dateISO || new Date().toISOString()).slice(0, 10);
  const glUserId = opts?.actor?.id != null ? String(opts.actor.id) : null;
  const bid = String(branchFallback || DEFAULT_BRANCH_ID).trim();

  try {
    db.transaction(() => {
      db.prepare(`UPDATE products SET stock_level = stock_level + ? WHERE product_id = ?`).run(qty, productID);
      appendMovementTx(db, {
        type: 'STORE_ACCESSORY_DIRECT',
        ref: String(payload?.refNote ?? '').trim() || 'ACCESSORY',
        productID,
        qty,
        detail: String(payload?.note ?? '').trim() || 'Accessory receipt',
        dateISO,
        unitPriceNgn: up || null,
        valueNgn: landed,
      });
      const src = `ACC-DIR-${productID}-${dateISO}-${Date.now()}`;
      const glS = tryPostInventoryReceiptJournal(db, {
        entryDateISO: dateISO,
        sourceKind: 'ACCESSORY_RECEIPT',
        sourceId: src,
        landedCostNgn: landed,
        branchId: bid,
        createdByUserId: glUserId,
        memo: `Accessory receipt ${productID}`,
      });
      if (landed && glS && glS.ok === false) throw new Error(glS.error || 'GL failed.');
    })();
    return { ok: true, productID, qtyReceived: qty };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function pragmaHasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch {
    return false;
  }
}

function productExistsForBranch(db, productId, branchId) {
  const hasPb = pragmaHasColumn(db, 'products', 'branch_id');
  if (!hasPb) {
    return Boolean(db.prepare(`SELECT 1 FROM products WHERE product_id = ? LIMIT 1`).get(productId));
  }
  const bid = String(branchId || '').trim();
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM products WHERE product_id = ? AND (branch_id IS NULL OR TRIM(COALESCE(branch_id,'')) = '' OR branch_id = ?) LIMIT 1`
      )
      .get(productId, bid)
  );
}

function reconcileCoilProductStockFromLots(db, productID, branchId) {
  const hasB = pragmaHasColumn(db, 'coil_lots', 'branch_id');
  const bid = String(branchId || '').trim();
  const prow = db.prepare(`SELECT branch_id FROM products WHERE product_id = ?`).get(productID);
  const pBranch = prow != null ? String(prow.branch_id ?? '').trim() : '';
  const productIsGlobalCatalog = prow != null && pBranch === '';

  let sumRow;
  if (productIsGlobalCatalog) {
    sumRow = db.prepare(`SELECT COALESCE(SUM(qty_remaining), 0) AS s FROM coil_lots WHERE product_id = ?`).get(productID);
  } else if (hasB && bid) {
    sumRow = db
      .prepare(
        `SELECT COALESCE(SUM(qty_remaining), 0) AS s FROM coil_lots WHERE product_id = ? AND (branch_id IS NULL OR TRIM(COALESCE(branch_id,'')) = '' OR branch_id = ?)`
      )
      .get(productID, bid);
  } else {
    sumRow = db.prepare(`SELECT COALESCE(SUM(qty_remaining), 0) AS s FROM coil_lots WHERE product_id = ?`).get(productID);
  }
  const total = Math.round(Number(sumRow?.s) || 0);
  const hasPb = pragmaHasColumn(db, 'products', 'branch_id');
  if (productIsGlobalCatalog || !hasPb) {
    db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ?`).run(total, productID);
    return;
  }
  if (hasPb && bid) {
    const u1 = db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ? AND branch_id = ?`).run(total, productID, bid);
    if (u1.changes === 0) {
      db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ?`).run(total, productID);
    }
  } else {
    db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ?`).run(total, productID);
  }
}

/**
 * Bulk upsert coil opening balances from spreadsheet-style rows (no purchase order, no GL).
 * Rows use camelCase or snake_case. Required: coilNo, productID, currentKg (on-hand kg).
 */
export function importCoilLotsFromSpreadsheet(db, payload, branchId = DEFAULT_BRANCH_ID, actor = null) {
  const rowsIn = Array.isArray(payload?.rows) ? payload.rows : [];
  if (!rowsIn.length) return { ok: false, error: 'No rows to import.' };
  const insertOnly = Boolean(payload?.insertOnly);
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
  const hasCoilBranch = pragmaHasColumn(db, 'coil_lots', 'branch_id');

  const normalized = [];
  const rowErrors = [];
  for (let i = 0; i < rowsIn.length; i++) {
    const r = rowsIn[i];
    const coilNo = String(r.coilNo ?? r.coil_no ?? '').trim();
    const productID = String(r.productID ?? r.product_id ?? '').trim();
    if (!coilNo) {
      rowErrors.push({ row: i + 1, error: 'Missing coil number.' });
      continue;
    }
    if (!productID) {
      rowErrors.push({ row: i + 1, error: 'Missing product ID.' });
      continue;
    }
    if (!productExistsForBranch(db, productID, bid)) {
      rowErrors.push({ row: i + 1, error: `Unknown product for this branch: ${productID}` });
      continue;
    }
    const currentKg = Number(r.currentKg ?? r.current_kg ?? r.qtyRemaining ?? r.qty_remaining);
    if (!Number.isFinite(currentKg) || currentKg < 0) {
      rowErrors.push({ row: i + 1, error: 'Current kg must be a non-negative number.' });
      continue;
    }
    const qtyReserved = Math.max(0, Number(r.qtyReserved ?? r.qty_reserved ?? 0) || 0);
    if (qtyReserved > currentKg + 1e-6) {
      rowErrors.push({ row: i + 1, error: 'Qty reserved cannot exceed current kg.' });
      continue;
    }
    const qtyReceivedRaw = Number(r.qtyReceived ?? r.qty_received);
    const qtyReceived = Number.isFinite(qtyReceivedRaw) && qtyReceivedRaw >= 0 ? qtyReceivedRaw : currentKg;
    const wRaw = r.weightKg ?? r.weight_kg;
    const weightKg = wRaw != null && wRaw !== '' ? Number(wRaw) : null;
    if (weightKg != null && !Number.isFinite(weightKg)) {
      rowErrors.push({ row: i + 1, error: 'Invalid weight kg.' });
      continue;
    }
    const colour = String(r.colour ?? r.color ?? '').trim() || null;
    const gaugeLabel = String(r.gaugeLabel ?? r.gauge_label ?? r.gauge ?? '').trim() || null;
    const location = String(r.location ?? '').trim() || null;
    const supplierName = String(r.supplierName ?? r.supplier_name ?? '').trim() || null;
    const supplierID = String(r.supplierID ?? r.supplier_id ?? '').trim() || null;
    const receivedAtISO =
      String(r.receivedAtISO ?? r.received_at_iso ?? r.receivedDate ?? '').slice(0, 10) ||
      new Date().toISOString().slice(0, 10);
    const unitCostNgnPerKg = roundMoney(r.unitCostNgnPerKg ?? r.unit_cost_ngn_per_kg ?? 0);
    const landedCostNgn = roundMoney(r.landedCostNgn ?? r.landed_cost_ngn ?? 0);
    const materialTypeName = String(r.materialTypeName ?? r.material_type_name ?? '').trim() || null;
    const semRaw = r.supplierExpectedMeters ?? r.supplier_expected_meters;
    const supplierExpectedMeters =
      semRaw != null && semRaw !== '' && Number.isFinite(Number(semRaw)) ? Number(semRaw) : null;
    const scRaw = r.supplierConversionKgPerM ?? r.supplier_conversion_kg_per_m;
    const supplierConversionKgPerM =
      scRaw != null && scRaw !== '' && Number.isFinite(Number(scRaw)) ? Number(scRaw) : null;
    let currentStatus = String(r.currentStatus ?? r.current_status ?? 'Available').trim() || 'Available';
    const allowed = new Set(['Available', 'Reserved', 'Consumed']);
    if (!allowed.has(currentStatus)) currentStatus = 'Available';
    const materialOriginNote = String(r.note ?? r.materialOriginNote ?? r.material_origin_note ?? '').trim() || null;
    const parentCoilNo = String(r.parentCoilNo ?? r.parent_coil_no ?? '').trim() || null;

    normalized.push({
      coilNo,
      productID,
      qty_received: qtyReceived,
      weight_kg: weightKg != null && !Number.isNaN(weightKg) ? weightKg : null,
      colour,
      gauge_label: gaugeLabel,
      material_type_name: materialTypeName,
      supplier_expected_meters: supplierExpectedMeters,
      supplier_conversion_kg_per_m: supplierConversionKgPerM,
      qty_remaining: currentKg,
      qty_reserved: qtyReserved,
      current_weight_kg: currentKg,
      current_status: currentStatus,
      location,
      po_id: null,
      supplier_id: supplierID,
      supplier_name: supplierName,
      received_at_iso: receivedAtISO,
      parent_coil_no: parentCoilNo,
      material_origin_note: materialOriginNote,
      landed_cost_ngn: landedCostNgn > 0 ? landedCostNgn : null,
      unit_cost_ngn_per_kg: unitCostNgnPerKg > 0 ? unitCostNgnPerKg : null,
      branch_id: hasCoilBranch ? bid : null,
    });
  }

  if (!normalized.length) {
    return { ok: false, error: 'No valid rows to import.', errors: rowErrors };
  }

  const baseCols = `coil_no, product_id, line_key, qty_received, weight_kg, colour, gauge_label, material_type_name,
      supplier_expected_meters, supplier_conversion_kg_per_m, qty_remaining, qty_reserved, current_weight_kg,
      current_status, location, po_id, supplier_id, supplier_name, received_at_iso,
      parent_coil_no, material_origin_note, landed_cost_ngn, unit_cost_ngn_per_kg`;
  const upsertSql = hasCoilBranch
    ? `INSERT INTO coil_lots (${baseCols}, branch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(coil_no) DO UPDATE SET
      product_id = excluded.product_id,
      line_key = excluded.line_key,
      qty_received = excluded.qty_received,
      weight_kg = excluded.weight_kg,
      colour = excluded.colour,
      gauge_label = excluded.gauge_label,
      material_type_name = excluded.material_type_name,
      supplier_expected_meters = excluded.supplier_expected_meters,
      supplier_conversion_kg_per_m = excluded.supplier_conversion_kg_per_m,
      qty_remaining = excluded.qty_remaining,
      qty_reserved = excluded.qty_reserved,
      current_weight_kg = excluded.current_weight_kg,
      current_status = excluded.current_status,
      location = excluded.location,
      po_id = excluded.po_id,
      supplier_id = excluded.supplier_id,
      supplier_name = excluded.supplier_name,
      received_at_iso = excluded.received_at_iso,
      parent_coil_no = excluded.parent_coil_no,
      material_origin_note = excluded.material_origin_note,
      landed_cost_ngn = excluded.landed_cost_ngn,
      unit_cost_ngn_per_kg = excluded.unit_cost_ngn_per_kg,
      branch_id = excluded.branch_id`
    : `INSERT INTO coil_lots (${baseCols}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(coil_no) DO UPDATE SET
      product_id = excluded.product_id,
      line_key = excluded.line_key,
      qty_received = excluded.qty_received,
      weight_kg = excluded.weight_kg,
      colour = excluded.colour,
      gauge_label = excluded.gauge_label,
      material_type_name = excluded.material_type_name,
      supplier_expected_meters = excluded.supplier_expected_meters,
      supplier_conversion_kg_per_m = excluded.supplier_conversion_kg_per_m,
      qty_remaining = excluded.qty_remaining,
      qty_reserved = excluded.qty_reserved,
      current_weight_kg = excluded.current_weight_kg,
      current_status = excluded.current_status,
      location = excluded.location,
      po_id = excluded.po_id,
      supplier_id = excluded.supplier_id,
      supplier_name = excluded.supplier_name,
      received_at_iso = excluded.received_at_iso,
      parent_coil_no = excluded.parent_coil_no,
      material_origin_note = excluded.material_origin_note,
      landed_cost_ngn = excluded.landed_cost_ngn,
      unit_cost_ngn_per_kg = excluded.unit_cost_ngn_per_kg`;

  const insertOnlySql = hasCoilBranch
    ? `INSERT INTO coil_lots (${baseCols}, branch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    : `INSERT INTO coil_lots (${baseCols}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

  const stmtUpsert = db.prepare(upsertSql);
  const stmtInsert = db.prepare(insertOnlySql);

  const bind = (n) => {
    const base = [
      n.coilNo,
      n.productID,
      null,
      n.qty_received,
      n.weight_kg,
      n.colour,
      n.gauge_label,
      n.material_type_name,
      n.supplier_expected_meters,
      n.supplier_conversion_kg_per_m,
      n.qty_remaining,
      n.qty_reserved,
      n.current_weight_kg,
      n.current_status,
      n.location,
      n.po_id,
      n.supplier_id,
      n.supplier_name,
      n.received_at_iso,
      n.parent_coil_no,
      n.material_origin_note,
      n.landed_cost_ngn,
      n.unit_cost_ngn_per_kg,
    ];
    if (hasCoilBranch) base.push(n.branch_id);
    return base;
  };

  let imported = 0;
  const skipped = [];
  const productsToReconcile = new Set();

  try {
    db.transaction(() => {
      for (const n of normalized) {
        if (insertOnly) {
          const exists = db.prepare(`SELECT 1 FROM coil_lots WHERE coil_no = ?`).get(n.coilNo);
          if (exists) {
            skipped.push({ coilNo: n.coilNo, reason: 'Already exists (insert-only mode).' });
            continue;
          }
          try {
            stmtInsert.run(...bind(n));
            imported += 1;
            productsToReconcile.add(n.productID);
          } catch (e) {
            skipped.push({ coilNo: n.coilNo, reason: String(e.message || e) });
          }
        } else {
          stmtUpsert.run(...bind(n));
          imported += 1;
          productsToReconcile.add(n.productID);
        }
      }
      for (const pid of productsToReconcile) {
        reconcileCoilProductStockFromLots(db, pid, bid);
      }
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e), errors: rowErrors };
  }

  appendAuditLog(db, {
    actor,
    action: 'coil_lots.import_spreadsheet',
    entityKind: 'inventory',
    entityId: 'coil_lots',
    note: `Imported ${imported} coil row(s)`,
    details: { imported, skippedCount: skipped.length, insertOnly, branchId: bid },
  });

  return {
    ok: true,
    imported,
    skipped,
    errors: rowErrors.length ? rowErrors : undefined,
    reconciledProductIDs: [...productsToReconcile],
  };
}

export function adjustStock(db, productID, type, qty, reasonCode, note, dateISO) {
  const q = Number(qty);
  if (Number.isNaN(q) || q <= 0) return { ok: false, error: 'Invalid quantity.' };
  const delta = type === 'Increase' ? q : -q;
  const p = db.prepare(`SELECT stock_level FROM products WHERE product_id = ?`).get(productID);
  if (!p) return { ok: false, error: 'Product not found.' };
  const next = Math.max(0, p.stock_level + delta);
  db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ?`).run(next, productID);
  appendMovementTx(db, {
    type: 'ADJUSTMENT',
    productID,
    qty: delta,
    detail: `${reasonCode}${note ? ` — ${note}` : ''}`,
    dateISO: dateISO || new Date().toISOString().slice(0, 10),
  });
  return { ok: true };
}

export function transferToProduction(db, productID, qty, productionOrderId, dateISO) {
  const q = Number(qty);
  if (Number.isNaN(q) || q <= 0) return { ok: false, error: 'Invalid quantity.' };
  const p = db.prepare(`SELECT stock_level, branch_id FROM products WHERE product_id = ?`).get(productID);
  if (!p || p.stock_level < q) return { ok: false, error: 'Insufficient stock in store.' };
  const wipBranch = String(p.branch_id ?? '').trim();
  db.prepare(`UPDATE products SET stock_level = stock_level - ? WHERE product_id = ?`).run(q, productID);
  db.prepare(
    `INSERT INTO wip_balances (branch_id, product_id, qty) VALUES (?,?,?)
     ON CONFLICT(branch_id, product_id) DO UPDATE SET qty = wip_balances.qty + excluded.qty`
  ).run(wipBranch, productID, q);
  appendMovementTx(db, {
    type: 'TRANSFER_TO_PRODUCTION',
    productID,
    qty: q,
    ref: productionOrderId,
    dateISO: dateISO || new Date().toISOString().slice(0, 10),
  });
  return { ok: true };
}

export function receiveFinishedGoods(
  db,
  productID,
  qty,
  unitPriceNgn,
  productionOrderId,
  dateISO,
  wipRelease,
  extras = {},
  opts = {}
) {
  const q = Number(qty);
  if (Number.isNaN(q) || q <= 0) return { ok: false, error: 'Invalid quantity.' };

  const markFinish = Boolean(extras?.markSourceCoilFinished);
  const coilNo = markFinish
    ? String(extras?.sourceCoilNo ?? productionOrderId ?? '').trim()
    : '';
  const workspaceBranchId = opts?.workspaceBranchId;

  let coilRow = null;
  if (markFinish) {
    if (!coilNo) return { ok: false, error: 'Source coil number is required for manual coil finish.' };
    coilRow = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(coilNo);
    if (!coilRow) return { ok: false, error: 'Source coil not found for manual finish.' };
    const br = assertCoilInWorkspaceBranch(coilRow, workspaceBranchId);
    if (!br.ok) return br;

    const qtyRes = Math.max(0, Number(coilRow.qty_reserved) || 0);
    if (qtyRes > 1e-6) {
      return {
        ok: false,
        error: 'Release shop-floor reservations on this coil before manual finish.',
      };
    }
    let qtyRem = Number(coilRow.qty_remaining);
    if (!Number.isFinite(qtyRem) || qtyRem < 0) {
      qtyRem = Math.max(0, Number(coilRow.current_weight_kg) || 0);
    }
    if (!Number.isFinite(qtyRem) || qtyRem < 0) qtyRem = 0;
    if (qtyRem >= 100) {
      return { ok: false, error: 'Only near-finished coils below 100kg can be closed manually.' };
    }

    try {
      assertPeriodOpen(db, dateISO || new Date().toISOString().slice(0, 10), 'Manual coil finish date');
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  const src = wipRelease?.wipSourceProductID?.trim?.() ?? '';
  const wqRaw = wipRelease?.wipQtyReleased;
  const coilProductId = coilRow ? String(coilRow.product_id ?? '').trim() : '';
  const pid = String(productID ?? '').trim();
  const skipProductBump = Boolean(markFinish && coilRow && coilProductId && pid === coilProductId);

  const spool =
    extras?.spoolKg != null && String(extras.spoolKg).trim() !== ''
      ? Number(extras.spoolKg)
      : null;
  const spoolPart =
    spool != null && !Number.isNaN(spool) && spool >= 0 ? `Spool ${spool} kg` : null;
  const finishNote = markFinish && coilNo ? `Manual coil finish ${coilNo}` : null;
  const movementDetail = [spoolPart, finishNote].filter(Boolean).join(' · ') || undefined;

  try {
    db.transaction(() => {
      if (src) {
        const wq = Number(wqRaw);
        const srcProd = db.prepare(`SELECT branch_id FROM products WHERE product_id = ?`).get(src);
        const wipBranch = String(srcProd?.branch_id ?? '').trim();
        const wrow = db.prepare(`SELECT qty FROM wip_balances WHERE product_id = ? AND branch_id = ?`).get(
          src,
          wipBranch
        );
        const cur = wrow?.qty || 0;
        if (Number.isNaN(wq) || wq <= 0) {
          throw new Error('Enter WIP consumed for the selected source.');
        }
        if (wq > cur) throw new Error(`Insufficient WIP on ${src}.`);
        db.prepare(`UPDATE wip_balances SET qty = qty - ? WHERE product_id = ? AND branch_id = ?`).run(
          wq,
          src,
          wipBranch
        );
        appendMovementTx(db, {
          type: 'WIP_CONSUMED',
          productID: src,
          qty: -wq,
          ref: productionOrderId,
          detail: `Released to FG ${productID}`,
          dateISO: dateISO || new Date().toISOString().slice(0, 10),
        });
      }

      if (!skipProductBump) {
        db.prepare(`UPDATE products SET stock_level = stock_level + ? WHERE product_id = ?`).run(q, productID);
      }

      appendMovementTx(db, {
        type: 'FINISHED_GOODS',
        productID,
        qty: q,
        unitPriceNgn: Number(unitPriceNgn) || 0,
        ref: productionOrderId,
        dateISO: dateISO || new Date().toISOString().slice(0, 10),
        detail: movementDetail,
      });

      if (coilRow) {
        db.prepare(
          `UPDATE coil_lots SET qty_remaining = 0, qty_reserved = 0, current_weight_kg = 0 WHERE coil_no = ?`
        ).run(coilNo);
        finalizeCoilLotStateTx(db, coilNo);
        const bid = String(coilRow.branch_id ?? workspaceBranchId ?? DEFAULT_BRANCH_ID).trim();
        reconcileCoilProductStockFromLots(db, coilProductId, bid);
        appendAuditLog(db, {
          actor: opts.actor || null,
          action: 'coil.manual_finish',
          entityKind: 'coil_lot',
          entityId: coilNo,
          status: 'success',
          note: `${q} m FG movement · coil closed`,
          details: { coilNo, productID, qtyMeters: q, skipProductBump },
        });
      }
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  return { ok: true };
}

function assertCoilInWorkspaceBranch(row, workspaceBranchId) {
  const expected = String(workspaceBranchId || DEFAULT_BRANCH_ID).trim();
  const got = String(row.branch_id || '').trim() || DEFAULT_BRANCH_ID;
  if (got !== expected) {
    return { ok: false, error: 'Coil is not in your current workspace branch.' };
  }
  return { ok: true };
}

function finalizeCoilLotStateTx(db, coilNo) {
  const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(coilNo);
  if (!row) return;
  let qtyRemaining = Number(row.qty_remaining);
  if (!Number.isFinite(qtyRemaining) || qtyRemaining < 0) {
    qtyRemaining = Math.max(0, Number(row.current_weight_kg) || 0);
  }
  let qtyReserved = Number(row.qty_reserved);
  if (!Number.isFinite(qtyReserved) || qtyReserved < 0) qtyReserved = 0;
  qtyReserved = Math.min(qtyRemaining, qtyReserved);
  const currentStatus =
    qtyRemaining <= 0.0001
      ? 'Consumed'
      : qtyReserved >= qtyRemaining - 0.0001 && qtyReserved > 0
        ? 'Reserved'
        : 'Available';
  db.prepare(
    `UPDATE coil_lots SET qty_remaining = ?, qty_reserved = ?, current_weight_kg = ?, current_status = ? WHERE coil_no = ?`
  ).run(qtyRemaining, qtyReserved, qtyRemaining, currentStatus, coilNo);
}

/**
 * Split unreserved kg from a parent coil into a new child coil tag (off-cut / daughter roll).
 * Does not change total raw kg in products.stock_level (mass moves between coil rows).
 */
export function splitCoilLot(db, payload = {}, opts = {}) {
  const parentCoilNo = String(payload.parentCoilNo ?? payload.coilNo ?? '').trim();
  const splitKg = Number(payload.splitKg);
  const note = String(payload.note ?? '').trim();
  const dateISO = String(payload.dateISO ?? new Date().toISOString().slice(0, 10)).trim();
  const workspaceBranchId = opts.workspaceBranchId;
  const actor = opts.actor;

  if (!parentCoilNo) return { ok: false, error: 'Coil number is required.' };
  if (!Number.isFinite(splitKg) || splitKg <= 0) return { ok: false, error: 'Split weight must be a positive number.' };

  try {
    assertPeriodOpen(db, dateISO, 'Coil split date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const parent = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(parentCoilNo);
  if (!parent) return { ok: false, error: 'Coil not found.' };
  const br = assertCoilInWorkspaceBranch(parent, workspaceBranchId);
  if (!br.ok) return br;

  const qtyRem = Math.max(0, Number(parent.qty_remaining) || Number(parent.current_weight_kg) || 0);
  const qtyRes = Math.max(0, Number(parent.qty_reserved) || 0);
  const maxSplit = qtyRem - qtyRes;
  if (splitKg > maxSplit + 1e-6) {
    return {
      ok: false,
      error: `Cannot split more than ${maxSplit.toFixed(2)} kg (remaining minus reserved on this coil).`,
    };
  }

  let newCoilNo = String(payload.newCoilNo ?? '').trim();
  if (!newCoilNo) {
    const n = Number(db.prepare(`SELECT COUNT(*) AS c FROM coil_lots`).get().c) || 0;
    newCoilNo = `CL-SPLIT-${Date.now()}-${String(n + 1).padStart(4, '0')}`;
  }
  if (db.prepare(`SELECT 1 FROM coil_lots WHERE coil_no = ?`).get(newCoilNo)) {
    return { ok: false, error: `Coil ${newCoilNo} already exists.` };
  }

  const parentNewRem = qtyRem - splitKg;
  const originNote = [note, `split from ${parentCoilNo}`].filter(Boolean).join(' · ').slice(0, 2000);
  const parentLanded = Math.round(Number(parent.landed_cost_ngn) || 0);
  const parentUnit = Math.round(Number(parent.unit_cost_ngn_per_kg) || 0);
  const volBefore = qtyRem + splitKg;
  let childLanded = null;
  let parentNewLanded = parentLanded;
  if (parentLanded > 0 && volBefore > 0) {
    childLanded = Math.round((splitKg / volBefore) * parentLanded);
    parentNewLanded = Math.max(0, parentLanded - childLanded);
  }

  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE coil_lots SET qty_remaining = ?, current_weight_kg = ?, landed_cost_ngn = ? WHERE coil_no = ?`
      ).run(parentNewRem, parentNewRem, parentNewLanded, parentCoilNo);
      finalizeCoilLotStateTx(db, parentCoilNo);

      db.prepare(
        `INSERT INTO coil_lots (
          coil_no, product_id, line_key, qty_received, weight_kg, colour, gauge_label, material_type_name,
          supplier_expected_meters, supplier_conversion_kg_per_m, qty_remaining, qty_reserved, current_weight_kg,
          current_status, location, po_id, supplier_id, supplier_name, received_at_iso, branch_id,
          parent_coil_no, material_origin_note, landed_cost_ngn, unit_cost_ngn_per_kg
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        newCoilNo,
        parent.product_id,
        parent.line_key ?? null,
        splitKg,
        splitKg,
        parent.colour ?? null,
        parent.gauge_label ?? null,
        parent.material_type_name ?? null,
        parent.supplier_expected_meters ?? null,
        parent.supplier_conversion_kg_per_m ?? null,
        splitKg,
        0,
        splitKg,
        'Available',
        parent.location ?? null,
        parent.po_id ?? null,
        parent.supplier_id ?? null,
        parent.supplier_name ?? null,
        dateISO,
        parent.branch_id || DEFAULT_BRANCH_ID,
        parentCoilNo,
        originNote || null,
        childLanded,
        parentUnit || null
      );

      appendMovementTx(db, {
        type: 'COIL_SPLIT',
        productID: parent.product_id,
        qty: 0,
        ref: parentCoilNo,
        dateISO,
        detail: `Child ${newCoilNo} · ${splitKg} kg${note ? ` — ${note}` : ''}`,
      });

      appendAuditLog(db, {
        actor,
        action: 'coil.split',
        entityKind: 'coil_lot',
        entityId: newCoilNo,
        status: 'success',
        note: `Split ${splitKg} kg from ${parentCoilNo}`,
        details: { parentCoilNo, newCoilNo, splitKg },
      });
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  return { ok: true, parentCoilNo, newCoilNo, splitKg };
}

/**
 * Update storage location label for a coil lot (physical move / bay change).
 */
export function setCoilLotLocation(db, coilNo, location, opts = {}) {
  const cn = String(coilNo || '').trim();
  const loc = location == null ? null : String(location).trim() || null;
  if (!cn) return { ok: false, error: 'Coil number is required.' };
  const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(cn);
  if (!row) return { ok: false, error: 'Coil not found.' };
  const br = assertCoilInWorkspaceBranch(row, opts.workspaceBranchId);
  if (!br.ok) return br;
  const prev = String(row.location ?? '').trim() || null;
  db.prepare(`UPDATE coil_lots SET location = ? WHERE coil_no = ?`).run(loc, cn);
  appendAuditLog(db, {
    actor: opts.actor,
    action: 'coil.location',
    entityKind: 'coil_lot',
    entityId: cn,
    status: 'success',
    note: loc ? `Location → ${loc}` : 'Location cleared',
    details: { previous: prev, next: loc },
  });
  return { ok: true, coilNo: cn, location: loc };
}

/**
 * Remove kg from a coil (physical scrap, damage, trim). Reduces raw product stock; optionally credits SCRAP-COIL (or other) SKU.
 */
export function postCoilScrap(db, payload = {}, opts = {}) {
  const coilNo = String(payload.coilNo ?? '').trim();
  const kg = Number(payload.kg);
  const reason = String(payload.reason ?? 'Scrap').trim() || 'Scrap';
  const note = String(payload.note ?? '').trim();
  const dateISO = String(payload.dateISO ?? new Date().toISOString().slice(0, 10)).trim();
  const creditScrapInventory = payload.creditScrapInventory !== false;
  const scrapProductID = String(payload.scrapProductID ?? 'SCRAP-COIL').trim();
  const workspaceBranchId = opts.workspaceBranchId;
  const actor = opts.actor;

  if (!coilNo) return { ok: false, error: 'Coil number is required.' };
  if (!Number.isFinite(kg) || kg <= 0) return { ok: false, error: 'Scrap weight must be a positive number.' };

  try {
    assertPeriodOpen(db, dateISO, 'Scrap posting date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(coilNo);
  if (!row) return { ok: false, error: 'Coil not found.' };
  const br = assertCoilInWorkspaceBranch(row, workspaceBranchId);
  if (!br.ok) return br;

  const qtyRem = Math.max(0, Number(row.qty_remaining) || Number(row.current_weight_kg) || 0);
  const qtyRes = Math.max(0, Number(row.qty_reserved) || 0);
  const maxScrap = qtyRem - qtyRes;
  if (kg > maxScrap + 1e-6) {
    return {
      ok: false,
      error: `Cannot scrap more than ${maxScrap.toFixed(2)} kg (unreserved balance on this coil).`,
    };
  }

  const productID = row.product_id;
  const newRem = qtyRem - kg;

  try {
    db.transaction(() => {
      db.prepare(`UPDATE coil_lots SET qty_remaining = ?, current_weight_kg = ? WHERE coil_no = ?`).run(
        newRem,
        newRem,
        coilNo
      );
      finalizeCoilLotStateTx(db, coilNo);

      db.prepare(`UPDATE products SET stock_level = stock_level - ? WHERE product_id = ?`).run(kg, productID);
      const p = db.prepare(`SELECT stock_level FROM products WHERE product_id = ?`).get(productID);
      if (!p || Number(p.stock_level) < -1e-6) {
        throw new Error('Raw material product stock would go negative — check coil vs book stock.');
      }

      appendMovementTx(db, {
        type: 'COIL_SCRAP',
        productID,
        qty: -kg,
        ref: coilNo,
        dateISO,
        detail: `${reason}${note ? ` — ${note}` : ''}`,
      });

      if (creditScrapInventory && scrapProductID) {
        const sp = db.prepare(`SELECT 1 FROM products WHERE product_id = ?`).get(scrapProductID);
        if (!sp) throw new Error(`Scrap product ${scrapProductID} not found.`);
        db.prepare(`UPDATE products SET stock_level = stock_level + ? WHERE product_id = ?`).run(kg, scrapProductID);
        appendMovementTx(db, {
          type: 'SCRAP_INVENTORY',
          productID: scrapProductID,
          qty: kg,
          ref: coilNo,
          dateISO,
          detail: `From ${coilNo} · ${reason}`,
        });
      }

      appendAuditLog(db, {
        actor,
        action: 'coil.scrap',
        entityKind: 'coil_lot',
        entityId: coilNo,
        status: 'success',
        note: `${kg} kg · ${reason}`,
        details: { coilNo, kg, reason, scrapProductID: creditScrapInventory ? scrapProductID : null },
      });

      const metersLog = Number(payload.meters);
      const dmf = Number(payload.defectMFrom);
      const dmt = Number(payload.defectMTo);
      insertCoilControlEventTx(db, {
        branchId: String(row.branch_id || workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID,
        eventKind: String(payload.controlEventKind || 'scrap_offcut').trim() || 'scrap_offcut',
        coilNo,
        productId: productID,
        gaugeLabel: row.gauge_label,
        colour: row.colour,
        meters: Number.isFinite(metersLog) ? metersLog : null,
        kgCoilDelta: -kg,
        bookRef: payload.bookRef,
        cuttingListRef: payload.cuttingListRef,
        quotationRef: payload.quotationRef,
        supplierId: payload.supplierID,
        defectMFrom: Number.isFinite(dmf) ? dmf : null,
        defectMTo: Number.isFinite(dmt) ? dmt : null,
        supplierResolution: payload.supplierResolution,
        outboundDestination: payload.outboundDestination,
        creditScrapInventory: Boolean(creditScrapInventory && scrapProductID),
        scrapProductId: creditScrapInventory ? scrapProductID : null,
        scrapReason: reason,
        note: note || null,
        dateISO,
        actorUserId: actorId(actor),
        actorDisplay: actorName(actor),
      });
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  return { ok: true, coilNo, kg, reason };
}

/**
 * Return weighed material onto an existing coil (correction, physical return to roll, recount).
 */
export function returnCoilMaterialToStock(db, payload = {}, opts = {}) {
  const coilNo = String(payload.coilNo ?? '').trim();
  const kg = Number(payload.kg);
  const reason = String(payload.reason ?? 'Return to stock').trim() || 'Return to stock';
  const note = String(payload.note ?? '').trim();
  const dateISO = String(payload.dateISO ?? new Date().toISOString().slice(0, 10)).trim();
  const workspaceBranchId = opts.workspaceBranchId;
  const actor = opts.actor;

  if (!coilNo) return { ok: false, error: 'Coil number is required.' };
  if (!Number.isFinite(kg) || kg <= 0) return { ok: false, error: 'Returned weight must be a positive number.' };

  try {
    assertPeriodOpen(db, dateISO, 'Return-to-stock date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(coilNo);
  if (!row) return { ok: false, error: 'Coil not found.' };
  const br = assertCoilInWorkspaceBranch(row, workspaceBranchId);
  if (!br.ok) return br;

  const qtyRem = Math.max(0, Number(row.qty_remaining) || Number(row.current_weight_kg) || 0);
  const newRem = qtyRem + kg;
  const productID = row.product_id;

  try {
    db.transaction(() => {
      db.prepare(`UPDATE coil_lots SET qty_remaining = ?, current_weight_kg = ? WHERE coil_no = ?`).run(
        newRem,
        newRem,
        coilNo
      );
      finalizeCoilLotStateTx(db, coilNo);

      db.prepare(`UPDATE products SET stock_level = stock_level + ? WHERE product_id = ?`).run(kg, productID);

      appendMovementTx(db, {
        type: 'COIL_RETURN',
        productID,
        qty: kg,
        ref: coilNo,
        dateISO,
        detail: `${reason}${note ? ` — ${note}` : ''}`,
      });

      appendAuditLog(db, {
        actor,
        action: 'coil.return',
        entityKind: 'coil_lot',
        entityId: coilNo,
        status: 'success',
        note: `${kg} kg onto ${coilNo}`,
        details: { coilNo, kg, reason },
      });

      insertCoilControlEventTx(db, {
        branchId: String(row.branch_id || workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID,
        eventKind: String(payload.controlEventKind || 'adjust_add_kg').trim() || 'adjust_add_kg',
        coilNo,
        productId: productID,
        gaugeLabel: row.gauge_label,
        colour: row.colour,
        meters: null,
        kgCoilDelta: kg,
        bookRef: payload.bookRef,
        cuttingListRef: payload.cuttingListRef,
        quotationRef: payload.quotationRef,
        scrapReason: reason,
        note: note || null,
        dateISO,
        actorUserId: actorId(actor),
        actorDisplay: actorName(actor),
      });
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  return { ok: true, coilNo, kg, reason };
}

/**
 * Customer / production return into the dimensional offcut pool (no kg added back onto a live coil).
 */
export function postOffcutPoolReturnInward(db, payload = {}, opts = {}) {
  const workspaceBranchId = opts.workspaceBranchId;
  const actor = opts.actor;
  const dateISO = String(payload.dateISO ?? new Date().toISOString().slice(0, 10)).trim();
  const productId = String(payload.productID ?? '').trim();
  const gaugeLabel = String(payload.gaugeLabel ?? '').trim();
  const colour = String(payload.colour ?? '').trim();
  const meters = Number(payload.meters);
  const kgBook = payload.kgBook != null && payload.kgBook !== '' ? Number(payload.kgBook) : null;
  const bookRef = String(payload.bookRef ?? '').trim();
  const cuttingListRef = String(payload.cuttingListRef ?? '').trim();
  const quotationRef = String(payload.quotationRef ?? '').trim();
  const customerLabel = String(payload.customerLabel ?? '').trim();
  const coilNo = String(payload.coilNo ?? '').trim() || null;
  const note = String(payload.note ?? '').trim();
  const branchId = String(workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;

  if (!productId) return { ok: false, error: 'Product / SKU is required.' };
  if (!gaugeLabel || !colour) return { ok: false, error: 'Gauge and colour are required for the offcut register.' };
  if (!Number.isFinite(meters) || meters <= 0) return { ok: false, error: 'Meters must be a positive number.' };
  if (!bookRef) return { ok: false, error: 'Book / transaction reference is required.' };

  try {
    assertPeriodOpen(db, dateISO, 'Return inward date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  if (coilNo) {
    const crow = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(coilNo);
    if (!crow) return { ok: false, error: 'Source coil not found.' };
    const br = assertCoilInWorkspaceBranch(crow, workspaceBranchId);
    if (!br.ok) return br;
  }

  let eventId = '';
  try {
    db.transaction(() => {
      eventId = insertCoilControlEventTx(db, {
        branchId,
        eventKind: 'return_inward_pool',
        coilNo,
        productId,
        gaugeLabel,
        colour,
        meters,
        kgCoilDelta: 0,
        kgBook: Number.isFinite(kgBook) ? kgBook : null,
        bookRef,
        cuttingListRef: cuttingListRef || null,
        quotationRef: quotationRef || null,
        customerLabel: customerLabel || null,
        note: note || null,
        dateISO,
        actorUserId: actorId(actor),
        actorDisplay: actorName(actor),
      });
      appendAuditLog(db, {
        actor,
        action: 'coil.offcut_return_inward',
        entityKind: 'coil_control_event',
        entityId: eventId,
        status: 'success',
        note: `${meters} m · ${bookRef}`,
        details: { meters, bookRef, productId, gaugeLabel, colour, coilNo },
      });
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  return { ok: true, id: eventId, meters, bookRef };
}

/**
 * Remove kg from a coil when material leaves the branch (supplier return, disposal) without crediting scrap SKU.
 */
export function postCoilReturnOutward(db, payload = {}, opts = {}) {
  const kg = Number(payload.kg);
  const outboundDestination = String(payload.outboundDestination ?? 'disposal').trim() || 'disposal';
  const supplierId = String(payload.supplierID ?? '').trim() || null;
  const note = String(payload.note ?? '').trim();
  const bookRef = String(payload.bookRef ?? '').trim() || null;
  const meters = Number(payload.meters);
  return postCoilScrap(
    db,
    {
      ...payload,
      kg,
      reason: 'Return outward',
      note: [note, supplierId ? `supplier ${supplierId}` : '', outboundDestination].filter(Boolean).join(' · '),
      creditScrapInventory: false,
      controlEventKind: 'return_outward',
      outboundDestination,
      bookRef,
      meters: Number.isFinite(meters) ? meters : undefined,
    },
    opts
  );
}

/** Record coil head trim when opening a new roll (production register). */
export function postCoilOpenHeadTrim(db, payload = {}, opts = {}) {
  const meters = Number(payload.meters);
  const kg = Number(payload.kg);
  if (!Number.isFinite(meters) || meters <= 0) return { ok: false, error: 'Head trim meters must be positive.' };
  if (!Number.isFinite(kg) || kg <= 0) return { ok: false, error: 'Head trim kg removed from the coil is required.' };
  return postCoilScrap(
    db,
    {
      ...payload,
      kg,
      reason: 'Coil open — head trim',
      creditScrapInventory: payload.creditScrapInventory !== false,
      controlEventKind: 'coil_open_trim',
      meters,
      bookRef: payload.bookRef,
      cuttingListRef: payload.cuttingListRef,
      quotationRef: payload.quotationRef,
    },
    opts
  );
}

/**
 * Log supplier quality on a received coil (stains, mid-coil rust span, negotiation). Optional kg removes weight from the coil like scrap without scrap credit.
 */
export function postSupplierCoilDefect(db, payload = {}, opts = {}) {
  const coilNo = String(payload.coilNo ?? '').trim();
  const workspaceBranchId = opts.workspaceBranchId;
  const actor = opts.actor;
  const dateISO = String(payload.dateISO ?? new Date().toISOString().slice(0, 10)).trim();
  const supplierResolution = String(payload.supplierResolution ?? '').trim();
  const defectMFrom = Number(payload.defectMFrom);
  const defectMTo = Number(payload.defectMTo);
  const kgRemove = Number(payload.kgRemove);
  const note = String(payload.note ?? '').trim();
  const supplierId = String(payload.supplierID ?? '').trim() || null;
  const bookRef = String(payload.bookRef ?? '').trim() || null;

  if (!coilNo) return { ok: false, error: 'Coil number is required.' };
  if (!supplierResolution) return { ok: false, error: 'Supplier resolution (credit, discount, return, logged, etc.) is required.' };

  const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(coilNo);
  if (!row) return { ok: false, error: 'Coil not found.' };
  const br = assertCoilInWorkspaceBranch(row, workspaceBranchId);
  if (!br.ok) return br;

  try {
    assertPeriodOpen(db, dateISO, 'Supplier defect date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  if (Number.isFinite(kgRemove) && kgRemove > 0) {
    const scr = postCoilScrap(
      db,
      {
        coilNo,
        kg: kgRemove,
        reason: 'Supplier defect — weight removed',
        note,
        dateISO,
        creditScrapInventory: false,
        controlEventKind: 'supplier_defect',
        bookRef,
        supplierID: supplierId,
        supplierResolution,
        defectMFrom: Number.isFinite(defectMFrom) ? defectMFrom : undefined,
        defectMTo: Number.isFinite(defectMTo) ? defectMTo : undefined,
      },
      opts
    );
    if (!scr.ok) return scr;
    return { ok: true, coilNo, kgRemoved: kgRemove, supplierResolution, logged: true };
  }

  let eventId = '';
  try {
    db.transaction(() => {
      eventId = insertCoilControlEventTx(db, {
        branchId: String(row.branch_id || workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID,
        eventKind: 'supplier_defect',
        coilNo,
        productId: row.product_id,
        gaugeLabel: row.gauge_label,
        colour: row.colour,
        meters:
          Number.isFinite(defectMFrom) && Number.isFinite(defectMTo) && defectMTo > defectMFrom
            ? defectMTo - defectMFrom
            : null,
        kgCoilDelta: 0,
        bookRef,
        supplierId,
        defectMFrom: Number.isFinite(defectMFrom) ? defectMFrom : null,
        defectMTo: Number.isFinite(defectMTo) ? defectMTo : null,
        supplierResolution,
        note: note || null,
        dateISO,
        actorUserId: actorId(actor),
        actorDisplay: actorName(actor),
      });
      appendAuditLog(db, {
        actor,
        action: 'coil.supplier_defect',
        entityKind: 'coil_control_event',
        entityId: eventId,
        status: 'success',
        note: supplierResolution,
        details: { coilNo, supplierId, defectMFrom, defectMTo },
      });
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  return { ok: true, id: eventId, coilNo, supplierResolution };
}

/** Signed kg adjustment on a coil (+ adds to roll and raw SKU, − removes like scrap without scrap credit). */
export function postCoilLedgerKgAdjustment(db, payload = {}, opts = {}) {
  const delta = Number(payload.kgDelta);
  if (!Number.isFinite(delta) || delta === 0) return { ok: false, error: 'kgDelta must be a non-zero number.' };
  if (delta > 0) {
    return returnCoilMaterialToStock(
      db,
      {
        coilNo: payload.coilNo,
        kg: delta,
        reason: String(payload.reason ?? 'Coil ledger adjustment (+)').trim() || 'Coil ledger adjustment (+)',
        note: String(payload.note ?? '').trim(),
        dateISO: payload.dateISO,
        bookRef: payload.bookRef,
        cuttingListRef: payload.cuttingListRef,
        quotationRef: payload.quotationRef,
        controlEventKind: 'adjust_add_kg',
      },
      opts
    );
  }
  return postCoilScrap(
    db,
    {
      coilNo: payload.coilNo,
      kg: -delta,
      reason: String(payload.reason ?? 'Coil ledger adjustment (−)').trim() || 'Coil ledger adjustment (−)',
      note: String(payload.note ?? '').trim(),
      dateISO: payload.dateISO,
      creditScrapInventory: false,
      bookRef: payload.bookRef,
      cuttingListRef: payload.cuttingListRef,
      quotationRef: payload.quotationRef,
      controlEventKind: 'adjust_remove_kg',
    },
    opts
  );
}

export function addCoilRequest(db, payload) {
  const branchId = String(payload?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const id = nextCoilRequestHumanId(db, branchId);
  const createdAtIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO coil_requests (
      id, status, created_at_iso, branch_id, requested_by_user_id, requested_by_display, gauge, colour, material_type, requested_kg, note
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    'pending',
    createdAtIso,
    branchId,
    String(payload?.requestedByUserId || '').trim() || null,
    String(payload?.requestedByDisplay || '').trim() || null,
    payload.gauge ?? '',
    payload.colour ?? '',
    payload.materialType ?? '',
    Number(payload.requestedKg) || 0,
    payload.note ?? ''
  );
  return {
    ok: true,
    row: {
      id,
      status: 'pending',
      createdAtISO: createdAtIso,
      branchId,
      requestedByUserId: String(payload?.requestedByUserId || '').trim() || '',
      requestedByDisplay: String(payload?.requestedByDisplay || '').trim() || '',
      ...payload,
    },
  };
}

export function acknowledgeCoilRequest(db, id) {
  const r = db
    .prepare(
      `UPDATE coil_requests SET status = 'acknowledged', acknowledged_at_iso = ? WHERE id = ? AND status = 'pending'`
    )
    .run(new Date().toISOString(), id);
  if (r.changes === 0) return { ok: false, error: 'Request not found or not pending.' };
  return { ok: true };
}

export function replaceTreasuryAccounts(db, accounts) {
  const ins = db.prepare(
    `INSERT INTO treasury_accounts (id, name, bank_name, balance, type, acc_no)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       bank_name = excluded.bank_name,
       balance = excluded.balance,
       type = excluded.type,
       acc_no = excluded.acc_no`
  );
  db.transaction(() => {
    for (const a of accounts) {
      ins.run(a.id, a.name, a.bankName ?? '', Number(a.balance) || 0, a.type ?? 'Bank', a.accNo ?? 'N/A');
    }
  })();
  return { ok: true };
}

export function nextPoIdFromDb(db, branchId = DEFAULT_BRANCH_ID) {
  return nextPurchaseOrderHumanId(db, branchId);
}

export function nextSupplierIdFromDb(db) {
  const rows = db.prepare(`SELECT supplier_id FROM suppliers`).all();
  const nums = rows
    .map((r) => parseInt(String(r.supplier_id).replace(/\D/g, ''), 10))
    .filter((n) => !Number.isNaN(n));
  const n = nums.length ? Math.max(...nums) + 1 : 1;
  return `SUP-${String(n).padStart(3, '0')}`;
}

/** @param {import('better-sqlite3').Database} db */
export function insertSupplier(db, row, branchId = DEFAULT_BRANCH_ID) {
  const name = String(row.name ?? '').trim();
  if (!name) throw new Error('Supplier name is required.');
  const id = String(row.supplierID ?? '').trim() || nextSupplierIdFromDb(db);
  let profileJson = null;
  if (row.supplierProfile != null && typeof row.supplierProfile === 'object') {
    const merged = mergeSupplierProfilePatch('{}', row.supplierProfile);
    const v = validateAndNormalizeSupplierProfile(merged);
    if (!v.ok) throw new Error(v.error);
    profileJson = JSON.stringify(v.profile);
  }
  db.prepare(
    `INSERT INTO suppliers (supplier_id, name, city, payment_terms, quality_score, notes, branch_id, supplier_profile_json) VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    id,
    name,
    String(row.city ?? '').trim() || '',
    row.paymentTerms ?? 'Credit',
    Number(row.qualityScore) || 80,
    String(row.notes ?? '').trim() || '',
    String(branchId || DEFAULT_BRANCH_ID).trim(),
    profileJson
  );
  return id;
}

export function updateSupplier(db, supplierID, row, branchId = DEFAULT_BRANCH_ID) {
  const name = String(row.name ?? '').trim();
  if (!name) return { ok: false, error: 'Supplier name is required.' };
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
  let profileJson = undefined;
  if (row.supplierProfile != null && typeof row.supplierProfile === 'object') {
    const cur = db
      .prepare(`SELECT supplier_profile_json FROM suppliers WHERE supplier_id = ? AND branch_id = ?`)
      .get(supplierID, bid);
    const merged = mergeSupplierProfilePatch(cur?.supplier_profile_json, row.supplierProfile);
    const v = validateAndNormalizeSupplierProfile(merged);
    if (!v.ok) return { ok: false, error: v.error };
    profileJson = JSON.stringify(v.profile);
  }
  const r = profileJson !== undefined
    ? db
        .prepare(
          `UPDATE suppliers SET name = ?, city = ?, payment_terms = ?, quality_score = ?, notes = ?, supplier_profile_json = ? WHERE supplier_id = ? AND branch_id = ?`
        )
        .run(
          name,
          String(row.city ?? '').trim() || '',
          row.paymentTerms ?? 'Credit',
          Number(row.qualityScore) || 80,
          String(row.notes ?? '').trim() || '',
          profileJson,
          supplierID,
          bid
        )
    : db
        .prepare(
          `UPDATE suppliers SET name = ?, city = ?, payment_terms = ?, quality_score = ?, notes = ? WHERE supplier_id = ? AND branch_id = ?`
        )
        .run(
          name,
          String(row.city ?? '').trim() || '',
          row.paymentTerms ?? 'Credit',
          Number(row.qualityScore) || 80,
          String(row.notes ?? '').trim() || '',
          supplierID,
          bid
        );
  if (r.changes === 0) return { ok: false, error: 'Supplier not found.' };
  db.prepare(`UPDATE purchase_orders SET supplier_name = ? WHERE supplier_id = ?`).run(name, supplierID);
  return { ok: true };
}

export function deleteSupplier(db, supplierID, branchId = DEFAULT_BRANCH_ID) {
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
  const own = db.prepare(`SELECT supplier_id FROM suppliers WHERE supplier_id = ? AND branch_id = ?`).get(supplierID, bid);
  if (!own) return { ok: false, error: 'Supplier not found in your branch.' };
  const c = db.prepare(`SELECT COUNT(*) AS c FROM purchase_orders WHERE supplier_id = ?`).get(supplierID).c;
  if (c > 0) {
    return {
      ok: false,
      error: `Cannot delete supplier: ${c} purchase order(s) still reference this supplier.`,
    };
  }
  const r = db.prepare(`DELETE FROM suppliers WHERE supplier_id = ? AND branch_id = ?`).run(supplierID, bid);
  if (r.changes === 0) return { ok: false, error: 'Supplier not found.' };
  return { ok: true };
}

export function nextTransportAgentIdFromDb(db) {
  const rows = db.prepare(`SELECT id FROM transport_agents`).all();
  const nums = rows
    .map((r) => parseInt(String(r.id).replace(/\D/g, ''), 10))
    .filter((n) => !Number.isNaN(n));
  const n = nums.length ? Math.max(...nums) + 1 : 1;
  return `AG-${String(n).padStart(3, '0')}`;
}

function stringifyTransportAgentProfile(row) {
  const raw = row.profile ?? row.profileJson;
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') return raw.trim() || null;
  try {
    return JSON.stringify(raw);
  } catch {
    return null;
  }
}

export function insertTransportAgent(db, row, branchId = DEFAULT_BRANCH_ID) {
  const name = String(row.name ?? '').trim();
  if (!name) throw new Error('Agent name is required.');
  const id = String(row.id ?? '').trim() || nextTransportAgentIdFromDb(db);
  const profileJson = stringifyTransportAgentProfile(row);
  db.prepare(
    `INSERT INTO transport_agents (id, name, region, phone, branch_id, profile_json) VALUES (?,?,?,?,?,?)`
  ).run(
    id,
    name,
    String(row.region ?? '').trim() || '',
    String(row.phone ?? '').trim() || '',
    String(branchId || DEFAULT_BRANCH_ID).trim(),
    profileJson
  );
  return id;
}

export function updateTransportAgent(db, id, row, branchId = DEFAULT_BRANCH_ID) {
  const name = String(row.name ?? '').trim();
  if (!name) return { ok: false, error: 'Agent name is required.' };
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
  const hasProfileKey =
    row != null &&
    (Object.prototype.hasOwnProperty.call(row, 'profile') ||
      Object.prototype.hasOwnProperty.call(row, 'profileJson'));
  let r;
  if (hasProfileKey) {
    const profileJson = stringifyTransportAgentProfile(row);
    r = db
      .prepare(
        `UPDATE transport_agents SET name = ?, region = ?, phone = ?, profile_json = ? WHERE id = ? AND branch_id = ?`
      )
      .run(
        name,
        String(row.region ?? '').trim() || '',
        String(row.phone ?? '').trim() || '',
        profileJson,
        id,
        bid
      );
  } else {
    r = db
      .prepare(`UPDATE transport_agents SET name = ?, region = ?, phone = ? WHERE id = ? AND branch_id = ?`)
      .run(name, String(row.region ?? '').trim() || '', String(row.phone ?? '').trim() || '', id, bid);
  }
  if (r.changes === 0) return { ok: false, error: 'Transport agent not found.' };
  db.prepare(`UPDATE purchase_orders SET transport_agent_name = ? WHERE transport_agent_id = ?`).run(
    name,
    id
  );
  return { ok: true };
}

export function deleteTransportAgent(db, id, branchId = DEFAULT_BRANCH_ID) {
  const r = db
    .prepare(`DELETE FROM transport_agents WHERE id = ? AND branch_id = ?`)
    .run(id, String(branchId || DEFAULT_BRANCH_ID).trim());
  if (r.changes === 0) return { ok: false, error: 'Transport agent not found.' };
  return { ok: true };
}

export function replaceExpenses(db, list) {
  db.prepare(`DELETE FROM expenses`).run();
  const ins = db.prepare(
    `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference) VALUES (?,?,?,?,?,?,?)`
  );
  for (const e of list || []) {
    ins.run(
      e.expenseID,
      e.expenseType,
      e.amountNgn,
      e.date,
      e.category,
      e.paymentMethod,
      e.reference
    );
  }
}

export function replacePaymentRequests(db, list) {
  db.prepare(`DELETE FROM payment_requests`).run();
  const ins = db.prepare(
    `INSERT INTO payment_requests (
      request_id, expense_id, amount_requested_ngn, request_date, approval_status, description,
      approved_by, approved_at_iso, approval_note,
      paid_amount_ngn, paid_at_iso, paid_by, payment_note,
      request_reference, line_items_json, attachment_name, attachment_mime, attachment_data_b64
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const p of list || []) {
    const lineJson =
      typeof p.lineItemsJson === 'string'
        ? p.lineItemsJson
        : Array.isArray(p.lineItems)
          ? JSON.stringify(p.lineItems)
          : '';
    ins.run(
      p.requestID,
      p.expenseID,
      p.amountRequestedNgn,
      p.requestDate,
      p.approvalStatus,
      p.description,
      p.approvedBy ?? '',
      p.approvedAtISO ?? '',
      p.approvalNote ?? '',
      p.paidAmountNgn ?? 0,
      p.paidAtISO ?? '',
      p.paidBy ?? '',
      p.paymentNote ?? '',
      p.requestReference ?? '',
      lineJson || null,
      p.attachmentName ?? '',
      p.attachmentMime ?? '',
      p.attachmentDataB64 ?? ''
    );
  }
}

export function replaceAccountsPayable(db, list) {
  db.prepare(`DELETE FROM accounts_payable`).run();
  const ins = db.prepare(
    `INSERT INTO accounts_payable (ap_id, supplier_name, po_ref, invoice_ref, amount_ngn, paid_ngn, due_date_iso, payment_method) VALUES (?,?,?,?,?,?,?,?)`
  );
  for (const a of list || []) {
    ins.run(
      a.apID,
      a.supplierName,
      a.poRef,
      a.invoiceRef,
      a.amountNgn,
      a.paidNgn,
      a.dueDateISO,
      a.paymentMethod ?? null
    );
  }
}

export function replaceBankReconciliation(db, list) {
  db.prepare(`DELETE FROM bank_reconciliation_lines`).run();
  const ins = db.prepare(
    `INSERT INTO bank_reconciliation_lines (
      id, bank_date_iso, description, amount_ngn, system_match, status, branch_id,
      settled_amount_ngn, matched_system_amount_ngn, variance_ngn, variance_percent,
      treasury_account_id, treasury_adjustment_movement_id,
      manager_cleared_at_iso, manager_cleared_by_user_id, manager_cleared_by_name
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const b of list || []) {
    const bid = String(b.branchId ?? DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
    ins.run(
      b.id,
      b.bankDateISO,
      b.description,
      b.amountNgn,
      b.systemMatch,
      b.status,
      bid,
      b.settledAmountNgn ?? null,
      b.matchedSystemAmountNgn ?? null,
      b.varianceNgn ?? null,
      b.variancePercent ?? null,
      b.treasuryAccountId ?? null,
      b.treasuryAdjustmentMovementId ?? null,
      b.managerClearedAtISO ?? null,
      b.managerClearedByUserId ?? null,
      b.managerClearedByName ?? null
    );
  }
}

/** Strictly above 0.1%: |variance| * 1000 > |expected| (integer naira). */
function bankReconVarianceNeedsManagerClearance(varianceNgn, expectedNgn) {
  const ev = Math.abs(roundMoney(expectedNgn));
  const base = Math.max(ev, 1);
  return Math.abs(roundMoney(varianceNgn)) * 1000 > base;
}

/** Map typo/graphical dashes to ASCII hyphen so LE–… / RC–… match stored ids (Word, PDF paste). */
function normalizeReceiptMatchDashes(s) {
  return String(s || '')
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '-')
    .replace(/\u2212/g, '-');
}

/**
 * First whitespace-/bullet-separated token from the system match field (tolerates copy/paste noise).
 * Do not split on en/em dash — those often replace hyphens inside receipt ids.
 */
function firstSystemMatchToken(systemMatch) {
  let raw = String(systemMatch ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  if (!raw) return '';
  let chunk = String(raw.split(/\s+/)[0] || '').trim();
  for (const sep of ['·', '\u2219', '\u2022', '\u2023', '•']) {
    const i = chunk.indexOf(sep);
    if (i !== -1) chunk = chunk.slice(0, i).trim();
  }
  return chunk.trim();
}

/**
 * Resolve to canonical sales_receipts.id for settlement / variance (posted receipts are often LE-…).
 * @param {import('better-sqlite3').Database} db
 */
function resolveSalesReceiptIdFromSystemMatch(db, systemMatch) {
  const token = normalizeReceiptMatchDashes(firstSystemMatchToken(systemMatch));
  if (!token) return null;
  const byId = db.prepare(`SELECT id FROM sales_receipts WHERE id = ?`).get(token);
  if (byId?.id) return String(byId.id);
  const byIdCi = db.prepare(`SELECT id FROM sales_receipts WHERE lower(id) = lower(?)`).get(token);
  if (byIdCi?.id) return String(byIdCi.id);
  const byLedger = db.prepare(`SELECT id FROM sales_receipts WHERE ledger_entry_id = ?`).get(token);
  if (byLedger?.id) return String(byLedger.id);
  const byLedgerCi = db
    .prepare(`SELECT id FROM sales_receipts WHERE ledger_entry_id IS NOT NULL AND lower(ledger_entry_id) = lower(?)`)
    .get(token);
  return byLedgerCi?.id ? String(byLedgerCi.id) : null;
}

function expectedReceiptSettlementNgn(db, receiptId) {
  const row = db.prepare(`SELECT amount_ngn FROM sales_receipts WHERE id = ?`).get(receiptId);
  const treasSum = db
    .prepare(
      `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM treasury_movements
       WHERE source_kind = 'LEDGER_RECEIPT' AND source_id = ?`
    )
    .get(receiptId);
  const t = roundMoney(treasSum?.s);
  if (t !== 0) return t;
  return roundMoney(row?.amount_ngn || 0);
}

function primaryTreasuryAccountForReceipt(db, receiptId) {
  const rows = db
    .prepare(
      `SELECT treasury_account_id, amount_ngn FROM treasury_movements
       WHERE source_kind = 'LEDGER_RECEIPT' AND source_id = ?
       ORDER BY ABS(amount_ngn) DESC`
    )
    .all(receiptId);
  const first = rows.find((r) => Number(r.treasury_account_id) > 0);
  return first ? Number(first.treasury_account_id) : 0;
}

/** Fallback when a receipt has no LEDGER_RECEIPT treasury split (e.g. legacy import). */
function firstTreasuryAccountId(db) {
  const r = db.prepare(`SELECT id FROM treasury_accounts ORDER BY id ASC LIMIT 1`).get();
  return r?.id ? Number(r.id) : 0;
}

function postBankReconTreasuryVariance(db, params) {
  const {
    lineId,
    deltaNgn,
    treasuryAccountId,
    receiptId,
    actor,
    postedAtISO,
    customerName,
  } = params;
  const d = roundMoney(deltaNgn);
  if (d === 0) return { ok: true, movementId: null };
  const tid = Number(treasuryAccountId);
  if (!tid) return { ok: false, error: 'Treasury account is required to post a settlement variance.' };
  const mv = insertTreasuryMovementTx(db, {
    type: 'BANK_RECON_ADJUSTMENT',
    treasuryAccountId: tid,
    amountNgn: d,
    postedAtISO: postedAtISO || new Date().toISOString(),
    reference: lineId,
    counterpartyKind: 'BANK_RECON',
    counterpartyId: lineId,
    counterpartyName: customerName || 'Bank reconciliation',
    sourceKind: 'BANK_RECON_LINE',
    sourceId: lineId,
    note: `Receipt ${receiptId} settlement vs books`,
    createdBy: actorName(actor),
  });
  return { ok: true, movementId: mv.id };
}

/**
 * When status is Matched and system match looks like a receipt id, require a real sales receipt.
 * Branch is not enforced — HQ often reconciles one bank statement against receipts from any branch.
 * @param {import('better-sqlite3').Database} db
 */
function validateBankReconMatchedReceipt(db, systemMatch) {
  const raw = String(systemMatch ?? '').trim();
  if (!raw) return { ok: true };
  const tokenRaw = firstSystemMatchToken(systemMatch);
  if (!tokenRaw) return { ok: true };
  const token = normalizeReceiptMatchDashes(tokenRaw);
  const resolvedId = resolveSalesReceiptIdFromSystemMatch(db, systemMatch);
  if (!resolvedId) {
    if (/^(RC-|RCP-|LE-)/i.test(token)) {
      return {
        ok: false,
        error: `No sales receipt found for "${tokenRaw}". Use the receipt id from Sales — posted receipts are usually LE-… (legacy imports may show RC-…).`,
      };
    }
    return { ok: true };
  }
  return { ok: true };
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      inQ = !inQ;
    } else if (c === ',' && !inQ) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out.map((s) => s.replace(/^"|"$/g, ''));
}

/**
 * Parse bank-statement CSV: optional header (bankDateISO, description, amountNgn).
 * Each data row: YYYY-MM-DD, description (commas allowed if quoted), amount (integer naira; negative = debit).
 * @param {string} csvText
 */
export function parseBankReconciliationCsvText(csvText) {
  const rows = String(csvText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (rows.length === 0) return { ok: false, error: 'Empty CSV.' };
  let start = 0;
  const h = rows[0].toLowerCase();
  if (
    h.includes('bankdateiso') ||
    (h.includes('date') && h.includes('description') && (h.includes('amount') || h.includes('amountngn')))
  ) {
    start = 1;
  }
  if (start >= rows.length) return { ok: false, error: 'No data rows after header.' };
  const lines = [];
  const parseErrors = [];
  for (let idx = start; idx < rows.length; idx += 1) {
    const parts = splitCsvLine(rows[idx]);
    if (parts.length < 3) {
      parseErrors.push({ line: idx + 1, error: 'Need date, description, and amount columns.' });
      continue;
    }
    const bankDateISO = parts[0].slice(0, 10);
    const amountNgn = roundMoney(Number(String(parts[parts.length - 1]).replace(/,/g, '')));
    const description = parts.slice(1, -1).join(',').trim();
    lines.push({ bankDateISO, description, amountNgn });
  }
  if (lines.length === 0) {
    return {
      ok: false,
      error: parseErrors[0]?.error || 'No valid rows.',
      parseErrors,
    };
  }
  return { ok: true, lines, parseErrors };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} payload
 * @param {string} [branchId]
 */
export function insertBankReconciliationLine(db, payload, branchId = DEFAULT_BRANCH_ID) {
  const bankDateISO = String(payload.bankDateISO ?? '').trim();
  const description = String(payload.description ?? '').trim();
  const amountNgn = roundMoney(payload.amountNgn);
  if (!bankDateISO || !/^\d{4}-\d{2}-\d{2}$/.test(bankDateISO)) {
    return { ok: false, error: 'Valid bank date (YYYY-MM-DD) is required.' };
  }
  if (!description) return { ok: false, error: 'Bank description is required.' };
  if (!Number.isFinite(amountNgn) || amountNgn === 0) {
    return {
      ok: false,
      error:
        'Amount must be a non-zero whole naira value (negative for bank debits/charges, positive for credits).',
    };
  }
  const systemMatch = payload.systemMatch !== undefined ? String(payload.systemMatch ?? '').trim() : '';
  let status = String(payload.status ?? 'Review').trim();
  if (!['Matched', 'Review', 'Excluded'].includes(status)) status = 'Review';
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  if (status === 'Matched') {
    const v = validateBankReconMatchedReceipt(db, systemMatch);
    if (!v.ok) return v;
  }
  const id = nextBankReconLineHumanId(db, bid);
  db.prepare(
    `INSERT INTO bank_reconciliation_lines (id, bank_date_iso, description, amount_ngn, system_match, status, branch_id) VALUES (?,?,?,?,?,?,?)`
  ).run(id, bankDateISO, description, amountNgn, systemMatch || null, status, bid);
  appendAuditLog(db, {
    actor: payload.actor,
    action: 'bank_reconciliation.create',
    entityKind: 'bank_reconciliation_line',
    entityId: id,
    note: description.slice(0, 120),
    status: 'success',
    details: { bankDateISO, amountNgn, status, branchId: bid },
  });
  return { ok: true, id };
}

/** @param {import('better-sqlite3').Database} db */
export function updateBankReconciliationLine(db, lineId, payload, actor) {
  const id = String(lineId ?? '').trim();
  if (!id) return { ok: false, error: 'Line id is required.' };
  const row = db.prepare(`SELECT * FROM bank_reconciliation_lines WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Bank line not found.' };

  const systemMatch =
    payload.systemMatch !== undefined ? String(payload.systemMatch ?? '').trim() : row.system_match || '';
  const requestedStatus = payload.status !== undefined ? String(payload.status ?? '').trim() : row.status;
  if (!['Matched', 'Review', 'Excluded', 'PendingManager'].includes(requestedStatus)) {
    return { ok: false, error: 'Status must be Matched, Review, Excluded, or PendingManager.' };
  }

  const settledOverride =
    payload.settledAmountNgn !== undefined && payload.settledAmountNgn !== null && payload.settledAmountNgn !== ''
      ? roundMoney(payload.settledAmountNgn)
      : null;
  const treasuryOverride =
    payload.treasuryAccountId !== undefined &&
    payload.treasuryAccountId !== null &&
    String(payload.treasuryAccountId).trim() !== ''
      ? Number(payload.treasuryAccountId)
      : null;

  const upd = db.prepare(
    `UPDATE bank_reconciliation_lines SET
      system_match = ?,
      status = ?,
      settled_amount_ngn = ?,
      matched_system_amount_ngn = ?,
      variance_ngn = ?,
      variance_percent = ?,
      treasury_account_id = ?,
      treasury_adjustment_movement_id = ?,
      manager_cleared_at_iso = ?,
      manager_cleared_by_user_id = ?,
      manager_cleared_by_name = ?
    WHERE id = ?`
  );

  if (requestedStatus === 'Review' || requestedStatus === 'Excluded') {
    const clearSettlement = requestedStatus === 'Excluded';
    upd.run(
      systemMatch || null,
      requestedStatus,
      clearSettlement ? null : row.settled_amount_ngn,
      clearSettlement ? null : row.matched_system_amount_ngn,
      clearSettlement ? null : row.variance_ngn,
      clearSettlement ? null : row.variance_percent,
      clearSettlement ? null : row.treasury_account_id,
      clearSettlement ? null : row.treasury_adjustment_movement_id,
      clearSettlement ? null : row.manager_cleared_at_iso,
      clearSettlement ? null : row.manager_cleared_by_user_id,
      clearSettlement ? null : row.manager_cleared_by_name,
      id
    );
    appendAuditLog(db, {
      actor,
      action: 'bank_reconciliation.update',
      entityKind: 'bank_reconciliation_line',
      entityId: id,
      note: `Bank line ${requestedStatus}${systemMatch ? `: ${systemMatch}` : ''}`,
      status: 'success',
      details: { systemMatch, status: requestedStatus },
    });
    return { ok: true, status: requestedStatus };
  }

  if (requestedStatus === 'PendingManager') {
    const v = validateBankReconMatchedReceipt(db, systemMatch);
    if (!v.ok) return v;
    upd.run(
      systemMatch || null,
      'PendingManager',
      row.settled_amount_ngn,
      row.matched_system_amount_ngn,
      row.variance_ngn,
      row.variance_percent,
      row.treasury_account_id,
      row.treasury_adjustment_movement_id,
      row.manager_cleared_at_iso,
      row.manager_cleared_by_user_id,
      row.manager_cleared_by_name,
      id
    );
    appendAuditLog(db, {
      actor,
      action: 'bank_reconciliation.update',
      entityKind: 'bank_reconciliation_line',
      entityId: id,
      note: 'Bank line set to awaiting manager clearance',
      status: 'success',
      details: { systemMatch, status: 'PendingManager' },
    });
    return { ok: true, status: 'PendingManager' };
  }

  const v = validateBankReconMatchedReceipt(db, systemMatch);
  if (!v.ok) return v;

  const bankAmt = roundMoney(row.amount_ngn);
  const rc = resolveSalesReceiptIdFromSystemMatch(db, systemMatch);

  if (!rc || bankAmt <= 0) {
    upd.run(
      systemMatch || null,
      'Matched',
      null,
      null,
      null,
      null,
      null,
      row.treasury_adjustment_movement_id,
      row.manager_cleared_at_iso,
      row.manager_cleared_by_user_id,
      row.manager_cleared_by_name,
      id
    );
    appendAuditLog(db, {
      actor,
      action: 'bank_reconciliation.update',
      entityKind: 'bank_reconciliation_line',
      entityId: id,
      note: `Bank line Matched${systemMatch ? `: ${systemMatch}` : ''}`,
      status: 'success',
      details: { systemMatch, status: 'Matched' },
    });
    return { ok: true, status: 'Matched' };
  }

  const receiptRow = db.prepare(`SELECT customer_name FROM sales_receipts WHERE id = ?`).get(rc);
  const expected = expectedReceiptSettlementNgn(db, rc);
  const settled = settledOverride != null ? settledOverride : bankAmt;
  const variance = settled - expected;
  const base = Math.max(Math.abs(expected), 1);
  const variancePct = (Math.abs(variance) / base) * 100;

  let treasuryId = treasuryOverride || primaryTreasuryAccountForReceipt(db, rc);
  if (Math.abs(variance) >= 1 && !treasuryId) treasuryId = firstTreasuryAccountId(db);
  if (Math.abs(variance) >= 1 && !treasuryId) {
    return {
      ok: false,
      error:
        'Choose the treasury (bank) account for this settlement. No treasury accounts exist yet.',
    };
  }

  const needsManager =
    Math.abs(variance) >= 1 && bankReconVarianceNeedsManagerClearance(variance, expected);

  if (needsManager) {
    upd.run(
      systemMatch || null,
      'PendingManager',
      settled,
      expected,
      variance,
      variancePct,
      treasuryId || null,
      null,
      null,
      null,
      null,
      id
    );
    appendAuditLog(db, {
      actor,
      action: 'bank_reconciliation.pending_manager',
      entityKind: 'bank_reconciliation_line',
      entityId: id,
      note: `Variance ${variance} naira (${variancePct.toFixed(4)}%) awaits manager clearance`,
      status: 'success',
      details: { receiptId: rc, expected, settled, variance, variancePct },
    });
    return {
      ok: true,
      status: 'PendingManager',
      needsManagerClearance: true,
      varianceNgn: variance,
      variancePercent: variancePct,
      matchedSystemAmountNgn: expected,
      settledAmountNgn: settled,
    };
  }

  try {
    let movementId = row.treasury_adjustment_movement_id || null;
    db.transaction(() => {
      if (Math.abs(variance) >= 1 && !movementId) {
        const p = postBankReconTreasuryVariance(db, {
          lineId: id,
          deltaNgn: variance,
          treasuryAccountId: treasuryId,
          receiptId: rc,
          actor,
          postedAtISO: normalizeIsoTimestamp(row.bank_date_iso),
          customerName: receiptRow?.customer_name || '',
        });
        if (!p.ok) throw new Error(p.error);
        movementId = p.movementId;
      }
      upd.run(
        systemMatch || null,
        'Matched',
        Math.abs(variance) >= 1 ? settled : null,
        Math.abs(variance) >= 1 ? expected : null,
        Math.abs(variance) >= 1 ? variance : null,
        Math.abs(variance) >= 1 ? variancePct : null,
        Math.abs(variance) >= 1 ? treasuryId : null,
        movementId,
        row.manager_cleared_at_iso,
        row.manager_cleared_by_user_id,
        row.manager_cleared_by_name,
        id
      );
    })();
    appendAuditLog(db, {
      actor,
      action: 'bank_reconciliation.update',
      entityKind: 'bank_reconciliation_line',
      entityId: id,
      note: `Bank line Matched${systemMatch ? `: ${systemMatch}` : ''}${Math.abs(variance) >= 1 ? ` · variance ${variance}` : ''}`,
      status: 'success',
      details: { systemMatch, status: 'Matched', variance, movementId },
    });
    return { ok: true, status: 'Matched', varianceNgn: variance, treasuryAdjustmentMovementId: movementId };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Manager / finance approver: post stored variance and mark line Matched.
 * @param {import('better-sqlite3').Database} db
 */
export function approveBankReconciliationVariance(db, lineId, actor) {
  const id = String(lineId ?? '').trim();
  if (!id) return { ok: false, error: 'Line id is required.' };
  const row = db.prepare(`SELECT * FROM bank_reconciliation_lines WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Bank line not found.' };
  if (String(row.status || '') !== 'PendingManager') {
    return { ok: false, error: 'This line is not awaiting manager clearance.' };
  }
  if (row.treasury_adjustment_movement_id) {
    return { ok: false, error: 'Treasury adjustment was already posted for this line.' };
  }
  const rc = resolveSalesReceiptIdFromSystemMatch(db, row.system_match);
  if (!rc) return { ok: false, error: 'Receipt id missing on bank line.' };
  const variance = roundMoney(row.variance_ngn);
  let tid = Number(row.treasury_account_id);
  if (!tid && Math.abs(variance) >= 1) tid = firstTreasuryAccountId(db);
  if (!tid && Math.abs(variance) >= 1) {
    return { ok: false, error: 'Treasury account is not set and no default bank account exists.' };
  }
  const receiptRow = db.prepare(`SELECT customer_name FROM sales_receipts WHERE id = ?`).get(rc);

  const upd = db.prepare(
    `UPDATE bank_reconciliation_lines SET
      status = 'Matched',
      treasury_adjustment_movement_id = ?,
      manager_cleared_at_iso = ?,
      manager_cleared_by_user_id = ?,
      manager_cleared_by_name = ?
    WHERE id = ?`
  );

  try {
    let movementId = null;
    db.transaction(() => {
      if (Math.abs(variance) >= 1) {
        const p = postBankReconTreasuryVariance(db, {
          lineId: id,
          deltaNgn: variance,
          treasuryAccountId: tid,
          receiptId: rc,
          actor,
          postedAtISO: normalizeIsoTimestamp(row.bank_date_iso),
          customerName: receiptRow?.customer_name || '',
        });
        if (!p.ok) throw new Error(p.error);
        movementId = p.movementId;
      }
      upd.run(movementId, new Date().toISOString(), actorId(actor), actorName(actor), id);
    })();
    appendAuditLog(db, {
      actor,
      action: 'bank_reconciliation.manager_clear',
      entityKind: 'bank_reconciliation_line',
      entityId: id,
      note: `Manager cleared bank recon variance ${variance}`,
      status: 'success',
      details: { movementId, variance },
    });
    return { ok: true, status: 'Matched', treasuryAdjustmentMovementId: movementId };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** @param {import('better-sqlite3').Database} db */
export function insertCustomerCrmInteraction(db, customerID, payload, actor, branchId = DEFAULT_BRANCH_ID) {
  const cid = String(customerID ?? '').trim();
  if (!cid) return { ok: false, error: 'customerID is required.' };
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
  const cust = db
    .prepare(`SELECT customer_id FROM customers WHERE customer_id = ? AND branch_id = ?`)
    .get(cid, bid);
  if (!cust) return { ok: false, error: 'Customer not found.' };
  const detail = String(payload.detail ?? '').trim();
  if (!detail) return { ok: false, error: 'Interaction detail is required.' };
  const kind = String(payload.kind ?? 'note').trim() || 'note';
  const title = String(payload.title ?? '').trim();
  const atIso = String(payload.atIso ?? '').trim() || new Date().toISOString();
  const id = nextCrmInteractionHumanId(db, bid);
  const createdByName = actor?.displayName || actor?.username || '';
  db.prepare(
    `INSERT INTO customer_crm_interactions (id, customer_id, at_iso, kind, title, detail, created_by_name, branch_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, cid, atIso, kind, title || null, detail, createdByName || null, bid);
  appendAuditLog(db, {
    actor,
    action: 'crm.interaction.create',
    entityKind: 'customer',
    entityId: cid,
    note: title || kind,
    status: 'success',
    details: { interactionId: id, kind },
  });
  return { ok: true, interaction: { id, customerID: cid, atIso, kind, title, detail, createdByName } };
}

function shortDateFromIso(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const [, m, d] = s.split('-');
  if (!d || !m) return '—';
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    Number(m) - 1
  ];
  return `${d} ${mo}`;
}

/** Mirror RECEIPT ledger row into sales_receipts (same id as ledger entry). */
export function upsertSalesReceiptForLedgerEntry(db, entry, quotationRow, branchId = null) {
  if (entry.type !== 'RECEIPT' || !quotationRow?.id) return;
  const display = `₦${(Number(entry.amountNgn) || 0).toLocaleString('en-NG')}`;
  const dateIso = String(entry.atISO || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const bid =
    branchId != null && String(branchId).trim()
      ? String(branchId).trim()
      : String(entry.branchId || quotationRow.branchId || '').trim() || null;
  db.prepare(
    `
    INSERT INTO sales_receipts (
      id, customer_id, customer_name, quotation_ref, date_label, date_iso, amount_display, amount_ngn, method, status, handled_by, ledger_entry_id, branch_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      customer_id = excluded.customer_id,
      customer_name = excluded.customer_name,
      quotation_ref = excluded.quotation_ref,
      date_label = excluded.date_label,
      date_iso = excluded.date_iso,
      amount_display = excluded.amount_display,
      amount_ngn = excluded.amount_ngn,
      method = excluded.method,
      status = excluded.status,
      handled_by = excluded.handled_by,
      ledger_entry_id = excluded.ledger_entry_id,
      branch_id = excluded.branch_id
  `
  ).run(
    entry.id,
    entry.customerID,
    entry.customerName ?? quotationRow.customer ?? quotationRow.customer_name,
    quotationRow.id,
    shortDateFromIso(entry.atISO),
    dateIso,
    display,
    entry.amountNgn,
    entry.paymentMethod ?? '—',
    'Posted',
    '—',
    entry.id,
    bid
  );
}

/** Mirror ADVANCE_IN ledger row for reporting / joins (ledger remains source of truth). */
export function insertAdvanceInEvent(db, entry) {
  if (entry.type !== 'ADVANCE_IN') return;
  db.prepare(
    `
    INSERT OR REPLACE INTO advance_in_events (
      ledger_entry_id, customer_id, customer_name, amount_ngn, at_iso, payment_method, bank_reference, purpose
    ) VALUES (?,?,?,?,?,?,?,?)
  `
  ).run(
    entry.id,
    entry.customerID,
    entry.customerName ?? null,
    entry.amountNgn,
    entry.atISO,
    entry.paymentMethod ?? null,
    entry.bankReference ?? null,
    entry.purpose ?? null
  );
}

function reversalMarker(targetEntryId) {
  return `REVERSAL_OF:${targetEntryId}`;
}

function parseReversalTarget(value) {
  const m = String(value ?? '').match(/REVERSAL_OF:([A-Za-z0-9-]+)/);
  return m ? m[1] : '';
}

export function reversedEntryIdsFromRows(rows) {
  const set = new Set();
  for (const row of rows || []) {
    const id = parseReversalTarget(row.bank_reference ?? row.bankReference ?? row.note);
    if (id) set.add(id);
  }
  return set;
}

/** Reverse a posted receipt by creating a compensating ledger row and marking the mirror row reversed. */
export function reverseReceiptEntry(db, entryId, note = '', actor = null) {
  const target = db.prepare(`SELECT * FROM ledger_entries WHERE id = ? AND type = 'RECEIPT'`).get(entryId);
  if (!target) return { ok: false, error: 'Receipt entry not found.' };

  const existing = db
    .prepare(`SELECT id FROM ledger_entries WHERE type = 'RECEIPT_REVERSAL' AND (bank_reference = ? OR note LIKE ?)`)
    .get(reversalMarker(entryId), `%${entryId}%`);
  if (existing) return { ok: false, error: 'Receipt already reversed.' };

  const reversalNote = note || `Reverse receipt ${entryId}`;
  const reversalDateISO = new Date().toISOString().slice(0, 10);
  try {
    assertPeriodOpen(db, reversalDateISO, 'Receipt reversal date');
    let reversal;
    db.transaction(() => {
      reversal = insertLedgerRows(
        db,
        [
          {
            type: 'RECEIPT_REVERSAL',
            customerID: target.customer_id,
            customerName: target.customer_name,
            amountNgn: target.amount_ngn,
            quotationRef: target.quotation_ref || '',
            paymentMethod: target.payment_method,
            bankReference: reversalMarker(entryId),
            createdByUserId: actor?.id ?? null,
            createdByName: actorName(actor),
            note: reversalNote,
            atISO: new Date().toISOString(),
          },
        ],
        target.branch_id || null
      )[0];
      db.prepare(`UPDATE sales_receipts SET status = 'Reversed' WHERE id = ? OR ledger_entry_id = ?`).run(entryId, entryId);
      reverseTreasurySourceTx(db, 'LEDGER_RECEIPT', entryId, 'RECEIPT_REVERSAL_OUT', reversalNote, actor);
      const glRev = tryPostCustomerReceiptReversalGl(db, {
        originalReceiptLedgerId: entryId,
        reversalLedgerId: reversal?.id,
        amountNgn: target.amount_ngn,
        entryDateISO: reversalDateISO,
        branchId: target.branch_id || null,
        createdByUserId: actor?.id ?? null,
      });
      if (!glRev.ok && !glRev.skipped) {
        throw new Error(glRev.error || 'GL reversal failed for receipt.');
      }
      appendAuditLog(db, {
        actor,
        action: 'ledger.reverse_receipt',
        entityKind: 'ledger_entry',
        entityId: entryId,
        note: reversalNote,
        details: { reversalEntryId: reversal?.id ?? '' },
      });
      const qref = String(target.quotation_ref || '').trim();
      if (qref) syncQuotationPaidFromLedger(db, qref);
    })();
    return { ok: true, entry: reversal };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Reverse a standalone advance deposit if present and not already reversed. */
export function reverseAdvanceEntry(db, entryId, note = '', actor = null) {
  const target = db
    .prepare(`SELECT * FROM ledger_entries WHERE id = ? AND type IN ('ADVANCE_IN','OVERPAY_ADVANCE')`)
    .get(entryId);
  if (!target) return { ok: false, error: 'Advance entry not found.' };

  const existing = db
    .prepare(`SELECT id FROM ledger_entries WHERE type = 'ADVANCE_REVERSAL' AND (bank_reference = ? OR note LIKE ?)`)
    .get(reversalMarker(entryId), `%${entryId}%`);
  if (existing) return { ok: false, error: 'Advance already reversed.' };

  const reversalNote = note || `Reverse advance ${entryId}`;
  const reversalDateISO = new Date().toISOString().slice(0, 10);
  try {
    assertPeriodOpen(db, reversalDateISO, 'Advance reversal date');
    let reversal;
    db.transaction(() => {
      reversal = insertLedgerRows(
        db,
        [
          {
            type: 'ADVANCE_REVERSAL',
            customerID: target.customer_id,
            customerName: target.customer_name,
            amountNgn: target.amount_ngn,
            quotationRef: target.quotation_ref || '',
            paymentMethod: target.payment_method,
            bankReference: reversalMarker(entryId),
            createdByUserId: actor?.id ?? null,
            createdByName: actorName(actor),
            note: reversalNote,
            atISO: new Date().toISOString(),
          },
        ],
        target.branch_id || null
      )[0];

      db.prepare(`DELETE FROM advance_in_events WHERE ledger_entry_id = ?`).run(entryId);
      if (target.type === 'ADVANCE_IN') {
        reverseTreasurySourceTx(db, 'LEDGER_ADVANCE', entryId, 'ADVANCE_REVERSAL_OUT', reversalNote, actor);
      }
      const glAdvRev = tryPostCustomerAdvanceReversalGl(db, {
        originalAdvanceLedgerId: entryId,
        reversalLedgerId: reversal?.id,
        amountNgn: target.amount_ngn,
        entryDateISO: reversalDateISO,
        branchId: target.branch_id || null,
        createdByUserId: actor?.id ?? null,
      });
      if (!glAdvRev.ok && !glAdvRev.skipped) {
        throw new Error(glAdvRev.error || 'GL reversal failed for advance.');
      }
      appendAuditLog(db, {
        actor,
        action: 'ledger.reverse_advance',
        entityKind: 'ledger_entry',
        entityId: entryId,
        note: reversalNote,
        details: { reversalEntryId: reversal?.id ?? '' },
      });
    })();
    return { ok: true, entry: reversal };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function formatMetersLabel(totalMeters) {
  const n = Number(totalMeters) || 0;
  const hasFraction = Math.abs(n - Math.round(n)) > 0.0001;
  return `${n.toLocaleString('en-NG', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  })} m`;
}

const CUTTING_LIST_LINE_TYPES = new Set(['Roof', 'Flatsheet', 'Cladding']);

function normalizeCuttingListLines(lines) {
  const out = [];
  let order = 0;
  for (const raw of lines || []) {
    const sheets = Number(raw?.sheets ?? raw?.qty ?? 0);
    const lengthM = Number(raw?.lengthM ?? raw?.length_m ?? raw?.length ?? 0);
    if (!Number.isFinite(sheets) || !Number.isFinite(lengthM) || sheets <= 0 || lengthM <= 0) continue;
    order += 1;
    const totalM = Number((sheets * lengthM).toFixed(2));
    const rawType = String(raw?.lineType ?? raw?.line_type ?? 'Roof').trim();
    const lineType = CUTTING_LIST_LINE_TYPES.has(rawType) ? rawType : 'Roof';
    out.push({ sortOrder: order, sheets, lengthM, totalM, lineType });
  }
  return out;
}

function syncCuttingListLineRows(db, cuttingListId, lines) {
  db.prepare(`DELETE FROM cutting_list_lines WHERE cutting_list_id = ?`).run(cuttingListId);
  const ins = db.prepare(
    `INSERT INTO cutting_list_lines (cutting_list_id, sort_order, sheets, length_m, total_m, line_type) VALUES (?,?,?,?,?,?)`
  );
  for (const line of lines) {
    ins.run(
      cuttingListId,
      line.sortOrder,
      line.sheets,
      line.lengthM,
      line.totalM,
      line.lineType ?? 'Roof'
    );
  }
}

/** Coil rows for this product in the workspace branch only. */
export function countCoilLotsForProductInWorkspace(db, productID, workspaceBranchId) {
  const pid = String(productID ?? '').trim();
  if (!pid) return 0;
  const bid = String(workspaceBranchId ?? '').trim() || DEFAULT_BRANCH_ID;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM coil_lots WHERE product_id = ? AND branch_id = ?`
    )
    .get(pid, bid);
  return Number(row?.c) || 0;
}

function validateQuotationForCuttingList(db, quotationRef, excludeCuttingListId) {
  const qref = String(quotationRef ?? '').trim();
  if (!qref) return { ok: false, error: 'Link a quotation.' };
  const qrow = db
    .prepare(
      `SELECT total_ngn, paid_ngn, manager_production_approved_at_iso, branch_id FROM quotations WHERE id = ?`
    )
    .get(qref);
  if (!qrow) return { ok: false, error: 'Quotation not found.' };
  const total = Number(qrow.total_ngn) || 0;
  if (total <= 0) return { ok: false, error: 'Quotation total must be greater than zero.' };
  const managerOk = Boolean(qrow.manager_production_approved_at_iso);
  const bookPaid = Number(qrow.paid_ngn) || 0;
  const bid = String(qrow.branch_id || '').trim() || DEFAULT_BRANCH_ID;
  let minPaidFrac = 0.7;
  try {
    const brRow = db.prepare(`SELECT cutting_list_min_paid_fraction FROM branches WHERE id = ?`).get(bid);
    const f = Number(brRow?.cutting_list_min_paid_fraction);
    if (Number.isFinite(f) && f >= 0.05 && f <= 1) minPaidFrac = f;
  } catch {
    minPaidFrac = 0.7;
  }
  const threshold = total * minPaidFrac - 1e-6;
  if (!managerOk && bookPaid < threshold) {
    const receiptRows = listSalesReceipts(db, 'ALL').filter(
      (r) => String(r.quotationRef || '').trim() === qref
    );
    const ledgerRows = listLedgerEntries(db, 'ALL');
    const enriched = enrichSalesReceiptRowsWithCashFromLedger(receiptRows, ledgerRows);
    const cashFromReceipts = enriched.reduce(
      (sum, r) => sum + Math.round(Number(r.cashReceivedNgn ?? r.amountNgn) || 0),
      0
    );
    const advRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM ledger_entries WHERE type = 'ADVANCE_APPLIED' AND quotation_ref = ?`
      )
      .get(qref);
    const advanceApplied = Math.round(Number(advRow?.s) || 0);
    const cashPaidTotal = cashFromReceipts + advanceApplied;
    if (cashPaidTotal < threshold) {
      const pct = Math.round(minPaidFrac * 100);
      return {
        ok: false,
        error: `At least ${pct}% of the quotation must be paid (recorded receipts / applied advances on file) before creating a cutting list.`,
      };
    }
  }
  const existing = excludeCuttingListId
    ? db
        .prepare(`SELECT id FROM cutting_lists WHERE quotation_ref = ? AND id != ?`)
        .get(qref, excludeCuttingListId)
    : db.prepare(`SELECT id FROM cutting_lists WHERE quotation_ref = ?`).get(qref);
  if (existing) return { ok: false, error: 'This quotation already has a cutting list.' };
  return { ok: true };
}

export function insertCuttingList(db, payload, branchFallback = DEFAULT_BRANCH_ID) {
  const quotationRef = String(payload.quotationRef ?? '').trim();
  const quote = quotationRef
    ? db
        .prepare(`SELECT id, customer_id, customer_name, branch_id FROM quotations WHERE id = ?`)
        .get(quotationRef)
    : null;
  const customerID = String(payload.customerID ?? quote?.customer_id ?? '').trim();
  if (!customerID) return { ok: false, error: 'Select a linked quotation or customer.' };
  const customer =
    db.prepare(`SELECT customer_id, name FROM customers WHERE customer_id = ?`).get(customerID) ||
    null;
  if (!customer) return { ok: false, error: 'Customer not found.' };
  const qCheck = validateQuotationForCuttingList(db, quotationRef, null);
  if (!qCheck.ok) return qCheck;
  const lines = normalizeCuttingListLines(payload.lines);
  if (!lines.length) return { ok: false, error: 'Add at least one valid cutting line.' };
  const branchId =
    String(quote?.branch_id || '').trim() || String(branchFallback || DEFAULT_BRANCH_ID).trim();
  const id = String(payload.id ?? '').trim() || nextCuttingListHumanId(db, branchId);
  const dateISO = String(payload.dateISO ?? '').trim() || new Date().toISOString().slice(0, 10);
  const dateLabel = shortDateFromIso(dateISO);
  const totalMeters = Number(
    payload.totalMeters ?? lines.reduce((sum, line) => sum + line.totalM, 0)
  );
  const sheetsToCut = Number(
    payload.sheetsToCut ?? lines.reduce((sum, line) => sum + line.sheets, 0)
  );
  const productID = String(payload.productID ?? '').trim();
  const productName = String(payload.productName ?? '').trim();
  const machineName = String(payload.machineName ?? '').trim();
  const status = 'Waiting';
  const handledBy = String(payload.handledBy ?? '').trim() || 'Sales';
  const productionReleasePending =
    Boolean(payload.holdForProductionApproval) || Boolean(payload.holdProductionRelease) ? 1 : 0;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO cutting_lists (
        id, customer_id, customer_name, quotation_ref, product_id, product_name, date_label, date_iso,
        sheets_to_cut, total_meters, total_label, status, machine_name, operator_name,
        production_registered, production_register_ref, handled_by, branch_id,
        production_release_pending, production_released_at_iso, production_released_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      customer.customer_id,
      customer.name,
      quotationRef || null,
      productID || null,
      productName || null,
      dateLabel,
      dateISO,
      sheetsToCut,
      totalMeters,
      formatMetersLabel(totalMeters),
      status,
      machineName || null,
      null,
      0,
      '',
      handledBy,
      branchId,
      productionReleasePending,
      null,
      null
    );
    syncCuttingListLineRows(db, id, lines);
  })();

  return { ok: true, id };
}

export function clearCuttingListProductionHold(db, cuttingListId, actor = null) {
  const row = db.prepare(`SELECT * FROM cutting_lists WHERE id = ?`).get(cuttingListId);
  if (!row) return { ok: false, error: 'Cutting list not found.' };
  if (!Number(row.production_release_pending)) {
    return { ok: false, error: 'This list is not waiting on a production release hold.' };
  }
  const iso = new Date().toISOString();
  const by = String(actor?.displayName || actor?.username || 'Manager').trim() || 'Manager';
  db.prepare(
    `UPDATE cutting_lists SET production_release_pending = 0, production_released_at_iso = ?, production_released_by = ? WHERE id = ?`
  ).run(iso, by, cuttingListId);
  appendAuditLog(db, {
    actor,
    action: 'cutting_list.production_release_cleared',
    entityKind: 'cutting_list',
    entityId: cuttingListId,
    note: 'Operations cleared production queue hold',
  });
  return { ok: true };
}

export function updateCuttingList(db, cuttingListId, payload) {
  const existing = db.prepare(`SELECT * FROM cutting_lists WHERE id = ?`).get(cuttingListId);
  if (!existing) return { ok: false, error: 'Cutting list not found.' };
  if (existing.production_registered) {
    return { ok: false, error: 'Cutting list is already tied to a production job.' };
  }
  const quotationRef =
    payload.quotationRef !== undefined ? String(payload.quotationRef ?? '').trim() : existing.quotation_ref || '';
  const prevRef = String(existing.quotation_ref ?? '').trim();
  if (payload.quotationRef !== undefined && quotationRef !== prevRef) {
    const qCheck = validateQuotationForCuttingList(db, quotationRef, cuttingListId);
    if (!qCheck.ok) return qCheck;
  }
  const quote = quotationRef
    ? db.prepare(`SELECT id, customer_id, customer_name, branch_id FROM quotations WHERE id = ?`).get(quotationRef)
    : null;
  const customerID =
    payload.customerID !== undefined
      ? String(payload.customerID ?? '').trim()
      : String(quote?.customer_id ?? existing.customer_id ?? '').trim();
  const customer =
    db.prepare(`SELECT customer_id, name FROM customers WHERE customer_id = ?`).get(customerID) ||
    null;
  if (!customer) return { ok: false, error: 'Customer not found.' };
  const lines = payload.lines
    ? normalizeCuttingListLines(payload.lines)
    : db
        .prepare(`SELECT * FROM cutting_list_lines WHERE cutting_list_id = ? ORDER BY sort_order`)
        .all(cuttingListId)
        .map((row) => ({
          sortOrder: row.sort_order,
          sheets: Number(row.sheets) || 0,
          lengthM: Number(row.length_m) || 0,
          totalM: Number(row.total_m) || 0,
          lineType: row.line_type || 'Roof',
        }));
  if (!lines.length) return { ok: false, error: 'Cutting list must keep at least one valid line.' };
  const dateISO = payload.dateISO ?? existing.date_iso;
  const totalMeters =
    payload.totalMeters !== undefined
      ? Number(payload.totalMeters) || 0
      : lines.reduce((sum, line) => sum + line.totalM, 0);
  const sheetsToCut =
    payload.sheetsToCut !== undefined
      ? Number(payload.sheetsToCut) || 0
      : lines.reduce((sum, line) => sum + line.sheets, 0);
  const productID =
    payload.productID !== undefined ? String(payload.productID ?? '').trim() : existing.product_id ?? '';
  const productName =
    payload.productName !== undefined
      ? String(payload.productName ?? '').trim()
      : existing.product_name ?? '';
  const machineName =
    payload.machineName !== undefined
      ? String(payload.machineName ?? '').trim()
      : existing.machine_name ?? '';
  const status = existing.status;
  const handledBy = payload.handledBy ?? existing.handled_by;

  db.transaction(() => {
    db.prepare(
      `UPDATE cutting_lists
       SET customer_id = ?, customer_name = ?, quotation_ref = ?, product_id = ?, product_name = ?,
           date_label = ?, date_iso = ?, sheets_to_cut = ?, total_meters = ?, total_label = ?,
           status = ?, machine_name = ?, operator_name = ?, handled_by = ?
       WHERE id = ?`
    ).run(
      customer.customer_id,
      customer.name,
      quotationRef || null,
      productID || null,
      productName || null,
      shortDateFromIso(dateISO),
      dateISO,
      sheetsToCut,
      totalMeters,
      formatMetersLabel(totalMeters),
      status,
      machineName || null,
      null,
      handledBy,
      cuttingListId
    );
    syncCuttingListLineRows(db, cuttingListId, lines);
  })();

  return { ok: true, id: cuttingListId };
}

export function insertProductionJob(db, payload, branchFallback = DEFAULT_BRANCH_ID) {
  const cuttingListId = String(payload.cuttingListId ?? '').trim();
  const cuttingList = cuttingListId
    ? db.prepare(`SELECT * FROM cutting_lists WHERE id = ?`).get(cuttingListId)
    : null;
  if (cuttingListId && !cuttingList) return { ok: false, error: 'Cutting list not found.' };
  if (cuttingList?.production_registered) {
    return { ok: false, error: 'Production is already registered for this cutting list.' };
  }
  if (cuttingListId && cuttingList && Number(cuttingList.production_release_pending) === 1) {
    return {
      ok: false,
      error:
        'This cutting list is waiting on operations approval before it can join the production queue. Clear the hold first.',
    };
  }
  const quotationRef = String(payload.quotationRef ?? cuttingList?.quotation_ref ?? '').trim();
  const customerID = String(payload.customerID ?? cuttingList?.customer_id ?? '').trim();
  const customerName = String(payload.customerName ?? cuttingList?.customer_name ?? '').trim();
  const productID = String(payload.productID ?? cuttingList?.product_id ?? '').trim();
  const productName = String(payload.productName ?? cuttingList?.product_name ?? '').trim();
  const plannedMeters = Number(payload.plannedMeters ?? cuttingList?.total_meters ?? 0) || 0;
  const plannedSheets = Number(payload.plannedSheets ?? cuttingList?.sheets_to_cut ?? 0) || 0;
  const machineName = String(payload.machineName ?? cuttingList?.machine_name ?? '').trim();
  const startDateISO = String(payload.startDateISO ?? '').trim();
  const endDateISO = String(payload.endDateISO ?? '').trim();
  const materialsNote = String(payload.materialsNote ?? '').trim();
  const operatorName = String(payload.operatorName ?? '').trim();
  const status = 'Planned';
  const createdAtISO = new Date().toISOString();
  const branchId =
    String(cuttingList?.branch_id || '').trim() || String(branchFallback || DEFAULT_BRANCH_ID).trim();
  const jobID =
    String(payload.jobID ?? '').trim() || nextProductionJobHumanId(db, branchId);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO production_jobs (
        job_id, cutting_list_id, quotation_ref, customer_id, customer_name, product_id, product_name,
        planned_meters, planned_sheets, machine_name, operator_name, start_date_iso, end_date_iso, materials_note,
        status, created_at_iso, completed_at_iso, actual_meters, actual_weight_kg,
        conversion_alert_state, manager_review_required, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      jobID,
      cuttingListId || null,
      quotationRef || null,
      customerID || null,
      customerName || null,
      productID || null,
      productName || null,
      plannedMeters,
      plannedSheets,
      machineName || null,
      operatorName || null,
      startDateISO || null,
      endDateISO || null,
      materialsNote || null,
      status,
      createdAtISO,
      null,
      0,
      0,
      'Pending',
      0,
      branchId
    );
    if (cuttingListId) {
      db.prepare(
        `UPDATE cutting_lists
         SET production_registered = 1, production_register_ref = ?, status = ?
         WHERE id = ?`
      ).run(jobID, 'Waiting', cuttingListId);
    }
  })();

  return { ok: true, jobID };
}

export function setProductionJobStatus(db, jobID, status) {
  const row = db.prepare(`SELECT * FROM production_jobs WHERE job_id = ?`).get(jobID);
  if (!row) return { ok: false, error: 'Production job not found.' };
  const nextStatus = String(status ?? '').trim();
  if (!nextStatus) return { ok: false, error: 'Status is required.' };
  if (nextStatus === 'Running') {
    return { ok: false, error: 'Use the production start action after allocating coils.' };
  }
  if (nextStatus === 'Completed') {
    return { ok: false, error: 'Use the completion flow with coil readings to finish this job.' };
  }
  if (nextStatus === 'Cancelled') {
    return {
      ok: false,
      error: 'Use POST /api/production-jobs/:jobId/cancel with a reason to cancel and release coil reservations.',
    };
  }
  db.transaction(() => {
    db.prepare(`UPDATE production_jobs SET status = ?, completed_at_iso = ? WHERE job_id = ?`).run(
      nextStatus,
      null,
      jobID
    );
    if (row.cutting_list_id) {
      db.prepare(`UPDATE cutting_lists SET status = ? WHERE id = ?`).run('In production', row.cutting_list_id);
    }
  })();
  return { ok: true };
}

/** Fill missing cutting-list header product from the linked production job (common after production register). */
function cuttingListRowForDelivery(db, cuttingListRow, cuttingListId) {
  if (!cuttingListRow || !cuttingListId) return cuttingListRow;
  const pid = String(cuttingListRow.product_id ?? '').trim();
  if (pid) return cuttingListRow;
  const job = db
    .prepare(
      `SELECT product_id, product_name FROM production_jobs
       WHERE cutting_list_id = ? ORDER BY created_at_iso DESC LIMIT 1`
    )
    .get(cuttingListId);
  const jp = String(job?.product_id ?? '').trim();
  if (!jp) return cuttingListRow;
  return {
    ...cuttingListRow,
    product_id: jp,
    product_name: String(job?.product_name ?? cuttingListRow.product_name ?? '').trim() || cuttingListRow.product_name,
  };
}

function normalizeDeliveryLines(payloadLines, cuttingListRow, cuttingListLines) {
  if (Array.isArray(payloadLines) && payloadLines.length > 0) {
    return payloadLines
      .map((line, index) => ({
        sortOrder: index + 1,
        productID: String(line.productID ?? '').trim(),
        productName: String(line.productName ?? '').trim(),
        qty: Number(line.qty) || 0,
        unit: String(line.unit ?? '').trim() || 'm',
        cuttingListLineNo: line.cuttingListLineNo ?? null,
      }))
      .filter((line) => line.productID && line.qty > 0);
  }
  if (!cuttingListRow) return [];
  const productID = String(cuttingListRow.product_id ?? '').trim();
  const productName = String(cuttingListRow.product_name ?? '').trim() || productID;
  if (!productID) return [];

  const fromLines = cuttingListLines
    .map((line) => ({
      sortOrder: line.sort_order,
      productID,
      productName,
      qty: Number(line.total_m) || 0,
      unit: 'm',
      cuttingListLineNo: line.sort_order,
    }))
    .filter((line) => line.qty > 0);
  if (fromLines.length) return fromLines;

  const headerM = Number(cuttingListRow.total_meters) || 0;
  if (headerM > 0) {
    return [
      {
        sortOrder: 1,
        productID,
        productName,
        qty: headerM,
        unit: 'm',
        cuttingListLineNo: null,
      },
    ];
  }
  return [];
}

function syncDeliveryLineRows(db, deliveryId, lines) {
  db.prepare(`DELETE FROM delivery_lines WHERE delivery_id = ?`).run(deliveryId);
  const ins = db.prepare(
    `INSERT INTO delivery_lines (
      delivery_id, sort_order, product_id, product_name, qty, unit, cutting_list_line_no
    ) VALUES (?,?,?,?,?,?,?)`
  );
  for (const line of lines) {
    ins.run(
      deliveryId,
      line.sortOrder,
      line.productID,
      line.productName || null,
      line.qty,
      line.unit || null,
      line.cuttingListLineNo ?? null
    );
  }
}

export function insertDelivery(db, payload, branchFallback = DEFAULT_BRANCH_ID) {
  const cuttingListId = String(payload.cuttingListId ?? '').trim();
  const cuttingList = cuttingListId
    ? db.prepare(`SELECT * FROM cutting_lists WHERE id = ?`).get(cuttingListId)
    : null;
  if (cuttingListId && !cuttingList) return { ok: false, error: 'Cutting list not found.' };
  const cuttingListLines = cuttingListId
    ? db.prepare(`SELECT * FROM cutting_list_lines WHERE cutting_list_id = ? ORDER BY sort_order`).all(cuttingListId)
    : [];
  const quotationRef = String(payload.quotationRef ?? cuttingList?.quotation_ref ?? '').trim();
  const quote = quotationRef
    ? db.prepare(`SELECT customer_id, customer_name FROM quotations WHERE id = ?`).get(quotationRef)
    : null;
  const customerID = String(payload.customerID ?? cuttingList?.customer_id ?? quote?.customer_id ?? '').trim();
  const customerName = String(
    payload.customerName ?? cuttingList?.customer_name ?? quote?.customer_name ?? ''
  ).trim();
  if (!customerName) return { ok: false, error: 'Customer is required.' };
  const listRowForLines = cuttingListRowForDelivery(db, cuttingList, cuttingListId);
  const lines = normalizeDeliveryLines(payload.lines, listRowForLines, cuttingListLines);
  if (!lines.length) return { ok: false, error: 'Add at least one delivery line.' };
  const status = String(payload.status ?? '').trim() || 'Scheduled';
  const destination = String(payload.destination ?? '').trim();
  const method = String(payload.method ?? '').trim() || 'Company truck';
  const trackingNo = String(payload.trackingNo ?? '').trim();
  const shipDate = String(payload.shipDate ?? '').trim() || new Date().toISOString().slice(0, 10);
  const eta = String(payload.eta ?? '').trim() || shipDate;
  const branchId =
    String(cuttingList?.branch_id || '').trim() || String(branchFallback || DEFAULT_BRANCH_ID).trim();
  const id = String(payload.id ?? '').trim() || nextDeliveryHumanId(db, branchId);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO deliveries (
        id, quotation_ref, customer_id, customer_name, cutting_list_id, destination, method, status,
        tracking_no, ship_date, eta, delivered_date_iso, pod_notes, courier_confirmed, customer_signed_pod, fulfillment_posted, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      quotationRef || null,
      customerID || null,
      customerName,
      cuttingListId || null,
      destination || null,
      method,
      status,
      trackingNo || null,
      shipDate,
      eta,
      null,
      null,
      0,
      0,
      0,
      branchId
    );
    syncDeliveryLineRows(db, id, lines);
    if (cuttingListId) {
      db.prepare(`UPDATE cutting_lists SET status = ? WHERE id = ?`).run('Ready for dispatch', cuttingListId);
    }
  })();

  return { ok: true, id };
}

export function insertExpenseEntry(db, payload, branchId = DEFAULT_BRANCH_ID) {
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
  const expenseID = String(payload.expenseID ?? '').trim() || nextExpenseHumanId(db, bid);
  const category = String(payload.category ?? '').trim();
  const amountNgn = roundMoney(payload.amountNgn);
  if (!category) return { ok: false, error: 'Expense category is required.' };
  if (!isAllowedExpenseCategory(category)) {
    return { ok: false, error: 'Expense category must be chosen from the standard list.' };
  }
  if (amountNgn <= 0) return { ok: false, error: 'Expense amount must be positive.' };
  try {
    assertPeriodOpen(db, payload.date || new Date().toISOString().slice(0, 10), 'Expense date');
    db.transaction(() => {
      db.prepare(
        `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(
        expenseID,
        payload.expenseType ?? '',
        amountNgn,
        payload.date || new Date().toISOString().slice(0, 10),
        category,
        payload.paymentMethod ?? '',
        payload.reference ?? '',
        bid
      );
      if (payload.treasuryAccountId) {
        insertTreasuryMovementTx(db, {
          type: 'EXPENSE',
          treasuryAccountId: payload.treasuryAccountId,
          amountNgn: -amountNgn,
          postedAtISO: payload.date,
          reference: payload.reference || expenseID,
          counterpartyKind: 'EXPENSE',
          counterpartyId: expenseID,
          counterpartyName: category,
          sourceKind: 'EXPENSE',
          sourceId: expenseID,
          note: payload.expenseType || category,
          createdBy: payload.createdBy ?? 'Finance',
          workspaceBranchId: bid,
        });
      }
      appendAuditLog(db, {
        actor: payload.actor,
        action: 'expense.create',
        entityKind: 'expense',
        entityId: expenseID,
        note: payload.expenseType || category,
        details: { amountNgn, treasuryAccountId: payload.treasuryAccountId ?? null },
      });
    })();
    return { ok: true, expenseID };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function transferTreasuryFunds(db, payload) {
  const fromId = Number(payload.fromId);
  const toId = Number(payload.toId);
  const amountNgn = roundMoney(payload.amountNgn);
  if (!fromId || !toId || fromId === toId) {
    return { ok: false, error: 'Choose two different accounts.' };
  }
  if (amountNgn <= 0) return { ok: false, error: 'Transfer amount must be positive.' };
  const batchId = nextTreasuryTransferBatchHumanId(db);
  try {
    assertPeriodOpen(db, payload.dateISO || new Date().toISOString().slice(0, 10), 'Transfer date');
    const movements = db.transaction(() => {
      const out = insertTreasuryMovementTx(db, {
        type: 'INTERNAL_TRANSFER_OUT',
        treasuryAccountId: fromId,
        amountNgn: -amountNgn,
        postedAtISO: payload.dateISO,
        reference: payload.reference || batchId,
        counterpartyKind: 'INTERNAL',
        counterpartyId: String(toId),
        sourceKind: 'TREASURY_TRANSFER',
        sourceId: batchId,
        note: payload.reference || 'Internal transfer out',
        createdBy: payload.createdBy ?? 'Finance',
        batchId,
      });
      const inn = insertTreasuryMovementTx(db, {
        type: 'INTERNAL_TRANSFER_IN',
        treasuryAccountId: toId,
        amountNgn,
        postedAtISO: payload.dateISO,
        reference: payload.reference || batchId,
        counterpartyKind: 'INTERNAL',
        counterpartyId: String(fromId),
        sourceKind: 'TREASURY_TRANSFER',
        sourceId: batchId,
        note: payload.reference || 'Internal transfer in',
        createdBy: payload.createdBy ?? 'Finance',
        batchId,
      });
      appendAuditLog(db, {
        actor: payload.actor,
        action: 'treasury.transfer',
        entityKind: 'treasury_transfer',
        entityId: batchId,
        note: payload.reference || 'Internal fund transfer',
        details: { fromId, toId, amountNgn },
      });
      return [out, inn];
    })();
    return { ok: true, batchId, movements };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function payPaymentRequest(db, requestID, payload) {
  const row = db.prepare(`SELECT * FROM payment_requests WHERE request_id = ?`).get(requestID);
  if (!row) return { ok: false, error: 'Payment request not found.' };
  if (String(row.approval_status || '') !== 'Approved') {
    return { ok: false, error: 'Only approved payment requests can be paid.' };
  }

  const requested = roundMoney(row.amount_requested_ngn);
  const alreadyPaid = roundMoney(row.paid_amount_ngn);
  const outstanding = requested - alreadyPaid;
  if (outstanding <= 0) {
    return { ok: false, error: 'Payment request is already fully paid.' };
  }

  let paymentLines = Array.isArray(payload.paymentLines)
    ? payload.paymentLines
        .map((line) => ({
          treasuryAccountId: Number(line?.treasuryAccountId),
          amountNgn: roundMoney(line?.amountNgn),
          reference: String(line?.reference ?? '').trim(),
          note: String(line?.note ?? '').trim(),
        }))
        .filter((line) => line.treasuryAccountId && line.amountNgn > 0)
    : [];

  if (paymentLines.length === 0) {
    const treasuryAccountId = Number(payload.treasuryAccountId);
    const amountNgn = roundMoney(payload.amountNgn) || outstanding;
    if (!treasuryAccountId) {
      return { ok: false, error: 'Select at least one treasury account for payment.' };
    }
    paymentLines = [
      {
        treasuryAccountId,
        amountNgn,
        reference: String(payload.reference ?? '').trim(),
        note: String(payload.note ?? '').trim(),
      },
    ];
  }

  const totalPaid = paymentLines.reduce((sum, line) => sum + roundMoney(line.amountNgn), 0);
  if (totalPaid <= 0) {
    return { ok: false, error: 'Payment amount must be positive.' };
  }
  if (totalPaid > outstanding) {
    return { ok: false, error: 'Payment exceeds the approved request balance.' };
  }

  const paidAtISO = String(payload.paidAtISO ?? '').trim() || new Date().toISOString().slice(0, 10);
  const paidBy = String(payload.paidBy ?? '').trim() || payload.createdBy || 'Finance';
  const paymentNote = String(payload.note ?? payload.reference ?? '').trim();
  const linkedExpense = db
    .prepare(`SELECT expense_id, branch_id, category, reference FROM expenses WHERE expense_id = ?`)
    .get(row.expense_id);
  const workspaceBranchId = String(payload.workspaceBranchId || '').trim();
  const workspaceViewAll = Boolean(payload.workspaceViewAll);
  const actor = payload.actor;
  const canPayCrossBranch =
    workspaceViewAll ||
    (actor && (userHasPermission(actor, '*') || userHasPermission(actor, 'finance.cross_branch_post')));
  if (!canPayCrossBranch && linkedExpense?.branch_id && workspaceBranchId) {
    const reqBranch = String(linkedExpense.branch_id || '').trim();
    if (reqBranch && reqBranch !== workspaceBranchId) {
      return {
        ok: false,
        error: `This request belongs to ${reqBranch}. Switch workspace branch before payout.`,
      };
    }
  }

  try {
    assertPeriodOpen(db, paidAtISO, 'Payment request payout date');
    const movements = db.transaction(() => {
      const created = insertTreasurySplitTx(
        db,
        paymentLines.map((line) => ({
          ...line,
          amountNgn: -roundMoney(line.amountNgn),
        })),
        {
          type: 'PAYMENT_REQUEST_OUT',
          postedAtISO: paidAtISO,
          reference: String(payload.reference ?? '').trim() || requestID,
          counterpartyKind: 'EXPENSE',
          counterpartyId: row.expense_id,
          counterpartyName: row.description || row.request_id,
          sourceKind: 'PAYMENT_REQUEST',
          sourceId: requestID,
          note: row.description || 'Payment request payout',
          createdBy: paidBy,
        }
      );

      const nextPaid = alreadyPaid + totalPaid;
      db.prepare(
        `UPDATE payment_requests
         SET paid_amount_ngn = ?, paid_at_iso = ?, paid_by = ?, payment_note = ?
         WHERE request_id = ?`
      ).run(nextPaid, paidAtISO, paidBy, paymentNote, requestID);

      if (nextPaid >= requested) {
        syncStaffLoanDisbursementOnFullPay(db, requestID, paidAtISO);
      }

      appendAuditLog(db, {
        actor: payload.actor,
        action: 'payment_request.pay',
        entityKind: 'payment_request',
        entityId: requestID,
        note: paymentNote || row.description || 'Payment request paid',
        details: {
          amountPaidNgn: totalPaid,
          paidAmountNgn: nextPaid,
          treasuryAccountIds: paymentLines.map((line) => line.treasuryAccountId),
          requestBranchId: linkedExpense?.branch_id || '',
          paidFromWorkspaceBranchId: workspaceBranchId || '',
        },
      });

      return created;
    })();

    const paidAmountNgn = alreadyPaid + totalPaid;
    const fullyPaid = paidAmountNgn >= requested;
    const remain = Math.max(0, requested - paidAmountNgn);
    const payLine = fullyPaid
      ? `Accounts: treasury paid ₦${totalPaid.toLocaleString('en-NG')} toward ${requestID} (now fully paid; total ₦${paidAmountNgn.toLocaleString('en-NG')}).`
      : `Accounts: treasury paid ₦${totalPaid.toLocaleString('en-NG')} toward ${requestID} (partial; ₦${remain.toLocaleString('en-NG')} remaining of ₦${requested.toLocaleString('en-NG')}).`;
    appendPaymentRequestTimelineToOfficeThreads(db, requestID, payLine);

    return {
      ok: true,
      amountPaidNgn: totalPaid,
      paidAmountNgn,
      fullyPaid,
      movements,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function payAccountsPayable(db, apId, payload) {
  const row = db.prepare(`SELECT * FROM accounts_payable WHERE ap_id = ?`).get(apId);
  if (!row) return { ok: false, error: 'Payable not found.' };
  const amountNgn = roundMoney(payload.amountNgn);
  if (amountNgn <= 0) return { ok: false, error: 'Payment amount must be positive.' };
  const outstanding = roundMoney(row.amount_ngn) - roundMoney(row.paid_ngn);
  if (outstanding <= 0) return { ok: false, error: 'Invoice is already fully paid.' };
  const apply = Math.min(amountNgn, outstanding);
  try {
    assertPeriodOpen(db, payload.dateISO || new Date().toISOString().slice(0, 10), 'AP payment date');
    db.transaction(() => {
      db.prepare(`UPDATE accounts_payable SET paid_ngn = ?, payment_method = ? WHERE ap_id = ?`).run(
        roundMoney(row.paid_ngn) + apply,
        payload.paymentMethod ?? row.payment_method,
        apId
      );
      if (row.po_ref) {
        const po = db.prepare(`SELECT po_id FROM purchase_orders WHERE po_id = ?`).get(row.po_ref);
        if (po) {
          db.prepare(`UPDATE purchase_orders SET supplier_paid_ngn = supplier_paid_ngn + ? WHERE po_id = ?`).run(
            apply,
            row.po_ref
          );
          appendMovementTx(db, {
            type: 'PO_SUPPLIER_PAYMENT',
            ref: row.po_ref,
            detail: `${apply} — ${row.invoice_ref || apId}`,
          });
        }
      }
      insertTreasuryMovementTx(db, {
        type: 'AP_PAYMENT',
        treasuryAccountId: payload.treasuryAccountId,
        amountNgn: -apply,
        postedAtISO: payload.dateISO,
        reference: payload.reference || row.invoice_ref || apId,
        counterpartyKind: 'SUPPLIER',
        counterpartyName: row.supplier_name,
        sourceKind: 'ACCOUNTS_PAYABLE',
        sourceId: apId,
        note: payload.paymentMethod || 'Supplier payment',
        createdBy: payload.createdBy ?? 'Finance',
      });
      appendAuditLog(db, {
        actor: payload.actor,
        action: 'accounts_payable.pay',
        entityKind: 'accounts_payable',
        entityId: apId,
        note: payload.reference || row.invoice_ref || 'Supplier payment',
        details: { amountApplied: apply, treasuryAccountId: payload.treasuryAccountId },
      });
      if (row.po_ref) {
        const poOk = db.prepare(`SELECT po_id FROM purchase_orders WHERE po_id = ?`).get(row.po_ref);
        if (poOk) syncAccountsPayableFromPurchaseOrder(db, row.po_ref);
      }
    })();
    return { ok: true, amountApplied: apply };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function payRefundEntry(db, refundId, payload) {
  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(refundId);
  if (!row) return { ok: false, error: 'Refund not found.' };
  if (String(row.status || '') !== 'Approved') {
    return { ok: false, error: 'Only approved refunds can be paid.' };
  }
  const approvedAmountNgn = roundMoney(row.approved_amount_ngn || row.amount_ngn);
  const paidAmountNgn = roundMoney(row.paid_amount_ngn);
  const outstandingAmountNgn = approvedAmountNgn - paidAmountNgn;
  if (outstandingAmountNgn <= 0) {
    return { ok: false, error: 'Refund has already been fully paid.' };
  }
  const paidAtISO = String(payload.paidAtISO ?? '').trim() || new Date().toISOString().slice(0, 10);
  const paidBy = String(payload.paidBy ?? '').trim() || 'Finance';
  const paymentNote = String(payload.paymentNote ?? '').trim();
  const fromExplicit = Array.isArray(payload.paymentLines)
    ? payload.paymentLines
        .map((line) => ({
          treasuryAccountId: Number(line?.treasuryAccountId),
          amountNgn: roundMoney(line?.amountNgn),
          reference: String(line?.reference ?? '').trim(),
          note: String(line?.note ?? '').trim(),
        }))
        .filter((line) => line.treasuryAccountId && line.amountNgn > 0)
    : [];
  const paymentLines =
    fromExplicit.length > 0
      ? fromExplicit
      : payload.treasuryAccountId
        ? [
            {
              treasuryAccountId: Number(payload.treasuryAccountId),
              amountNgn: outstandingAmountNgn,
              reference: String(payload.reference ?? '').trim(),
              note: String(payload.note ?? '').trim(),
            },
          ]
        : [];
  const payoutAmountNgn = paymentLines.reduce((sum, line) => sum + line.amountNgn, 0);
  if (!paymentLines.length || payoutAmountNgn <= 0) {
    return { ok: false, error: 'Add at least one payout line.' };
  }
  if (payoutAmountNgn > outstandingAmountNgn) {
    return { ok: false, error: 'Payout exceeds the approved refund balance.' };
  }
  try {
    assertPeriodOpen(db, paidAtISO, 'Refund payout date');
    const result = db.transaction(() => {
      const movements = insertTreasurySplitTx(db, paymentLines.map((line) => ({ ...line, amountNgn: -line.amountNgn })), {
        type: 'REFUND_PAYOUT',
        postedAtISO: paidAtISO,
        counterpartyKind: 'CUSTOMER',
        counterpartyId: row.customer_id,
        counterpartyName: row.customer_name,
        sourceKind: 'REFUND',
        sourceId: refundId,
        reference: payload.reference || refundId,
        note: paymentNote || row.reason || 'Customer refund',
        createdBy: paidBy,
      });
      const nextPaidAmountNgn = paidAmountNgn + payoutAmountNgn;
      const fullyPaid = nextPaidAmountNgn >= approvedAmountNgn;
      db.prepare(
        `UPDATE customer_refunds
         SET status = ?, paid_amount_ngn = ?, paid_at_iso = ?, paid_by = ?, payment_note = ?
         WHERE refund_id = ?`
      ).run(
        fullyPaid ? 'Paid' : 'Approved',
        nextPaidAmountNgn,
        paidAtISO,
        paidBy,
        paymentNote || row.payment_note || null,
        refundId
      );
      appendAuditLog(db, {
        actor: payload.actor,
        action: 'refund.pay',
        entityKind: 'refund',
        entityId: refundId,
        note: paymentNote || row.reason || 'Customer refund payout recorded',
        details: {
          payoutAmountNgn,
          approvedAmountNgn,
          paidAmountNgn: nextPaidAmountNgn,
          treasuryAccountIds: movements.map((movement) => movement.treasuryAccountId),
        },
      });
      const glPay = tryPostCustomerRefundPayoutGlTx(db, {
        refundId,
        payoutAmountNgn,
        cumulativePaidNgn: nextPaidAmountNgn,
        entryDateISO: paidAtISO.slice(0, 10),
        branchId: row.branch_id ?? null,
        createdByUserId: payload.actor?.id != null ? String(payload.actor.id) : null,
      });
      if (!glPay.ok && !glPay.skipped && !glPay.duplicate) {
        throw new Error(glPay.error || 'Refund payout GL failed.');
      }
      const cid = String(row.customer_id || '').trim();
      if (cid && payoutAmountNgn > 0) {
        const advBal = advanceBalanceNgnForCustomerDb(db, cid);
        const refundAdvanceAmt = Math.min(payoutAmountNgn, Math.max(0, advBal));
        if (refundAdvanceAmt > 0) {
          const wb = String(row.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
          insertLedgerRows(
            db,
            [
              {
                type: 'REFUND_ADVANCE',
                customerID: cid,
                customerName: String(row.customer_name || '').trim() || null,
                amountNgn: refundAdvanceAmt,
                quotationRef: '',
                paymentMethod: null,
                bankReference: refundId,
                purpose: 'Sales refund payout',
                note: `Refund ${refundId} — reduces customer advance/overpay credit (₦${refundAdvanceAmt.toLocaleString()} of ₦${payoutAmountNgn.toLocaleString()} payout).`,
                atISO: normalizeIsoTimestamp(paidAtISO),
                createdByUserId: payload.actor?.id ?? null,
                createdByName: paidBy,
              },
            ],
            wb
          );
        }
      }
      return { movements, nextPaidAmountNgn, fullyPaid };
    })();
    const outstandingAfterNgn = approvedAmountNgn - result.nextPaidAmountNgn;
    return {
      ok: true,
      amountPaidNgn: payoutAmountNgn,
      paidAmountNgn: result.nextPaidAmountNgn,
      approvedAmountNgn,
      outstandingNgn: Math.max(0, outstandingAfterNgn),
      fullyPaid: result.fullyPaid,
      movements: result.movements,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function sumQuotationLinesJson(linesJson) {
  if (!linesJson || typeof linesJson !== 'object') return 0;
  let s = 0;
  for (const cat of ['products', 'accessories', 'services']) {
    const arr = linesJson[cat];
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      const q = Number(String(row?.qty ?? '').replace(/,/g, ''));
      const p = Number(String(row?.unitPrice ?? '').replace(/,/g, ''));
      if (Number.isFinite(q) && Number.isFinite(p)) s += Math.round(q * p);
    }
  }
  return s;
}

function parseQuotationLinesJsonObject(raw) {
  try {
    const j = JSON.parse(raw || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function syncQuotationLineRows(db, quotationId, linesJson) {
  db.prepare(`DELETE FROM quotation_lines WHERE quotation_id = ?`).run(quotationId);
  const ins = db.prepare(`
    INSERT INTO quotation_lines (id, quotation_id, sort_order, category, name, qty, unit, unit_price_ngn, line_total_ngn)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  let order = 0;
  for (const cat of ['products', 'accessories', 'services']) {
    const arr = linesJson?.[cat];
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      const name = String(row?.name ?? '').trim();
      if (!name) continue;
      order += 1;
      const qty = Number(String(row?.qty ?? '').replace(/,/g, '')) || 0;
      const unitPrice = Math.round(Number(String(row?.unitPrice ?? '').replace(/,/g, '')) || 0);
      const lineTotal = Math.round(qty * unitPrice);
      const lid = `${quotationId}-L${order}`;
      ins.run(lid, quotationId, order, cat, name, qty, 'ea', unitPrice, lineTotal);
    }
  }
}

export function insertQuotation(db, payload, branchId = DEFAULT_BRANCH_ID) {
  const customerID = String(payload.customerID ?? '').trim();
  if (!customerID) throw new Error('customerID is required.');
  const cust = db.prepare(`SELECT customer_id, name FROM customers WHERE customer_id = ?`).get(customerID);
  if (!cust) throw new Error('Customer not found.');

  const linesJson = {
    products: payload.lines?.products ?? [],
    accessories: payload.lines?.accessories ?? [],
    services: payload.lines?.services ?? [],
  };
  if (payload.materialGauge !== undefined) linesJson.materialGauge = String(payload.materialGauge ?? '').trim();
  if (payload.materialColor !== undefined) linesJson.materialColor = String(payload.materialColor ?? '').trim();
  if (payload.materialDesign !== undefined) linesJson.materialDesign = String(payload.materialDesign ?? '').trim();
  if (payload.materialTypeId !== undefined) linesJson.materialTypeId = String(payload.materialTypeId ?? '').trim();
  const totalNgn = sumQuotationLinesJson(linesJson);
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim();
  const id = String(payload.id ?? '').trim() || nextQuotationHumanId(db, bid);
  const dateISO = payload.dateISO || new Date().toISOString().slice(0, 10);
  const dateLabel = shortDateFromIso(dateISO);
  const dueDateISO = payload.dueDateISO || '';
  const totalDisplay = `₦${totalNgn.toLocaleString('en-NG')}`;
  const paidNgn = Math.round(Number(payload.paidNgn) || 0);
  let paymentStatus = payload.paymentStatus;
  if (!paymentStatus) {
    if (paidNgn <= 0) paymentStatus = 'Unpaid';
    else if (totalNgn > 0 && paidNgn >= totalNgn) paymentStatus = 'Paid';
    else paymentStatus = 'Partial';
  }
  const status = payload.status || 'Pending';
  const handledBy = payload.handledBy || 'Sales';
  const projectName = String(payload.projectName ?? '').trim() || null;
  const linesStr = JSON.stringify(linesJson);

  db.transaction(() => {
    db.prepare(
      `
      INSERT INTO quotations (
        id, customer_id, customer_name, date_label, date_iso, due_date_iso,
        total_display, total_ngn, paid_ngn, payment_status, status, approval_date, customer_feedback, handled_by,
        project_name, lines_json, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `
    ).run(
      id,
      customerID,
      cust.name,
      dateLabel,
      dateISO,
      dueDateISO,
      totalDisplay,
      totalNgn,
      paidNgn,
      paymentStatus,
      status,
      payload.approvalDate ?? '',
      payload.customerFeedback ?? '',
      handledBy,
      projectName,
      linesStr,
      bid
    );
    syncQuotationLineRows(db, id, linesJson);
  })();

  return id;
}

export function updateQuotation(db, quotationId, payload) {
  const existing = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(quotationId);
  if (!existing) throw new Error('Quotation not found.');
  const st0 = String(existing.status || '').trim();
  if (st0 === 'Expired' || st0 === 'Void') {
    throw new Error('This quotation is archived (expired or void). Use Revive to restore it to the active pipeline.');
  }

  const prior = parseQuotationLinesJsonObject(existing.lines_json);
  const linesJson = { ...prior };
  if (payload.lines) {
    linesJson.products = payload.lines.products ?? [];
    linesJson.accessories = payload.lines.accessories ?? [];
    linesJson.services = payload.lines.services ?? [];
  }
  if (payload.materialGauge !== undefined) linesJson.materialGauge = String(payload.materialGauge ?? '').trim();
  if (payload.materialColor !== undefined) linesJson.materialColor = String(payload.materialColor ?? '').trim();
  if (payload.materialDesign !== undefined) linesJson.materialDesign = String(payload.materialDesign ?? '').trim();
  if (payload.materialTypeId !== undefined) linesJson.materialTypeId = String(payload.materialTypeId ?? '').trim();

  const totalNgn = payload.lines != null ? sumQuotationLinesJson(linesJson) : existing.total_ngn;
  const customerID =
    payload.customerID != null ? String(payload.customerID).trim() : existing.customer_id;
  const cust = db.prepare(`SELECT name FROM customers WHERE customer_id = ?`).get(customerID);
  if (!cust) throw new Error('Customer not found.');
  const customerName = cust.name;

  const dateISO = payload.dateISO ?? existing.date_iso;
  const dateLabel = shortDateFromIso(dateISO);
  const dueDateISO = payload.dueDateISO !== undefined ? payload.dueDateISO : existing.due_date_iso;
  const totalDisplay = `₦${(Number(totalNgn) || 0).toLocaleString('en-NG')}`;
  const paidNgn =
    payload.paidNgn != null ? Math.round(Number(payload.paidNgn) || 0) : existing.paid_ngn;
  let paymentStatus = payload.paymentStatus ?? existing.payment_status;
  if (payload.paidNgn != null || payload.lines) {
    const t = Number(totalNgn) || 0;
    const p = Number(paidNgn) || 0;
    if (p <= 0) paymentStatus = 'Unpaid';
    else if (t > 0 && p >= t) paymentStatus = 'Paid';
    else paymentStatus = 'Partial';
  }
  const status = payload.status ?? existing.status;
  const approvalDate = payload.approvalDate !== undefined ? payload.approvalDate : existing.approval_date;
  const customerFeedback =
    payload.customerFeedback !== undefined ? payload.customerFeedback : existing.customer_feedback;
  const handledBy = payload.handledBy ?? existing.handled_by;
  const projectName =
    payload.projectName !== undefined
      ? String(payload.projectName ?? '').trim() || null
      : existing.project_name;
  const linesStr = JSON.stringify(linesJson);

  db.transaction(() => {
    db.prepare(
      `
      UPDATE quotations SET
        customer_id = ?,
        customer_name = ?,
        date_label = ?,
        date_iso = ?,
        due_date_iso = ?,
        total_display = ?,
        total_ngn = ?,
        paid_ngn = ?,
        payment_status = ?,
        status = ?,
        approval_date = ?,
        customer_feedback = ?,
        handled_by = ?,
        project_name = ?,
        lines_json = ?
      WHERE id = ?
    `
    ).run(
      customerID,
      customerName,
      dateLabel,
      dateISO,
      dueDateISO ?? '',
      totalDisplay,
      totalNgn,
      paidNgn,
      paymentStatus,
      status,
      approvalDate ?? '',
      customerFeedback ?? '',
      handledBy,
      projectName,
      linesStr,
      quotationId
    );
    if (payload.lines) syncQuotationLineRows(db, quotationId, linesJson);
  })();

  return quotationId;
}

export function reviveQuotation(db, quotationId) {
  const row = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(quotationId);
  if (!row) throw new Error('Quotation not found.');
  const st = String(row.status || '').trim();
  if (st !== 'Expired' && st !== 'Void') {
    throw new Error('Only expired or void quotations can be revived.');
  }
  db.prepare(
    `UPDATE quotations SET status = 'Pending', archived = 0, quotation_lifecycle_note = NULL WHERE id = ?`
  ).run(quotationId);
  return quotationId;
}

export function replaceRefunds(db, refunds) {
  db.prepare(`DELETE FROM customer_refunds`).run();
  const ins = db.prepare(`
    INSERT INTO customer_refunds (
      refund_id, customer_id, customer_name, quotation_ref, cutting_list_ref, product, reason_category, reason,
      amount_ngn, calculation_lines_json, suggested_lines_json, calculation_notes, status, requested_by, requested_at_iso,
      approval_date, approved_by, approved_amount_ngn, manager_comments, paid_amount_ngn, paid_at_iso, paid_by, payment_note, branch_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  db.transaction(() => {
    for (const r of refunds) {
      ins.run(
        r.refundID,
        r.customerID,
        r.customer,
        r.quotationRef,
        r.cuttingListRef,
        r.product,
        r.reasonCategory,
        r.reason,
        r.amountNgn,
        JSON.stringify(r.calculationLines || []),
        JSON.stringify(r.suggestedLines || r.calculationLines || []),
        r.calculationNotes,
        r.status,
        r.requestedBy,
        r.requestedAtISO,
        r.approvalDate,
        r.approvedBy,
        r.approvedAmountNgn ?? r.amountNgn ?? 0,
        r.managerComments,
        r.paidAmountNgn ?? (r.status === 'Paid' ? r.approvedAmountNgn ?? r.amountNgn ?? 0 : 0),
        r.paidAtISO,
        r.paidBy,
        r.paymentNote ?? '',
        String(r.branchId || DEFAULT_BRANCH_ID).trim()
      );
    }
  })();
  return { ok: true };
}

/**
 * Cashier: mark mirror receipt row as confirmed against bank deposit.
 * @param {import('better-sqlite3').Database} db
 * @param {string} receiptId
 * @param {boolean} confirmed
 * @param {object | null} actor
 */
export function patchSalesReceiptBankConfirmation(db, receiptId, confirmed, actor = null) {
  const id = String(receiptId || '').trim();
  if (!id) return { ok: false, error: 'Receipt id required.' };
  const row = db.prepare(`SELECT id FROM sales_receipts WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Receipt not found.' };
  const now = new Date().toISOString();
  if (confirmed) {
    db.prepare(
      `UPDATE sales_receipts SET bank_confirmed_at_iso = ?, bank_confirmed_by_user_id = ? WHERE id = ?`
    ).run(now, actor?.id ?? null, id);
  } else {
    db.prepare(
      `UPDATE sales_receipts SET bank_confirmed_at_iso = NULL, bank_confirmed_by_user_id = NULL WHERE id = ?`
    ).run(id);
  }
  appendAuditLog(db, {
    actor,
    action: 'receipt.bank_confirmation',
    entityKind: 'sales_receipt',
    entityId: id,
    note: confirmed ? 'Confirmed in bank' : 'Bank confirmation cleared',
  });
  return { ok: true };
}

/**
 * Finance: record amount actually received in bank and optionally clear receipt for delivery.
 * @param {import('better-sqlite3').Database} db
 * @param {string} receiptId
 * @param {{ bankReceivedAmountNgn?: number | string | null, clearForDelivery?: boolean }} payload
 * @param {object | null} actor
 */
export function patchSalesReceiptFinanceSettlement(db, receiptId, payload, actor = null) {
  const id = String(receiptId || '').trim();
  if (!id) return { ok: false, error: 'Receipt id required.' };
  const row = db.prepare(`SELECT * FROM sales_receipts WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Receipt not found.' };

  const clearForDelivery = Boolean(payload?.clearForDelivery);
  const rawAmt = payload?.bankReceivedAmountNgn;
  const hasBankAmt =
    rawAmt !== undefined && rawAmt !== null && String(rawAmt).trim() !== '';
  let nextBankReceived =
    row.bank_received_amount_ngn != null ? roundMoney(row.bank_received_amount_ngn) : null;
  if (hasBankAmt) {
    const n = roundMoney(rawAmt);
    if (n < 0) return { ok: false, error: 'Bank received amount cannot be negative.' };
    nextBankReceived = n;
  }

  const now = new Date().toISOString();
  const uid = actor?.id ?? null;

  db.prepare(
    `UPDATE sales_receipts SET
      bank_received_amount_ngn = ?,
      finance_delivery_cleared_at_iso = ?,
      finance_delivery_cleared_by_user_id = ?,
      bank_confirmed_at_iso = ?,
      bank_confirmed_by_user_id = ?
     WHERE id = ?`
  ).run(
    nextBankReceived,
    clearForDelivery ? now : null,
    clearForDelivery ? uid : null,
    clearForDelivery ? now : null,
    clearForDelivery ? uid : null,
    id
  );

  appendAuditLog(db, {
    actor,
    action: 'receipt.finance_settlement',
    entityKind: 'sales_receipt',
    entityId: id,
    note: clearForDelivery
      ? `Cleared for delivery; bank received ₦${nextBankReceived ?? row.amount_ngn}`
      : `Bank received amount updated`,
    details: {
      bankReceivedAmountNgn: nextBankReceived,
      bookAmountNgn: row.amount_ngn,
      clearForDelivery,
    },
  });
  return { ok: true };
}

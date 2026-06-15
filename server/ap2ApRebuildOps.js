/**
 * AP2b — received-basis AP rebuild preview and controlled apply (Head of Accounts approval).
 */
import { appendAuditLog } from './controlOps.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import {
  apReceivedBasisRebuildEnabled,
  computePoReceivedBasisEconomics,
  hashAp2RebuildPreview,
  isAutoManagedApId,
  listPurchaseOrdersForAp2Scope,
  parsePeriodKey,
  readLastApReceivedBasisRebuild,
  roundMoney,
  tableExists,
} from './ap2ReceivedBasisOps.js';

const PREVIEW_ROW_CAP = 500;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   branchId?: string | null;
 *   period?: string | null;
 *   supplierId?: string | null;
 *   status?: string | null;
 *   limitSamples?: number;
 * }} [opts]
 */
export function buildAp2ApRebuildPreview(db, opts = {}) {
  const branchScope =
    opts.branchId && String(opts.branchId).trim() && opts.branchId !== 'ALL'
      ? String(opts.branchId).trim()
      : 'ALL';
  const period = opts.period ? parsePeriodKey(opts.period) : null;

  const notes = [
    'PO value is a commitment only.',
    'Received-basis AP uses received goods value less supplier payments.',
    'Head of Accounts must approve before rebuild is applied.',
    'Current AP may still be ordered-basis until rebuild is approved.',
  ];

  if (!tableExists(db, 'purchase_orders')) {
    return emptyPreview(branchScope, period, notes);
  }

  const lineStmt = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ?`);
  const apStmt = tableExists(db, 'accounts_payable')
    ? db.prepare(
        `SELECT ap_id, amount_ngn, paid_ngn FROM accounts_payable WHERE po_ref = ? ORDER BY ap_id LIMIT 1`
      )
    : null;

  const pos = listPurchaseOrdersForAp2Scope(db, opts);
  const rows = [];
  const summary = {
    poCount: 0,
    affectedPoCount: 0,
    currentApNgn: 0,
    expectedApNgn: 0,
    proposedApTotalNgn: 0,
    apDecreaseNgn: 0,
    apIncreaseNgn: 0,
    supplierAdvanceNgn: 0,
    orderedNotReceivedNgn: 0,
    estimatedReceivedValueNgn: 0,
    missingCostCount: 0,
    manualApSkippedCount: 0,
  };

  for (const po of pos) {
    const poId = po.po_id;
    const lines = lineStmt.all(poId);
    const apRow = apStmt?.get(poId) ?? null;
    const econ = computePoReceivedBasisEconomics(db, po, lines, { apRow });

    summary.poCount += 1;
    summary.currentApNgn += econ.currentApNgn;
    summary.expectedApNgn += econ.expectedApNgn;
    summary.proposedApTotalNgn += econ.proposedApNgn;
    summary.supplierAdvanceNgn += econ.supplierAdvanceNgn;
    summary.orderedNotReceivedNgn += econ.orderedNotReceivedNgn;
    if (econ.estimated) summary.estimatedReceivedValueNgn += econ.receivedValueNgn;
    if (econ.missingCostCount) summary.missingCostCount += 1;
    if (econ.riskFlags.includes('manual_ap_skipped')) summary.manualApSkippedCount += 1;

    const delta = econ.amountDeltaNgn;
    if (econ.rebuildEligible && delta !== 0) {
      summary.affectedPoCount += 1;
      if (delta > 0) summary.apDecreaseNgn += delta;
      else summary.apIncreaseNgn += -delta;
    }

    rows.push({
      poId: econ.poId,
      supplierRef: econ.supplierRef,
      supplierName: econ.supplierName,
      branchId: econ.branchId,
      status: econ.status,
      orderedValueNgn: econ.orderedValueNgn,
      receivedValueNgn: econ.receivedValueNgn,
      supplierPaidNgn: econ.supplierPaidNgn,
      currentApNgn: econ.currentApNgn,
      expectedApNgn: econ.expectedApNgn,
      proposedApNgn: econ.proposedApNgn,
      supplierAdvanceNgn: econ.supplierAdvanceNgn,
      apDifferenceNgn: econ.amountDeltaNgn,
      estimated: econ.estimated,
      autoManaged: econ.autoManaged,
      rebuildEligible: econ.rebuildEligible,
      riskFlags: econ.riskFlags,
    });
  }

  const previewHash = hashAp2RebuildPreview(rows, {
    branchId: branchScope,
    period: period?.key ?? null,
    supplierId: opts.supplierId ?? null,
    status: opts.status ?? null,
  });

  const lastRebuild = readLastApReceivedBasisRebuild(db);

  return {
    ok: true,
    status: 'preview_only',
    label: 'AP Received-Basis Rebuild Preview',
    disclaimer: 'Preview only. No AP values were changed.',
    branchScope: branchScope === 'ALL' ? null : branchScope,
    period: period || null,
    generatedAtISO: new Date().toISOString(),
    previewHash,
    apBasis: 'ordered',
    apBasisNote: 'Current AP may still be ordered-basis until rebuild is approved.',
    lastRebuild,
    summary,
    rows: rows.slice(0, PREVIEW_ROW_CAP),
    rowCount: rows.length,
    notes,
    flags: readFinanceFeatureFlags(),
  };
}

function emptyPreview(branchScope, period, notes) {
  return {
    ok: true,
    status: 'preview_only',
    label: 'AP Received-Basis Rebuild Preview',
    disclaimer: 'Preview only. No AP values were changed.',
    branchScope: branchScope === 'ALL' ? null : branchScope,
    period: period || null,
    generatedAtISO: new Date().toISOString(),
    previewHash: hashAp2RebuildPreview([], { branchId: branchScope, period: period?.key ?? null }),
    summary: {
      poCount: 0,
      affectedPoCount: 0,
      currentApNgn: 0,
      expectedApNgn: 0,
      proposedApTotalNgn: 0,
      apDecreaseNgn: 0,
      apIncreaseNgn: 0,
      supplierAdvanceNgn: 0,
      orderedNotReceivedNgn: 0,
      estimatedReceivedValueNgn: 0,
      missingCostCount: 0,
      manualApSkippedCount: 0,
    },
    rows: [],
    rowCount: 0,
    notes,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {{
 *   branchId?: string;
 *   period?: string;
 *   supplierId?: string;
 *   status?: string;
 *   confirmPreviewHash: string;
 *   approvalNote: string;
 *   dryRunAccepted?: boolean;
 * }} body
 */
export function applyAp2ReceivedBasisRebuild(db, actor, body) {
  if (!apReceivedBasisRebuildEnabled()) {
    return { ok: false, error: 'AP received-basis rebuild is disabled (AP_RECEIVED_BASIS_REBUILD_ENABLED=0).' };
  }
  const note = String(body.approvalNote || '').trim();
  if (!note) {
    return { ok: false, error: 'Approval note is required.' };
  }
  if (!body.dryRunAccepted) {
    return { ok: false, error: 'dryRunAccepted must be true to confirm Head of Accounts review.' };
  }
  const hash = String(body.confirmPreviewHash || '').trim();
  if (!hash) {
    return { ok: false, error: 'confirmPreviewHash is required (load preview first).' };
  }

  const preview = buildAp2ApRebuildPreview(db, {
    branchId: body.branchId,
    period: body.period,
    supplierId: body.supplierId,
    status: body.status,
  });
  if (preview.previewHash !== hash) {
    return {
      ok: false,
      error: 'Preview hash mismatch. Reload preview and approve again.',
      code: 'PREVIEW_STALE',
    };
  }

  const lineStmt = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ?`);
  const apAllStmt = tableExists(db, 'accounts_payable')
    ? db.prepare(`SELECT ap_id, amount_ngn, paid_ngn FROM accounts_payable WHERE po_ref = ?`)
    : null;

  let updatedCount = 0;
  let skippedManual = 0;
  let beforeTotal = 0;
  let afterTotal = 0;

  const run = db.transaction(() => {
    for (const po of listPurchaseOrdersForAp2Scope(db, body)) {
      const poId = po.po_id;
      const lines = lineStmt.all(poId);
      const apRows = apAllStmt?.all(poId) ?? [];
      const autoAp = apRows.find((r) => isAutoManagedApId(r.ap_id));
      if (apRows.length && !autoAp) {
        skippedManual += 1;
        continue;
      }
      const econ = computePoReceivedBasisEconomics(db, po, lines, { apRow: autoAp ?? null });
      if (!econ.rebuildEligible) continue;

      const proposed = econ.proposedApNgn;
      const paidNgn = roundMoney(po.supplier_paid_ngn);
      beforeTotal += roundMoney(autoAp?.amount_ngn);

      if (autoAp) {
        if (roundMoney(autoAp.amount_ngn) === proposed) continue;
        db.prepare(
          `UPDATE accounts_payable SET amount_ngn = ?, paid_ngn = ? WHERE po_ref = ? AND ap_id LIKE 'AP-PO-%'`
        ).run(proposed, paidNgn, poId);
        updatedCount += 1;
        afterTotal += proposed;
      } else if (proposed > 0 && String(po.status || '').trim() !== 'Rejected') {
        const inv = String(po.invoice_no || '').trim();
        const due = String(po.expected_delivery_iso || po.order_date_iso || '').slice(0, 10);
        db.prepare(
          `INSERT INTO accounts_payable (ap_id, supplier_name, po_ref, invoice_ref, amount_ngn, paid_ngn, due_date_iso, payment_method)
           VALUES (?,?,?,?,?,?,?,NULL)`
        ).run(`AP-PO-${poId}`, po.supplier_name, poId, inv, proposed, paidNgn, due);
        updatedCount += 1;
        afterTotal += proposed;
      }
    }

    appendAuditLog(db, {
      actor,
      action: 'ap.received_basis.rebuilt',
      entityKind: 'accounts_payable',
      entityId: 'AP2b',
      note,
      details: {
        branchId: body.branchId ?? 'ALL',
        period: body.period ?? null,
        previewHash: hash,
        updatedCount,
        skippedManual,
        beforeTotalApNgn: beforeTotal,
        afterTotalApNgn: afterTotal,
      },
    });
  });

  run();

  return {
    ok: true,
    status: 'rebuilt',
    label: 'AP received-basis rebuild applied',
    updatedCount,
    skippedManualCount: skippedManual,
    beforeTotalApNgn: beforeTotal,
    afterTotalApNgn: afterTotal,
    apBasis: 'received_goods',
    previewSummary: preview.summary,
    generatedAtISO: new Date().toISOString(),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {object} scope
 */
export function logAp2RebuildPreviewed(db, actor, scope) {
  const preview = buildAp2ApRebuildPreview(db, scope);
  appendAuditLog(db, {
    actor,
    action: 'ap.received_basis.previewed',
    entityKind: 'accounts_payable',
    entityId: 'AP2b',
    note: 'AP received-basis rebuild preview loaded',
    details: {
      branchId: scope.branchId ?? 'ALL',
      period: scope.period ?? null,
      previewHash: preview.previewHash,
      affectedPoCount: preview.summary.affectedPoCount,
    },
  });
  return preview;
}

import { companionOverpayNgnByReceiptId } from '../../frontend/src/lib/customerLedgerCore.js';
import { accessoryFulfillmentSummaryForQuotation } from './accessoryFulfillment.js';
import { publicUserFromRow } from './auth.js';
import { procurementKindFromPoRow } from './procurementPoKind.js';
import { parseSupplierProfileJson, stripAgreementBodiesForList } from './supplierProfile.js';
import { listBranches } from './branches.js';
import { branchPredicate } from './branchSql.js';
import { listInTransitLoads } from './inTransitOps.js';
/** @param {import('better-sqlite3').Database} db */

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } catch {
    return false;
  }
}

/** @param {'ALL' | string} scope */
function branchWhere(db, table, scope) {
  if (scope === 'ALL' || !scope || !hasColumn(db, table, 'branch_id')) {
    return { sql: '', args: [] };
  }
  return { sql: ` AND branch_id = ?`, args: [scope] };
}

function parseCrmTagsJson(raw) {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j.filter((t) => typeof t === 'string' && t.trim()) : [];
  } catch {
    return [];
  }
}

function parsePaymentRequestLineItemsJson(raw) {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function mapCustomerRow(row) {
  if (!row) return null;
  return {
    customerID: row.customer_id,
    name: row.name,
    phoneNumber: row.phone_number,
    email: row.email,
    addressShipping: row.address_shipping,
    addressBilling: row.address_billing,
    status: row.status,
    tier: row.tier,
    paymentTerms: row.payment_terms,
    createdBy: row.created_by,
    createdAtISO: row.created_at_iso,
    lastActivityISO: row.last_activity_iso,
    companyName: row.company_name ?? '',
    leadSource: row.lead_source ?? '',
    preferredContact: row.preferred_contact ?? '',
    followUpISO: row.follow_up_iso ?? '',
    crmTags: parseCrmTagsJson(row.crm_tags_json),
    crmProfileNotes: row.crm_profile_notes ?? '',
    branchId: row.branch_id ?? '',
  };
}

export function listCustomers(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'customers', branchScope);
  return db
    .prepare(`SELECT * FROM customers WHERE 1=1${b.sql} ORDER BY name COLLATE NOCASE`)
    .all(...b.args)
    .map((row) => mapCustomerRow(row));
}

export function getCustomer(db, customerId, branchScope = 'ALL') {
  const b = branchWhere(db, 'customers', branchScope);
  const row = db
    .prepare(`SELECT * FROM customers WHERE customer_id = ?${b.sql}`)
    .get(customerId, ...b.args);
  return mapCustomerRow(row);
}

export function listCustomerCrmInteractions(db, customerId, branchScope = 'ALL') {
  const b = branchWhere(db, 'customer_crm_interactions', branchScope);
  return db
    .prepare(
      `SELECT * FROM customer_crm_interactions WHERE customer_id = ?${b.sql} ORDER BY at_iso DESC, id DESC`
    )
    .all(customerId, ...b.args)
    .map((row) => ({
      id: row.id,
      customerID: row.customer_id,
      atIso: row.at_iso,
      kind: row.kind,
      title: row.title ?? '',
      detail: row.detail,
      createdByName: row.created_by_name ?? '',
    }));
}

function groupedFromQuotationLinesTableRows(rows) {
  const out = { products: [], accessories: [], services: [] };
  for (const r of rows) {
    const cat = r.category;
    if (!out[cat]) continue;
    out[cat].push({
      id: r.id,
      name: r.name,
      qty: String(r.qty ?? ''),
      unitPrice: String(r.unit_price_ngn ?? ''),
    });
  }
  return out;
}

function mapQuotationRow(row) {
  let quotationLines;
  let materialGauge = '';
  let materialColor = '';
  let materialDesign = '';
  let materialTypeId = '';
  try {
    const raw = row.lines_json;
    if (raw) {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') {
        if (typeof j.materialGauge === 'string') materialGauge = j.materialGauge;
        if (typeof j.materialColor === 'string') materialColor = j.materialColor;
        if (typeof j.materialDesign === 'string') materialDesign = j.materialDesign;
        if (typeof j.materialTypeId === 'string') materialTypeId = j.materialTypeId;
        if (
          Array.isArray(j.products) &&
          Array.isArray(j.accessories) &&
          Array.isArray(j.services)
        ) {
          quotationLines = {
            products: j.products,
            accessories: j.accessories,
            services: j.services,
          };
        }
      }
    }
  } catch {
    /* ignore */
  }
  return {
    id: row.id,
    customerID: row.customer_id,
    customer: row.customer_name,
    date: row.date_label,
    dateISO: row.date_iso,
    dueDateISO: row.due_date_iso,
    total: row.total_display,
    totalNgn: row.total_ngn,
    paidNgn: row.paid_ngn,
    paymentStatus: row.payment_status,
    status: row.status,
    approvalDate: row.approval_date,
    customerFeedback: row.customer_feedback,
    handledBy: row.handled_by,
    projectName: row.project_name || '',
    quotationLines,
    materialGauge,
    materialColor,
    materialDesign,
    materialTypeId,
    branchId: row.branch_id ?? '',
    managerProductionApprovedAtISO: row.manager_production_approved_at_iso ?? null,
    managerClearedAtISO: row.manager_cleared_at_iso ?? null,
    managerFlaggedAtISO: row.manager_flagged_at_iso ?? null,
    managerFlagReason: row.manager_flag_reason ?? '',
    mdPriceExceptionApprovedAtISO: row.md_price_exception_approved_at_iso ?? null,
    mdPriceExceptionApprovedByUserId: row.md_price_exception_approved_by_user_id ?? null,
    archived: Number(row.archived) === 1,
    lifecycleNote: row.quotation_lifecycle_note ?? '',
  };
}

function enrichQuotationWithLineTable(db, mapped) {
  if (mapped.quotationLines) return mapped;
  const lr = db
    .prepare(`SELECT * FROM quotation_lines WHERE quotation_id = ? ORDER BY sort_order`)
    .all(mapped.id);
  if (lr.length) {
    return { ...mapped, quotationLines: groupedFromQuotationLinesTableRows(lr) };
  }
  return mapped;
}

export function listQuotations(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'quotations', branchScope);
  return db
    .prepare(`SELECT * FROM quotations WHERE 1=1${b.sql} ORDER BY date_iso DESC, id DESC`)
    .all(...b.args)
    .map((row) => enrichQuotationWithLineTable(db, mapQuotationRow(row)));
}

export function getQuotation(db, id) {
  const row = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(id);
  if (!row) return null;
  return enrichQuotationWithLineTable(db, mapQuotationRow(row));
}

export function listManagementItems(db, branchScope = 'ALL') {
  const bQuo = branchWhere(db, 'quotations', branchScope);
  const bCL = branchWhere(db, 'cutting_lists', branchScope);
  const bRef = branchWhere(db, 'customer_refunds', branchScope);
  const bJob = branchWhere(db, 'production_jobs', branchScope);

  // 1. Quotations requiring clearance (Not cleared, not flagged yet, and has payments)
  const pendingClearance = db.prepare(`
    SELECT id, customer_name, total_ngn, paid_ngn, date_iso, status, branch_id
    FROM quotations 
    WHERE manager_cleared_at_iso IS NULL 
      AND manager_flagged_at_iso IS NULL
      AND paid_ngn > 0
      ${bQuo.sql}
    ORDER BY date_iso DESC LIMIT 50
  `).all(...bQuo.args);

  // 2. Flagged transactions
  const flagged = db.prepare(`
    SELECT id, customer_name, total_ngn, manager_flag_reason, manager_flagged_at_iso, branch_id
    FROM quotations 
    WHERE manager_flagged_at_iso IS NOT NULL
      ${bQuo.sql}
    ORDER BY manager_flagged_at_iso DESC LIMIT 50
  `).all(...bQuo.args);

  // 3. Production Overrides (70% threshold bypass requirements)
  const productionOverrides = db.prepare(`
    SELECT cl.id, cl.customer_name, cl.quotation_ref, cl.total_meters, q.paid_ngn, q.total_ngn, cl.branch_id
    FROM cutting_lists cl
    JOIN quotations q ON cl.quotation_ref = q.id
    WHERE cl.status = 'Draft' 
      AND (q.paid_ngn < (q.total_ngn * 0.7))
      AND q.manager_production_approved_at_iso IS NULL
      ${bCL.sql.replace('branch_id', 'cl.branch_id')}
    ORDER BY cl.date_iso DESC LIMIT 50
  `).all(...bCL.args);

  // 4. Refund Requests
  const pendingRefunds = db.prepare(`
    SELECT refund_id, customer_name, quotation_ref, amount_ngn, requested_at_iso, reason_category, branch_id
    FROM customer_refunds
    WHERE status = 'Pending'
      ${bRef.sql}
    ORDER BY requested_at_iso DESC LIMIT 50
  `).all(...bRef.args);

  // 5. Payment requests pending approval (column is approval_status, not status)
  const pendingExpensesRaw = db.prepare(`
    SELECT pr.request_id, pr.expense_id, pr.amount_requested_ngn, pr.request_date, pr.description, pr.approval_status,
           pr.request_reference, pr.line_items_json, pr.attachment_name, pr.attachment_data_b64,
           e.category AS expense_category, e.branch_id AS branch_id
    FROM payment_requests pr
    LEFT JOIN expenses e ON e.expense_id = pr.expense_id
    WHERE pr.approval_status = 'Pending'
    ORDER BY pr.request_date DESC LIMIT 50
  `).all();
  const pendingExpenses = pendingExpensesRaw.map((row) => ({
    request_id: row.request_id,
    expense_id: row.expense_id,
    amount_requested_ngn: row.amount_requested_ngn,
    request_date: row.request_date,
    description: row.description,
    approval_status: row.approval_status,
    request_reference: row.request_reference ?? '',
    line_items: parsePaymentRequestLineItemsJson(row.line_items_json),
    attachment_present: Boolean(row.attachment_data_b64 && String(row.attachment_data_b64).trim()),
    attachment_name: row.attachment_name ?? '',
    expense_category: row.expense_category ?? '',
    branch_id: row.branch_id ?? '',
  }));

  // 6. Completed production jobs awaiting conversion / manager review sign-off (High/Low or flag)
  const pendingConversionReviews = db.prepare(`
    SELECT job_id, cutting_list_id, quotation_ref, customer_name, product_name,
      conversion_alert_state, manager_review_required, actual_meters, actual_weight_kg, completed_at_iso, branch_id
    FROM production_jobs
    WHERE status = 'Completed'
      AND (manager_review_signed_at_iso IS NULL OR TRIM(COALESCE(manager_review_signed_at_iso, '')) = '')
      AND (
        manager_review_required = 1
        OR UPPER(TRIM(COALESCE(conversion_alert_state, ''))) IN ('HIGH', 'LOW')
      )
      ${bJob.sql}
    ORDER BY completed_at_iso DESC
    LIMIT 50
  `).all(...bJob.args);

  return {
    pendingClearance,
    flagged,
    productionOverrides,
    pendingRefunds,
    pendingExpenses,
    pendingConversionReviews,
  };
}

const LEDGER_INFLOW_TYPES = new Set(['RECEIPT', 'ADVANCE_IN', 'OVERPAY_ADVANCE']);

export function listManagerQuotationAudit(db, quotationRef) {
  const qid = String(quotationRef || '').trim();
  if (!qid) {
    return {
      ok: false,
      error: 'quotationRef required',
      quotation: null,
      summary: null,
      ledgerEntries: [],
      receipts: [],
      cuttingLists: [],
      productionLogs: [],
      conversionChecks: [],
      jobCoils: [],
      refunds: [],
      totals: {
        cuttingListMetersSum: 0,
        completedProductionMetersSum: 0,
        productionJobsMetersSum: 0,
      },
    };
  }

  const quotation = getQuotation(db, qid);
  const qRow = db
    .prepare(
      `SELECT id, customer_name, total_ngn, paid_ngn, status, payment_status,
        manager_cleared_at_iso, manager_flagged_at_iso, manager_production_approved_at_iso
       FROM quotations WHERE id = ?`
    )
    .get(qid);

  const ledgerEntries = db
    .prepare(
      `SELECT id, at_iso, type, amount_ngn, payment_method, bank_reference, purpose, note, created_by_name
       FROM ledger_entries
       WHERE quotation_ref = ?
       ORDER BY at_iso ASC, id ASC`
    )
    .all(qid);

  const receipts = ledgerEntries.filter((e) => LEDGER_INFLOW_TYPES.has(String(e.type)));

  const cuttingLists = db
    .prepare(
      `SELECT id, date_iso, total_meters, status, handled_by
       FROM cutting_lists
       WHERE quotation_ref = ?
       ORDER BY date_iso DESC`
    )
    .all(qid);

  const cuttingListMetersSum = cuttingLists.reduce((s, cl) => s + (Number(cl.total_meters) || 0), 0);

  const productionLogs = db
    .prepare(
      `SELECT job_id, cutting_list_id, product_name, planned_meters, actual_meters, actual_weight_kg, status,
        conversion_alert_state, manager_review_required, completed_at_iso, operator_name,
        manager_review_signed_at_iso, manager_review_remark,
        start_date_iso, end_date_iso, machine_name, materials_note, created_at_iso
       FROM production_jobs
       WHERE quotation_ref = ?
       ORDER BY (completed_at_iso IS NULL), completed_at_iso DESC, created_at_iso DESC`
    )
    .all(qid);

  const jobIds = productionLogs.map((j) => j.job_id).filter(Boolean);
  let conversionChecks = [];
  let jobCoils = [];
  if (jobIds.length) {
    const ph = jobIds.map(() => '?').join(',');
    conversionChecks = db
      .prepare(
        `SELECT job_id, coil_no, alert_state, actual_conversion_kg_per_m, standard_conversion_kg_per_m,
          checked_at_iso, note, gauge_label, material_type_name
         FROM production_conversion_checks
         WHERE job_id IN (${ph})
         ORDER BY checked_at_iso DESC`
      )
      .all(...jobIds);
    jobCoils = db
      .prepare(
        `SELECT job_id, coil_no, meters_produced, consumed_weight_kg, opening_weight_kg, closing_weight_kg,
          actual_conversion_kg_per_m, sequence_no
         FROM production_job_coils
         WHERE job_id IN (${ph})
         ORDER BY job_id, sequence_no ASC`
      )
      .all(...jobIds);
  }

  const refunds = db
    .prepare(
      `SELECT refund_id, product, reason_category, amount_ngn, status, requested_at_iso, approved_amount_ngn,
        paid_amount_ngn, reason, calculation_notes, cutting_list_ref, manager_comments
       FROM customer_refunds
       WHERE quotation_ref = ?
       ORDER BY requested_at_iso DESC`
    )
    .all(qid);

  const orderTotal = Number(qRow?.total_ngn) || 0;
  const bookedPaid = Number(qRow?.paid_ngn) || 0;
  const ledgerInflowSum = ledgerEntries
    .filter((e) => LEDGER_INFLOW_TYPES.has(String(e.type || '').toUpperCase()))
    .reduce((s, e) => s + (Number(e.amount_ngn) || 0), 0);
  /** Prefer ledger receipts/advances when higher than booked paid (stale quotation row). */
  const paid = Math.max(bookedPaid, ledgerInflowSum);
  const outstanding = Math.max(0, orderTotal - paid);
  const completedMeters = productionLogs
    .filter((j) => String(j.status || '').toLowerCase() === 'completed')
    .reduce((s, j) => s + (Number(j.actual_meters) || 0), 0);
  const allJobMeters = productionLogs.reduce((s, j) => s + (Number(j.actual_meters) || 0), 0);

  return {
    ok: true,
    quotation,
    summary: qRow
      ? {
          orderTotalNgn: orderTotal,
          paidNgn: paid,
          outstandingNgn: outstanding,
          percentPaid: orderTotal > 0 ? Math.round((paid / orderTotal) * 1000) / 10 : null,
          status: qRow.status,
          paymentStatus: qRow.payment_status,
          managerClearedAtIso: qRow.manager_cleared_at_iso,
          managerFlaggedAtIso: qRow.manager_flagged_at_iso,
          managerProductionApprovedAtIso: qRow.manager_production_approved_at_iso,
        }
      : null,
    ledgerEntries,
    receipts,
    cuttingLists,
    productionLogs,
    conversionChecks,
    jobCoils,
    refunds,
    totals: {
      cuttingListMetersSum: cuttingListMetersSum,
      completedProductionMetersSum: completedMeters,
      productionJobsMetersSum: allJobMeters,
    },
  };
}

function listDeliveryLinesForId(db, deliveryId) {
  return db
    .prepare(`SELECT * FROM delivery_lines WHERE delivery_id = ? ORDER BY sort_order`)
    .all(deliveryId)
    .map((row) => ({
      lineNo: row.sort_order,
      productID: row.product_id,
      productName: row.product_name ?? row.product_id,
      qty: Number(row.qty) || 0,
      unit: row.unit || '',
      cuttingListLineNo: row.cutting_list_line_no ?? null,
    }));
}

function listCuttingListLinesForId(db, cuttingListId) {
  return db
    .prepare(`SELECT * FROM cutting_list_lines WHERE cutting_list_id = ? ORDER BY sort_order`)
    .all(cuttingListId)
    .map((row) => ({
      lineNo: row.sort_order,
      sheets: Number(row.sheets) || 0,
      lengthM: Number(row.length_m) || 0,
      totalM: Number(row.total_m) || 0,
      lineType: row.line_type || 'Roof',
    }));
}

function mapCuttingListRow(db, row) {
  const lines = listCuttingListLinesForId(db, row.id);
  const totalMeters =
    Number(row.total_meters) ||
    lines.reduce((sum, line) => sum + (Number(line.totalM) || 0), 0);
  const totalLabel =
    row.total_label ||
    `${totalMeters.toLocaleString('en-NG', {
      minimumFractionDigits: Number.isInteger(totalMeters) ? 0 : 2,
      maximumFractionDigits: 2,
    })} m`;
  return {
    id: row.id,
    customerID: row.customer_id,
    customer: row.customer_name,
    quotationRef: row.quotation_ref,
    productID: row.product_id ?? '',
    productName: row.product_name ?? '',
    date: row.date_label,
    dateISO: row.date_iso,
    sheetsToCut: Number(row.sheets_to_cut) || 0,
    totalMeters,
    total: totalLabel,
    status: row.status,
    machineName: row.machine_name ?? '',
    operatorName: row.operator_name ?? '',
    productionRegistered: Boolean(row.production_registered),
    productionRegisterRef: row.production_register_ref ?? '',
    handledBy: row.handled_by,
    lines,
    branchId: row.branch_id ?? '',
    productionReleasePending: Boolean(Number(row.production_release_pending)),
    productionReleasedAtISO: row.production_released_at_iso ?? '',
    productionReleasedBy: row.production_released_by ?? '',
  };
}

export function mapLedgerRow(row) {
  return {
    id: row.id,
    atISO: row.at_iso,
    type: row.type,
    customerID: row.customer_id,
    customerName: row.customer_name ?? undefined,
    amountNgn: row.amount_ngn,
    quotationRef: row.quotation_ref || '',
    paymentMethod: row.payment_method ?? undefined,
    bankReference: row.bank_reference ?? undefined,
    purpose: row.purpose ?? undefined,
    createdByUserId: row.created_by_user_id ?? '',
    createdByName: row.created_by_name ?? '',
    note: row.note ?? undefined,
    branchId: row.branch_id ?? '',
  };
}

export function listLedgerEntries(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'ledger_entries', branchScope);
  return db
    .prepare(`SELECT * FROM ledger_entries WHERE 1=1${b.sql} ORDER BY at_iso DESC, id DESC`)
    .all(...b.args)
    .map(mapLedgerRow);
}

export function listLedgerEntriesForCustomer(db, customerId, branchScope = 'ALL') {
  const b = branchWhere(db, 'ledger_entries', branchScope);
  return db
    .prepare(
      `SELECT * FROM ledger_entries WHERE customer_id = ?${b.sql} ORDER BY at_iso DESC, id DESC`
    )
    .all(customerId, ...b.args)
    .map(mapLedgerRow);
}

export function listSuppliers(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'suppliers', branchScope);
  return db
    .prepare(`SELECT * FROM suppliers WHERE 1=1${b.sql} ORDER BY name COLLATE NOCASE`)
    .all(...b.args)
    .map((row) => {
      const rawProfile = hasColumn(db, 'suppliers', 'supplier_profile_json')
        ? parseSupplierProfileJson(row.supplier_profile_json)
        : {};
      const supplierProfile = stripAgreementBodiesForList(rawProfile);
      return {
        supplierID: row.supplier_id,
        name: row.name,
        city: row.city,
        paymentTerms: row.payment_terms,
        qualityScore: row.quality_score,
        notes: row.notes,
        supplierProfile,
      };
    });
}

export function listTransportAgents(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'transport_agents', branchScope);
  return db
    .prepare(`SELECT * FROM transport_agents WHERE 1=1${b.sql} ORDER BY name`)
    .all(...b.args)
    .map((row) => {
      let profile = {};
      try {
        profile = JSON.parse(row.profile_json || '{}');
      } catch {
        profile = {};
      }
      return {
        id: row.id,
        name: row.name,
        region: row.region,
        phone: row.phone,
        profile,
      };
    });
}

export function listProducts(db, branchScope = 'ALL') {
  const hasPb = hasColumn(db, 'products', 'branch_id');
  let rows;
  if (branchScope === 'ALL' || !branchScope || !hasPb) {
    const b = branchWhere(db, 'products', branchScope);
    rows = db.prepare(`SELECT * FROM products WHERE 1=1${b.sql} ORDER BY name`).all(...b.args);
  } else {
    rows = db
      .prepare(
        `SELECT * FROM products WHERE branch_id = ? OR branch_id IS NULL OR TRIM(COALESCE(branch_id,'')) = '' ORDER BY name`
      )
      .all(branchScope);
  }
  return rows
    .map((row) => {
      let dashboardAttrs = {};
      try {
        dashboardAttrs = JSON.parse(row.dashboard_attrs_json || '{}');
      } catch {
        /* ignore */
      }
      return {
        productID: row.product_id,
        name: row.name,
        stockLevel: row.stock_level,
        unit: row.unit,
        lowStockThreshold: row.low_stock_threshold,
        reorderQty: row.reorder_qty,
        dashboardAttrs: {
          gauge: dashboardAttrs.gauge ?? row.gauge,
          colour: dashboardAttrs.colour ?? row.colour,
          materialType: dashboardAttrs.materialType ?? row.material_type,
        },
      };
    });
}

export function listPurchaseOrders(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'purchase_orders', branchScope);
  const pos = db
    .prepare(`SELECT * FROM purchase_orders WHERE 1=1${b.sql} ORDER BY order_date_iso DESC`)
    .all(...b.args);
  const lineStmt = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ? ORDER BY line_key`);
  return pos.map((row) => {
    const rawLines = lineStmt.all(row.po_id);
    return {
      poID: row.po_id,
      supplierID: row.supplier_id,
      supplierName: row.supplier_name,
      orderDateISO: row.order_date_iso,
      expectedDeliveryISO: row.expected_delivery_iso,
      status: row.status,
      invoiceNo: row.invoice_no ?? '',
      invoiceDateISO: row.invoice_date_iso ?? '',
      deliveryDateISO: row.delivery_date_iso ?? '',
      transportAgentId: row.transport_agent_id ?? '',
      transportAgentName: row.transport_agent_name ?? '',
      transportReference: row.transport_reference ?? '',
      transportNote: row.transport_note ?? '',
      transportFinanceAdvice: row.transport_finance_advice ?? '',
      transportTreasuryMovementId: row.transport_treasury_movement_id ?? '',
      transportAmountNgn: Number(row.transport_amount_ngn) || 0,
      transportAdvanceNgn: Number(row.transport_advance_ngn) || 0,
      transportPaidNgn: Number(row.transport_paid_ngn) || 0,
      transportPaid: Boolean(row.transport_paid),
      transportPaidAtISO: row.transport_paid_at_iso ?? '',
      supplierPaidNgn: row.supplier_paid_ngn ?? 0,
      procurementKind: procurementKindFromPoRow(row, rawLines),
      lines: rawLines.map((l) => ({
        lineKey: l.line_key,
        productID: l.product_id,
        productName: l.product_name,
        color: l.color ?? '',
        gauge: l.gauge ?? '',
        metersOffered: l.meters_offered,
        conversionKgPerM: l.conversion_kg_per_m,
        unitPricePerKgNgn: l.unit_price_per_kg_ngn,
        unitPriceNgn: l.unit_price_ngn,
        qtyOrdered: l.qty_ordered,
        qtyReceived: l.qty_received,
      })),
    };
  });
}

export function listCoilControlEvents(db, branchScope = 'ALL') {
  if (!hasColumn(db, 'coil_control_events', 'branch_id')) return [];
  const b = branchWhere(db, 'coil_control_events', branchScope);
  const lim = 2000;
  return db
    .prepare(
      `SELECT * FROM coil_control_events WHERE 1=1${b.sql} ORDER BY datetime(created_at_iso) DESC, id DESC LIMIT ?`
    )
    .all(...b.args, lim)
    .map((row) => ({
      id: row.id,
      branchId: row.branch_id ?? '',
      eventKind: row.event_kind ?? '',
      coilNo: row.coil_no ?? '',
      productID: row.product_id ?? '',
      gaugeLabel: row.gauge_label ?? '',
      colour: row.colour ?? '',
      meters: row.meters != null ? Number(row.meters) : null,
      kgCoilDelta: Number(row.kg_coil_delta) || 0,
      kgBook: row.kg_book != null ? Number(row.kg_book) : null,
      bookRef: row.book_ref ?? '',
      cuttingListRef: row.cutting_list_ref ?? '',
      quotationRef: row.quotation_ref ?? '',
      customerLabel: row.customer_label ?? '',
      supplierID: row.supplier_id ?? '',
      defectMFrom: row.defect_m_from != null ? Number(row.defect_m_from) : null,
      defectMTo: row.defect_m_to != null ? Number(row.defect_m_to) : null,
      supplierResolution: row.supplier_resolution ?? '',
      outboundDestination: row.outbound_destination ?? '',
      creditScrapInventory: Boolean(row.credit_scrap_inventory),
      scrapProductID: row.scrap_product_id ?? '',
      scrapReason: row.scrap_reason ?? '',
      note: row.note ?? '',
      dateISO: row.date_iso ?? '',
      createdAtISO: row.created_at_iso ?? '',
      actorUserId: row.actor_user_id ?? '',
      actorDisplay: row.actor_display ?? '',
    }));
}

export function listCoilLots(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'coil_lots', branchScope);
  return db
    .prepare(`SELECT * FROM coil_lots WHERE 1=1${b.sql} ORDER BY received_at_iso DESC, coil_no DESC`)
    .all(...b.args)
    .map((row) => ({
      coilNo: row.coil_no,
      productID: row.product_id,
      lineKey: row.line_key,
      qtyReceived: row.qty_received,
      weightKg: row.weight_kg,
      colour: row.colour ?? '',
      gaugeLabel: row.gauge_label ?? '',
      materialTypeName: row.material_type_name ?? '',
      supplierExpectedMeters: row.supplier_expected_meters,
      supplierConversionKgPerM: row.supplier_conversion_kg_per_m,
      qtyRemaining: Number(row.qty_remaining) || 0,
      qtyReserved: Number(row.qty_reserved) || 0,
      currentWeightKg: Number(row.current_weight_kg) || 0,
      currentStatus: row.current_status ?? 'Available',
      location: row.location,
      poID: row.po_id,
      supplierID: row.supplier_id,
      supplierName: row.supplier_name,
      receivedAtISO: row.received_at_iso,
      branchId: row.branch_id ?? '',
      parentCoilNo: row.parent_coil_no ?? '',
      materialOriginNote: row.material_origin_note ?? '',
      landedCostNgn: row.landed_cost_ngn != null ? Number(row.landed_cost_ngn) : null,
      unitCostNgnPerKg: row.unit_cost_ngn_per_kg != null ? Number(row.unit_cost_ngn_per_kg) : null,
    }));
}

export function listStockMovements(db) {
  return db
    .prepare(`SELECT * FROM stock_movements ORDER BY at_iso DESC, id DESC`)
    .all()
    .map((row) => ({
      id: row.id,
      atISO: row.at_iso,
      type: row.type,
      ref: row.ref,
      productID: row.product_id,
      qty: row.qty,
      detail: row.detail,
      dateISO: row.date_iso,
      unitPriceNgn: row.unit_price_ngn,
      valueNgn: row.value_ngn != null ? Number(row.value_ngn) : null,
    }));
}

/**
 * Stock ledger for one product (in/out), newest first.
 * @param {import('better-sqlite3').Database} db
 * @param {string} productID
 * @param {number} [limit]
 */
export function listStockMovementsForProduct(db, productID, limit = 500) {
  const pid = String(productID || '').trim();
  if (!pid) return [];
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  return db
    .prepare(
      `SELECT * FROM stock_movements WHERE product_id = ? ORDER BY at_iso DESC, id DESC LIMIT ?`
    )
    .all(pid, lim)
    .map((row) => ({
      id: row.id,
      atISO: row.at_iso,
      type: row.type,
      ref: row.ref,
      productID: row.product_id,
      qty: row.qty,
      detail: row.detail,
      dateISO: row.date_iso,
      unitPriceNgn: row.unit_price_ngn,
      valueNgn: row.value_ngn != null ? Number(row.value_ngn) : null,
    }));
}

export function getWipByProduct(db, branchScope = 'ALL') {
  const hasBb = hasColumn(db, 'wip_balances', 'branch_id');
  let rows;
  if (!hasBb) {
    rows = db.prepare(`SELECT * FROM wip_balances`).all();
  } else if (branchScope === 'ALL' || !branchScope) {
    rows = db.prepare(`SELECT * FROM wip_balances`).all();
  } else {
    rows = db
      .prepare(
        `SELECT * FROM wip_balances WHERE branch_id = ? OR branch_id IS NULL OR TRIM(COALESCE(branch_id,'')) = ''`
      )
      .all(branchScope);
  }
  const o = {};
  for (const r of rows) o[r.product_id] = r.qty;
  return o;
}

export function listDeliveries(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'deliveries', branchScope);
  return db
    .prepare(`SELECT * FROM deliveries WHERE 1=1${b.sql} ORDER BY id DESC`)
    .all(...b.args)
    .map((row) => {
      const lines = listDeliveryLinesForId(db, row.id);
      return {
        id: row.id,
        quotationRef: row.quotation_ref,
        customerID: row.customer_id ?? '',
        customer: row.customer_name,
        cuttingListId: row.cutting_list_id ?? '',
        destination: row.destination,
        method: row.method,
        status: row.status,
        trackingNo: row.tracking_no,
        shipDate: row.ship_date,
        eta: row.eta,
        deliveredDateISO: row.delivered_date_iso,
        podNotes: row.pod_notes,
        courierConfirmed: Boolean(row.courier_confirmed),
        customerSignedPod: Boolean(row.customer_signed_pod),
        fulfillmentPosted: Boolean(row.fulfillment_posted),
        lineCount: lines.length,
        totalQty: lines.reduce((sum, line) => sum + (Number(line.qty) || 0), 0),
        lines,
      };
    });
}

export function listSalesReceipts(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'sales_receipts', branchScope);
  return db
    .prepare(`SELECT * FROM sales_receipts WHERE 1=1${b.sql} ORDER BY date_iso DESC, id DESC`)
    .all(...b.args)
    .map((row) => ({
      id: row.id,
      customerID: row.customer_id,
      customer: row.customer_name,
      quotationRef: row.quotation_ref,
      date: row.date_label,
      dateISO: row.date_iso,
      amount: row.amount_display,
      amountNgn: row.amount_ngn,
      method: row.method,
      status: row.status,
      handledBy: row.handled_by,
      ledgerEntryId: row.ledger_entry_id ?? null,
      bankConfirmedAtISO: row.bank_confirmed_at_iso ?? null,
      bankConfirmedByUserId: row.bank_confirmed_by_user_id ?? null,
      bankReceivedAmountNgn:
        row.bank_received_amount_ngn != null ? Number(row.bank_received_amount_ngn) : null,
      financeDeliveryClearedAtISO: row.finance_delivery_cleared_at_iso ?? null,
      financeDeliveryClearedByUserId: row.finance_delivery_cleared_by_user_id ?? null,
    }));
}

function ngnListDisplay(n) {
  const v = Math.round(Number(n) || 0);
  return `₦${v.toLocaleString('en-NG')}`;
}

/**
 * Adds `cashReceivedNgn` (actual payment) while keeping `amountNgn` as quotation allocation for paid-AR math.
 * Updates `amount` label when cash exceeds allocation (overpayment split).
 * @param {object[]} receiptRows from listSalesReceipts
 * @param {object[]} ledgerEntries
 */
export function enrichSalesReceiptRowsWithCashFromLedger(receiptRows, ledgerEntries) {
  const rows = Array.isArray(receiptRows) ? receiptRows : [];
  if (!ledgerEntries?.length) {
    return rows.map((r) => ({
      ...r,
      cashReceivedNgn: Math.round(Number(r.amountNgn) || 0),
    }));
  }
  const companion = companionOverpayNgnByReceiptId(ledgerEntries);
  return rows.map((r) => {
    const alloc = Math.round(Number(r.amountNgn) || 0);
    const rid = String(r.id || '');
    const lid = r.ledgerEntryId != null ? String(r.ledgerEntryId) : '';
    const extra = companion.get(rid) || (lid ? companion.get(lid) : 0) || 0;
    const cash = Math.round(alloc + extra);
    const next = { ...r, cashReceivedNgn: cash };
    if (extra > 0) {
      next.quotationAllocatedNgn = alloc;
      next.amount = ngnListDisplay(cash);
    }
    return next;
  });
}

/** Advance deposits (ADVANCE_IN) mirrored at post time — query-friendly; balances still from ledger math. */
export function listAdvanceInEvents(db) {
  return db
    .prepare(`SELECT * FROM advance_in_events ORDER BY at_iso DESC, ledger_entry_id DESC`)
    .all()
    .map((row) => ({
      ledgerEntryId: row.ledger_entry_id,
      customerID: row.customer_id,
      customerName: row.customer_name,
      amountNgn: row.amount_ngn,
      atISO: row.at_iso,
      paymentMethod: row.payment_method,
      bankReference: row.bank_reference,
      purpose: row.purpose,
    }));
}

export function listCuttingLists(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'cutting_lists', branchScope);
  return db
    .prepare(`SELECT * FROM cutting_lists WHERE 1=1${b.sql} ORDER BY date_iso DESC`)
    .all(...b.args)
    .map((row) => mapCuttingListRow(db, row));
}

export function getCuttingList(db, id) {
  const row = db.prepare(`SELECT * FROM cutting_lists WHERE id = ?`).get(id);
  if (!row) return null;
  return mapCuttingListRow(db, row);
}

function fgAdjustmentTotalsByJobId(db, branchScope) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_completion_adjustments'`).get()) {
    return new Map();
  }
  const b = branchWhere(db, 'production_jobs', branchScope);
  const branchSql = b.sql ? b.sql.replace(/\bbranch_id\b/g, 'j.branch_id') : '';
  const rows = db
    .prepare(
      `SELECT a.job_id AS job_id, COALESCE(SUM(a.delta_finished_goods_m), 0) AS total
       FROM production_completion_adjustments a
       INNER JOIN production_jobs j ON j.job_id = a.job_id
       WHERE 1=1${branchSql}
       GROUP BY a.job_id`
    )
    .all(...b.args);
  const m = new Map();
  for (const r of rows) m.set(r.job_id, Number(r.total) || 0);
  return m;
}

export function listProductionJobs(db, branchScope = 'ALL') {
  const adjByJob = fgAdjustmentTotalsByJobId(db, branchScope);
  const b = branchWhere(db, 'production_jobs', branchScope);
  return db
    .prepare(`SELECT * FROM production_jobs WHERE 1=1${b.sql} ORDER BY created_at_iso DESC, job_id DESC`)
    .all(...b.args)
    .map((row) => {
      const baseActual = Number(row.actual_meters) || 0;
      const fgAdj = adjByJob.get(row.job_id) || 0;
      return {
        jobID: row.job_id,
        cuttingListId: row.cutting_list_id ?? '',
        quotationRef: row.quotation_ref ?? '',
        customerID: row.customer_id ?? '',
        customerName: row.customer_name ?? '',
        productID: row.product_id ?? '',
        productName: row.product_name ?? '',
        plannedMeters: Number(row.planned_meters) || 0,
        plannedSheets: Number(row.planned_sheets) || 0,
        machineName: row.machine_name ?? '',
        startDateISO: row.start_date_iso ?? '',
        endDateISO: row.end_date_iso ?? '',
        materialsNote: row.materials_note ?? '',
        status: row.status ?? 'Planned',
        createdAtISO: row.created_at_iso,
        completedAtISO: row.completed_at_iso ?? '',
        actualMeters: baseActual,
        fgAdjustmentMetersTotal: fgAdj,
        effectiveOutputMeters: baseActual + fgAdj,
        actualWeightKg: Number(row.actual_weight_kg) || 0,
        conversionAlertState: row.conversion_alert_state ?? 'Pending',
        managerReviewRequired: Boolean(row.manager_review_required),
        managerReviewSignedAtISO: row.manager_review_signed_at_iso ?? '',
        managerReviewSignedByUserId: row.manager_review_signed_by_user_id ?? '',
        managerReviewSignedByName: row.manager_review_signed_by_name ?? '',
        managerReviewRemark: row.manager_review_remark ?? '',
        operatorName: row.operator_name ?? '',
        branchId: row.branch_id ?? '',
        coilSpecMismatchPending: Boolean(row.coil_spec_mismatch_pending),
      };
    });
}

export function listProductionCompletionAdjustments(db, branchScope = 'ALL') {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_completion_adjustments'`).get()) {
    return [];
  }
  const b = branchWhere(db, 'production_jobs', branchScope);
  const branchSql = b.sql ? b.sql.replace(/\bbranch_id\b/g, 'j.branch_id') : '';
  const rows = db
    .prepare(
      `SELECT a.id AS id, a.job_id AS job_id, a.delta_finished_goods_m AS delta_finished_goods_m,
              a.note AS note, a.at_iso AS at_iso, a.created_by_user_id AS created_by_user_id,
              a.created_by_name AS created_by_name
       FROM production_completion_adjustments a
       INNER JOIN production_jobs j ON j.job_id = a.job_id
       WHERE 1=1${branchSql}
       ORDER BY a.at_iso DESC, a.id DESC`
    )
    .all(...b.args);
  return rows.map((row) => ({
    id: row.id,
    jobID: row.job_id,
    deltaFinishedGoodsM: Number(row.delta_finished_goods_m) || 0,
    note: row.note ?? '',
    atISO: row.at_iso ?? '',
    createdByUserId: row.created_by_user_id ?? '',
    createdByName: row.created_by_name ?? '',
  }));
}

export function listProductionJobAccessoryUsage(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'production_jobs', branchScope);
  const branchSql = b.sql ? b.sql.replace(/\bbranch_id\b/g, 'j.branch_id') : '';
  const rows = db
    .prepare(
      `SELECT u.id AS id, u.job_id AS job_id, u.quotation_ref AS quotation_ref, u.quote_line_id AS quote_line_id,
              u.name AS name, u.ordered_qty AS ordered_qty, u.supplied_qty AS supplied_qty,
              u.inventory_product_id AS inventory_product_id, u.posted_at_iso AS posted_at_iso
       FROM production_job_accessory_usage u
       INNER JOIN production_jobs j ON j.job_id = u.job_id
       WHERE 1=1${branchSql}
       ORDER BY u.posted_at_iso DESC`
    )
    .all(...b.args);
  return rows.map((row) => ({
    id: row.id,
    jobID: row.job_id,
    quotationRef: row.quotation_ref ?? '',
    quoteLineId: row.quote_line_id ?? '',
    name: row.name ?? '',
    orderedQty: Number(row.ordered_qty) || 0,
    suppliedQty: Number(row.supplied_qty) || 0,
    inventoryProductId: row.inventory_product_id ?? '',
    postedAtISO: row.posted_at_iso ?? '',
  }));
}

/** Receipts, cutting lists, and produced metres for the refund modal “Transaction Intelligence” panel. */
export function getRefundIntelligenceForQuotation(db, quotationRef, branchScope = 'ALL') {
  const ref = String(quotationRef || '').trim();
  if (!ref) {
    return {
      receipts: [],
      cuttingLists: [],
      summary: { producedMeters: 0, accessoriesSummary: { lines: [] } },
    };
  }
  const ledgerRows = listLedgerEntries(db, branchScope);
  const lb = branchWhere(db, 'ledger_entries', branchScope);
  const overpayRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM ledger_entries WHERE type = 'OVERPAY_ADVANCE' AND quotation_ref = ?${lb.sql}`
    )
    .get(ref, ...lb.args);
  const overpayAdvanceNgn = Math.round(Number(overpayRow?.s) || 0);
  const qb = branchWhere(db, 'quotations', branchScope);
  const qPaidRow = db
    .prepare(`SELECT paid_ngn FROM quotations WHERE id = ?${qb.sql}`)
    .get(ref, ...qb.args);
  const bookedOnQuotationNgn = Math.round(Number(qPaidRow?.paid_ngn) || 0);

  const receipts = enrichSalesReceiptRowsWithCashFromLedger(
    listSalesReceipts(db, branchScope).filter((r) => String(r.quotationRef || '').trim() === ref),
    ledgerRows
  ).map((r) => ({
    id: r.id,
    amountNgn: Math.round(Number(r.cashReceivedNgn ?? r.amountNgn) || 0),
  }));
  const cuttingLists = listCuttingLists(db, branchScope).filter(
    (cl) => String(cl.quotationRef || '').trim() === ref
  );
  const jobs = listProductionJobs(db, branchScope).filter(
    (j) => String(j.quotationRef || '').trim() === ref
  );
  const producedMeters = jobs.reduce(
    (sum, j) => sum + (Number(j.effectiveOutputMeters ?? j.actualMeters) || 0),
    0
  );
  const accLines = accessoryFulfillmentSummaryForQuotation(db, ref);
  return {
    receipts,
    cuttingLists,
    summary: {
      producedMeters,
      accessoriesSummary: { lines: accLines },
      overpayAdvanceNgn,
      bookedOnQuotationNgn,
      quotationCashInNgn: bookedOnQuotationNgn + overpayAdvanceNgn,
    },
  };
}

export function listRefunds(db, branchScope = 'ALL') {
  const payoutStmt = db.prepare(
    `SELECT tm.*, ta.name AS account_name
     FROM treasury_movements tm
     LEFT JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
     WHERE tm.source_kind = 'REFUND' AND tm.source_id = ?
     ORDER BY tm.posted_at_iso ASC, tm.id ASC`
  );
  const b = branchWhere(db, 'customer_refunds', branchScope);
  return db
    .prepare(`SELECT * FROM customer_refunds WHERE 1=1${b.sql} ORDER BY requested_at_iso DESC`)
    .all(...b.args)
    .map((row) => {
      let calculationLines = [];
      let suggestedLines = [];
      try {
        calculationLines = JSON.parse(row.calculation_lines_json || '[]');
      } catch {
        /* ignore */
      }
      try {
        suggestedLines = JSON.parse(row.suggested_lines_json || '[]');
      } catch {
        /* ignore */
      }
      let previewSnapshot = null;
      try {
        previewSnapshot = JSON.parse(row.preview_snapshot_json || 'null');
      } catch {
        previewSnapshot = null;
      }
      const approvedAmountNgn = row.approved_amount_ngn != null ? Number(row.approved_amount_ngn) || 0 : 0;
      const paidAmountNgn = Number(row.paid_amount_ngn) || 0;
      const finalApprovedAmountNgn =
        row.status === 'Approved' || row.status === 'Paid'
          ? approvedAmountNgn || Number(row.amount_ngn) || 0
          : approvedAmountNgn;
      const payoutHistory = payoutStmt.all(row.refund_id).map((movement) => ({
        id: movement.id,
        postedAtISO: movement.posted_at_iso,
        treasuryAccountId: movement.treasury_account_id,
        accountName: movement.account_name ?? '',
        amountNgn: Math.abs(Number(movement.amount_ngn) || 0),
        reference: movement.reference ?? '',
        note: movement.note ?? '',
      }));
      return {
        refundID: row.refund_id,
        customerID: row.customer_id,
        customer: row.customer_name,
        quotationRef: row.quotation_ref,
        cuttingListRef: row.cutting_list_ref,
        product: row.product,
        reasonCategory: row.reason_category,
        reason: row.reason,
        amountNgn: row.amount_ngn,
        calculationLines,
        suggestedLines,
        previewSnapshot,
        calculationNotes: row.calculation_notes,
        status: row.status,
        requestedBy: row.requested_by,
        requestedAtISO: row.requested_at_iso,
        approvalDate: row.approval_date,
        approvedBy: row.approved_by,
        approvedAmountNgn: finalApprovedAmountNgn,
        managerComments: row.manager_comments,
        paidAmountNgn,
        paidAtISO: row.paid_at_iso,
        paidBy: row.paid_by,
        paymentNote: row.payment_note ?? '',
        payoutHistory,
        branchId: row.branch_id ?? '',
      };
    });
}

export function listTreasuryAccounts(db) {
  return db
    .prepare(`SELECT * FROM treasury_accounts ORDER BY id`)
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      bankName: row.bank_name,
      balance: row.balance,
      type: row.type,
      accNo: row.acc_no,
    }));
}

export function listTreasuryMovements(db) {
  return db
    .prepare(
      `SELECT tm.*, ta.name AS account_name, ta.type AS account_type, ta.acc_no AS account_no
       FROM treasury_movements tm
       LEFT JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
       ORDER BY tm.posted_at_iso DESC, tm.id DESC`
    )
    .all()
    .map((row) => ({
      id: row.id,
      postedAtISO: row.posted_at_iso,
      type: row.type,
      treasuryAccountId: row.treasury_account_id,
      accountName: row.account_name ?? '',
      accountType: row.account_type ?? '',
      accountNo: row.account_no ?? '',
      amountNgn: row.amount_ngn,
      reference: row.reference ?? '',
      counterpartyKind: row.counterparty_kind ?? '',
      counterpartyId: row.counterparty_id ?? '',
      counterpartyName: row.counterparty_name ?? '',
      sourceKind: row.source_kind ?? '',
      sourceId: row.source_id ?? '',
      note: row.note ?? '',
      createdBy: row.created_by ?? '',
      reversesMovementId: row.reverses_movement_id ?? '',
      batchId: row.batch_id ?? '',
    }));
}

export function listExpenses(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'expenses', branchScope);
  return db
    .prepare(`SELECT * FROM expenses WHERE 1=1${b.sql} ORDER BY date DESC`)
    .all(...b.args)
    .map((row) => ({
      expenseID: row.expense_id,
      expenseType: row.expense_type,
      amountNgn: row.amount_ngn,
      date: row.date,
      category: row.category,
      paymentMethod: row.payment_method,
      reference: row.reference,
      branchId: row.branch_id ?? '',
    }));
}

export function listPaymentRequests(db, branchScope = 'ALL') {
  const useScope = branchScope !== 'ALL' && String(branchScope || '').trim();
  const scopeSql = useScope ? ` AND (e.branch_id = ? OR e.branch_id IS NULL)` : '';
  const scopeArgs = useScope ? [branchScope] : [];
  return db
    .prepare(
      `SELECT pr.*, e.branch_id AS expense_branch_id, e.category AS expense_category, e.reference AS expense_reference,
              hr.user_id AS staff_user_id, u.display_name AS staff_display_name
       FROM payment_requests pr
       LEFT JOIN expenses e ON e.expense_id = pr.expense_id
       LEFT JOIN hr_requests hr ON hr.id = e.reference
       LEFT JOIN app_users u ON u.id = hr.user_id
       WHERE 1=1${scopeSql}
       ORDER BY pr.request_date DESC`
    )
    .all(...scopeArgs)
    .map((row) => {
      const b64 = row.attachment_data_b64;
      const hasAttachment = Boolean(b64 && String(b64).length > 0);
      return {
        requestID: row.request_id,
        expenseID: row.expense_id,
        amountRequestedNgn: row.amount_requested_ngn,
        requestDate: row.request_date,
        approvalStatus: row.approval_status,
        description: row.description,
        approvedBy: row.approved_by ?? '',
        approvedAtISO: row.approved_at_iso ?? '',
        approvalNote: row.approval_note ?? '',
        paidAmountNgn: row.paid_amount_ngn ?? 0,
        paidAtISO: row.paid_at_iso ?? '',
        paidBy: row.paid_by ?? '',
        paymentNote: row.payment_note ?? '',
        branchId: row.expense_branch_id ?? '',
        expenseCategory: row.expense_category ?? '',
        isStaffLoan: String(row.expense_category || '').toLowerCase().includes('staff loan'),
        hrRequestId: row.expense_reference ?? '',
        staffUserId: row.staff_user_id ?? '',
        staffDisplayName: row.staff_display_name ?? '',
        requestReference: row.request_reference ?? '',
        lineItems: parsePaymentRequestLineItemsJson(row.line_items_json),
        attachmentName: row.attachment_name ?? '',
        attachmentMime: row.attachment_mime ?? '',
        attachmentPresent: hasAttachment,
      };
    });
}

/** Single payment request for approval/detail UIs (no attachment bytes). */
export function getPaymentRequestDetail(db, requestId) {
  const rid = String(requestId || '').trim();
  if (!rid) return null;
  const row = db
    .prepare(
      `SELECT pr.*, e.branch_id AS expense_branch_id, e.category AS expense_category, e.reference AS expense_reference,
              hr.user_id AS staff_user_id, u.display_name AS staff_display_name
       FROM payment_requests pr
       LEFT JOIN expenses e ON e.expense_id = pr.expense_id
       LEFT JOIN hr_requests hr ON hr.id = e.reference
       LEFT JOIN app_users u ON u.id = hr.user_id
       WHERE pr.request_id = ?`
    )
    .get(rid);
  if (!row) return null;
  const b64 = row.attachment_data_b64;
  const hasAttachment = Boolean(b64 && String(b64).length > 0);
  return {
    requestID: row.request_id,
    expenseID: row.expense_id,
    amountRequestedNgn: row.amount_requested_ngn,
    requestDate: row.request_date,
    approvalStatus: row.approval_status,
    description: row.description,
    approvedBy: row.approved_by ?? '',
    approvedAtISO: row.approved_at_iso ?? '',
    approvalNote: row.approval_note ?? '',
    paidAmountNgn: row.paid_amount_ngn ?? 0,
    paidAtISO: row.paid_at_iso ?? '',
    paidBy: row.paid_by ?? '',
    paymentNote: row.payment_note ?? '',
    branchId: row.expense_branch_id ?? '',
    expenseCategory: row.expense_category ?? '',
    isStaffLoan: String(row.expense_category || '').toLowerCase().includes('staff loan'),
    hrRequestId: row.expense_reference ?? '',
    staffUserId: row.staff_user_id ?? '',
    staffDisplayName: row.staff_display_name ?? '',
    requestReference: row.request_reference ?? '',
    lineItems: parsePaymentRequestLineItemsJson(row.line_items_json),
    attachmentName: row.attachment_name ?? '',
    attachmentMime: row.attachment_mime ?? '',
    attachmentPresent: hasAttachment,
  };
}

/** Full refund row for review/detail UIs. */
export function getCustomerRefundDetail(db, refundId) {
  const id = String(refundId || '').trim();
  if (!id) return null;
  return db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id) || null;
}

export function listAccountsPayable(db, branchScope = 'ALL') {
  const b = branchPredicate(db, 'purchase_orders', branchScope, 'po');
  return db
    .prepare(
      `SELECT ap.*, po.branch_id AS po_branch_id FROM accounts_payable ap
       LEFT JOIN purchase_orders po ON po.po_id = ap.po_ref
       WHERE 1=1${b.sql}
       ORDER BY ap.due_date_iso DESC`
    )
    .all(...b.args)
    .map((row) => ({
      apID: row.ap_id,
      supplierName: row.supplier_name,
      poRef: row.po_ref,
      invoiceRef: row.invoice_ref,
      amountNgn: row.amount_ngn,
      paidNgn: row.paid_ngn,
      dueDateISO: row.due_date_iso,
      paymentMethod: row.payment_method,
      branchId: row.po_branch_id ?? '',
    }));
}

export function listBankReconciliation(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'bank_reconciliation_lines', branchScope);
  return db
    .prepare(`SELECT * FROM bank_reconciliation_lines WHERE 1=1${b.sql} ORDER BY bank_date_iso DESC`)
    .all(...b.args)
    .map((row) => ({
      id: row.id,
      bankDateISO: row.bank_date_iso,
      description: row.description,
      amountNgn: row.amount_ngn,
      systemMatch: row.system_match,
      status: row.status,
      branchId: row.branch_id || '',
      settledAmountNgn: row.settled_amount_ngn ?? null,
      matchedSystemAmountNgn: row.matched_system_amount_ngn ?? null,
      varianceNgn: row.variance_ngn ?? null,
      variancePercent: row.variance_percent ?? null,
      treasuryAccountId: row.treasury_account_id ?? null,
      treasuryAdjustmentMovementId: row.treasury_adjustment_movement_id ?? null,
      managerClearedAtISO: row.manager_cleared_at_iso ?? null,
      managerClearedByUserId: row.manager_cleared_by_user_id ?? null,
      managerClearedByName: row.manager_cleared_by_name ?? null,
    }));
}

export function listCoilRequests(db) {
  return db
    .prepare(`SELECT * FROM coil_requests ORDER BY created_at_iso DESC`)
    .all()
    .map((row) => ({
      id: row.id,
      status: row.status,
      createdAtISO: row.created_at_iso,
      acknowledgedAtISO: row.acknowledged_at_iso,
      branchId: row.branch_id ?? '',
      requestedByUserId: row.requested_by_user_id ?? '',
      requestedByDisplay: row.requested_by_display ?? '',
      gauge: row.gauge,
      colour: row.colour,
      materialType: row.material_type,
      requestedKg: row.requested_kg,
      note: row.note,
      workItemId: row.work_item_id ?? '',
      materialRequestId: row.material_request_id ?? '',
    }));
}

export function listYardCoils(db) {
  return db
    .prepare(`SELECT * FROM yard_coils ORDER BY id`)
    .all()
    .map((row) => ({
      id: row.id,
      colour: row.colour,
      gaugeLabel: row.gauge_label,
      materialType: row.material_type,
      weightKg: row.weight_kg,
      loc: row.loc,
    }));
}

export function listProcurementCatalog(db) {
  return db
    .prepare(`SELECT * FROM procurement_catalog ORDER BY id`)
    .all()
    .map((row) => ({
      id: row.id,
      color: row.color,
      gauge: row.gauge,
      productID: row.product_id,
      offerKg: row.offer_kg,
      offerMeters: row.offer_meters,
      conversionKgPerM: row.conversion_kg_per_m,
      label: row.label,
    }));
}

export function listAppUsers(db) {
  return db
    .prepare(`SELECT * FROM app_users ORDER BY display_name COLLATE NOCASE, username COLLATE NOCASE`)
    .all()
    .map((row) => {
      const u = publicUserFromRow(row);
      const rawJson = row.permissions_json ?? row.permissionsJson;
      let hasCustomPermissions = false;
      if (rawJson && String(rawJson).trim()) {
        try {
          const p = JSON.parse(rawJson);
          hasCustomPermissions = Array.isArray(p);
        } catch {
          /* ignore */
        }
      }
      return {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        email: u.email && String(u.email).trim() ? String(u.email).trim().toLowerCase() : '',
        roleKey: u.roleKey,
        department: u.department,
        status: u.status,
        permissions: u.permissions,
        hasCustomPermissions,
        lastLoginAtISO: u.lastLoginAtISO || '',
        createdAtISO: u.createdAtISO || row.created_at_iso || '',
      };
    });
}

export function listPeriodLocks(db) {
  return db
    .prepare(`SELECT * FROM accounting_period_locks ORDER BY period_key DESC`)
    .all()
    .map((row) => ({
      periodKey: row.period_key,
      lockedFromISO: row.locked_from_iso,
      lockedAtISO: row.locked_at_iso,
      lockedByUserId: row.locked_by_user_id ?? '',
      lockedByName: row.locked_by_name ?? '',
      reason: row.reason ?? '',
    }));
}

export function listApprovalActions(db, limit = 120) {
  return db
    .prepare(`SELECT * FROM approval_actions ORDER BY acted_at_iso DESC, id DESC LIMIT ?`)
    .all(limit)
    .map((row) => ({
      id: row.id,
      entityKind: row.entity_kind,
      entityId: row.entity_id,
      action: row.action,
      status: row.status,
      note: row.note ?? '',
      actedAtISO: row.acted_at_iso,
      actedByUserId: row.acted_by_user_id ?? '',
      actedByName: row.acted_by_name ?? '',
    }));
}

export function listAuditLog(db, limit = 120) {
  return db
    .prepare(`SELECT * FROM audit_log ORDER BY occurred_at_iso DESC, id DESC LIMIT ?`)
    .all(limit)
    .map((row) => {
      let details = null;
      try {
        details = row.details_json ? JSON.parse(row.details_json) : null;
      } catch {
        details = null;
      }
      return {
        id: row.id,
        occurredAtISO: row.occurred_at_iso,
        actorUserId: row.actor_user_id ?? '',
        actorName: row.actor_name ?? '',
        action: row.action,
        entityKind: row.entity_kind ?? '',
        entityId: row.entity_id ?? '',
        status: row.status,
        note: row.note ?? '',
        details,
      };
    });
}

/** Chronological export rows for compliance download (cap for safety). */
export function listAuditLogNdjsonRows(db, maxRows = 250000) {
  return db
    .prepare(`SELECT * FROM audit_log ORDER BY occurred_at_iso ASC, id ASC LIMIT ?`)
    .all(maxRows)
    .map((row) => ({
      id: row.id,
      occurredAtISO: row.occurred_at_iso,
      actorUserId: row.actor_user_id ?? '',
      actorName: row.actor_name ?? '',
      action: row.action,
      entityKind: row.entity_kind ?? '',
      entityId: row.entity_id ?? '',
      status: row.status,
      note: row.note ?? '',
      detailsJson: row.details_json ?? null,
    }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string | import('./branchScope.js').BranchScope} [branchScope]
 */
export function computeProductionMetricsRollup(db, branchScope = 'ALL') {
  const b = branchWhere(db, 'production_jobs', branchScope);
  const rows = db
    .prepare(
      `SELECT status,
              COALESCE(SUM(planned_meters), 0) AS planned_m,
              COALESCE(SUM(actual_meters), 0) AS actual_m,
              COUNT(*) AS cnt
         FROM production_jobs WHERE 1=1${b.sql}
         GROUP BY status`
    )
    .all(...b.args);
  const byStatus = {};
  let totalPlannedMeters = 0;
  let totalActualMeters = 0;
  let completedActualMeters = 0;
  let jobCount = 0;
  for (const r of rows) {
    const st = String(r.status || 'Unknown');
    const pm = Number(r.planned_m) || 0;
    const am = Number(r.actual_m) || 0;
    const cnt = Number(r.cnt) || 0;
    byStatus[st] = { count: cnt, plannedMeters: pm, actualMeters: am };
    totalPlannedMeters += pm;
    totalActualMeters += am;
    jobCount += cnt;
    if (st === 'Completed') completedActualMeters += am;
  }
  return {
    jobCount,
    byStatus,
    totalPlannedMeters,
    totalActualMeters,
    completedActualMeters,
  };
}

const OPS_STALE_PLANNED_DAYS = 5;
const OPS_STALE_RUNNING_DAYS = 4;
const OPS_ATTENTION_SAMPLES = 10;

function dayIsoFromTimestamp(raw) {
  const t = String(raw || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
}

function ageUtcDaysFromDayIso(dayIso) {
  if (!dayIso) return 0;
  const t0 = Date.UTC(
    Number(dayIso.slice(0, 4)),
    Number(dayIso.slice(5, 7)) - 1,
    Number(dayIso.slice(8, 10))
  );
  const now = new Date();
  const t1 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((t1 - t0) / 86400000));
}

function mapProductionAttentionSample(row, kind) {
  const anchorRaw = kind === 'runningStale' ? row.start_date_iso : row.created_at_iso;
  const day = dayIsoFromTimestamp(anchorRaw) || dayIsoFromTimestamp(row.created_at_iso);
  return {
    kind,
    jobID: row.job_id,
    cuttingListId: row.cutting_list_id ?? '',
    customerName: row.customer_name ?? '',
    quotationRef: row.quotation_ref ?? '',
    status: row.status ?? '',
    anchorDayISO: day,
    ageDays: ageUtcDaysFromDayIso(day),
  };
}

/** Empty payload when user cannot read production snapshot (matches bootstrap guard). */
export function emptyOperationsInventoryAttention() {
  return {
    ok: true,
    thresholds: { stalePlannedDays: OPS_STALE_PLANNED_DAYS, staleRunningDays: OPS_STALE_RUNNING_DAYS },
    stuckProductionAttentionDistinctJobCount: 0,
    stuckProduction: {
      plannedWithoutCoils: { count: 0, samples: [] },
      plannedStale: { count: 0, samples: [] },
      runningStale: { count: 0, samples: [] },
      managerReviewOpen: { count: 0, samples: [] },
      coilSpecMismatchPending: { count: 0, samples: [] },
    },
    inventoryChain: {
      wipProductsNonZero: 0,
      completionAdjustmentsLast30d: 0,
      deliveriesInProgress: { count: 0, samples: [] },
    },
    crossModule: {
      partialPurchaseOrderCount: 0,
      openInTransitLoadCount: 0,
    },
  };
}

/**
 * Branch-scoped “hygiene” signals for production + inventory + procurement hand-offs.
 * Intended for bootstrap (small JSON) and Operations attention UI — keep queries bounded.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string | import('./branchScope.js').BranchScope} [branchScope]
 */
export function computeOperationsInventoryAttention(db, branchScope = 'ALL') {
  const empty = () => emptyOperationsInventoryAttention();
  try {
    const b = branchWhere(db, 'production_jobs', branchScope);
    const plannedMod = `-${OPS_STALE_PLANNED_DAYS} days`;
    const runningMod = `-${OPS_STALE_RUNNING_DAYS} days`;

    const plannedNoCoilCount =
      Number(
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM production_jobs j
             WHERE j.status = 'Planned'
               AND NOT EXISTS (SELECT 1 FROM production_job_coils c WHERE c.job_id = j.job_id)
               AND 1=1${b.sql}`
          )
          .get(...b.args)?.c
      ) || 0;

    const plannedNoCoilRows = db
      .prepare(
        `SELECT j.job_id, j.cutting_list_id, j.customer_name, j.quotation_ref, j.created_at_iso, j.start_date_iso, j.status
           FROM production_jobs j
          WHERE j.status = 'Planned'
            AND NOT EXISTS (SELECT 1 FROM production_job_coils c WHERE c.job_id = j.job_id)
            AND 1=1${b.sql}
          ORDER BY datetime(COALESCE(j.created_at_iso, '')) ASC, j.job_id ASC
          LIMIT ?`
      )
      .all(...b.args, OPS_ATTENTION_SAMPLES);

    const plannedStaleCount =
      Number(
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM production_jobs j
             WHERE j.status = 'Planned'
               AND date(j.created_at_iso) <= date('now', ?)
               AND 1=1${b.sql}`
          )
          .get(plannedMod, ...b.args)?.c
      ) || 0;

    const plannedStaleRows = db
      .prepare(
        `SELECT j.job_id, j.cutting_list_id, j.customer_name, j.quotation_ref, j.created_at_iso, j.start_date_iso, j.status
           FROM production_jobs j
          WHERE j.status = 'Planned'
            AND date(j.created_at_iso) <= date('now', ?)
            AND 1=1${b.sql}
          ORDER BY datetime(COALESCE(j.created_at_iso, '')) ASC, j.job_id ASC
          LIMIT ?`
      )
      .all(plannedMod, ...b.args, OPS_ATTENTION_SAMPLES);

    const runningStaleCount =
      Number(
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM production_jobs j
             WHERE j.status = 'Running'
               AND TRIM(IFNULL(j.start_date_iso,'')) != ''
               AND date(j.start_date_iso) <= date('now', ?)
               AND 1=1${b.sql}`
          )
          .get(runningMod, ...b.args)?.c
      ) || 0;

    const runningStaleRows = db
      .prepare(
        `SELECT j.job_id, j.cutting_list_id, j.customer_name, j.quotation_ref, j.created_at_iso, j.start_date_iso, j.status
           FROM production_jobs j
          WHERE j.status = 'Running'
            AND TRIM(IFNULL(j.start_date_iso,'')) != ''
            AND date(j.start_date_iso) <= date('now', ?)
            AND 1=1${b.sql}
          ORDER BY datetime(COALESCE(j.start_date_iso, j.created_at_iso, '')) ASC, j.job_id ASC
          LIMIT ?`
      )
      .all(runningMod, ...b.args, OPS_ATTENTION_SAMPLES);

    const mgrOpenCount =
      Number(
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM production_jobs j
             WHERE j.status IN ('Planned','Running')
               AND j.manager_review_required = 1
               AND 1=1${b.sql}`
          )
          .get(...b.args)?.c
      ) || 0;

    const mgrOpenRows = db
      .prepare(
        `SELECT j.job_id, j.cutting_list_id, j.customer_name, j.quotation_ref, j.created_at_iso, j.start_date_iso, j.status
           FROM production_jobs j
          WHERE j.status IN ('Planned','Running')
            AND j.manager_review_required = 1
            AND 1=1${b.sql}
          ORDER BY datetime(COALESCE(j.created_at_iso, '')) DESC, j.job_id DESC
          LIMIT ?`
      )
      .all(...b.args, OPS_ATTENTION_SAMPLES);

    const specMismatchCount =
      Number(
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM production_jobs j
             WHERE j.status IN ('Planned','Running')
               AND j.coil_spec_mismatch_pending = 1
               AND 1=1${b.sql}`
          )
          .get(...b.args)?.c
      ) || 0;

    const specMismatchRows = db
      .prepare(
        `SELECT j.job_id, j.cutting_list_id, j.customer_name, j.quotation_ref, j.created_at_iso, j.start_date_iso, j.status
           FROM production_jobs j
          WHERE j.status IN ('Planned','Running')
            AND j.coil_spec_mismatch_pending = 1
            AND 1=1${b.sql}
          ORDER BY j.job_id DESC
          LIMIT ?`
      )
      .all(...b.args, OPS_ATTENTION_SAMPLES);

    const distinctStuck =
      Number(
        db
          .prepare(
            `SELECT COUNT(DISTINCT j.job_id) AS c FROM production_jobs j
             WHERE j.status IN ('Planned','Running')
               AND 1=1${b.sql}
               AND (
                 (j.status = 'Planned' AND NOT EXISTS (SELECT 1 FROM production_job_coils c WHERE c.job_id = j.job_id))
                 OR (j.status = 'Planned' AND date(j.created_at_iso) <= date('now', ?))
                 OR (j.status = 'Running' AND TRIM(IFNULL(j.start_date_iso,'')) != ''
                     AND date(j.start_date_iso) <= date('now', ?))
                 OR j.manager_review_required = 1
                 OR j.coil_spec_mismatch_pending = 1
               )`
          )
          .get(plannedMod, runningMod, ...b.args)?.c
      ) || 0;

    let wipProductsNonZero = 0;
    if (hasColumn(db, 'wip_balances', 'branch_id')) {
      const bw = branchWhere(db, 'wip_balances', branchScope);
      wipProductsNonZero =
        Number(
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM wip_balances WHERE ABS(COALESCE(qty,0)) > 0.0001 AND 1=1${bw.sql}`
            )
            .get(...bw.args)?.c
        ) || 0;
    }

    let completionAdjustmentsLast30d = 0;
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_completion_adjustments'`).get()) {
      const ba = branchWhere(db, 'production_jobs', branchScope);
      const branchSqlA = ba.sql ? ba.sql.replace(/\bbranch_id\b/g, 'j.branch_id') : '';
      completionAdjustmentsLast30d =
        Number(
          db
            .prepare(
              `SELECT COUNT(*) AS c
                 FROM production_completion_adjustments a
                 INNER JOIN production_jobs j ON j.job_id = a.job_id
                WHERE date(a.at_iso) >= date('now', '-30 day')
                  AND 1=1${branchSqlA}`
            )
            .get(...ba.args)?.c
        ) || 0;
    }

    const bd = branchWhere(db, 'deliveries', branchScope);
    const deliveriesInProgressCount =
      Number(
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM deliveries d
              WHERE LOWER(TRIM(IFNULL(d.status,''))) NOT IN ('delivered','cancelled','void')
                AND 1=1${bd.sql}`
          )
          .get(...bd.args)?.c
      ) || 0;

    const deliveriesInProgressRows = db
      .prepare(
        `SELECT d.id, d.cutting_list_id, d.customer_name, d.status, d.ship_date, d.eta
           FROM deliveries d
          WHERE LOWER(TRIM(IFNULL(d.status,''))) NOT IN ('delivered','cancelled','void')
            AND 1=1${bd.sql}
          ORDER BY datetime(COALESCE(d.ship_date, d.eta, '')) DESC, d.id DESC
          LIMIT ?`
      )
      .all(...bd.args, OPS_ATTENTION_SAMPLES);

    const bpo = branchWhere(db, 'purchase_orders', branchScope);
    const partialPurchaseOrderCount =
      Number(
        db
          .prepare(
            `SELECT COUNT(DISTINCT po.po_id) AS c
               FROM purchase_orders po
               INNER JOIN purchase_order_lines l ON l.po_id = po.po_id
              WHERE LOWER(TRIM(IFNULL(po.status,''))) NOT IN ('cancelled','void','draft','rejected')
                AND (IFNULL(l.qty_received,0) + 0.001) < IFNULL(l.qty_ordered,0)
                AND 1=1${bpo.sql}`
          )
          .get(...bpo.args)?.c
      ) || 0;

    const inLoads = listInTransitLoads(db, branchScope);
    const openInTransitLoadCount = inLoads.filter((x) => {
      const s = String(x.status || '').trim().toLowerCase();
      if (!s) return true;
      return !['received', 'closed', 'cancelled', 'complete', 'completed'].includes(s);
    }).length;

    return {
      ok: true,
      thresholds: { stalePlannedDays: OPS_STALE_PLANNED_DAYS, staleRunningDays: OPS_STALE_RUNNING_DAYS },
      stuckProductionAttentionDistinctJobCount: distinctStuck,
      stuckProduction: {
        plannedWithoutCoils: {
          count: plannedNoCoilCount,
          samples: plannedNoCoilRows.map((r) => mapProductionAttentionSample(r, 'plannedWithoutCoils')),
        },
        plannedStale: {
          count: plannedStaleCount,
          samples: plannedStaleRows.map((r) => mapProductionAttentionSample(r, 'plannedStale')),
        },
        runningStale: {
          count: runningStaleCount,
          samples: runningStaleRows.map((r) => mapProductionAttentionSample(r, 'runningStale')),
        },
        managerReviewOpen: {
          count: mgrOpenCount,
          samples: mgrOpenRows.map((r) => mapProductionAttentionSample(r, 'managerReviewOpen')),
        },
        coilSpecMismatchPending: {
          count: specMismatchCount,
          samples: specMismatchRows.map((r) => mapProductionAttentionSample(r, 'coilSpecMismatch')),
        },
      },
      inventoryChain: {
        wipProductsNonZero,
        completionAdjustmentsLast30d,
        deliveriesInProgress: {
          count: deliveriesInProgressCount,
          samples: deliveriesInProgressRows.map((row) => ({
            id: row.id,
            cuttingListId: row.cutting_list_id ?? '',
            customerName: row.customer_name ?? '',
            status: row.status ?? '',
            shipDate: row.ship_date ?? '',
            eta: row.eta ?? '',
          })),
        },
      },
      crossModule: {
        partialPurchaseOrderCount,
        openInTransitLoadCount,
      },
    };
  } catch (e) {
    console.error('[zarewa] computeOperationsInventoryAttention', e);
    return empty();
  }
}

/**
 * Branch-scoped aggregate counts for reports (no row payloads).
 * @param {import('better-sqlite3').Database} db
 * @param {string | import('./branchScope.js').BranchScope} [branchScope]
 */
export function workspaceReportAggregateCounts(db, branchScope = 'ALL') {
  const countWhere = (table) => {
    const b = branchWhere(db, table, branchScope);
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE 1=1${b.sql}`).get(...b.args);
    return Number(row?.c) || 0;
  };
  const countAll = (table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c) || 0;
  return {
    customersTotal: countAll('customers'),
    suppliersTotal: countAll('suppliers'),
    productsTotal: countAll('products'),
    quotationsTotal: countWhere('quotations'),
    receiptsTotal: countWhere('sales_receipts'),
    purchaseOrdersTotal: countWhere('purchase_orders'),
    deliveriesTotal: countWhere('deliveries'),
    cuttingListsTotal: countWhere('cutting_lists'),
    ledgerEntriesTotal: countWhere('ledger_entries'),
    refundsTotal: countWhere('customer_refunds'),
    expensesTotal: countWhere('expenses'),
    productionJobsTotal: countWhere('production_jobs'),
    coilLotsTotal: countWhere('coil_lots'),
    stockMovementsTotal: countWhere('stock_movements'),
    treasuryMovementsTotal: countAll('treasury_movements'),
  };
}

/**
 * Dashboard-only payload: aggregates + small recent slices.
 * Keep this fast and stable for caching.
 * @param {import('better-sqlite3').Database} db
 * @param {string | import('./branchScope.js').BranchScope} [branchScope]
 * @param {{ recentLimit?: number }} [opts]
 */
export function dashboardSummary(db, branchScope = 'ALL', opts = {}) {
  const recentLimit = Math.max(1, Math.min(100, Number(opts.recentLimit) || 12));
  const counts = workspaceReportAggregateCounts(db, branchScope);
  const productionMetrics = computeProductionMetricsRollup(db, branchScope);

  const rq = branchWhere(db, 'quotations', branchScope);
  const recentQuotations = db
    .prepare(`SELECT id, customer_id, customer_name, date_iso, total_ngn, status FROM quotations WHERE 1=1${rq.sql} ORDER BY date_iso DESC, id DESC LIMIT ?`)
    .all(...rq.args, recentLimit)
    .map((row) => ({
      id: row.id,
      customerID: row.customer_id ?? '',
      customer: row.customer_name ?? '',
      dateISO: row.date_iso ?? '',
      totalNgn: Number(row.total_ngn) || 0,
      status: row.status ?? '',
    }));

  const rr = branchWhere(db, 'sales_receipts', branchScope);
  const recentReceipts = db
    .prepare(
      `SELECT id, customer_id, customer_name, quotation_ref, date_iso, amount_ngn, method, status
         FROM sales_receipts WHERE 1=1${rr.sql}
         ORDER BY date_iso DESC, id DESC
         LIMIT ?`
    )
    .all(...rr.args, recentLimit)
    .map((row) => ({
      id: row.id,
      customerID: row.customer_id ?? '',
      customer: row.customer_name ?? '',
      quotationRef: row.quotation_ref ?? '',
      dateISO: row.date_iso ?? '',
      amountNgn: Number(row.amount_ngn) || 0,
      method: row.method ?? '',
      status: row.status ?? '',
    }));

  return {
    ok: true,
    branchScope,
    counts,
    productionMetrics,
    recent: {
      quotations: recentQuotations,
      receipts: recentReceipts,
    },
  };
}

/**
 * Org-wide aggregates for executive (CEO) dashboard — no row payloads.
 * @param {import('better-sqlite3').Database} db
 */
export function execOrgSummary(db) {
  const counts = workspaceReportAggregateCounts(db, 'ALL');
  const productionMetrics = computeProductionMetricsRollup(db, 'ALL');

  let payrollDraftsAwaitingMd = 0;
  try {
    payrollDraftsAwaitingMd =
      Number(
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM hr_payroll_runs
             WHERE LOWER(TRIM(IFNULL(status,''))) = 'draft'
               AND (md_approved_at_iso IS NULL OR TRIM(IFNULL(md_approved_at_iso,'')) = '')`
          )
          .get()?.c
      ) || 0;
  } catch {
    /* HR tables or MD column not present */
  }

  let bankReconciliationLinesInReview = 0;
  try {
    bankReconciliationLinesInReview =
      Number(
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM bank_reconciliation_lines
             WHERE TRIM(IFNULL(status,'')) IN ('Review', 'PendingManager')`
          )
          .get()?.c
      ) || 0;
  } catch {
    /* table missing in minimal test DBs */
  }

  const pendingRefunds =
    Number(
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM customer_refunds WHERE TRIM(LOWER(IFNULL(status,''))) IN ('pending','submitted','awaiting approval')`
        )
        .get()?.c
    ) || 0;
  const pendingPaymentRequests =
    Number(
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM payment_requests WHERE TRIM(IFNULL(approval_status,'')) IN ('Pending','Submitted','Awaiting approval','')`
        )
        .get()?.c
    ) || 0;
  const branches = listBranches(db).map((b) => ({ id: b.id, name: b.name ?? b.id }));
  return {
    ok: true,
    generatedAtISO: new Date().toISOString(),
    branches,
    counts,
    productionMetrics,
    pendingRefunds,
    pendingPaymentRequests,
    payrollDraftsAwaitingMd,
    bankReconciliationLinesInReview,
  };
}

export function getJsonBlob(db, key) {
  const row = db.prepare(`SELECT payload FROM app_json_blobs WHERE key = ?`).get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

export function setJsonBlob(db, key, value) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  db.prepare(`INSERT OR REPLACE INTO app_json_blobs (key, payload) VALUES (?,?)`).run(key, payload);
}

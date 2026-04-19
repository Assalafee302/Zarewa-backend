import { CUSTOMERS_SEED, QUOTATIONS_SEED } from './seedData.js';
import {
  SUPPLIERS_SEED,
  TRANSPORT_AGENTS_SEED,
  PRODUCTS_SEED,
  PURCHASE_ORDERS_SEED,
  DELIVERIES_SEED,
  SALES_RECEIPTS_SEED,
  CUTTING_LISTS_SEED,
  REFUNDS_SEED,
  TREASURY_SEED,
  EXPENSES_SEED,
  PAYMENT_REQUESTS_SEED,
  ACCOUNTS_PAYABLE_SEED,
  BANK_RECONCILIATION_SEED,
  PROCUREMENT_CATALOG_SEED,
  YARD_COILS_SEED,
  AVAILABLE_STOCK_SEED,
  CUSTOMER_DASHBOARD_SEED,
} from './seedExtra.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { seedAuthUsers } from './auth.js';
import { seedMasterData } from './masterData.js';
import { seedProductionLineDemo } from './seedProductionLineDemo.js';
import { seedHrIfEmpty } from './hrOps.js';
import { isEmptySeedMode, seedEmptyClientMinimal } from './emptySeed.js';

/**
 * Idempotent seed: fills empty tables. Safe on existing DBs after migrations.
 * @param {import('better-sqlite3').Database} db
 */
export function seedEverything(db) {
  seedAuthUsers(db);
  seedMasterData(db);

  if (isEmptySeedMode()) {
    seedEmptyClientMinimal(db);
    seedHrIfEmpty(db);
    return;
  }

  const custCount = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
  if (custCount === 0) {
    const insC = db.prepare(`
      INSERT INTO customers (
        customer_id, name, phone_number, email, address_shipping, address_billing,
        status, tier, payment_terms, created_by, created_at_iso, last_activity_iso,
        company_name, lead_source, preferred_contact, follow_up_iso, crm_tags_json, crm_profile_notes, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insQ = db.prepare(`
      INSERT INTO quotations (
        id, customer_id, customer_name, date_label, date_iso, due_date_iso,
        total_display, total_ngn, paid_ngn, payment_status, status, approval_date, customer_feedback, handled_by,
        project_name, lines_json, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    db.transaction(() => {
      for (const c of CUSTOMERS_SEED) {
        const tagsJson = JSON.stringify(
          Array.isArray(c.crmTags) ? c.crmTags : []
        );
        insC.run(
          c.customerID,
          c.name,
          c.phoneNumber,
          c.email,
          c.addressShipping,
          c.addressBilling,
          c.status,
          c.tier,
          c.paymentTerms,
          c.createdBy,
          c.createdAtISO,
          c.lastActivityISO,
          c.companyName ?? '',
          c.leadSource ?? '',
          c.preferredContact ?? '',
          c.followUpISO ?? '',
          tagsJson,
          c.crmProfileNotes ?? '',
          DEFAULT_BRANCH_ID
        );
      }
      for (const q of QUOTATIONS_SEED) {
        insQ.run(
          q.id,
          q.customerID,
          q.customer,
          q.date,
          q.dateISO,
          q.dueDateISO,
          q.total,
          q.totalNgn,
          q.paidNgn,
          q.paymentStatus,
          q.status,
          q.approvalDate,
          q.customerFeedback,
          q.handledBy,
          q.projectName ?? null,
          q.linesJson ?? null,
          DEFAULT_BRANCH_ID
        );
      }
    })();
  }

  const supCount = db.prepare('SELECT COUNT(*) AS c FROM suppliers').get().c;
  if (supCount === 0) {
    const insS = db.prepare(
      `INSERT INTO suppliers (supplier_id, name, city, payment_terms, quality_score, notes, branch_id, supplier_profile_json) VALUES (?,?,?,?,?,?,?,?)`
    );
    const insA = db.prepare(
      `INSERT INTO transport_agents (id, name, region, phone, branch_id) VALUES (?,?,?,?,?)`
    );
    const insP = db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, gauge, colour, material_type, dashboard_attrs_json, branch_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    const insPo = db.prepare(`
      INSERT INTO purchase_orders (
        po_id, supplier_id, supplier_name, order_date_iso, expected_delivery_iso, status,
        invoice_no, invoice_date_iso, delivery_date_iso, transport_agent_id, transport_agent_name,
        transport_paid, transport_paid_at_iso, supplier_paid_ngn, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insPol = db.prepare(`
      INSERT INTO purchase_order_lines (
        po_id, line_key, product_id, product_name, color, gauge, meters_offered, conversion_kg_per_m,
        unit_price_per_kg_ngn, unit_price_ngn, qty_ordered, qty_received
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insD = db.prepare(`
      INSERT INTO deliveries (
        id, quotation_ref, customer_name, destination, method, status, tracking_no, ship_date, eta, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    const insR = db.prepare(`
      INSERT INTO sales_receipts (
        id, customer_id, customer_name, quotation_ref, date_label, date_iso, amount_display, amount_ngn, method, status, handled_by, ledger_entry_id, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insCl = db.prepare(`
      INSERT INTO cutting_lists (
        id, customer_id, customer_name, quotation_ref, product_id, product_name, date_label, date_iso,
        sheets_to_cut, total_meters, total_label, status, machine_name, operator_name,
        production_registered, production_register_ref, handled_by, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insClLine = db.prepare(`
      INSERT INTO cutting_list_lines (cutting_list_id, sort_order, sheets, length_m, total_m, line_type)
      VALUES (?,?,?,?,?,?)
    `);
    const insRf = db.prepare(`
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, cutting_list_ref, product, reason_category, reason,
        amount_ngn, calculation_lines_json, suggested_lines_json, calculation_notes, status, requested_by, requested_at_iso,
        approval_date, approved_by, approved_amount_ngn, manager_comments, paid_amount_ngn, paid_at_iso, paid_by, payment_note, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insT = db.prepare(
      `INSERT INTO treasury_accounts (id, name, bank_name, balance, type, acc_no) VALUES (?,?,?,?,?,?)`
    );
    const insE = db.prepare(
      `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id) VALUES (?,?,?,?,?,?,?,?)`
    );
    const insPr = db.prepare(
      `INSERT INTO payment_requests (request_id, expense_id, amount_requested_ngn, request_date, approval_status, description) VALUES (?,?,?,?,?,?)`
    );
    const insAp = db.prepare(
      `INSERT INTO accounts_payable (ap_id, supplier_name, po_ref, invoice_ref, amount_ngn, paid_ngn, due_date_iso, payment_method) VALUES (?,?,?,?,?,?,?,?)`
    );
    const insBr = db.prepare(
      `INSERT INTO bank_reconciliation_lines (id, bank_date_iso, description, amount_ngn, system_match, status, branch_id) VALUES (?,?,?,?,?,?,?)`
    );
    const insCat = db.prepare(
      `INSERT INTO procurement_catalog (id, color, gauge, product_id, offer_kg, offer_meters, conversion_kg_per_m, label) VALUES (?,?,?,?,?,?,?,?)`
    );
    const insY = db.prepare(
      `INSERT INTO yard_coils (id, colour, gauge_label, material_type, weight_kg, loc) VALUES (?,?,?,?,?,?)`
    );
    const insBlob = db.prepare(`INSERT OR REPLACE INTO app_json_blobs (key, payload) VALUES (?,?)`);

    db.transaction(() => {
      for (const s of SUPPLIERS_SEED) {
        insS.run(s.supplierID, s.name, s.city, s.paymentTerms, s.qualityScore, s.notes, DEFAULT_BRANCH_ID, null);
      }
      for (const a of TRANSPORT_AGENTS_SEED) {
        insA.run(a.id, a.name, a.region, a.phone, DEFAULT_BRANCH_ID);
      }
      for (const p of PRODUCTS_SEED) {
        insP.run(
          p.productID,
          p.name,
          p.stockLevel,
          p.unit,
          p.lowStockThreshold,
          p.reorderQty,
          p.dashboardAttrs?.gauge ?? null,
          p.dashboardAttrs?.colour ?? null,
          p.dashboardAttrs?.materialType ?? null,
          JSON.stringify(p.dashboardAttrs ?? {}),
          DEFAULT_BRANCH_ID
        );
      }
      for (const { po, lines } of PURCHASE_ORDERS_SEED) {
        insPo.run(
          po.poID,
          po.supplierID,
          po.supplierName,
          po.orderDateISO,
          po.expectedDeliveryISO,
          po.status,
          po.invoiceNo,
          po.invoiceDateISO,
          po.deliveryDateISO,
          po.transportAgentId,
          po.transportAgentName,
          po.transportPaid ? 1 : 0,
          po.transportPaidAtISO || null,
          po.supplierPaidNgn ?? 0,
          DEFAULT_BRANCH_ID
        );
        for (const l of lines) {
          insPol.run(
            po.poID,
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
      }
      for (const d of DELIVERIES_SEED) {
        insD.run(
          d.id,
          d.quotationRef,
          d.customer,
          d.destination,
          d.method,
          d.status,
          d.trackingNo,
          d.shipDate,
          d.eta,
          DEFAULT_BRANCH_ID
        );
      }
      for (const r of SALES_RECEIPTS_SEED) {
        insR.run(
          r.id,
          r.customerID,
          r.customer,
          r.quotationRef,
          r.date,
          r.dateISO,
          r.amount,
          r.amountNgn,
          r.method,
          r.status,
          r.handledBy,
          r.ledgerEntryId ?? null,
          DEFAULT_BRANCH_ID
        );
      }
      for (const c of CUTTING_LISTS_SEED) {
        insCl.run(
          c.id,
          c.customerID,
          c.customer,
          c.quotationRef || null,
          c.productID ?? null,
          c.productName ?? null,
          c.date,
          c.dateISO,
          c.sheetsToCut ?? 0,
          c.totalMeters ?? 0,
          c.total,
          c.status,
          c.machineName ?? null,
          c.operatorName ?? null,
          c.productionRegistered ? 1 : 0,
          c.productionRegisterRef || '',
          c.handledBy,
          DEFAULT_BRANCH_ID
        );
        for (const line of c.lines ?? []) {
          const sortOrder = line.lineNo ?? 0;
          const sheets = Number(line.sheets) || 0;
          const lengthM = Number(line.lengthM) || 0;
          const totalM = Number(line.totalM) || sheets * lengthM;
          insClLine.run(c.id, sortOrder, sheets, lengthM, totalM, line.lineType || 'Roof');
        }
      }
      for (const r of REFUNDS_SEED) {
        insRf.run(
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
          r.approvedAmountNgn ?? (r.status === 'Approved' || r.status === 'Paid' ? r.amountNgn : 0),
          r.managerComments,
          r.paidAmountNgn ?? (r.status === 'Paid' ? r.amountNgn : 0),
          r.paidAtISO,
          r.paidBy,
          r.paymentNote ?? '',
          DEFAULT_BRANCH_ID
        );
      }
      for (const t of TREASURY_SEED) {
        insT.run(t.id, t.name, t.bankName, t.balance, t.type, t.accNo);
      }
      for (const e of EXPENSES_SEED) {
        insE.run(
          e.expenseID,
          e.expenseType,
          e.amountNgn,
          e.date,
          e.category,
          e.paymentMethod,
          e.reference,
          DEFAULT_BRANCH_ID
        );
      }
      for (const p of PAYMENT_REQUESTS_SEED) {
        insPr.run(
          p.requestID,
          p.expenseID,
          p.amountRequestedNgn,
          p.requestDate,
          p.approvalStatus,
          p.description
        );
      }
      for (const a of ACCOUNTS_PAYABLE_SEED) {
        insAp.run(
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
      for (const b of BANK_RECONCILIATION_SEED) {
        insBr.run(
          b.id,
          b.bankDateISO,
          b.description,
          b.amountNgn,
          b.systemMatch,
          b.status,
          b.branchId ?? DEFAULT_BRANCH_ID
        );
      }
      for (const c of PROCUREMENT_CATALOG_SEED) {
        insCat.run(c.id, c.color, c.gauge, c.productID, c.offerKg, c.offerMeters, c.conversionKgPerM, c.label);
      }
      for (const y of YARD_COILS_SEED) {
        insY.run(y.id, y.colour, y.gaugeLabel, y.materialType, y.weightKg, y.loc);
      }
      insBlob.run('customer_dashboard', JSON.stringify(CUSTOMER_DASHBOARD_SEED));
      insBlob.run('sales_available_stock', JSON.stringify(AVAILABLE_STOCK_SEED));
    })();
  }

  const crmCount = db.prepare(`SELECT COUNT(*) AS c FROM customer_crm_interactions`).get().c;
  if (crmCount === 0) {
    const demoCustomer = db.prepare(`SELECT 1 FROM customers WHERE customer_id = ?`).get('CUS-001');
    if (demoCustomer) {
      db.prepare(
        `INSERT INTO customer_crm_interactions (id, customer_id, at_iso, kind, title, detail, created_by_name, branch_id) VALUES (?,?,?,?,?,?,?,?)`
      ).run(
        'CRM-DEMO-1',
        'CUS-001',
        '2026-03-28T09:30:00.000Z',
        'call',
        'Gauge follow-up',
        'Confirmed interest in 0.45 HMB for April delivery window.',
        'Auwal Idris',
        DEFAULT_BRANCH_ID
      );
    }
  }

  seedProductionLineDemo(db);
  seedHrIfEmpty(db);
}

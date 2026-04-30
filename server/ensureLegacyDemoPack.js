import { CUSTOMERS_SEED, QUOTATIONS_SEED } from './seedData.js';
import { SALES_RECEIPTS_SEED } from './seedExtra.js';
import { LAGACY_CUTTING_LIST_SEED } from './lagacyCuttingListSeed.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

const DEMO_CUSTOMER_ID = 'CUS-NDA';
const DEMO_QUOTE_ID = 'QT-2026-027';
const DEMO_RECEIPT_ID = 'RC-2026-1849';
const DEMO_CL_ID = 'CL-2026-1592';

/**
 * Ensures the legacy factory demo pack exists in the SQLite file even when the DB was
 * created before those rows were added to the seed arrays (seedEverything only fills an empty DB).
 * Uses INSERT OR IGNORE / line backfill so it is safe to run on every startup.
 * @param {import('better-sqlite3').Database} db
 */
export function ensureLegacyDemoPack(db) {
  const customer = CUSTOMERS_SEED.find((c) => c.customerID === DEMO_CUSTOMER_ID);
  const quotation = QUOTATIONS_SEED.find((q) => q.id === DEMO_QUOTE_ID);
  const receipt = SALES_RECEIPTS_SEED.find((r) => r.id === DEMO_RECEIPT_ID);
  const cutting = LAGACY_CUTTING_LIST_SEED;

  if (!customer || !quotation || !receipt || !cutting || cutting.id !== DEMO_CL_ID) {
    console.warn('[zarewa] Legacy demo pack: seed entries missing; skip ensure.');
    return;
  }

  let inserted = 0;

  /** Commit each step separately so one failure does not roll back the whole pack (e.g. FK / constraint). */
  const step = (label, fn) => {
    try {
      fn();
    } catch (e) {
      console.warn(`[zarewa] Legacy demo pack — ${label} skipped:`, e?.message || e);
    }
  };

  step('customer', () => {
    const insC = db.prepare(`
      INSERT OR IGNORE INTO customers (
        customer_id, name, phone_number, email, address_shipping, address_billing,
        status, tier, payment_terms, created_by, created_at_iso, last_activity_iso,
        company_name, lead_source, preferred_contact, follow_up_iso, crm_tags_json, crm_profile_notes, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const tagsJson = JSON.stringify(Array.isArray(customer.crmTags) ? customer.crmTags : []);
    inserted += insC.run(
      customer.customerID,
      customer.name,
      customer.phoneNumber,
      customer.email,
      customer.addressShipping,
      customer.addressBilling,
      customer.status,
      customer.tier,
      customer.paymentTerms,
      customer.createdBy,
      customer.createdAtISO,
      customer.lastActivityISO,
      customer.companyName ?? '',
      customer.leadSource ?? '',
      customer.preferredContact ?? '',
      customer.followUpISO ?? '',
      tagsJson,
      customer.crmProfileNotes ?? '',
      DEFAULT_BRANCH_ID
    ).changes;
  });

  step('quotation', () => {
    const insQ = db.prepare(`
      INSERT OR IGNORE INTO quotations (
        id, customer_id, customer_name, date_label, date_iso, due_date_iso,
        total_display, total_ngn, paid_ngn, payment_status, status, approval_date, customer_feedback, handled_by,
        project_name, lines_json, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    inserted += insQ.run(
      quotation.id,
      quotation.customerID,
      quotation.customer,
      quotation.date,
      quotation.dateISO,
      quotation.dueDateISO,
      quotation.total,
      quotation.totalNgn,
      quotation.paidNgn,
      quotation.paymentStatus,
      quotation.status,
      quotation.approvalDate,
      quotation.customerFeedback,
      quotation.handledBy,
      quotation.projectName ?? null,
      quotation.linesJson ?? null,
      DEFAULT_BRANCH_ID
    ).changes;
  });

  step('receipt', () => {
    const insR = db.prepare(`
      INSERT OR IGNORE INTO sales_receipts (
        id, customer_id, customer_name, quotation_ref, date_label, date_iso, amount_display, amount_ngn, method, status, handled_by, ledger_entry_id, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    inserted += insR.run(
      receipt.id,
      receipt.customerID,
      receipt.customer,
      receipt.quotationRef,
      receipt.date,
      receipt.dateISO,
      receipt.amount,
      receipt.amountNgn,
      receipt.method,
      receipt.status,
      receipt.handledBy,
      receipt.ledgerEntryId ?? null,
      DEFAULT_BRANCH_ID
    ).changes;
  });

  step('cutting list', () => {
    const insCl = db.prepare(`
      INSERT OR IGNORE INTO cutting_lists (
        id, customer_id, customer_name, quotation_ref, product_id, product_name, date_label, date_iso,
        sheets_to_cut, total_meters, total_label, status, machine_name, operator_name,
        production_registered, production_register_ref, handled_by, branch_id,
        production_release_pending, production_released_at_iso, production_released_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    inserted += insCl.run(
      cutting.id,
      cutting.customerID,
      cutting.customer,
      cutting.quotationRef || null,
      cutting.productID ?? null,
      cutting.productName ?? null,
      cutting.date,
      cutting.dateISO,
      cutting.sheetsToCut ?? 0,
      cutting.totalMeters ?? 0,
      cutting.total,
      cutting.status,
      cutting.machineName ?? null,
      cutting.operatorName ?? null,
      cutting.productionRegistered ? 1 : 0,
      cutting.productionRegisterRef || '',
      cutting.handledBy,
      DEFAULT_BRANCH_ID,
      0,
      null,
      null
    ).changes;
  });

  step('cutting list lines', () => {
    const lineCount = db
      .prepare(`SELECT COUNT(*) AS c FROM cutting_list_lines WHERE cutting_list_id = ?`)
      .get(DEMO_CL_ID).c;

    if (lineCount === 0) {
      const insClLine = db.prepare(`
        INSERT OR IGNORE INTO cutting_list_lines (cutting_list_id, sort_order, sheets, length_m, total_m, line_type)
        VALUES (?,?,?,?,?,?)
      `);
      for (const line of cutting.lines ?? []) {
        const sortOrder = line.lineNo ?? 0;
        const sheets = Number(line.sheets) || 0;
        const lengthM = Number(line.lengthM) || 0;
        const totalM = Number(line.totalM) || sheets * lengthM;
        inserted += insClLine.run(cutting.id, sortOrder, sheets, lengthM, totalM, line.lineType || 'Roof').changes;
      }
    }
  });

  if (inserted > 0) {
    console.log(
      `[zarewa] Legacy demo pack applied to database (${inserted} row(s)): ${DEMO_QUOTE_ID} / ${DEMO_CL_ID} / ${DEMO_RECEIPT_ID}.`
    );
  }
}

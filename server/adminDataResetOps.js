/**
 * Admin-only selective data reset (MySQL / SQLite worker). Uses FK checks off per transaction.
 * Does not drop users, branches, catalog products, suppliers, transport agents, or treasury account rows.
 * Deletes are scoped to a single workspace branch — never all branches at once.
 */

import { getBranch, GLOBAL_MASTER_DATA_BRANCH } from './branches.js';
import { getBranchCodeUpper } from './humanId.js';
import { setSuppressLegacyDemoPackAfterOperationsReset } from './legacyDemoPackPolicy.js';
import { resetHrBranchOperationalData } from './hrAdminDataResetOps.js';

/** @type {{ id: string, label: string, warning: string, tables: string[] }[]} */
export const ADMIN_DATA_RESET_PRESETS = [
  {
    id: 'document_sequences',
    label: 'Document number sequences',
    warning:
      'Resets ID counters for the current branch only (e.g. QT-YL-26-0001). Other branches keep their sequences.',
    tables: ['human_id_sequences', 'entity_sequences', 'reference_counters'],
  },
  {
    id: 'office_desk',
    label: 'Office Desk & work items',
    warning:
      'Removes threads, messages, dossiers, material/in-transit requests, and work items for this branch only.',
    tables: [
      'work_item_print_snapshots',
      'work_item_filing',
      'work_item_sla_events',
      'work_item_decisions',
      'work_item_links',
      'work_item_visibility',
      'work_items',
      'office_thread_filing',
      'office_thread_reads',
      'office_messages',
      'office_threads',
      'office_dossier_links',
      'office_dossiers',
      'office_inter_branch_requests',
      'material_request_lines',
      'material_requests',
      'in_transit_load_lines',
      'in_transit_loads',
    ],
  },
  {
    id: 'operations_core',
    label: 'Sales, production, procurement & inventory',
    warning:
      'Deletes this branch’s customers, quotations, cutting lists, production, POs, stock movements, and ledger rows. Shared supplier/transporter profiles are kept. Coil book rows stay unless you also tick Coil lots.',
    tables: [
      'production_completion_adjustments',
      'production_job_stone_flatsheet_usage',
      'production_job_accessory_usage',
      'production_job_coils',
      'production_conversion_checks',
      'production_jobs',
      'cutting_list_lines',
      'cutting_lists',
      'customer_refunds',
      'advance_in_events',
      'sales_receipts',
      'ledger_entries',
      'quotation_lines',
      'quotations',
      'delivery_lines',
      'deliveries',
      'inter_branch_loan_repayments',
      'inter_branch_loans',
      'purchase_order_lines',
      'purchase_orders',
      'procurement_catalog',
      'stock_movements',
      'wip_balances',
      'approval_actions',
      'customer_crm_interactions',
      'customers',
    ],
  },
  {
    id: 'coil_stock',
    label: 'Coil lots & coil stock',
    warning:
      'Deletes this branch’s coil lots, yard rows tied to those coils, coil control events, and related production coil lines.',
    tables: [
      'material_incident_audit',
      'material_incident_issues',
      'material_incident_stock_links',
      'material_incident_attachments',
      'material_incident_lines',
      'material_incidents',
      'coil_control_events',
      'production_conversion_checks',
      'production_job_coils',
      'coil_requests',
      'yard_coils',
      'coil_lots',
    ],
  },
  {
    id: 'gl_journals',
    label: 'General ledger journal entries',
    warning: 'Removes GL journals posted for this branch. Chart of accounts is kept.',
    tables: ['gl_journal_lines', 'gl_journal_entries'],
  },
  {
    id: 'treasury_movements',
    label: 'Treasury movement lines',
    warning:
      'Clears treasury_movements for this branch’s bank/cash accounts only. Account rows and balances are not recalculated here.',
    tables: ['treasury_movements'],
  },
  {
    id: 'expenses_ap',
    label: 'Expenses, AP, payment requests & bank rec lines',
    warning: 'Deletes expenses, payables, payment requests, and bank reconciliation lines for this branch only.',
    tables: ['payment_requests', 'accounts_payable', 'expenses', 'bank_reconciliation_lines'],
  },
  {
    id: 'hr_staff_payroll',
    label: 'HR staff profiles, payroll & requests',
    warning:
      'Removes HR employee records, documents, leave/payroll rows, discipline, and transfer data for this branch only. Usernames and passwords in Team & access are NOT changed or deleted — logins stay exactly as they are. HR settings, departments, designations, and salary matrix are kept.',
    tables: [],
    customReset: true,
  },
  {
    id: 'audit_log',
    label: 'Audit log',
    warning:
      'Not branch-scoped in storage — skipped when resetting a single branch. Use HQ export before any company-wide cleanup.',
    tables: ['audit_log'],
  },
];

const PRESET_BY_ID = new Map(ADMIN_DATA_RESET_PRESETS.map((p) => [p.id, p]));

const CONFIRM_PHRASE = 'RESET SELECTED DATA';

/** Tables cleared only via parent subquery (no branch_id column). */
const BRANCH_CHILD_DELETE_SQL = {
  quotation_lines: `DELETE FROM quotation_lines WHERE quotation_id IN (SELECT id FROM quotations WHERE branch_id = ?)`,
  purchase_order_lines: `DELETE FROM purchase_order_lines WHERE po_id IN (SELECT po_id FROM purchase_orders WHERE branch_id = ?)`,
  cutting_list_lines: `DELETE FROM cutting_list_lines WHERE cutting_list_id IN (SELECT id FROM cutting_lists WHERE branch_id = ?)`,
  delivery_lines: `DELETE FROM delivery_lines WHERE delivery_id IN (SELECT id FROM deliveries WHERE branch_id = ?)`,
  gl_journal_lines: `DELETE FROM gl_journal_lines WHERE journal_id IN (SELECT id FROM gl_journal_entries WHERE branch_id = ?)`,
  production_completion_adjustments: `DELETE FROM production_completion_adjustments WHERE job_id IN (SELECT job_id FROM production_jobs WHERE branch_id = ?)`,
  production_job_stone_flatsheet_usage: `DELETE FROM production_job_stone_flatsheet_usage WHERE job_id IN (SELECT job_id FROM production_jobs WHERE branch_id = ?)`,
  production_job_accessory_usage: `DELETE FROM production_job_accessory_usage WHERE job_id IN (SELECT job_id FROM production_jobs WHERE branch_id = ?)`,
  production_job_coils: `DELETE FROM production_job_coils WHERE job_id IN (SELECT job_id FROM production_jobs WHERE branch_id = ?)`,
  production_conversion_checks: `DELETE FROM production_conversion_checks WHERE job_id IN (SELECT job_id FROM production_jobs WHERE branch_id = ?)`,
  advance_in_events: `DELETE FROM advance_in_events WHERE ledger_entry_id IN (SELECT id FROM ledger_entries WHERE branch_id = ?)`,
  payment_requests: `DELETE FROM payment_requests WHERE expense_id IN (SELECT expense_id FROM expenses WHERE branch_id = ?)`,
  accounts_payable: `DELETE FROM accounts_payable WHERE po_ref IN (SELECT po_id FROM purchase_orders WHERE branch_id = ?)`,
  material_request_lines: `DELETE FROM material_request_lines WHERE material_request_id IN (SELECT id FROM material_requests WHERE branch_id = ?)`,
  in_transit_load_lines: `DELETE FROM in_transit_load_lines WHERE load_id IN (SELECT id FROM in_transit_loads WHERE branch_id = ? OR destination_branch_id = ?)`,
  work_item_print_snapshots: `DELETE FROM work_item_print_snapshots WHERE work_item_id IN (SELECT id FROM work_items WHERE branch_id = ?)`,
  work_item_filing: `DELETE FROM work_item_filing WHERE work_item_id IN (SELECT id FROM work_items WHERE branch_id = ?)`,
  work_item_sla_events: `DELETE FROM work_item_sla_events WHERE work_item_id IN (SELECT id FROM work_items WHERE branch_id = ?)`,
  work_item_decisions: `DELETE FROM work_item_decisions WHERE work_item_id IN (SELECT id FROM work_items WHERE branch_id = ?)`,
  work_item_links: `DELETE FROM work_item_links WHERE work_item_id IN (SELECT id FROM work_items WHERE branch_id = ?)`,
  work_item_visibility: `DELETE FROM work_item_visibility WHERE work_item_id IN (SELECT id FROM work_items WHERE branch_id = ?)`,
  office_messages: `DELETE FROM office_messages WHERE thread_id IN (SELECT id FROM office_threads WHERE branch_id = ?)`,
  office_thread_reads: `DELETE FROM office_thread_reads WHERE thread_id IN (SELECT id FROM office_threads WHERE branch_id = ?)`,
  office_thread_filing: `DELETE FROM office_thread_filing WHERE thread_id IN (SELECT id FROM office_threads WHERE branch_id = ?)`,
  office_dossier_links: `DELETE FROM office_dossier_links WHERE dossier_id IN (SELECT id FROM office_dossiers WHERE branch_id = ?)`,
  material_incident_audit: `DELETE FROM material_incident_audit WHERE incident_id IN (SELECT id FROM material_incidents WHERE branch_id = ?)`,
  material_incident_issues: `DELETE FROM material_incident_issues WHERE incident_id IN (SELECT id FROM material_incidents WHERE branch_id = ?)`,
  material_incident_stock_links: `DELETE FROM material_incident_stock_links WHERE incident_id IN (SELECT id FROM material_incidents WHERE branch_id = ?)`,
  material_incident_attachments: `DELETE FROM material_incident_attachments WHERE incident_id IN (SELECT id FROM material_incidents WHERE branch_id = ?)`,
  material_incident_lines: `DELETE FROM material_incident_lines WHERE incident_id IN (SELECT id FROM material_incidents WHERE branch_id = ?)`,
  inter_branch_loan_repayments: `DELETE FROM inter_branch_loan_repayments WHERE loan_id IN (SELECT loan_id FROM inter_branch_loans WHERE lender_branch_id = ? OR borrower_branch_id = ?)`,
};

/** Tables with special branch rules (not a simple branch_id column). */
const BRANCH_SPECIAL_HANDLERS = {
  human_id_sequences(db, branchId) {
    const code = getBranchCodeUpper(db, branchId);
    const like = `%|${code}|%`;
    db.prepare(`DELETE FROM human_id_sequences WHERE scope LIKE ?`).run(like);
  },
  entity_sequences() {
    /* Company-wide coil serial counter — not cleared per branch. */
  },
  reference_counters() {
    /* Shared counters — not cleared per branch. */
  },
  treasury_movements(db, branchId) {
    db.prepare(
      `DELETE FROM treasury_movements WHERE treasury_account_id IN (SELECT id FROM treasury_accounts WHERE branch_id = ?)`
    ).run(branchId);
  },
  inter_branch_loans(db, branchId) {
    db.prepare(
      `DELETE FROM inter_branch_loans WHERE lender_branch_id = ? OR borrower_branch_id = ?`
    ).run(branchId, branchId);
  },
  office_inter_branch_requests(db, branchId) {
    db.prepare(
      `DELETE FROM office_inter_branch_requests WHERE from_branch_id = ? OR to_branch_id = ?`
    ).run(branchId, branchId);
  },
  in_transit_loads(db, branchId) {
    db.prepare(
      `DELETE FROM in_transit_loads WHERE branch_id = ? OR destination_branch_id = ?`
    ).run(branchId, branchId);
  },
  stock_movements(db, branchId) {
    db.prepare(
      `DELETE FROM stock_movements WHERE ref IN (SELECT po_id FROM purchase_orders WHERE branch_id = ?)`
    ).run(branchId);
  },
  approval_actions(db, branchId) {
    db.prepare(
      `DELETE FROM approval_actions WHERE
         (entity_kind = 'purchase_order' AND entity_id IN (SELECT po_id FROM purchase_orders WHERE branch_id = ?))
         OR (entity_kind = 'quotation' AND entity_id IN (SELECT id FROM quotations WHERE branch_id = ?))
         OR (entity_kind = 'expense' AND entity_id IN (SELECT expense_id FROM expenses WHERE branch_id = ?))
         OR (entity_kind = 'payment_request' AND entity_id IN (SELECT request_id FROM payment_requests WHERE expense_id IN (SELECT expense_id FROM expenses WHERE branch_id = ?)))
         OR (entity_kind = 'customer_refund' AND entity_id IN (SELECT refund_id FROM customer_refunds WHERE branch_id = ?))`
    ).run(branchId, branchId, branchId, branchId, branchId);
  },
  procurement_catalog() {
    /* Shared procurement offer grid — not branch-owned. */
  },
  yard_coils(db, branchId) {
    db.prepare(`DELETE FROM yard_coils WHERE id IN (SELECT coil_no FROM coil_lots WHERE branch_id = ?)`).run(
      branchId
    );
  },
  audit_log() {
    /* Audit rows are not keyed by branch — skipped for branch-scoped reset. */
  },
};

const SKIP_ON_BRANCH_SCOPE = new Set(['entity_sequences', 'reference_counters', 'procurement_catalog', 'audit_log']);

function isIgnorableMissingTableError(e) {
  const msg = String(e?.message || e || '');
  const code = String(e?.code || '');
  return (
    code === 'ER_NO_SUCH_TABLE' ||
    msg.includes('1146') ||
    msg.includes('42S02') ||
    msg.includes('no such table')
  );
}

function assertSafeTableName(table) {
  if (!/^[a-z][a-z0-9_]*$/i.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 */
function tableHasColumn(db, table, column) {
  assertSafeTableName(table);
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {string} branchId
 * @returns {{ deleted: boolean, skipped?: boolean, reason?: string }}
 */
function deleteTableForBranch(db, table, branchId) {
  assertSafeTableName(table);

  if (SKIP_ON_BRANCH_SCOPE.has(table)) {
    return { deleted: false, skipped: true, reason: 'not_branch_scoped' };
  }

  const special = BRANCH_SPECIAL_HANDLERS[table];
  if (special) {
    special(db, branchId);
    return { deleted: true };
  }

  if (tableHasColumn(db, table, 'branch_id')) {
    db.prepare(`DELETE FROM \`${table}\` WHERE branch_id = ?`).run(branchId);
    return { deleted: true };
  }

  const childSql = BRANCH_CHILD_DELETE_SQL[table];
  if (childSql) {
    const args = childSql.includes('destination_branch_id') || childSql.includes('borrower_branch_id')
      ? [branchId, branchId]
      : [branchId];
    db.prepare(childSql).run(...args);
    return { deleted: true };
  }

  return { deleted: false, skipped: true, reason: 'no_branch_rule' };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} presetIds
 * @param {string} confirmPhrase
 * @param {{ actorId?: string|null, branchId?: string, workspaceViewAll?: boolean }} [meta]
 */
export function applyAdminDataReset(db, presetIds, confirmPhrase, meta = {}) {
  if (String(confirmPhrase || '').trim() !== CONFIRM_PHRASE) {
    return { ok: false, error: `Type exactly: ${CONFIRM_PHRASE}` };
  }

  const branchId = String(meta.branchId || '').trim();
  if (!branchId || branchId === 'ALL' || branchId === GLOBAL_MASTER_DATA_BRANCH) {
    return {
      ok: false,
      error:
        'Switch workspace to one branch (not “all branches”) before running data reset. This tool only clears that branch’s data.',
    };
  }
  if (meta.workspaceViewAll) {
    return {
      ok: false,
      error:
        'Turn off “all branches” workspace view and select a single branch before reset. This prevents deleting every factory at once.',
    };
  }

  const ids = Array.isArray(presetIds) ? presetIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!ids.length) {
    return { ok: false, error: 'Select at least one category.' };
  }
  const unknown = ids.filter((id) => !PRESET_BY_ID.has(id));
  if (unknown.length) {
    return { ok: false, error: `Unknown category: ${unknown.join(', ')}` };
  }

  const canonicalPresetOrder = ADMIN_DATA_RESET_PRESETS.map((p) => p.id);
  const idSet = new Set(ids);
  const sortedPresetIds = canonicalPresetOrder.filter((presetId) => idSet.has(presetId));

  const orderedTables = [];
  const seen = new Set();
  const skippedTables = [];
  let tablesCleared = 0;

  for (const id of sortedPresetIds) {
    const p = PRESET_BY_ID.get(id);
    if (p?.customReset) {
      if (id === 'hr_staff_payroll') {
        const hr = resetHrBranchOperationalData(db, branchId);
        if (!hr.ok) throw new Error(hr.error || 'HR reset failed.');
        tablesCleared += 1;
      }
      continue;
    }
    for (const t of p.tables) {
      if (seen.has(t)) continue;
      seen.add(t);
      orderedTables.push(t);
    }
  }

  try {
    db.transaction(() => {
      db.exec('SET SESSION foreign_key_checks = 0');
      for (const t of orderedTables) {
        try {
          const r = deleteTableForBranch(db, t, branchId);
          if (r.deleted) tablesCleared += 1;
          else if (r.skipped) skippedTables.push(t);
        } catch (e) {
          if (isIgnorableMissingTableError(e)) continue;
          throw e;
        }
      }
      db.exec('SET SESSION foreign_key_checks = 1');
    })();
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }

  if (idSet.has('operations_core')) {
    setSuppressLegacyDemoPackAfterOperationsReset(db, { actorId: meta.actorId ?? null });
  }

  const branch = getBranch(db, branchId);

  return {
    ok: true,
    presetIds: sortedPresetIds,
    branchId,
    branchName: branch?.name || branchId,
    tablesCleared,
    skippedTables,
    actorId: meta.actorId ?? null,
  };
}

export { CONFIRM_PHRASE as ADMIN_DATA_RESET_CONFIRM_PHRASE };

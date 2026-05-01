/**
 * Admin-only selective data reset (MySQL / SQLite worker). Uses FK checks off per transaction.
 * Does not drop users, branches, products, suppliers, master setup_*, or treasury account rows.
 */

import { setSuppressLegacyDemoPackAfterOperationsReset } from './legacyDemoPackPolicy.js';

/** @type {{ id: string, label: string, warning: string, tables: string[] }[]} */
export const ADMIN_DATA_RESET_PRESETS = [
  {
    id: 'document_sequences',
    label: 'Document number sequences',
    warning: 'Next human-readable IDs (e.g. QT-KD-26-0001) start from …0001 again.',
    tables: ['human_id_sequences', 'entity_sequences', 'reference_counters'],
  },
  {
    id: 'office_desk',
    label: 'Office Desk & work items',
    warning: 'Removes threads, messages, dossiers, material/in-transit requests, and work items.',
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
      'Deletes customers, quotations, cutting lists, production, POs, stock movements, and customer cashbook ledger rows. Does not remove app users, catalog products, master price lists, or coil lots — use the separate “Coil lots & coil stock” option to clear yard/coil book data.',
    tables: [
      'production_completion_adjustments',
      'production_job_accessory_usage',
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
      'Deletes coil_lots (GRN/opening book), yard_coils, coil control events, coil requests, and production rows that reference coil numbers (job coil lines & conversion checks). Run after or without “Sales, production…” — if production jobs still exist, their coil allocation rows are cleared first.',
    tables: [
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
    warning: 'Removes posted GL journals and lines. Chart of accounts (gl_accounts) is kept.',
    tables: ['gl_journal_lines', 'gl_journal_entries'],
  },
  {
    id: 'treasury_movements',
    label: 'Treasury movement lines',
    warning: 'Clears treasury_movements only; account rows and balances are not recalculated here.',
    tables: ['treasury_movements'],
  },
  {
    id: 'expenses_ap',
    label: 'Expenses, AP, payment requests & bank rec lines',
    warning: 'Deletes expenses, accounts payable, payment requests, and bank reconciliation import lines.',
    tables: ['payment_requests', 'accounts_payable', 'expenses', 'bank_reconciliation_lines'],
  },
  {
    id: 'audit_log',
    label: 'Audit log',
    warning: 'Removes stored audit_log rows (compliance / history).',
    tables: ['audit_log'],
  },
];

const PRESET_BY_ID = new Map(ADMIN_DATA_RESET_PRESETS.map((p) => [p.id, p]));

const CONFIRM_PHRASE = 'RESET SELECTED DATA';

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

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 */
function deleteAllFromTable(db, table) {
  if (!/^[a-z][a-z0-9_]*$/i.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  try {
    db.exec(`DELETE FROM \`${table}\``);
  } catch (e) {
    if (isIgnorableMissingTableError(e)) return;
    throw e;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} presetIds
 * @param {string} confirmPhrase
 * @param {{ actorId?: string|null }} [meta]
 */
export function applyAdminDataReset(db, presetIds, confirmPhrase, meta = {}) {
  if (String(confirmPhrase || '').trim() !== CONFIRM_PHRASE) {
    return { ok: false, error: `Type exactly: ${CONFIRM_PHRASE}` };
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
  for (const id of sortedPresetIds) {
    const p = PRESET_BY_ID.get(id);
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
        deleteAllFromTable(db, t);
      }
      db.exec('SET SESSION foreign_key_checks = 1');
    })();
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }

  if (idSet.has('operations_core')) {
    setSuppressLegacyDemoPackAfterOperationsReset(db, { actorId: meta.actorId ?? null });
  }

  return {
    ok: true,
    presetIds: sortedPresetIds,
    tablesCleared: orderedTables.length,
    actorId: meta.actorId ?? null,
  };
}

export { CONFIRM_PHRASE as ADMIN_DATA_RESET_CONFIRM_PHRASE };

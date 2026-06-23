/**
 * Opening Pack — register-first cutover rollups → one GL bridge journal.
 * See docs/ACCOUNTING_SYSTEM_ARCHITECTURE.md
 */
import {
  ACCOUNTING_OPENING_DATE_ISO,
  ACCOUNTING_OPENING_PERIOD_KEY,
  ACCOUNTING_OPENING_SOURCE_ID,
} from '../shared/lib/accountingCutover.js';
import { buildCreditorsRegister, buildDebtorsRegister } from './accountingSubledgerOps.js';
import { listFixedAssets } from './accountingPhase2Ops.js';
import { buildStockRegisterForBranch } from './stockRegisterOps.js';
import { listTreasuryAccounts } from './readModel.js';
import { ensureTreasuryCashGlAccount, getOpeningBalanceStatus, postOpeningBalanceJournal } from './accountingPostingOps.js';
import { computePayrollRunGlAmounts, payrollGlStatusForRun } from './payrollGlOps.js';
import { listBranches } from './branches.js';
import { tableExists } from './ap2ReceivedBasisOps.js';
import { buildApInventoryGlAlignmentReport } from './ap2GlAlignmentOps.js';

const ASSET_CATEGORY_TO_GL = {
  plant: '1500',
  building: '1501',
  land: '1501',
  it: '1502',
  other: '1502',
  vehicle: '1504',
};

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function sectionTotal(register, sectionId) {
  const sec = (register?.sections || []).find((s) => s.id === sectionId);
  return roundMoney(sec?.subtotalNgn ?? 0);
}

function sectionCount(register, sectionId) {
  const sec = (register?.sections || []).find((s) => s.id === sectionId);
  return Number(sec?.count ?? sec?.items?.length ?? 0) || 0;
}

/**
 * @param {object} p
 * @returns {object}
 */
function packSource(p) {
  return {
    id: p.id,
    module: p.module,
    label: p.label,
    glAccountCode: p.glAccountCode,
    side: p.side,
    amountNgn: roundMoney(p.amountNgn),
    rowCount: p.rowCount ?? 0,
    drillDownTab: p.drillDownTab || '',
    status: p.status || (p.amountNgn > 0 ? 'ok' : 'empty'),
    detail: p.detail || '',
  };
}

function lastDayOfMonth(periodKey) {
  const m = String(periodKey || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = new Date(y, mo, 0).getDate();
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function priorPeriodKey(periodKey) {
  const m = String(periodKey || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  let y = Number(m[1]);
  let mo = Number(m[2]) - 1;
  if (mo < 1) {
    mo = 12;
    y -= 1;
  }
  return `${y}-${String(mo).padStart(2, '0')}`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
function rollupCreditorsSources(db, branchScope) {
  const reg = buildCreditorsRegister(db, { branchId: branchScope === 'ALL' ? null : branchScope });
  const arSections = [
    'customer_receivables',
    'staff_loans',
    'staff_purchase_receivables',
    'staff_recovery_receivables',
    'legacy_inherited',
  ];
  const arAmount = arSections.reduce((s, id) => s + sectionTotal(reg, id), 0);
  const arRows = arSections.reduce((s, id) => s + sectionCount(reg, id), 0);

  return [
    packSource({
      id: 'creditors_trade_ar',
      module: 'creditors',
      label: 'Trade & staff receivables',
      glAccountCode: '1200',
      side: 'debit',
      amountNgn: arAmount,
      rowCount: arRows,
      drillDownTab: 'creditors',
      detail: 'Customer AR, staff loans/purchases/recovery, inherited receivables',
    }),
    packSource({
      id: 'creditors_supplier_prepay',
      module: 'creditors',
      label: 'Supplier prepayments',
      glAccountCode: '1400',
      side: 'debit',
      amountNgn: sectionTotal(reg, 'supplier_prepayments'),
      rowCount: sectionCount(reg, 'supplier_prepayments'),
      drillDownTab: 'creditors',
    }),
    packSource({
      id: 'creditors_inter_branch',
      module: 'creditors',
      label: 'Inter-branch receivable',
      glAccountCode: '1800',
      side: 'debit',
      amountNgn: sectionTotal(reg, 'inter_branch_receivable'),
      rowCount: sectionCount(reg, 'inter_branch_receivable'),
      drillDownTab: 'interBranch',
    }),
  ];
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
function rollupDebtorsSources(db, branchScope) {
  const reg = buildDebtorsRegister(db, { branchId: branchScope === 'ALL' ? null : branchScope });
  const depositAmount =
    sectionTotal(reg, 'customer_deposits') +
    sectionTotal(reg, 'deposit_on_production_line') +
    sectionTotal(reg, 'deposit_paid_backlog');
  const depositRows =
    sectionCount(reg, 'customer_deposits') +
    sectionCount(reg, 'deposit_on_production_line') +
    sectionCount(reg, 'deposit_paid_backlog');
  const suspenseAmount =
    sectionTotal(reg, 'bank_deposit_suspense') + sectionTotal(reg, 'unallocated_receipts');
  const suspenseRows =
    sectionCount(reg, 'bank_deposit_suspense') + sectionCount(reg, 'unallocated_receipts');
  const legacyAmount = sectionTotal(reg, 'legacy_inherited');

  const sources = [
    packSource({
      id: 'debtors_supplier_ap',
      module: 'debtors',
      label: 'Supplier trade payables',
      glAccountCode: '2000',
      side: 'credit',
      amountNgn: sectionTotal(reg, 'supplier_payables'),
      rowCount: sectionCount(reg, 'supplier_payables'),
      drillDownTab: 'debtors',
    }),
    packSource({
      id: 'debtors_customer_deposits',
      module: 'debtors',
      label: 'Customer deposits & pre-production',
      glAccountCode: '2500',
      side: 'credit',
      amountNgn: depositAmount,
      rowCount: depositRows,
      drillDownTab: 'debtors',
    }),
    packSource({
      id: 'debtors_suspense',
      module: 'debtors',
      label: 'Bank suspense & unallocated receipts',
      glAccountCode: '2150',
      side: 'credit',
      amountNgn: suspenseAmount,
      rowCount: suspenseRows,
      drillDownTab: 'debtors',
      status: suspenseAmount > 0 ? 'warn' : 'empty',
      detail: suspenseAmount > 0 ? 'Clear or match before month-end lock where possible' : '',
    }),
    packSource({
      id: 'debtors_inter_branch',
      module: 'debtors',
      label: 'Inter-branch payable',
      glAccountCode: '2800',
      side: 'credit',
      amountNgn: sectionTotal(reg, 'inter_branch_payable'),
      rowCount: sectionCount(reg, 'inter_branch_payable'),
      drillDownTab: 'interBranch',
    }),
  ];

  if (legacyAmount > 0) {
    sources.push(
      packSource({
        id: 'debtors_legacy_inherited',
        module: 'debtors',
        label: 'Inherited payables / credits (manual)',
        glAccountCode: '2000',
        side: 'credit',
        amountNgn: legacyAmount,
        rowCount: sectionCount(reg, 'legacy_inherited'),
        drillDownTab: 'debtors',
        status: 'warn',
        detail: 'Review categories on debtors register — may include overpayments',
      })
    );
  }

  return sources;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
function rollupFixedAssetSources(db, branchScope) {
  const { assets = [] } = listFixedAssets(db, branchScope);
  const active = assets.filter((a) => String(a.status || 'active') === 'active');
  /** @type {Record<string, { cost: number; accDep: number; count: number }>} */
  const byGl = {};
  for (const a of active) {
    const code = ASSET_CATEGORY_TO_GL[String(a.category || 'other').toLowerCase()] || '1502';
    if (!byGl[code]) byGl[code] = { cost: 0, accDep: 0, count: 0 };
    byGl[code].cost += roundMoney(a.costNgn);
    byGl[code].accDep += roundMoney(a.accumulatedDepreciationNgn);
    byGl[code].count += 1;
  }

  const sources = [];
  for (const [code, v] of Object.entries(byGl)) {
    if (v.cost <= 0) continue;
    sources.push(
      packSource({
        id: `fixed_assets_${code}`,
        module: 'fixed_assets',
        label: `Fixed assets (${code})`,
        glAccountCode: code,
        side: 'debit',
        amountNgn: v.cost,
        rowCount: v.count,
        drillDownTab: 'assets',
      })
    );
  }

  const totalAccDep = Object.values(byGl).reduce((s, v) => s + v.accDep, 0);
  if (totalAccDep > 0) {
    sources.push(
      packSource({
        id: 'fixed_assets_acc_dep',
        module: 'fixed_assets',
        label: 'Accumulated depreciation (opening)',
        glAccountCode: '1398',
        side: 'credit',
        amountNgn: totalAccDep,
        rowCount: active.length,
        drillDownTab: 'assets',
        detail: 'Opening accumulated depreciation from asset register',
      })
    );
  }

  if (!sources.length) {
    sources.push(
      packSource({
        id: 'fixed_assets_empty',
        module: 'fixed_assets',
        label: 'Fixed assets',
        glAccountCode: '1500',
        side: 'debit',
        amountNgn: 0,
        rowCount: 0,
        drillDownTab: 'assets',
        status: 'warn',
        detail: 'No active fixed assets — enter assets on Fixed assets tab',
      })
    );
  }

  return sources;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
function rollupTreasurySources(db, branchScope) {
  const accounts = listTreasuryAccounts(db, branchScope);
  if (!accounts.length) {
    return [
      packSource({
        id: 'treasury_empty',
        module: 'treasury',
        label: 'Cash per bank',
        glAccountCode: '1001',
        side: 'debit',
        amountNgn: 0,
        rowCount: 0,
        drillDownTab: 'reconciliation',
        status: 'warn',
        detail: 'Confirm treasury balances after reconciliation',
      }),
    ];
  }

  return accounts.map((ta) => {
    ensureTreasuryCashGlAccount(db, ta.id);
    const code = String(1000 + Number(ta.id));
    const bal = roundMoney(ta.balance ?? ta.openingBalanceNgn ?? 0);
    return packSource({
      id: `treasury_${ta.id}`,
      module: 'treasury',
      label: `Cash — ${ta.name || ta.bankName || `Account ${ta.id}`}`,
      glAccountCode: code,
      side: 'debit',
      amountNgn: bal,
      rowCount: 1,
      drillDownTab: 'reconciliation',
      detail: 'Treasury book balance — confirm on Reconciliation tab',
    });
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} inventoryPeriodKey
 * @param {'ALL' | string} branchScope
 */
function rollupInventorySource(db, inventoryPeriodKey, branchScope) {
  const periodEnd = lastDayOfMonth(inventoryPeriodKey);
  if (!periodEnd) {
    return packSource({
      id: 'inventory_invalid_period',
      module: 'stock_register',
      label: 'Raw materials inventory',
      glAccountCode: '1300',
      side: 'debit',
      amountNgn: 0,
      status: 'fail',
      detail: 'Invalid inventory period key',
    });
  }

  let branchIds = [];
  if (branchScope && branchScope !== 'ALL') {
    branchIds = [branchScope];
  } else {
    try {
      branchIds = listBranches(db).map((b) => b.id).filter(Boolean);
    } catch {
      branchIds = [];
    }
  }

  let totalValue = 0;
  let branchReady = 0;
  let branchWarn = 0;
  const warnings = [];

  for (const bid of branchIds) {
    const built = buildStockRegisterForBranch(db, bid, periodEnd, { viewMode: 'procurement' });
    if (!built.ok) {
      branchWarn += 1;
      warnings.push(`${bid}: stock register not available`);
      continue;
    }
    const wf = built.workflow;
    const status = String(wf?.status || '').toLowerCase();
    if (!wf?.procurementCostedAtISO && status !== 'procurement_costed' && status !== 'md_approved') {
      branchWarn += 1;
      warnings.push(`${bid}: May register not procurement-costed`);
    } else {
      branchReady += 1;
    }
    totalValue += roundMoney(built.register?.summary?.totalClosingValueNgn ?? 0);
  }

  let status = 'ok';
  if (branchIds.length && branchReady === 0) status = 'fail';
  if (branchIds.length && branchWarn > 0 && branchReady < branchIds.length) status = status === 'fail' ? 'fail' : 'warn';
  if (totalValue <= 0 && branchIds.length) status = status === 'fail' ? 'fail' : 'warn';

  return packSource({
    id: 'inventory_stock_register',
    module: 'stock_register',
    label: `Inventory (${inventoryPeriodKey} close)`,
    glAccountCode: '1300',
    side: 'debit',
    amountNgn: totalValue,
    rowCount: branchIds.length,
    drillDownTab: 'costing',
    status,
    detail:
      warnings.length > 0
        ? warnings.join('; ')
        : `Stock register closing value for ${inventoryPeriodKey}`,
  });
}

/**
 * GRNI diagnostic for opening pack — not auto-posted; HoA reviews gap.
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 * @param {string} periodKey
 */
function rollupGrniDiagnostic(db, branchScope, periodKey) {
  const align = buildApInventoryGlAlignmentReport(db, {
    period: periodKey,
    branchId: branchScope !== 'ALL' ? branchScope : null,
  });
  if (align.status === 'disabled') {
    return packSource({
      id: 'grni_diagnostic',
      module: 'ap2_diagnostic',
      label: 'GRNI / received-not-paid',
      glAccountCode: '2100',
      side: 'credit',
      amountNgn: 0,
      status: 'empty',
      detail: 'Enable AP_GL_ALIGNMENT_DIAGNOSTICS for GRNI tie-out.',
      drillDownTab: 'debtors',
    });
  }
  const rnp = roundMoney(align.summary?.receivedNotPaidNgn ?? 0);
  const apCheck = (align.checks || []).find((c) => c.id === 'ap_vs_grni_2100');
  const delta = roundMoney(apCheck?.differenceNgn ?? rnp);
  return packSource({
    id: 'grni_diagnostic',
    module: 'ap2_diagnostic',
    label: 'GRNI / received-not-paid (diagnostic)',
    glAccountCode: '2100',
    side: 'credit',
    amountNgn: 0,
    rowCount: align.summary?.missingCostCount ?? 0,
    status: Math.abs(delta) > 50_000 || rnp > 50_000 ? 'warn' : 'ok',
    detail: `Operational received-not-paid ₦${rnp.toLocaleString()} — not auto-posted; review on Debtors / Supplier AP.`,
    drillDownTab: 'debtors',
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} payrollPeriodKey
 */
function rollupPayrollSources(db, payrollPeriodKey) {
  if (!tableExists(db, 'hr_payroll_runs')) {
    return [
      packSource({
        id: 'payroll_na',
        module: 'payroll',
        label: 'Payroll liabilities',
        glAccountCode: '2200',
        side: 'credit',
        amountNgn: 0,
        status: 'empty',
      }),
    ];
  }

  let net = 0;
  let paye = 0;
  let pension = 0;
  let runCount = 0;

  const runs = db
    .prepare(
      `SELECT id FROM hr_payroll_runs WHERE period_yyyymm = ? AND status IN ('locked','paid')`
    )
    .all(payrollPeriodKey);

  for (const r of runs) {
    const st = payrollGlStatusForRun(db, r.id);
    if (st.accrualPosted) continue;
    const amounts = computePayrollRunGlAmounts(db, r.id);
    runCount += 1;
    net += roundMoney(amounts?.netCr ?? 0);
    paye += roundMoney(amounts?.taxCr ?? 0);
    pension += roundMoney(amounts?.penCr ?? 0);
  }

  const total = net + paye + pension;
  if (total <= 0) {
    return [
      packSource({
        id: 'payroll_empty',
        module: 'payroll',
        label: 'Payroll accrual (unposted)',
        glAccountCode: '2200',
        side: 'credit',
        amountNgn: 0,
        rowCount: runCount,
        drillDownTab: 'payroll',
        status: 'empty',
        detail: 'No unposted payroll accrual for period',
      }),
    ];
  }

  const detail = `Net ${net.toLocaleString()} + PAYE ${paye.toLocaleString()} + pension ${pension.toLocaleString()} — post accrual from Payroll tab`;
  /** @type {ReturnType<typeof packSource>[]} */
  const sources = [];
  if (net > 0) {
    sources.push(
      packSource({
        id: 'payroll_2200',
        module: 'payroll',
        label: 'Net payroll payable (unposted accrual)',
        glAccountCode: '2200',
        side: 'credit',
        amountNgn: net,
        rowCount: runCount,
        drillDownTab: 'payroll',
        status: 'warn',
        detail,
      })
    );
  }
  if (paye > 0) {
    sources.push(
      packSource({
        id: 'payroll_2300',
        module: 'payroll',
        label: 'PAYE payable (unposted accrual)',
        glAccountCode: '2300',
        side: 'credit',
        amountNgn: paye,
        rowCount: runCount,
        drillDownTab: 'payroll',
        status: 'warn',
        detail,
      })
    );
  }
  if (pension > 0) {
    sources.push(
      packSource({
        id: 'payroll_2400',
        module: 'payroll',
        label: 'Pension payable (unposted accrual)',
        glAccountCode: '2400',
        side: 'credit',
        amountNgn: pension,
        rowCount: runCount,
        drillDownTab: 'payroll',
        status: 'warn',
        detail,
      })
    );
  }
  return sources;
}

/**
 * @param {object[]} sources
 * @param {number} capitalNgn
 */
function buildProposedJournalLines(sources, capitalNgn = 0) {
  /** @type {Array<{ accountCode: string; debitNgn?: number; creditNgn?: number; memo: string }>} */
  const lines = [];

  for (const s of sources) {
    if (s.amountNgn <= 0) continue;
    if (s.side === 'debit') {
      lines.push({ accountCode: s.glAccountCode, debitNgn: s.amountNgn, memo: s.label });
    } else {
      lines.push({ accountCode: s.glAccountCode, creditNgn: s.amountNgn, memo: s.label });
    }
  }

  const cap = roundMoney(capitalNgn);
  if (cap > 0) {
    lines.push({ accountCode: '3100', creditNgn: cap, memo: "Owner's capital (cutover)" });
  }

  let debits = 0;
  let credits = 0;
  for (const l of lines) {
    debits += roundMoney(l.debitNgn);
    credits += roundMoney(l.creditNgn);
  }

  const plug = debits - credits;
  if (plug !== 0) {
    if (plug > 0) {
      lines.push({ accountCode: '3900', creditNgn: plug, memo: 'Retained earnings opening plug' });
    } else {
      lines.push({ accountCode: '3900', debitNgn: -plug, memo: 'Retained earnings opening plug' });
    }
  }

  return lines;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   branchScope?: 'ALL' | string;
 *   inventoryPeriodKey?: string;
 *   payrollPeriodKey?: string;
 *   capitalNgn?: number;
 *   summaryOnly?: boolean;
 * }} [opts]
 */
export function buildOpeningPackReport(db, opts = {}) {
  const branchScope = opts.branchScope || 'ALL';
  const summaryOnly = Boolean(opts.summaryOnly);
  const inventoryPeriodKey =
    opts.inventoryPeriodKey || priorPeriodKey(ACCOUNTING_OPENING_PERIOD_KEY) || '2026-05';
  const payrollPeriodKey = opts.payrollPeriodKey || inventoryPeriodKey;
  const capitalNgn = roundMoney(opts.capitalNgn ?? 0);

  const openingStatus = getOpeningBalanceStatus(db);
  if (openingStatus.posted) {
    return {
      ok: true,
      alreadyPosted: true,
      entryDateISO: ACCOUNTING_OPENING_DATE_ISO,
      inventoryPeriodKey,
      branchScope,
      sources: [],
      proposedJournal: { lines: [] },
      readinessScore: 100,
      blockers: [],
      warnings: ['Opening balance journal already posted.'],
      summary: 'Opening balance already posted to GL.',
    };
  }

  const sources = [
    ...rollupCreditorsSources(db, branchScope),
    ...rollupDebtorsSources(db, branchScope),
    ...rollupFixedAssetSources(db, branchScope),
    rollupInventorySource(db, inventoryPeriodKey, branchScope),
    ...rollupTreasurySources(db, branchScope),
    ...rollupPayrollSources(db, payrollPeriodKey),
    rollupGrniDiagnostic(db, branchScope, inventoryPeriodKey),
  ];

  const proposedLines = summaryOnly ? [] : buildProposedJournalLines(sources, capitalNgn);

  const blockers = [];
  const warnings = [];
  if (sources.some((s) => s.status === 'fail')) {
    blockers.push('One or more sources failed to load.');
  }
  if (sources.filter((s) => s.id === 'fixed_assets_empty' || s.id === 'treasury_empty').length) {
    warnings.push('Enter fixed assets and confirm treasury balances.');
  }
  if (sources.some((s) => s.id === 'inventory_stock_register' && s.status === 'fail')) {
    blockers.push('May stock register must be procurement-costed for all branches before posting inventory.');
  } else if (sources.some((s) => s.id === 'inventory_stock_register' && s.status === 'warn')) {
    warnings.push('Complete May stock register costing before posting inventory.');
  }
  if (sources.some((s) => s.id === 'grni_diagnostic' && s.status === 'warn')) {
    warnings.push('GRNI / received-not-paid gap — review Supplier AP before cutover.');
  }

  let debits = 0;
  let credits = 0;
  if (!summaryOnly) {
    for (const l of proposedLines) {
      debits += roundMoney(l.debitNgn);
      credits += roundMoney(l.creditNgn);
    }
    if (debits !== credits) {
      blockers.push('Proposed journal does not balance.');
    }
  }

  const scored = sources.filter((s) => s.status === 'ok' || s.status === 'empty').length;
  const readinessScore = sources.length ? Math.round((scored / sources.length) * 100) : 0;

  return {
    ok: true,
    alreadyPosted: false,
    asAtISO: lastDayOfMonth(inventoryPeriodKey),
    entryDateISO: ACCOUNTING_OPENING_DATE_ISO,
    inventoryPeriodKey,
    payrollPeriodKey,
    branchScope,
    capitalNgn,
    sources,
    proposedJournal: {
      lines: proposedLines,
      totalDebitsNgn: debits,
      totalCreditsNgn: credits,
      plugAccountCode: '3900',
    },
    readinessScore,
    blockers,
    warnings,
    summary:
      blockers.length > 0
        ? `${blockers.length} blocker(s) — resolve before posting.`
        : warnings.length > 0
          ? `Preview ready with ${warnings.length} warning(s). Review sources, enter capital, then post.`
          : 'Opening Pack balanced — review and post when HoA confirms.',
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchScope?: string; capitalNgn?: number; inventoryPeriodKey?: string; createdByUserId?: string }} payload
 */
export function postOpeningPackJournal(db, payload = {}) {
  const report = buildOpeningPackReport(db, {
    branchScope: payload.branchScope || 'ALL',
    capitalNgn: payload.capitalNgn,
    inventoryPeriodKey: payload.inventoryPeriodKey,
  });

  if (report.alreadyPosted) {
    return { ok: true, duplicate: true, message: 'Opening balance already posted.' };
  }
  if (report.blockers?.length) {
    return { ok: false, error: report.blockers.join(' ') };
  }
  if (!report.proposedJournal?.lines?.length) {
    return { ok: false, error: 'No journal lines to post.' };
  }

  return postOpeningBalanceJournal(db, {
    entryDateISO: ACCOUNTING_OPENING_DATE_ISO,
    sourceId: ACCOUNTING_OPENING_SOURCE_ID,
    branchId: payload.branchScope && payload.branchScope !== 'ALL' ? payload.branchScope : null,
    createdByUserId: payload.createdByUserId ?? null,
    memo: `Opening balance pack ${ACCOUNTING_OPENING_DATE_ISO}`,
    lines: report.proposedJournal.lines,
  });
}

export {
  rollupCreditorsSources,
  rollupDebtorsSources,
  rollupInventorySource,
  buildProposedJournalLines,
  ASSET_CATEGORY_TO_GL,
};

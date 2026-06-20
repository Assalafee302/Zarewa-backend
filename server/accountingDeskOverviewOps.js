/**
 * Single fast payload for Accounting Desk Overview — avoids duplicate opening-pack / close / tie-out work.
 */
import { getOpeningBalanceStatus } from './accountingPostingOps.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import { buildOpeningPackReport } from './accountingOpeningPackOps.js';
import { getAccountingStatementsPack } from './accountingStatementsOps.js';
import { buildMonthEndCloseChecklist } from './accountingCloseOps.js';
import { buildCutoverActionPlan } from './accountingCutoverPlanOps.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} periodKey
 * @param {'ALL' | string} branchScope
 * @param {object} [trialExceptions]
 */
export function buildAccountingDeskOverview(db, periodKey, branchScope = 'ALL', trialExceptions = null) {
  const opening = getOpeningBalanceStatus(db);
  const flags = readFinanceFeatureFlags();
  const pack = buildOpeningPackReport(db, { branchScope, summaryOnly: true });
  const statements = getAccountingStatementsPack(db, periodKey, branchScope, { summaryOnly: true });
  const close = buildMonthEndCloseChecklist(db, periodKey, branchScope, {
    trialExceptions,
    light: true,
  });
  const cutoverPlan = buildCutoverActionPlan(db, branchScope, { pack, skipUnlinkedScan: true });

  const exceptionTotal = (() => {
    const ex = trialExceptions?.exceptions || trialExceptions || {};
    return (
      (Number(ex.pendingReceiptClearance) || 0) +
      (Number(ex.receiptBankAmountMismatch) || 0) +
      (Number(ex.treasuryMovementWithoutFinanceSettlement) || 0) +
      (Number(ex.openDeliveriesWouldBlockOnPayment) || 0)
    );
  })();

  return {
    ok: true,
    periodKey,
    branchScope,
    label: 'management_draft',
    exceptions: trialExceptions,
    exceptionTotal,
    opening,
    flags: {
      accountingPolicyV1ReceiptGl: flags.accountingPolicyV1ReceiptGl,
      accountingPolicyV1ProductionRelease: flags.accountingPolicyV1ProductionRelease,
      accountingPolicyV1Diagnostics: flags.accountingPolicyV1Diagnostics,
    },
    pack: pack.ok ? pack : null,
    statements: statements.ok ? statements : null,
    close: close.ok ? close : null,
    cutoverPlan: cutoverPlan.ok ? cutoverPlan : null,
  };
}

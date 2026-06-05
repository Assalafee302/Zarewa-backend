/**
 * Phase B3a — trial exception counts & role adoption (SELECT only).
 */
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import { countAccountingPolicyV1Diagnostics } from './accountingPolicyV1Diagnostics.js';

/**
 * Use the app's MySQL worker (`db.prepare`) or a mysql2/promise connection.
 * @param {unknown} source
 */
export function wrapFinanceQuerySource(source) {
  if (source && typeof source.prepare === 'function') {
    return {
      async query(sql, args = []) {
        const rows = source.prepare(sql).all(...args);
        return [rows];
      },
      async end() {},
    };
  }
  return source;
}

async function q(conn, sql, args = []) {
  const [rows] = await conn.query(sql, args);
  return rows;
}

async function scalar(conn, sql, args = []) {
  const rows = await q(conn, sql, args);
  const row = rows[0] || {};
  const k = Object.keys(row)[0];
  return row[k];
}

async function columnExists(conn, table, column) {
  const n = await scalar(
    conn,
    `SELECT COUNT(*) AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return Number(n) > 0;
}

async function tableExists(conn, name) {
  const n = await scalar(
    conn,
    `SELECT COUNT(*) AS c FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [name]
  );
  return Number(n) > 0;
}

/**
 * @param {string | null | undefined} branchId
 * @param {boolean} hasSrBranch
 */
function receiptBranchFilter(branchId, hasSrBranch) {
  const bid = String(branchId || '').trim();
  if (!bid || bid === 'ALL' || !hasSrBranch) return { clause: '', args: [] };
  return { clause: ' AND sr.branch_id = ? ', args: [bid] };
}

/**
 * @param {import('mysql2/promise').Connection | ReturnType<import('./mysqlDatabase.js').createMysqlDatabase>} source
 * @param {{ branchId?: string | null }} [opts]
 */
export async function buildFinanceTrialExceptionSummary(source, opts = {}) {
  const conn = wrapFinanceQuerySource(source);
  const branchId = opts.branchId ?? null;
  const flags = readFinanceFeatureFlags();
  const hasSrBranch = await columnExists(conn, 'sales_receipts', 'branch_id');
  const hasFinSettle = await columnExists(conn, 'sales_receipts', 'finance_reconciliation_saved_at_iso');
  const hasBankRecv = await columnExists(conn, 'sales_receipts', 'bank_received_amount_ngn');
  const hasFinByUser = await columnExists(conn, 'sales_receipts', 'finance_reconciliation_saved_by_user_id');
  const taHasBranch = await columnExists(conn, 'treasury_accounts', 'branch_id');
  const br = receiptBranchFilter(branchId, hasSrBranch);

  const pendingClearanceSql = hasFinSettle
    ? `SELECT COUNT(*) FROM sales_receipts sr
       WHERE (sr.finance_reconciliation_saved_at_iso IS NULL OR TRIM(sr.finance_reconciliation_saved_at_iso) = '')
         AND UPPER(TRIM(COALESCE(sr.status,''))) != 'REVERSED' ${br.clause}`
    : `SELECT COUNT(*) FROM sales_receipts sr
       WHERE UPPER(TRIM(COALESCE(sr.status,''))) != 'REVERSED' ${br.clause}`;

  const exceptions = {
    pendingReceiptClearance: Number(await scalar(conn, pendingClearanceSql, br.args)),
    receiptBankAmountMismatch: 0,
    receiptWithoutTreasuryMovement: Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM sales_receipts sr
         WHERE UPPER(TRIM(COALESCE(sr.status,''))) != 'REVERSED' ${br.clause}
           AND NOT EXISTS (
             SELECT 1 FROM treasury_movements tm
             WHERE tm.source_kind IN ('RECEIPT','LEDGER_RECEIPT','SALES_RECEIPT')
               AND (tm.source_id = sr.id OR tm.reference = sr.id OR tm.counterparty_id = sr.quotation_ref)
           )`,
        br.args
      )
    ),
    treasuryMovementWithoutFinanceSettlement: 0,
    approvedUnpaidPaymentRequests: Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM payment_requests
         WHERE TRIM(COALESCE(approval_status,'')) = 'Approved'
           AND COALESCE(paid_amount_ngn,0) < COALESCE(amount_requested_ngn,0)`
      )
    ),
    approvedUnpaidRefunds: Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM customer_refunds
         WHERE TRIM(COALESCE(status,'')) = 'Approved'
           AND COALESCE(paid_amount_ngn,0) < COALESCE(approved_amount_ngn, amount_ngn, 0)`
      )
    ),
    sameDisplayNamePaymentApprovePay: Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM payment_requests
         WHERE TRIM(COALESCE(approval_status,'')) = 'Approved'
           AND COALESCE(paid_amount_ngn,0) > 0
           AND TRIM(COALESCE(approved_by,'')) != ''
           AND TRIM(COALESCE(paid_by,'')) != ''
           AND LOWER(TRIM(approved_by)) = LOWER(TRIM(paid_by))`
      )
    ),
    sameDisplayNameRefundApprovePay: Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM customer_refunds
         WHERE TRIM(COALESCE(status,'')) IN ('Approved','Paid')
           AND TRIM(COALESCE(approved_by,'')) != '' AND TRIM(COALESCE(paid_by,'')) != ''
           AND LOWER(TRIM(approved_by)) = LOWER(TRIM(paid_by))`
      )
    ),
    sameUserRefundRequestedAndApproved: 0,
    treasuryBalanceDriftCount: 0,
    reconciliationMaterialMismatch: false,
    reconciliationMaterialMismatchPeriod: null,
    unresolvedHighRiskCount: 0,
  };

  if (hasBankRecv) {
    exceptions.receiptBankAmountMismatch = Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM sales_receipts sr
         WHERE bank_received_amount_ngn IS NOT NULL
           AND ABS(COALESCE(bank_received_amount_ngn,0) - COALESCE(amount_ngn,0)) > 100
           AND UPPER(TRIM(COALESCE(sr.status,''))) != 'REVERSED' ${br.clause}`,
        br.args
      )
    );
  }

  if (hasFinSettle) {
    exceptions.treasuryMovementWithoutFinanceSettlement = Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM sales_receipts sr
         WHERE EXISTS (
           SELECT 1 FROM treasury_movements tm
           WHERE tm.type IN ('RECEIPT_IN','ADVANCE_IN') AND tm.amount_ngn > 0
             AND (tm.source_id = sr.id OR tm.reference LIKE CONCAT('%', sr.id, '%'))
         )
         AND (sr.finance_reconciliation_saved_at_iso IS NULL OR TRIM(sr.finance_reconciliation_saved_at_iso) = '')
         AND UPPER(TRIM(COALESCE(sr.status,''))) != 'REVERSED' ${br.clause}`,
        br.args
      )
    );
  }

  if (await columnExists(conn, 'customer_refunds', 'requested_by_user_id') && (await tableExists(conn, 'approval_actions'))) {
    exceptions.sameUserRefundRequestedAndApproved = Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM customer_refunds r
         INNER JOIN approval_actions aa ON aa.entity_kind = 'refund' AND aa.entity_id = r.refund_id AND aa.action = 'review'
         WHERE r.requested_by_user_id IS NOT NULL AND r.requested_by_user_id = aa.acted_by_user_id`
      )
    );
  }

  const driftSql = taHasBranch
    ? `SELECT ta.id FROM treasury_accounts ta
       LEFT JOIN treasury_movements tm ON tm.treasury_account_id = ta.id
       GROUP BY ta.id, ta.branch_id, ta.balance
       HAVING ABS(ta.balance - COALESCE(SUM(tm.amount_ngn),0)) > 1000`
    : `SELECT ta.id FROM treasury_accounts ta
       LEFT JOIN treasury_movements tm ON tm.treasury_account_id = ta.id
       GROUP BY ta.id, ta.balance
       HAVING ABS(ta.balance - COALESCE(SUM(tm.amount_ngn),0)) > 1000`;
  const driftRows = await q(conn, driftSql);
  exceptions.treasuryBalanceDriftCount = driftRows.length;

  const now = new Date();
  const hasLedger = await tableExists(conn, 'ledger_entries');
  if (hasLedger) {
    for (let i = 0; i < 6; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
      const endIso = end.toISOString().slice(0, 10);
      const srSum = await scalar(
        conn,
        `SELECT COALESCE(SUM(amount_ngn),0) FROM sales_receipts
         WHERE date_iso >= ? AND date_iso <= ?
           AND (status IS NULL OR UPPER(TRIM(status)) != 'REVERSED')`,
        [start, endIso]
      );
      const leSum = await scalar(
        conn,
        `SELECT COALESCE(SUM(CASE WHEN type IN ('RECEIPT','ADVANCE_IN') THEN amount_ngn
             WHEN type = 'RECEIPT_REVERSAL' THEN -amount_ngn ELSE 0 END),0)
         FROM ledger_entries WHERE substr(at_iso,1,10) >= ? AND substr(at_iso,1,10) <= ?`,
        [start, endIso]
      );
      const diff = Math.abs(Number(srSum) - Number(leSum));
      if (diff > 50_000) {
        exceptions.reconciliationMaterialMismatch = true;
        exceptions.reconciliationMaterialMismatchPeriod = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        break;
      }
    }
  }

  exceptions.unresolvedHighRiskCount =
    exceptions.pendingReceiptClearance +
    exceptions.receiptWithoutTreasuryMovement +
    exceptions.treasuryMovementWithoutFinanceSettlement +
    exceptions.approvedUnpaidPaymentRequests +
    exceptions.approvedUnpaidRefunds +
    (exceptions.reconciliationMaterialMismatch ? 1 : 0) +
    Math.min(exceptions.treasuryBalanceDriftCount, 5);

  const today = now.toISOString().slice(0, 10);
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 6);
  const weekStartIso = weekStart.toISOString().slice(0, 10);

  let confirmedToday = 0;
  let confirmedThisWeek = 0;
  if (hasFinSettle) {
    confirmedToday = Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM sales_receipts sr
         WHERE finance_reconciliation_saved_at_iso IS NOT NULL
           AND TRIM(finance_reconciliation_saved_at_iso) != ''
           AND substr(finance_reconciliation_saved_at_iso,1,10) = ? ${br.clause}`,
        [today, ...br.args]
      )
    );
    confirmedThisWeek = Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM sales_receipts sr
         WHERE finance_reconciliation_saved_at_iso IS NOT NULL
           AND TRIM(finance_reconciliation_saved_at_iso) != ''
           AND substr(finance_reconciliation_saved_at_iso,1,10) >= ? ${br.clause}`,
        [weekStartIso, ...br.args]
      )
    );
  }

  const roleAdoption = {
    receiptConfirmationsByRole: [],
    paymentApprovalsByRole: [],
    paymentPayoutsByRole: [],
    refundApprovalsByRole: [],
    refundPayoutsByRole: [],
    cashierActiveUserCount: 0,
    financeManagerReceiptConfirmationCount: 0,
    financeManagerOverrideNote:
      'Finance manager may still confirm receipts during trial onboarding; not blocked in B3a.',
  };

  if (hasFinByUser) {
    const byRole = await q(
      conn,
      `SELECT COALESCE(u.role_key,'(no_user)') AS roleKey, COUNT(*) AS c
       FROM sales_receipts sr
       LEFT JOIN app_users u ON u.id = sr.finance_reconciliation_saved_by_user_id
       WHERE finance_reconciliation_saved_at_iso IS NOT NULL AND TRIM(finance_reconciliation_saved_at_iso) != ''
       GROUP BY COALESCE(u.role_key,'(no_user)') ORDER BY c DESC`
    );
    roleAdoption.receiptConfirmationsByRole = byRole.map((r) => ({
      roleKey: r.roleKey,
      count: Number(r.c),
    }));
    roleAdoption.financeManagerReceiptConfirmationCount = Number(
      byRole.find((r) => r.roleKey === 'finance_manager')?.c ?? 0
    );
  }

  if (await tableExists(conn, 'audit_log')) {
    const mapAudit = async (action) => {
      const rows = await q(
        conn,
        `SELECT COALESCE(u.role_key,'unknown') AS roleKey, COUNT(*) AS c
         FROM audit_log a
         LEFT JOIN app_users u ON u.id = a.actor_user_id
         WHERE a.action = ?
         GROUP BY COALESCE(u.role_key,'unknown') ORDER BY c DESC`,
        [action]
      );
      return rows.map((r) => ({ roleKey: r.roleKey, count: Number(r.c) }));
    };
    roleAdoption.paymentApprovalsByRole = await mapAudit('payment_request.review');
    roleAdoption.paymentPayoutsByRole = await mapAudit('payment_request.pay');
    roleAdoption.refundApprovalsByRole = await mapAudit('refund.review');
    roleAdoption.refundPayoutsByRole = await mapAudit('refund.pay');
  }

  const cashierUsers = await q(
    conn,
    `SELECT COUNT(*) AS c FROM app_users
     WHERE role_key = 'cashier' AND COALESCE(status,'active') IN ('active','')`
  );
  roleAdoption.cashierActiveUserCount = Number(cashierUsers[0]?.c ?? 0);

  const dualControlWarnings = {
    paymentSameDisplayName: exceptions.sameDisplayNamePaymentApprovePay,
    refundSameDisplayName: exceptions.sameDisplayNameRefundApprovePay,
    refundSameUserRequestAndApprove: exceptions.sameUserRefundRequestedAndApproved,
    enforcementActive: flags.enforceDualControlPayments,
    message: flags.enforceDualControlPayments
      ? 'Dual control enforcement is ON — same-user approve/pay may be blocked.'
      : 'Trial phase: same-user approve/pay shown as warnings only; not blocked.',
  };

  /** @type {Record<string, number> | null} */
  let accountingPolicyV1 = null;
  if (flags.accountingPolicyV1Diagnostics && source && typeof source.prepare === 'function') {
    try {
      accountingPolicyV1 = countAccountingPolicyV1Diagnostics(source, branchId && branchId !== 'ALL' ? branchId : 'ALL');
    } catch {
      accountingPolicyV1 = null;
    }
  }

  return {
    ok: true,
    phase: flags.phase,
    generatedAt: new Date().toISOString(),
    branchScope: branchId && branchId !== 'ALL' ? String(branchId) : null,
    trialPhaseNote:
      'First live month: onboarding and training usage. Exception counts include corrections and finance-manager assist — review before enforcing strict RBAC.',
    flags,
    exceptions,
    dualControlWarnings,
    confirmedReceipts: { today: confirmedToday, thisWeek: confirmedThisWeek },
    roleAdoption,
    accountingPolicyV1,
    deliveryPaymentGateMode: flags.deliveryPaymentGateMode,
    accountingPolicyV1Note: accountingPolicyV1
      ? flags.deliveryPaymentGateMode === 'enforce'
        ? 'Policy v1 delivery payment gate is ENFORCING blocks on confirm. GL timing unchanged until AP1c.'
        : flags.deliveryPaymentGateMode === 'warn'
          ? 'Policy v1 delivery gate in WARN mode: confirm succeeds but audit + API warnings when unpaid.'
          : 'Read-only Policy v1 indicators (AP1a). Set DELIVERY_PAYMENT_GATE=1 for warn mode.'
      : null,
  };
}

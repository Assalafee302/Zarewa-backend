/**
 * Read-only finance/cashier/accounting aggregates (SELECT only). No PII in output.
 */
import mysql from 'mysql2/promise';
import crypto from 'node:crypto';
import { refundPayableQuotationWhereSql } from '../shared/lib/quotationRefundsBlocked.js';
import { loadProjectEnv } from './loadProjectEnv.js';
import { mysqlConfigFromEnv, databaseLabel } from './mysqlDatabase.js';

export const ROUND_BUCKET = (n) => {
  const x = Math.abs(Number(n) || 0);
  if (x < 1_000_000) return '<₦1M';
  if (x < 10_000_000) return '₦1M–₦10M';
  if (x < 100_000_000) return '₦10M–₦100M';
  if (x < 1_000_000_000) return '₦100M–₦1B';
  return '₦1B+';
};

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

async function tableExists(conn, name) {
  const n = await scalar(
    conn,
    `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
    [name]
  );
  return Number(n) > 0;
}

async function columnExists(conn, table, column) {
  const n = await scalar(
    conn,
    `SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return Number(n) > 0;
}

/**
 * @param {import('mysql2/promise').Connection} conn
 * @param {{ target?: string }} [meta]
 */
export async function buildFinanceLiveProfileReport(conn, meta = {}) {
  const out = {
    ok: true,
    target: meta.target || 'mysql',
    generatedAt: new Date().toISOString().slice(0, 19) + 'Z',
  };

  const branches = await q(conn, `SELECT id, COALESCE(active,1) AS active FROM branches ORDER BY id`);
  out.branches = {
    count: branches.length,
    activeCount: branches.filter((b) => Number(b.active) === 1).length,
    ids: branches.map((b) => String(b.id)),
  };

  const usersByRole = await q(
    conn,
    `SELECT role_key AS roleKey, COUNT(*) AS userCount,
            SUM(CASE WHEN COALESCE(status,'active') IN ('active','') OR status IS NULL THEN 1 ELSE 0 END) AS activeCount
     FROM app_users GROUP BY role_key ORDER BY userCount DESC`
  );
  out.usersByRole = usersByRole.map((r) => ({
    roleKey: r.roleKey,
    userCount: Number(r.userCount),
    activeCount: Number(r.activeCount),
  }));

  const broadPermUsers = await q(
    conn,
    `SELECT role_key AS roleKey, COUNT(*) AS c FROM app_users
     WHERE permissions_json LIKE '%"*"%' OR permissions_json LIKE '%finance.post%'
     GROUP BY role_key`
  );
  out.usersWithWildcardOrCustomFinance = broadPermUsers.map((r) => ({
    roleKey: r.roleKey,
    count: Number(r.c),
  }));

  if (await tableExists(conn, 'audit_log')) {
    const auditByAction = await q(
      conn,
      `SELECT action, COUNT(*) AS c FROM audit_log
       WHERE action IN (
         'ledger.receipt','payment_request.create','payment_request.review','payment_request.pay',
         'refund.create','refund.review','refund.pay','treasury.transfer','gl.journal'
       )
       GROUP BY action ORDER BY c DESC`
    );
    out.auditActionCounts = auditByAction.map((r) => ({ action: r.action, count: Number(r.c) }));

    const roleActivity = await q(
      conn,
      `SELECT u.role_key AS roleKey, a.action, COUNT(*) AS c
       FROM audit_log a
       LEFT JOIN app_users u ON u.id = a.actor_user_id
       WHERE a.action IN (
         'ledger.receipt','payment_request.review','payment_request.pay',
         'refund.review','refund.pay'
       )
       GROUP BY u.role_key, a.action
       ORDER BY c DESC
       LIMIT 40`
    );
    out.roleAuditActivity = roleActivity.map((r) => ({
      roleKey: r.roleKey || 'unknown',
      action: r.action,
      count: Number(r.c),
    }));
  }

  const cashierBranchSpan = await q(
    conn,
    `SELECT u.id, u.role_key AS roleKey,
            COUNT(DISTINCT COALESCE(u.workspace_branch_id, '')) AS branchHints
     FROM app_users u
     WHERE u.role_key = 'cashier'
     GROUP BY u.id, u.role_key`
  );
  out.cashierUsers = {
    count: cashierBranchSpan.length,
    multiBranchHintCount: cashierBranchSpan.filter((r) => Number(r.branchHints) > 1).length,
  };

  const hasSrBranch = await columnExists(conn, 'sales_receipts', 'branch_id');
  const hasFinSettle = await columnExists(conn, 'sales_receipts', 'finance_reconciliation_saved_at_iso');
  const hasBankRecv = await columnExists(conn, 'sales_receipts', 'bank_received_amount_ngn');

  let receiptStatusSql = `SELECT COUNT(*) AS total`;
  if (hasSrBranch) {
    receiptStatusSql = `
      SELECT COALESCE(branch_id,'(none)') AS branchId,
             COUNT(*) AS total,
             SUM(CASE WHEN UPPER(TRIM(COALESCE(status,''))) = 'REVERSED' THEN 1 ELSE 0 END) AS reversed,
             SUM(CASE WHEN ${
               hasFinSettle
                 ? `(finance_reconciliation_saved_at_iso IS NOT NULL AND TRIM(finance_reconciliation_saved_at_iso) != '')`
                 : '0'
             } THEN 1 ELSE 0 END) AS cleared,
             SUM(CASE WHEN ${
               hasFinSettle
                 ? `(finance_reconciliation_saved_at_iso IS NULL OR TRIM(finance_reconciliation_saved_at_iso) = '') AND UPPER(TRIM(COALESCE(status,''))) != 'REVERSED'`
                 : `UPPER(TRIM(COALESCE(status,''))) != 'REVERSED'`
             } THEN 1 ELSE 0 END) AS pendingClearance
      FROM sales_receipts GROUP BY COALESCE(branch_id,'(none)')`;
  }
  const receiptByBranch = await q(conn, receiptStatusSql);
  out.receipts = {
    byBranch: receiptByBranch.map((r) => ({
      branchId: r.branchId || '(all)',
      total: Number(r.total),
      pendingClearance: Number(r.pendingClearance ?? 0),
      cleared: Number(r.cleared ?? 0),
      reversed: Number(r.reversed ?? 0),
    })),
  };

  if (hasBankRecv) {
    out.receipts.bankReceivedDiffersFromAmount = Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM sales_receipts
         WHERE bank_received_amount_ngn IS NOT NULL
           AND ABS(COALESCE(bank_received_amount_ngn,0) - COALESCE(amount_ngn,0)) > 100
           AND UPPER(TRIM(COALESCE(status,''))) != 'REVERSED'`
      )
    );
  }

  out.receipts.withoutTreasuryMovement = Number(
    await scalar(
      conn,
      `SELECT COUNT(*) FROM sales_receipts sr
       WHERE UPPER(TRIM(COALESCE(sr.status,''))) != 'REVERSED'
         AND NOT EXISTS (
           SELECT 1 FROM treasury_movements tm
           WHERE tm.source_kind IN ('RECEIPT','LEDGER_RECEIPT','SALES_RECEIPT')
             AND (tm.source_id = sr.id OR tm.reference = sr.id OR tm.counterparty_id = sr.quotation_ref)
         )`
    )
  );

  if (hasFinSettle) {
    out.receipts.treasuryButNoFinanceSettlement = Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM sales_receipts sr
         WHERE EXISTS (
           SELECT 1 FROM treasury_movements tm
           WHERE tm.type IN ('RECEIPT_IN','ADVANCE_IN') AND tm.amount_ngn > 0
             AND (tm.source_id = sr.id OR tm.reference LIKE CONCAT('%', sr.id, '%'))
         )
         AND (finance_reconciliation_saved_at_iso IS NULL OR TRIM(finance_reconciliation_saved_at_iso) = '')
         AND UPPER(TRIM(COALESCE(sr.status,''))) != 'REVERSED'`
      )
    );
  }

  if (hasFinSettle && (await columnExists(conn, 'sales_receipts', 'finance_reconciliation_saved_by_user_id'))) {
    const byConfirmerRole = await q(
      conn,
      `SELECT COALESCE(u.role_key,'(no_user)') AS roleKey, COUNT(*) AS c
       FROM sales_receipts sr
       LEFT JOIN app_users u ON u.id = sr.finance_reconciliation_saved_by_user_id
       WHERE finance_reconciliation_saved_at_iso IS NOT NULL AND TRIM(finance_reconciliation_saved_at_iso) != ''
       GROUP BY COALESCE(u.role_key,'(no_user)') ORDER BY c DESC`
    );
    out.receipts.confirmationByRole = byConfirmerRole.map((r) => ({
      roleKey: r.roleKey,
      count: Number(r.c),
    }));
  }

  if (hasFinSettle && (await columnExists(conn, 'sales_receipts', 'date_iso'))) {
    const avgHours = await scalar(
      conn,
      `SELECT AVG(TIMESTAMPDIFF(HOUR, STR_TO_DATE(CONCAT(date_iso,' 12:00:00'), '%Y-%m-%d %H:%i:%s'),
               STR_TO_DATE(finance_reconciliation_saved_at_iso, '%Y-%m-%dT%H:%i:%s'))) AS h
       FROM sales_receipts
       WHERE finance_reconciliation_saved_at_iso IS NOT NULL AND TRIM(date_iso) != ''`
    );
    out.receipts.avgHoursPostToConfirmation =
      avgHours != null ? Math.round(Number(avgHours) * 10) / 10 : null;
  }

  const taHasBranch = await columnExists(conn, 'treasury_accounts', 'branch_id');
  out.treasury = {};
  if (taHasBranch) {
    const taByBranch = await q(
      conn,
      `SELECT branch_id AS branchId, COUNT(*) AS accountCount,
              SUM(CASE WHEN COALESCE(balance,0) < 0 THEN 1 ELSE 0 END) AS negativeBalanceAccounts
       FROM treasury_accounts GROUP BY branch_id`
    );
    const balanceByBranch = await q(
      conn,
      `SELECT branch_id AS branchId, SUM(COALESCE(balance,0)) AS bookBalanceNgn
       FROM treasury_accounts GROUP BY branch_id`
    );
    const balanceMap = new Map(balanceByBranch.map((r) => [String(r.branchId), Number(r.bookBalanceNgn)]));
    out.treasury.accountsByBranch = taByBranch.map((r) => ({
      branchId: r.branchId,
      accountCount: Number(r.accountCount),
      negativeBalanceAccounts: Number(r.negativeBalanceAccounts),
      bookBalanceBucket: ROUND_BUCKET(balanceMap.get(String(r.branchId)) ?? 0),
    }));
  } else {
    const taTotals = await q(
      conn,
      `SELECT COUNT(*) AS accountCount,
              SUM(CASE WHEN COALESCE(balance,0) < 0 THEN 1 ELSE 0 END) AS negativeBalanceAccounts,
              SUM(COALESCE(balance,0)) AS bookBalanceNgn
       FROM treasury_accounts`
    );
    const t = taTotals[0] || {};
    out.treasury.accountsByBranch = [
      {
        branchId: '(schema: no branch_id)',
        accountCount: Number(t.accountCount),
        negativeBalanceAccounts: Number(t.negativeBalanceAccounts),
        bookBalanceBucket: ROUND_BUCKET(t.bookBalanceNgn),
      },
    ];
  }

  const mvByType = await q(
    conn,
    `SELECT type, COUNT(*) AS c, SUM(amount_ngn) AS sumNgn FROM treasury_movements GROUP BY type ORDER BY c DESC`
  );
  out.treasury.movementsByType = mvByType.map((r) => ({
    type: r.type,
    count: Number(r.c),
    sumBucket: ROUND_BUCKET(r.sumNgn),
  }));
  out.treasury.movementsMissingSource = Number(
    await scalar(
      conn,
      `SELECT COUNT(*) FROM treasury_movements
       WHERE (source_kind IS NULL OR TRIM(source_kind) = '')
         OR (source_id IS NULL OR TRIM(source_id) = '')`
    )
  );

  const driftSql = taHasBranch
    ? `SELECT ta.id AS accountId, ta.branch_id AS branchId,
              ta.balance AS storedBalance,
              COALESCE(SUM(tm.amount_ngn),0) AS movementSum
       FROM treasury_accounts ta
       LEFT JOIN treasury_movements tm ON tm.treasury_account_id = ta.id
       GROUP BY ta.id, ta.branch_id, ta.balance
       HAVING ABS(ta.balance - COALESCE(SUM(tm.amount_ngn),0)) > 1000
       ORDER BY ABS(ta.balance - COALESCE(SUM(tm.amount_ngn),0)) DESC
       LIMIT 5`
    : `SELECT ta.id AS accountId, '(none)' AS branchId,
              ta.balance AS storedBalance,
              COALESCE(SUM(tm.amount_ngn),0) AS movementSum
       FROM treasury_accounts ta
       LEFT JOIN treasury_movements tm ON tm.treasury_account_id = ta.id
       GROUP BY ta.id, ta.balance
       HAVING ABS(ta.balance - COALESCE(SUM(tm.amount_ngn),0)) > 1000
       ORDER BY ABS(ta.balance - COALESCE(SUM(tm.amount_ngn),0)) DESC
       LIMIT 5`;
  const drift = await q(conn, driftSql);
  out.treasury.balanceDriftSample = drift.map((r, i) => ({
    sample: `Account_${i + 1}`,
    branchId: r.branchId,
    driftBucket: ROUND_BUCKET(Math.abs(Number(r.storedBalance) - Number(r.movementSum))),
  }));

  const prHasBranch = await columnExists(conn, 'payment_requests', 'branch_id');
  const prStatus = await q(
    conn,
    `SELECT COALESCE(approval_status,'(blank)') AS status, COUNT(*) AS c FROM payment_requests GROUP BY COALESCE(approval_status,'(blank)')`
  );
  out.paymentRequests = {
    byStatus: prStatus.map((r) => ({ status: r.status, count: Number(r.c) })),
    approvedUnpaid: Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM payment_requests
         WHERE TRIM(COALESCE(approval_status,'')) = 'Approved'
           AND COALESCE(paid_amount_ngn,0) < COALESCE(amount_requested_ngn,0)`
      )
    ),
  };

  if (prHasBranch) {
    const prByBranch = await q(
      conn,
      `SELECT branch_id AS branchId, COUNT(*) AS c FROM payment_requests GROUP BY branch_id`
    );
    out.paymentRequests.byBranch = prByBranch.map((r) => ({
      branchId: r.branchId,
      count: Number(r.c),
    }));
  }

  out.paymentRequests.withoutExpenseLink = Number(
    await scalar(
      conn,
      `SELECT COUNT(*) FROM payment_requests WHERE expense_id IS NULL OR TRIM(expense_id) = ''`
    )
  );

  const expCat = await q(
    conn,
    `SELECT COALESCE(e.category,'(none)') AS category, COUNT(*) AS c
     FROM payment_requests pr
     LEFT JOIN expenses e ON e.expense_id = pr.expense_id
     GROUP BY COALESCE(e.category,'(none)') ORDER BY c DESC LIMIT 12`
  );
  out.paymentRequests.topExpenseCategories = expCat.map((r) => ({
    category: r.category,
    count: Number(r.c),
  }));

  const prTiming = await q(
    conn,
    `SELECT
       AVG(DATEDIFF(STR_TO_DATE(approved_at_iso,'%Y-%m-%d'), STR_TO_DATE(request_date,'%Y-%m-%d'))) AS avgDaysToApprove,
       AVG(DATEDIFF(STR_TO_DATE(paid_at_iso,'%Y-%m-%d'), STR_TO_DATE(approved_at_iso,'%Y-%m-%d'))) AS avgDaysApproveToPay
     FROM payment_requests
     WHERE TRIM(COALESCE(approval_status,'')) = 'Approved'
       AND approved_at_iso IS NOT NULL AND request_date IS NOT NULL`
  );
  if (prTiming[0]) {
    out.paymentRequests.avgDaysRequestToApproval =
      prTiming[0].avgDaysToApprove != null ? Math.round(Number(prTiming[0].avgDaysToApprove) * 10) / 10 : null;
    out.paymentRequests.avgDaysApprovalToPayout =
      prTiming[0].avgDaysApproveToPay != null ? Math.round(Number(prTiming[0].avgDaysApproveToPay) * 10) / 10 : null;
  }

  out.paymentRequests.sameDisplayNameApproveAndPay = Number(
    await scalar(
      conn,
      `SELECT COUNT(*) FROM payment_requests
       WHERE TRIM(COALESCE(approval_status,'')) = 'Approved'
         AND COALESCE(paid_amount_ngn,0) > 0
         AND TRIM(COALESCE(approved_by,'')) != ''
         AND TRIM(COALESCE(paid_by,'')) != ''
         AND LOWER(TRIM(approved_by)) = LOWER(TRIM(paid_by))`
    )
  );

  const refStatus = await q(
    conn,
    `SELECT COALESCE(status,'(blank)') AS status, COUNT(*) AS c FROM customer_refunds GROUP BY COALESCE(status,'(blank)')`
  );
  out.refunds = {
    byStatus: refStatus.map((r) => ({ status: r.status, count: Number(r.c) })),
    approvedUnpaid: Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM customer_refunds
         WHERE TRIM(COALESCE(status,'')) = 'Approved'
           AND COALESCE(paid_amount_ngn,0) < COALESCE(approved_amount_ngn, amount_ngn, 0)
           AND ${refundPayableQuotationWhereSql('customer_refunds')}`
      )
    ),
  };

  if (await columnExists(conn, 'customer_refunds', 'branch_id')) {
    const refBranch = await q(
      conn,
      `SELECT branch_id AS branchId, COUNT(*) AS c FROM customer_refunds GROUP BY branch_id`
    );
    out.refunds.byBranch = refBranch.map((r) => ({ branchId: r.branchId, count: Number(r.c) }));
  }

  out.refunds.paidWithoutTreasuryMovement = Number(
    await scalar(
      conn,
      `SELECT COUNT(*) FROM customer_refunds r
       WHERE TRIM(COALESCE(status,'')) = 'Approved'
         AND COALESCE(paid_amount_ngn,0) >= COALESCE(approved_amount_ngn, amount_ngn, 0)
         AND NOT EXISTS (
           SELECT 1 FROM treasury_movements tm
           WHERE tm.type = 'REFUND_PAYOUT' AND tm.source_id = r.refund_id
         )`
    )
  );

  if (await columnExists(conn, 'customer_refunds', 'requested_by_user_id')) {
    out.refunds.sameUserRequestedAndApproved = Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM customer_refunds r
         INNER JOIN approval_actions aa ON aa.entity_kind = 'refund' AND aa.entity_id = r.refund_id AND aa.action = 'review'
         INNER JOIN app_users approver ON approver.id = aa.acted_by_user_id
         WHERE r.requested_by_user_id IS NOT NULL AND r.requested_by_user_id = aa.acted_by_user_id`
      )
    );
  }

  out.refunds.sameDisplayNameApproveAndPay = Number(
    await scalar(
      conn,
      `SELECT COUNT(*) FROM customer_refunds
       WHERE TRIM(COALESCE(status,'')) IN ('Approved','Paid')
         AND TRIM(COALESCE(approved_by,'')) != '' AND TRIM(COALESCE(paid_by,'')) != ''
         AND LOWER(TRIM(approved_by)) = LOWER(TRIM(paid_by))`
    )
  );

  const poStatus = await q(
    conn,
    `SELECT COALESCE(status,'(blank)') AS status, COUNT(*) AS c FROM purchase_orders GROUP BY COALESCE(status,'(blank)')`
  );
  out.procurement = {
    poByStatus: poStatus.map((r) => ({ status: r.status, count: Number(r.c) })),
    supplierPaymentMovements: Number(
      await scalar(
        conn,
        `SELECT COUNT(*) FROM treasury_movements WHERE type IN ('PO_SUPPLIER_PAYMENT','SUPPLIER_PAYMENT')`
      )
    ),
  };

  if (await columnExists(conn, 'accounts_payable', 'branch_id')) {
    const apOutstanding = await q(
      conn,
      `SELECT COALESCE(branch_id,'(none)') AS branchId,
              COUNT(*) AS lineCount,
              SUM(GREATEST(0, COALESCE(amount_ngn,0) - COALESCE(paid_ngn,0))) AS outstandingNgn
       FROM accounts_payable GROUP BY COALESCE(branch_id,'(none)')`
    );
    out.procurement.apOutstandingByBranch = apOutstanding.map((r) => ({
      branchId: r.branchId,
      lineCount: Number(r.lineCount),
      outstandingBucket: ROUND_BUCKET(r.outstandingNgn),
    }));
  } else {
    const apTotals = await q(
      conn,
      `SELECT COUNT(*) AS lineCount,
              SUM(GREATEST(0, COALESCE(amount_ngn,0) - COALESCE(paid_ngn,0))) AS outstandingNgn
       FROM accounts_payable`
    );
    const a = apTotals[0] || {};
    out.procurement.apOutstandingByBranch = [
      {
        branchId: '(schema: no branch_id)',
        lineCount: Number(a.lineCount),
        outstandingBucket: ROUND_BUCKET(a.outstandingNgn),
      },
    ];
  }

  if (await tableExists(conn, 'bank_reconciliation_lines')) {
    const brUnmatched = await scalar(
      conn,
      `SELECT COUNT(*) FROM bank_reconciliation_lines
       WHERE (system_match IS NULL OR TRIM(system_match) = '')
         OR UPPER(TRIM(COALESCE(status,''))) IN ('REVIEW','UNMATCHED','OPEN')`
    );
    const brTotal = await scalar(conn, `SELECT COUNT(*) FROM bank_reconciliation_lines`);
    out.bankReconciliation = {
      lineCount: Number(brTotal),
      possibleUnmatched: Number(brUnmatched),
    };
    const inflowUnclear = await scalar(
      conn,
      `SELECT COUNT(*) FROM treasury_movements
       WHERE amount_ngn > 0
         AND type NOT IN ('RECEIPT_IN','ADVANCE_IN','TRANSFER_IN')
         AND (source_kind IS NULL OR TRIM(source_kind) = '' OR source_id IS NULL OR TRIM(source_id) = '')`
    );
    out.possibleUnidentifiedInflows = {
      treasuryPositiveNoSource: Number(inflowUnclear),
      bankReconUnmatchedLines: Number(brUnmatched),
    };
  }

  if (await tableExists(conn, 'gl_journal_entries')) {
    out.gl = {
      journalCount: Number(await scalar(conn, `SELECT COUNT(*) FROM gl_journal_entries`)),
      journalsMissingSourceKind: Number(
        await scalar(
          conn,
          `SELECT COUNT(*) FROM gl_journal_entries WHERE source_kind IS NULL OR TRIM(source_kind) = ''`
        )
      ),
    };
  }

  if (await tableExists(conn, 'accounting_period_locks')) {
    const locks = await q(
      conn,
      `SELECT period_key AS periodKey FROM accounting_period_locks ORDER BY period_key DESC LIMIT 6`
    );
    out.periodLocks = locks.map((r) => r.periodKey);
  }

  const months = [];
  const now = new Date();
  for (let i = 0; i < 3; i += 1) {
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
    months.push({
      period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      salesReceiptsBucket: ROUND_BUCKET(srSum),
      ledgerReceiptLikeBucket: ROUND_BUCKET(leSum),
      subledgerVsLedgerDiffBucket: ROUND_BUCKET(diff),
      materialMismatch: diff > 50_000,
    });
  }
  out.reconciliationPackRecentMonths = months;

  return out;
}

/** @returns {Promise<import('mysql2/promise').Connection>} */
export async function openFinanceProfileMysqlConnection(cfg = mysqlConfigFromEnv()) {
  return mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectTimeout: 15_000,
  });
}

/**
 * Load .env, connect, run SELECT-only profile, close connection.
 */
export async function runFinanceLiveProfileFromEnv() {
  loadProjectEnv();
  const cfg = mysqlConfigFromEnv();
  const label = databaseLabel(cfg);
  let conn;
  try {
    conn = await openFinanceProfileMysqlConnection(cfg);
    return await buildFinanceLiveProfileReport(conn, { target: label });
  } finally {
    if (conn) await conn.end();
  }
}

export function financeProfileTokenMatches(req) {
  const expected = String(process.env.ZAREWA_FINANCE_PROFILE_TOKEN || '').trim();
  if (!expected) return false;
  const got = String(req.headers['x-finance-profile-token'] || '').trim();
  if (!got) return false;
  const left = Buffer.from(got, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

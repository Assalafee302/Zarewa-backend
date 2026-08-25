/**
 * Customer / company-staff payout account resolution for refunds.
 * Staff-linked customers prefer HR payroll bank over customers.bank_*.
 * @module server/sales/customerPayoutAccount
 */
import { decryptBankAccount, storedBankToMasked } from '../hrBankCrypto.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import {
  ensureStaffSalesCustomer,
  getStaffSalesCustomerId,
  staffPurchaseCreditColumnsReady,
} from '../staffPurchaseCreditOps.js';
import { unclearedReceiptFloatBySalesCustomerIds } from './refundClaimingStaffUnclearedReceipts.js';

function trim(v) {
  return String(v ?? '').trim();
}

/**
 * HR bank for a sales customer linked via hr_staff_profiles.sales_customer_id.
 * @returns {{ userId: string, employeeNo: string, displayName: string, payeeName: string, payeeBankName: string, payeeAccountNo: string, bankAccountNoMasked: string } | null}
 */
export function hrPayoutAccountForSalesCustomer(db, customerId) {
  const cid = trim(customerId);
  if (!cid || !staffPurchaseCreditColumnsReady(db)) return null;
  if (!hasColumn(db, 'hr_staff_profiles', 'bank_account_no')) return null;

  const row = db
    .prepare(
      `SELECT p.user_id, p.employee_no, p.bank_account_name, p.bank_name, p.bank_account_no,
              p.bank_account_no_masked, u.display_name, u.username, u.status AS user_status
       FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id
       WHERE trim(IFNULL(p.sales_customer_id, '')) = ?
       LIMIT 1`
    )
    .get(cid);
  if (!row) return null;

  const userStatus = trim(row.user_status || 'active').toLowerCase();
  if (userStatus && userStatus !== 'active') return null;

  const bankName = trim(row.bank_name);
  const payeeAccountNo = trim(decryptBankAccount(row.bank_account_no) || '');
  if (!bankName || !payeeAccountNo) return null;

  const displayName = trim(row.display_name || row.username || '');
  const payeeName = trim(row.bank_account_name) || displayName;
  const masked =
    trim(row.bank_account_no_masked) || storedBankToMasked(row.bank_account_no) || '';

  return {
    userId: trim(row.user_id),
    employeeNo: trim(row.employee_no),
    displayName,
    payeeName,
    payeeBankName: bankName,
    payeeAccountNo,
    bankAccountNoMasked: masked,
  };
}

/**
 * Prefer HR payroll bank when the customer is a staff purchase account; else customer bank columns.
 * @returns {{ partyKind: 'customer', partyId: string, partyName: string, payeeName: string, payeeAccountNo: string, payeeBankName: string, source?: 'hr'|'customer' } | null}
 */
export function savedCustomerPayoutAccount(db, customerId) {
  const cid = trim(customerId);
  if (!cid) return null;

  const cust = db
    .prepare(
      `SELECT name, bank_account_name, bank_name, bank_account_no
       FROM customers WHERE customer_id = ?`
    )
    .get(cid);
  if (!cust) return null;

  const partyName = trim(cust.name);
  const hr = hrPayoutAccountForSalesCustomer(db, cid);
  if (hr) {
    return {
      partyKind: 'customer',
      partyId: cid,
      partyName: partyName || hr.displayName || cid,
      payeeName: hr.payeeName || partyName,
      payeeAccountNo: hr.payeeAccountNo,
      payeeBankName: hr.payeeBankName,
      source: 'hr',
    };
  }

  const bankAccountNo = trim(cust.bank_account_no);
  const bankName = trim(cust.bank_name);
  const bankAccountName = trim(cust.bank_account_name);
  if (!bankAccountNo || !bankName) return null;

  return {
    partyKind: 'customer',
    partyId: cid,
    partyName,
    payeeName: bankAccountName || partyName,
    payeeAccountNo: bankAccountNo,
    payeeBankName: bankName,
    source: 'customer',
  };
}

/**
 * Directory for refund “claiming staff” picker (masked bank only).
 * Includes active HR logins for the workspace branch — not only those already linked to a sales customer.
 * Avoid decrypting every HR account — that made the refund form hang.
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL'|string} [branchScope]
 */
export function listClaimingStaffForRefunds(db, branchScope = 'ALL') {
  if (!staffPurchaseCreditColumnsReady(db)) return [];
  if (!hasColumn(db, 'hr_staff_profiles', 'bank_account_no')) return [];

  const scope = trim(branchScope);
  const hasUserBranch = hasColumn(db, 'app_users', 'workspace_branch_id');
  const branchSql =
    scope && scope !== 'ALL'
      ? hasUserBranch
        ? ` AND (
             trim(IFNULL(p.branch_id, '')) = ?
             OR trim(IFNULL(p.branch_id, '')) = ''
             OR trim(IFNULL(u.workspace_branch_id, '')) = ?
           )`
        : ` AND (
             trim(IFNULL(p.branch_id, '')) = ?
             OR trim(IFNULL(p.branch_id, '')) = ''
           )`
      : '';
  const args =
    scope && scope !== 'ALL' ? (hasUserBranch ? [scope, scope] : [scope]) : [];

  const rows = db
    .prepare(
      `SELECT p.user_id, p.employee_no, p.sales_customer_id, p.bank_account_name, p.bank_name,
              p.bank_account_no, p.bank_account_no_masked, p.branch_id,
              u.display_name, u.username, u.role_key, u.status AS user_status,
              c.name AS customer_name, c.status AS customer_status
       FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id
       LEFT JOIN customers c ON trim(IFNULL(c.customer_id, '')) = trim(IFNULL(p.sales_customer_id, ''))
       WHERE 1=1${branchSql}
       ORDER BY u.display_name
       LIMIT 500`
    )
    .all(...args);

  const staffRows = rows
    .map((row) => {
      const userStatus = trim(row.user_status || 'active').toLowerCase();
      if (userStatus && userStatus !== 'active') return null;
      const customerStatus = trim(row.customer_status || 'Active').toLowerCase();
      // If linked customer exists and is inactive, skip; unlinked HR staff still listed.
      if (trim(row.sales_customer_id) && customerStatus && customerStatus !== 'active') return null;

      const customerID = trim(row.sales_customer_id);
      const bankName = trim(row.bank_name);
      const masked = trim(row.bank_account_no_masked);
      const encPresent = Boolean(trim(row.bank_account_no));
      const hasBank = Boolean(bankName && (masked || encPresent));
      const displayName = trim(row.display_name);
      const username = trim(row.username);
      const customerName = trim(row.customer_name);
      const name = displayName || username || customerName || customerID || trim(row.user_id);

      return {
        customerID,
        userId: trim(row.user_id),
        name,
        customerName,
        username,
        roleKey: trim(row.role_key).toLowerCase(),
        employeeNo: trim(row.employee_no),
        bankName: hasBank ? bankName : '',
        bankAccountNoMasked: hasBank ? masked || '****' : '',
        hasBank,
        needsSalesCustomer: !customerID,
        branchId: trim(row.branch_id),
      };
    })
    .filter(Boolean);

  const linkedIds = staffRows.map((r) => r.customerID).filter(Boolean);
  const floatMap = unclearedReceiptFloatBySalesCustomerIds(db, linkedIds);
  return staffRows.map((row) => {
    const info = row.customerID ? floatMap.get(row.customerID) : null;
    return {
      ...row,
      unclearedReceiptFloatNgn: info ? Math.round(Number(info.totalNgn) || 0) : 0,
      unclearedReceiptCount: info ? Number(info.receiptCount) || 0 : 0,
    };
  });
}

/**
 * Resolve HR claiming-staff payee for a login user (quotation maker / handled-by).
 * Uses the linked sales customer — no separate refund-staff table.
 */
export function claimingStaffPayeeForUserId(db, userId) {
  const uid = trim(userId);
  if (!uid) return null;
  try {
    ensureStaffSalesCustomer(db, uid);
  } catch {
    /* profile may lack HR row */
  }
  const cid = getStaffSalesCustomerId(db, uid);
  if (!cid) return null;
  const rows = listClaimingStaffForRefunds(db, 'ALL');
  return rows.find((r) => String(r.customerID || '').trim() === cid) || null;
}

/**
 * Resolve a prepared-by / handled-by display label to an active app_users.id.
 * Exact match only (display name or username) — fuzzy matching wrongly pinned Suleiman/Abdulrahman.
 */
export function resolveAppUserIdFromHandledByLabel(db, label) {
  const name = trim(label);
  if (!name || name.toLowerCase() === 'sales') return '';

  const norm = (s) =>
    String(s || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  const target = norm(name);

  const rows = db
    .prepare(
      `SELECT id, display_name, username FROM app_users
       WHERE LOWER(TRIM(COALESCE(status, 'active'))) = 'active'
         AND (
           LOWER(TRIM(COALESCE(display_name, ''))) = LOWER(?)
           OR LOWER(REPLACE(TRIM(COALESCE(display_name, '')), '  ', ' ')) = ?
           OR LOWER(TRIM(COALESCE(username, ''))) = LOWER(?)
         )
       ORDER BY display_name COLLATE NOCASE
       LIMIT 5`
    )
    .all(name, target, name);

  const unique = [];
  const seen = new Set();
  for (const row of rows) {
    const id = trim(row.id);
    if (!id || seen.has(id)) continue;
    const display = norm(row.display_name);
    const username = norm(row.username);
    if (display !== target && username !== target) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique.length === 1 ? unique[0] : '';
}

function namesEqualForPayee(a, b) {
  const left = String(a || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const right = String(b || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return Boolean(left && right && left === right);
}

/**
 * Same person allowing optional middle names (e.g. "Suleiman Liman" ↔ "Suleiman Abdullahi Liman").
 * Requires ≥2 shared tokens of the shorter name — never single-token fuzzy (that pinned wrong BMs).
 */
function namesAgreeForHandledBy(a, b) {
  if (namesEqualForPayee(a, b)) return true;
  const left = String(a || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean);
  const right = String(b || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean);
  if (!left.length || !right.length) return false;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length < 2) return false;
  return shorter.every((t) => longer.includes(t));
}

function backfillQuotationHandlerLink(db, { hasHandlerCol, ref, userId, payee, handledByLabel }) {
  if (!hasHandlerCol || !userId || !payee?.customerID) return;
  try {
    db.prepare(
      `UPDATE quotations
       SET handled_by_user_id = ?,
           agent_customer_id = ?,
           agent_customer_name = ?
       WHERE id = ?`
    ).run(userId, payee.customerID, payee.name || handledByLabel, ref);
  } catch {
    /* best-effort */
  }
}

/**
 * Default refund sales staff for a quotation: handled_by_user_id → HR bank.
 * Legacy quotes: exact handled_by name → login → ensure HR sales customer, and backfill user id.
 * Never keep a stale handled_by_user_id / agent_customer_id that does not match Prepared by.
 */
export function defaultRefundPayeeForQuotation(db, quotationRef) {
  const ref = trim(quotationRef);
  if (!ref) return { ok: false, error: 'quotationRef is required.' };

  const hasHandlerCol = hasColumn(db, 'quotations', 'handled_by_user_id');
  const q = db
    .prepare(
      hasHandlerCol
        ? `SELECT id, handled_by, handled_by_user_id, agent_customer_id, agent_customer_name, branch_id
           FROM quotations WHERE id = ?`
        : `SELECT id, handled_by, agent_customer_id, agent_customer_name, branch_id
           FROM quotations WHERE id = ?`
    )
    .get(ref);
  if (!q) return { ok: false, error: 'Quotation not found.' };

  let handledByUserId = trim(q.handled_by_user_id);
  const handledByLabel = trim(q.handled_by);
  const agentCustomerId = trim(q.agent_customer_id);
  const agentCustomerName = trim(q.agent_customer_name);

  let payee = null;
  let source = '';
  let resolvedUserId = handledByUserId;

  if (handledByUserId) {
    const byUser = claimingStaffPayeeForUserId(db, handledByUserId);
    if (byUser) {
      const agrees =
        !handledByLabel ||
        handledByLabel.toLowerCase() === 'sales' ||
        namesAgreeForHandledBy(byUser.name, handledByLabel);
      if (agrees) {
        payee = byUser;
        source = 'handled_by_user_id';
      } else {
        // Stale backfill (often Suleiman/Abdulrahman) — try Prepared by text, else discard.
        const fromLabel = resolveAppUserIdFromHandledByLabel(db, handledByLabel);
        if (fromLabel && fromLabel !== handledByUserId) {
          const relinked = claimingStaffPayeeForUserId(db, fromLabel);
          if (relinked) {
            payee = relinked;
            resolvedUserId = fromLabel;
            source = 'handled_by_name_override';
            backfillQuotationHandlerLink(db, {
              hasHandlerCol,
              ref,
              userId: fromLabel,
              payee: relinked,
              handledByLabel,
            });
            handledByUserId = fromLabel;
          }
        }
        if (!payee) {
          resolvedUserId = '';
          handledByUserId = '';
        }
      }
    }
  }

  if (!payee && handledByLabel) {
    const fromLabel = resolveAppUserIdFromHandledByLabel(db, handledByLabel);
    if (fromLabel) {
      resolvedUserId = fromLabel;
      payee = claimingStaffPayeeForUserId(db, fromLabel);
      if (payee) {
        source = 'handled_by_name';
        backfillQuotationHandlerLink(db, {
          hasHandlerCol,
          ref,
          userId: fromLabel,
          payee,
          handledByLabel,
        });
        handledByUserId = fromLabel;
      }
    }
  }

  // agent_customer_id only when it agrees with Prepared by (or Prepared by is blank).
  if (!payee && agentCustomerId) {
    const rows = listClaimingStaffForRefunds(db, 'ALL');
    const byAgent = rows.find((r) => String(r.customerID || '').trim() === agentCustomerId) || null;
    if (byAgent) {
      const agrees =
        !handledByLabel ||
        handledByLabel.toLowerCase() === 'sales' ||
        namesAgreeForHandledBy(byAgent.name, handledByLabel) ||
        namesAgreeForHandledBy(agentCustomerName, handledByLabel);
      if (agrees) {
        payee = byAgent;
        source = 'agent_customer_id';
      }
    }
  }

  return {
    ok: true,
    quotationRef: ref,
    handledBy: handledByLabel,
    handledByUserId: handledByUserId || resolvedUserId || '',
    agentCustomerId: payee?.customerID || '',
    source,
    payee,
    unresolved: !payee,
    hint: payee
      ? source.startsWith('handled_by_name')
        ? `Matched prepared-by “${handledByLabel}” to ${payee.name} (HR bank).`
        : 'Quotation maker / handled-by staff (HR bank).'
      : handledByLabel
        ? `Could not link prepared-by “${handledByLabel}” to an exact HR login — pick that person under Branch staff, or fix their display name on the user profile.`
        : 'Quotation has no handled-by user id — pick branch staff, or re-save the quotation with Handled by set.',
  };
}

/**
 * Active logins with HR profiles for quotation “Handled by” (not settings-gated).
 */
export function listHandledByStaffForQuotations(db, opts = {}) {
  const branchId = trim(opts.branchId);
  if (!hasColumn(db, 'hr_staff_profiles', 'user_id')) return [];

  const branchSql =
    branchId && branchId !== 'ALL'
      ? ` AND (
           trim(IFNULL(p.branch_id, '')) = ?
           OR trim(IFNULL(p.branch_id, '')) = ''
           OR trim(IFNULL(u.workspace_branch_id, '')) = ?
         )`
      : '';
  const args = branchId && branchId !== 'ALL' ? [branchId, branchId] : [];

  const rows = db
    .prepare(
      `SELECT u.id AS user_id, u.display_name, u.username, u.role_key, u.status AS user_status,
              p.employee_no, p.branch_id AS hr_branch_id, p.sales_customer_id
       FROM app_users u
       JOIN hr_staff_profiles p ON p.user_id = u.id
       WHERE LOWER(TRIM(COALESCE(u.status, 'active'))) = 'active'
         ${branchSql}
       ORDER BY u.display_name COLLATE NOCASE
       LIMIT 400`
    )
    .all(...args);

  return rows.map((row) => ({
    id: trim(row.user_id),
    name: trim(row.display_name || row.username || row.user_id),
    username: trim(row.username),
    roleKey: trim(row.role_key).toLowerCase(),
    employeeNo: trim(row.employee_no),
    branchId: trim(row.hr_branch_id),
    hasSalesCustomer: Boolean(trim(row.sales_customer_id)),
  }));
}

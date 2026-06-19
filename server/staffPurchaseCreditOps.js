/**
 * Staff purchase credit — roofing / materials on credit linked to quotations.
 * @module server/staffPurchaseCreditOps
 */
import { userHasPermission } from './auth.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { getCreditPolicyConfig } from './creditPolicy.js';
import { getHrPolicyPayload } from './hrBusinessRules.js';
import { evaluateQuotationPaymentForDeliveryRelease } from './deliveryReleaseGate.js';
import { listProductionJobs } from './readModel.js';
import { insertCustomer, insertLedgerRows, syncQuotationPaidFromReceipts } from './writeOps.js';
import { appendHrAuditEvent, hrTablesReady, nowIso } from './hrOps.js';
import {
  OBLIGATION_KIND,
  OBLIGATION_ORIGIN,
  OBLIGATION_STATUS,
  OBLIGATION_TX_TYPE,
  insertObligationAccount,
  mapObligationAccountRow,
  postObligationTransaction,
  staffObligationTablesReady,
} from './staffObligationOps.js';

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function roleKey(actor) {
  return String(actor?.roleKey || actor?.role || '').toLowerCase();
}

export function staffPurchaseCreditColumnsReady(db) {
  try {
    const cols = new Set(db.prepare(`PRAGMA table_info(hr_staff_profiles)`).all().map((c) => c.name));
    return cols.has('sales_customer_id');
  } catch {
    return false;
  }
}

export function getStaffPurchaseCreditPolicy(db) {
  const credit = getCreditPolicyConfig(db);
  const hrPolicy = getHrPolicyPayload(db);
  const p = hrPolicy.staffPurchaseCredit || {};
  return {
    enabled: p.enabled !== false,
    minServiceYears: Number(p.minServiceYears) || 1,
    maxOutstandingNgn: Number(p.maxOutstandingNgn) || 5_000_000,
    maxSinglePurchaseNgn: Number(p.maxSinglePurchaseNgn) || 2_000_000,
    maxRepaymentMonths: Number(p.maxRepaymentMonths) || 6,
    maxConcurrentActive: Number(p.maxConcurrentActive) || 1,
    requireDepositPercent: Number(p.requireDepositPercent) || 0,
    branchManagerLimitNgn: credit.branchManagerLimitNgn,
    mdRequiredAboveNgn: credit.mdRequiredAboveNgn,
    defaultTermsDays: credit.defaultTermsDays,
    maxTermsDays: credit.maxTermsDays,
  };
}

export function getStaffSalesCustomerId(db, userId) {
  if (!staffPurchaseCreditColumnsReady(db)) return null;
  const row = db.prepare(`SELECT sales_customer_id FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  return String(row?.sales_customer_id || '').trim() || null;
}

/** Display name for linked staff sales customer — includes employee no when set. */
export function formatStaffSalesCustomerName(displayName, employeeNo) {
  const base = String(displayName || 'Staff').trim();
  const eno = String(employeeNo || '').trim().toUpperCase();
  if (eno) return `${base} · ${eno} (Staff)`;
  return `${base} (Staff)`;
}

function syncStaffSalesCustomerName(db, customerId, name) {
  const cid = String(customerId || '').trim();
  const label = String(name || '').trim();
  if (!cid || !label) return;
  db.prepare(`UPDATE customers SET name = ? WHERE customer_id = ?`).run(label, cid);
  db.prepare(`UPDATE quotations SET customer_name = ? WHERE customer_id = ?`).run(label, cid);
  db.prepare(`UPDATE sales_receipts SET customer_name = ? WHERE customer_id = ?`).run(label, cid);
  db.prepare(`UPDATE cutting_lists SET customer_name = ? WHERE customer_id = ?`).run(label, cid);
  db.prepare(`UPDATE customer_refunds SET customer_name = ? WHERE customer_id = ?`).run(label, cid);
  db.prepare(`UPDATE ledger_entries SET customer_name = ? WHERE customer_id = ?`).run(label, cid);
  db.prepare(`UPDATE advance_in_events SET customer_name = ? WHERE customer_id = ?`).run(label, cid);
}

export function ensureStaffSalesCustomer(db, userId, actor = null) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'userId is required.' };

  const prof = db
    .prepare(
      `SELECT p.branch_id, p.sales_customer_id, p.employee_no, u.display_name, u.username
       FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id
       WHERE p.user_id = ?`
    )
    .get(uid);
  if (!prof) return { ok: false, error: 'Staff profile not found.' };

  const expectedName = formatStaffSalesCustomerName(prof.display_name || prof.username, prof.employee_no);

  const existing = String(prof.sales_customer_id || '').trim();
  if (existing) {
    const cust = db.prepare(`SELECT customer_id, name FROM customers WHERE customer_id = ?`).get(existing);
    if (cust) {
      if (String(cust.name || '').trim() !== expectedName) {
        syncStaffSalesCustomerName(db, existing, expectedName);
      }
      return { ok: true, customerId: existing, already: true, nameSynced: String(cust.name || '').trim() !== expectedName };
    }
  }

  const bid = String(prof.branch_id || DEFAULT_BRANCH_ID).trim();
  const name = expectedName;
  const customerId = insertCustomer(
    db,
    {
      name,
      phoneNumber: '',
      email: '',
      paymentTerms: 'Staff credit',
      status: 'Active',
      tier: 'Staff',
      createdBy: actor?.displayName || actor?.username || 'HR',
      crmTags: ['staff-purchase'],
      crmProfileNotes: `Linked staff user ${uid}${prof.employee_no ? ` · ${prof.employee_no}` : ''}`,
    },
    bid
  );

  if (staffPurchaseCreditColumnsReady(db)) {
    db.prepare(`UPDATE hr_staff_profiles SET sales_customer_id = ?, updated_at_iso = ? WHERE user_id = ?`).run(
      customerId,
      nowIso(),
      uid
    );
  }

  return { ok: true, customerId, created: true };
}

/** Sync linked staff customer names from HR profiles (employee no + display name). */
export function backfillStaffSalesCustomerNames(db) {
  if (!hrTablesReady(db) || !staffPurchaseCreditColumnsReady(db)) {
    return { ok: false, error: 'HR staff purchase credit not migrated.' };
  }
  const rows = db
    .prepare(
      `SELECT p.sales_customer_id, p.employee_no, u.display_name, u.username
       FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id
       WHERE trim(IFNULL(p.sales_customer_id, '')) != ''`
    )
    .all();
  let synced = 0;
  for (const row of rows) {
    const cid = String(row.sales_customer_id || '').trim();
    if (!cid) continue;
    const expectedName = formatStaffSalesCustomerName(row.display_name || row.username, row.employee_no);
    const cust = db.prepare(`SELECT name FROM customers WHERE customer_id = ?`).get(cid);
    if (!cust) continue;
    if (String(cust.name || '').trim() !== expectedName) {
      syncStaffSalesCustomerName(db, cid, expectedName);
      synced += 1;
    }
  }
  return { ok: true, synced, total: rows.length };
}

function mergeStaffPurchaseCrmTags(existingJson) {
  let tags = [];
  try {
    const parsed = JSON.parse(String(existingJson || '[]'));
    tags = Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
  } catch {
    tags = [];
  }
  if (!tags.includes('staff-purchase')) tags.push('staff-purchase');
  return JSON.stringify(tags);
}

export function userMayLinkStaffSalesCustomer(actor) {
  if (userHasPermission(actor, '*')) return true;
  return (
    userHasPermission(actor, 'customers.manage') ||
    userHasPermission(actor, 'sales.manage') ||
    userHasPermission(actor, 'hr.staff.manage')
  );
}

/**
 * Staff rows Sales can pick when linking a customer account.
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 * @param {string} [query]
 */
export function listStaffForSalesCustomerLink(db, branchScope = 'ALL', query = '') {
  if (!hrTablesReady(db) || !staffPurchaseCreditColumnsReady(db)) return [];
  const q = String(query || '').trim().toLowerCase();
  let sql = `
    SELECT p.user_id AS userId, u.display_name AS displayName, u.username,
           p.employee_no AS employeeNo, p.branch_id AS branchId,
           p.sales_customer_id AS salesCustomerId
    FROM hr_staff_profiles p
    JOIN app_users u ON u.id = p.user_id
    WHERE u.status = 'active'`;
  const args = [];
  if (branchScope && branchScope !== 'ALL') {
    sql += ` AND p.branch_id = ?`;
    args.push(String(branchScope).trim());
  }
  if (q) {
    sql += ` AND (
      lower(IFNULL(u.display_name, '')) LIKE ? ESCAPE '\\\\'
      OR lower(IFNULL(u.username, '')) LIKE ? ESCAPE '\\\\'
      OR lower(IFNULL(p.employee_no, '')) LIKE ? ESCAPE '\\\\'
    )`;
    const like = `%${q.replace(/\\/g, '\\\\')}%`;
    args.push(like, like, like);
  }
  sql += ` ORDER BY u.display_name COLLATE NOCASE, p.employee_no COLLATE NOCASE LIMIT 80`;
  return db.prepare(sql).all(...args).map((row) => ({
    userId: row.userId,
    displayName: row.displayName || row.username || row.userId,
    employeeNo: String(row.employeeNo || '').trim(),
    branchId: row.branchId || '',
    salesCustomerId: String(row.salesCustomerId || '').trim() || null,
    label: formatStaffSalesCustomerName(row.displayName || row.username, row.employeeNo),
  }));
}

/**
 * Link an existing sales customer to an HR staff member (purchase credit).
 * @param {import('better-sqlite3').Database} db
 * @param {string} customerId
 * @param {string} staffUserId
 * @param {object | null} [actor]
 */
export function linkSalesCustomerToStaff(db, customerId, staffUserId, actor = null) {
  if (!hrTablesReady(db) || !staffPurchaseCreditColumnsReady(db)) {
    return { ok: false, error: 'Staff purchase credit is not available.' };
  }
  const cid = String(customerId || '').trim();
  const uid = String(staffUserId || '').trim();
  if (!cid || !uid) return { ok: false, error: 'Customer and staff are required.' };

  const cust = db
    .prepare(`SELECT customer_id, name, branch_id, crm_tags_json, crm_profile_notes FROM customers WHERE customer_id = ?`)
    .get(cid);
  if (!cust) return { ok: false, error: 'Customer not found.' };

  const prof = db
    .prepare(
      `SELECT p.user_id, p.branch_id, p.employee_no, p.sales_customer_id, u.display_name, u.username
       FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id
       WHERE p.user_id = ?`
    )
    .get(uid);
  if (!prof) return { ok: false, error: 'Staff profile not found.' };

  const existingForStaff = String(prof.sales_customer_id || '').trim();
  if (existingForStaff && existingForStaff !== cid) {
    return {
      ok: false,
      error: `This staff member is already linked to customer ${existingForStaff}. Unlink there first.`,
      code: 'STAFF_ALREADY_LINKED',
      existingCustomerId: existingForStaff,
    };
  }

  const expectedName = formatStaffSalesCustomerName(prof.display_name || prof.username, prof.employee_no);
  const profileNotes = `Linked staff user ${uid}${prof.employee_no ? ` · ${prof.employee_no}` : ''}`;
  const tagsJson = mergeStaffPurchaseCrmTags(cust.crm_tags_json);
  const at = nowIso();

  db.transaction(() => {
    const others = db
      .prepare(`SELECT user_id FROM hr_staff_profiles WHERE sales_customer_id = ? AND user_id != ?`)
      .all(cid, uid);
    for (const row of others) {
      db.prepare(`UPDATE hr_staff_profiles SET sales_customer_id = NULL, updated_at_iso = ? WHERE user_id = ?`).run(
        at,
        row.user_id
      );
    }
    db.prepare(`UPDATE hr_staff_profiles SET sales_customer_id = ?, updated_at_iso = ? WHERE user_id = ?`).run(
      cid,
      at,
      uid
    );
    db.prepare(
      `UPDATE customers SET name = ?, tier = 'Staff', payment_terms = 'Staff credit',
       crm_tags_json = ?, crm_profile_notes = ? WHERE customer_id = ?`
    ).run(expectedName, tagsJson, profileNotes, cid);
    syncStaffSalesCustomerName(db, cid, expectedName);
  })();

  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    action: 'hr.purchase_credit.customer_linked',
    entityKind: 'customer',
    entityId: cid,
    branchId: cust.branch_id || prof.branch_id || null,
    details: { staffUserId: uid, customerName: expectedName },
  });

  return {
    ok: true,
    customerId: cid,
    staffUserId: uid,
    customerName: expectedName,
    staffDisplayName: prof.display_name || prof.username,
    staffEmployeeNo: prof.employee_no || '',
  };
}

/**
 * Remove staff link from a sales customer.
 * @param {import('better-sqlite3').Database} db
 * @param {string} customerId
 * @param {object | null} [actor]
 */
export function unlinkSalesCustomerFromStaff(db, customerId, actor = null) {
  if (!staffPurchaseCreditColumnsReady(db)) return { ok: false, error: 'Staff link not available.' };
  const cid = String(customerId || '').trim();
  if (!cid) return { ok: false, error: 'Customer id required.' };

  const row = db.prepare(`SELECT user_id, branch_id FROM hr_staff_profiles WHERE sales_customer_id = ?`).get(cid);
  if (!row) return { ok: true, already: true };

  const at = nowIso();
  db.prepare(`UPDATE hr_staff_profiles SET sales_customer_id = NULL, updated_at_iso = ? WHERE user_id = ?`).run(
    at,
    row.user_id
  );

  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    action: 'hr.purchase_credit.customer_unlinked',
    entityKind: 'customer',
    entityId: cid,
    branchId: row.branch_id || null,
    details: { staffUserId: row.user_id },
  });

  return { ok: true, staffUserId: row.user_id };
}

export function computeStaffPurchaseCreditEligibility(db, userId) {
  const policy = getStaffPurchaseCreditPolicy(db);
  const issues = [];
  if (!policy.enabled) issues.push('Staff purchase credit is not enabled for your organisation.');

  const prof = db.prepare(`SELECT date_joined_iso FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  if (!prof) issues.push('No HR staff profile found.');

  const joined = String(prof?.date_joined_iso || '').slice(0, 10);
  let serviceYears = 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(joined)) {
    serviceYears = Math.max(0, (Date.now() - new Date(`${joined}T12:00:00Z`).getTime()) / (365.25 * 86400000));
  }
  if (serviceYears < policy.minServiceYears) {
    issues.push(`Minimum ${policy.minServiceYears} year(s) of service required (~${serviceYears.toFixed(1)} years).`);
  }

  let activeOutstanding = 0;
  let activeCount = 0;
  if (staffObligationTablesReady(db)) {
    const rows = db
      .prepare(
        `SELECT principal_outstanding_ngn, status FROM hr_staff_obligation_accounts
         WHERE user_id = ? AND kind = ? AND status IN (?, ?)`
      )
      .all(userId, OBLIGATION_KIND.PURCHASE, OBLIGATION_STATUS.ACTIVE, OBLIGATION_STATUS.PENDING_APPROVAL);
    for (const r of rows) {
      activeCount += 1;
      activeOutstanding += Math.round(Number(r.principal_outstanding_ngn) || 0);
    }
  }
  if (activeCount >= policy.maxConcurrentActive) {
    issues.push(`You already have ${activeCount} active staff purchase credit request(s).`);
  }

  return {
    eligible: issues.length === 0,
    policy,
    serviceYears,
    activeOutstandingNgn: activeOutstanding,
    activeCount,
    issues,
    salesCustomerId: getStaffSalesCustomerId(db, userId),
  };
}

function staffUserIdForCustomer(db, customerId) {
  if (!staffPurchaseCreditColumnsReady(db)) return null;
  const row = db.prepare(`SELECT user_id FROM hr_staff_profiles WHERE sales_customer_id = ?`).get(customerId);
  return row?.user_id || null;
}

export function userMayRequestStaffPurchaseCredit(actor) {
  const rk = roleKey(actor);
  if (userHasPermission(actor, '*')) return true;
  if (['sales_manager', 'branch_manager', 'sales_staff', 'md', 'admin'].includes(rk)) return true;
  return userHasPermission(actor, 'quotations.manage') || userHasPermission(actor, 'sales.manage');
}

export function userMayApproveStaffPurchaseCredit(actor) {
  const rk = roleKey(actor);
  if (userHasPermission(actor, '*')) return true;
  if (rk === 'md') return true;
  if (userHasPermission(actor, 'hr.payroll.md_approve')) return true;
  return false;
}

export function userMayRejectStaffPurchaseCredit(actor) {
  if (userMayApproveStaffPurchaseCredit(actor)) return true;
  return userHasPermission(actor, 'hr.loans.manage') || userHasPermission(actor, 'hr.staff.manage');
}

function addDaysIso(isoDate, days) {
  const d = new Date(`${String(isoDate).slice(0, 10)}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

function quotationStaffPurchaseColumnsReady(db) {
  try {
    const cols = new Set(db.prepare(`PRAGMA table_info(quotations)`).all().map((c) => c.name));
    return cols.has('is_staff_purchase') && cols.has('staff_purchase_credit_id');
  } catch {
    return false;
  }
}

function linkQuotationToPurchaseCredit(db, quotationRef, accountId) {
  if (!quotationStaffPurchaseColumnsReady(db)) return;
  db.prepare(`UPDATE quotations SET is_staff_purchase = 1, staff_purchase_credit_id = ? WHERE id = ?`).run(
    accountId,
    quotationRef
  );
}

/**
 * Mark quotation as staff purchase when customer is a linked staff sales customer.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationId
 */
export function syncQuotationStaffPurchaseFlag(db, quotationId) {
  if (!quotationStaffPurchaseColumnsReady(db)) return;
  const ref = String(quotationId || '').trim();
  if (!ref) return;
  const q = db.prepare(`SELECT customer_id, staff_purchase_credit_id FROM quotations WHERE id = ?`).get(ref);
  if (!q) return;
  if (String(q.staff_purchase_credit_id || '').trim()) return;
  const staff = staffPurchaseCreditColumnsReady(db)
    ? db.prepare(`SELECT user_id FROM hr_staff_profiles WHERE sales_customer_id = ?`).get(q.customer_id)
    : null;
  db.prepare(`UPDATE quotations SET is_staff_purchase = ? WHERE id = ?`).run(staff ? 1 : 0, ref);
}

/**
 * Book staff purchase credit against quotation paid balance (ledger + paid_ngn sync).
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {number} amountNgn
 * @param {string} accountId
 * @param {object | null} [actor]
 */
export function applyStaffPurchaseCreditToQuotationPaid(db, quotationRef, amountNgn, accountId, actor = null) {
  const ref = String(quotationRef || '').trim();
  const amt = Math.round(Number(amountNgn) || 0);
  const acctId = String(accountId || '').trim();
  if (!ref || amt <= 0 || !acctId) return { ok: false, error: 'Invalid quotation credit application.' };

  const q = db.prepare(`SELECT customer_id, customer_name, branch_id FROM quotations WHERE id = ?`).get(ref);
  if (!q) return { ok: false, error: 'Quotation not found.' };

  const dup = db
    .prepare(
      `SELECT id FROM ledger_entries WHERE type = 'STAFF_PURCHASE_CREDIT' AND quotation_ref = ? AND bank_reference = ? LIMIT 1`
    )
    .get(ref, acctId);
  if (dup) return { ok: true, already: true };

  const bid = String(q.branch_id || DEFAULT_BRANCH_ID).trim();
  insertLedgerRows(
    db,
    [
      {
        type: 'STAFF_PURCHASE_CREDIT',
        customerID: q.customer_id,
        customerName: q.customer_name,
        amountNgn: amt,
        quotationRef: ref,
        bankReference: acctId,
        purpose: 'Staff purchase credit',
        note: `Staff purchase credit approved — obligation ${acctId}`,
        createdByUserId: actor?.id || null,
        createdByName: actor?.displayName || actor?.username || null,
      },
    ],
    bid
  );
  const sync = syncQuotationPaidFromReceipts(db, ref);
  return { ok: true, paidNgn: sync.paidNgn, paymentStatus: sync.paymentStatus };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object | null} actor
 * @param {object} body
 */
export function createStaffPurchaseCreditRequest(db, actor, body = {}) {
  if (!staffObligationTablesReady(db)) {
    return { ok: false, error: 'Staff obligation ledger not migrated.' };
  }
  if (!userMayRequestStaffPurchaseCredit(actor)) {
    return { ok: false, error: 'You do not have permission to request staff purchase credit.', code: 'FORBIDDEN' };
  }

  const quotationRef = String(body.quotationRef || body.quotationId || '').trim();
  if (!quotationRef) return { ok: false, error: 'quotationRef is required.' };

  const q = db.prepare(`SELECT id, customer_id, branch_id, total_ngn, paid_ngn, project_name FROM quotations WHERE id = ?`).get(quotationRef);
  if (!q) return { ok: false, error: 'Quotation not found.' };

  const staffUserId = String(body.staffUserId || body.userId || staffUserIdForCustomer(db, q.customer_id) || '').trim();
  if (!staffUserId) {
    return { ok: false, error: 'Quotation is not linked to a staff customer. Link staff sales customer first.' };
  }

  const custLink = getStaffSalesCustomerId(db, staffUserId);
  if (custLink && String(q.customer_id) !== custLink) {
    return { ok: false, error: 'Quotation customer does not match the staff sales customer record.' };
  }

  const jobs = listProductionJobs(db, 'ALL');
  const pay = evaluateQuotationPaymentForDeliveryRelease(db, quotationRef, jobs);
  const outstanding = Math.round(Number(pay.balanceNgn) || 0);
  if (outstanding <= 0) return { ok: false, error: 'Quotation has no outstanding balance.' };

  const policy = getStaffPurchaseCreditPolicy(db);
  const amountNgn = Math.round(Number(body.amountNgn) || outstanding);
  if (amountNgn <= 0) return { ok: false, error: 'amountNgn must be positive.' };
  if (amountNgn > outstanding) {
    return { ok: false, error: `Amount cannot exceed quotation balance (₦${outstanding.toLocaleString('en-NG')}).` };
  }
  if (amountNgn > policy.maxSinglePurchaseNgn) {
    return { ok: false, error: `Exceeds single purchase limit (₦${policy.maxSinglePurchaseNgn.toLocaleString('en-NG')}).` };
  }

  const elig = computeStaffPurchaseCreditEligibility(db, staffUserId);
  if (!elig.eligible) {
    return { ok: false, error: elig.issues[0] || 'Staff is not eligible for purchase credit.' };
  }
  if (elig.activeOutstandingNgn + amountNgn > policy.maxOutstandingNgn) {
    return { ok: false, error: 'Would exceed staff maximum outstanding purchase credit.' };
  }

  const existing = db
    .prepare(
      `SELECT id FROM hr_staff_obligation_accounts WHERE quotation_ref = ? AND status IN (?, ?) LIMIT 1`
    )
    .get(quotationRef, OBLIGATION_STATUS.PENDING_APPROVAL, OBLIGATION_STATUS.ACTIVE);
  if (existing) {
    return { ok: false, error: 'A staff purchase credit already exists for this quotation.', code: 'DUPLICATE' };
  }

  const termMonths = Math.min(
    policy.maxRepaymentMonths,
    Math.max(1, Math.round(Number(body.termMonths ?? body.repaymentMonths) || 3))
  );
  let installmentNgn = Math.round(Number(body.installmentNgn ?? body.deductionPerMonthNgn) || 0);
  if (installmentNgn <= 0) installmentNgn = Math.ceil(amountNgn / termMonths);

  const requestDate = String(body.requestDateISO || '').slice(0, 10) || nowIso().slice(0, 10);
  const termsDays = Math.min(
    policy.maxTermsDays,
    Math.max(1, Math.round(Number(body.creditTermsDays) || policy.defaultTermsDays))
  );
  const dueDateISO = String(body.dueDateISO || '').slice(0, 10) || addDaysIso(requestDate, termsDays);
  const title = String(body.title || q.project_name || `Staff purchase — ${quotationRef}`).trim();
  const prof = db.prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`).get(staffUserId);

  const ins = insertObligationAccount(db, {
    userId: staffUserId,
    branchId: q.branch_id || prof?.branch_id || DEFAULT_BRANCH_ID,
    kind: OBLIGATION_KIND.PURCHASE,
    origin: OBLIGATION_ORIGIN.NEW,
    title,
    principalOriginalNgn: amountNgn,
    principalOutstandingNgn: 0,
    installmentNgn,
    termMonths,
    status: OBLIGATION_STATUS.PENDING_APPROVAL,
    deductionsActive: false,
    quotationRef,
    dueDateIso: dueDateISO,
    note: String(body.reason || body.note || '').trim() || null,
    createdByUserId: actor?.id || null,
  });
  if (!ins.ok) return ins;

  linkQuotationToPurchaseCredit(db, quotationRef, ins.account.id);

  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    action: 'hr.purchase_credit.requested',
    entityKind: 'hr_staff_obligation_account',
    entityId: ins.account.id,
    branchId: ins.account.branchId,
    details: { quotationRef, amountNgn, staffUserId },
  });

  const requiredLevel = 'md';
  return { ok: true, account: ins.account, requiredApprovalLevel: requiredLevel };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} accountId
 * @param {'approve' | 'reject'} decision
 * @param {object | null} actor
 * @param {object} body
 */
export function decideStaffPurchaseCredit(db, accountId, decision, actor, body = {}) {
  if (!staffObligationTablesReady(db)) return { ok: false, error: 'Ledger not available.' };
  const id = String(accountId || '').trim();
  const row = db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Purchase credit not found.' };
  if (String(row.kind) !== OBLIGATION_KIND.PURCHASE) return { ok: false, error: 'Not a purchase credit account.' };
  if (String(row.status) !== OBLIGATION_STATUS.PENDING_APPROVAL) {
    return { ok: false, error: 'Only pending requests can be decided.' };
  }

  const amountNgn = Math.round(Number(row.principal_original_ngn) || 0);
  const dec = String(decision || '').toLowerCase();
  const note = String(body.note || body.decisionNote || '').trim() || null;
  const now = nowIso();

  if (dec === 'reject') {
    if (!userMayRejectStaffPurchaseCredit(actor)) {
      return { ok: false, error: 'You cannot reject this purchase credit request.', code: 'FORBIDDEN' };
    }
    db.prepare(`UPDATE hr_staff_obligation_accounts SET status = ?, note = ?, updated_at_iso = ? WHERE id = ?`).run(
      OBLIGATION_STATUS.REJECTED,
      note,
      now,
      id
    );
    return { ok: true, account: mapObligationAccountRow(db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ?`).get(id)) };
  }

  if (dec !== 'approve') return { ok: false, error: 'decision must be approve or reject.' };

  if (!userMayApproveStaffPurchaseCredit(actor)) {
    return {
      ok: false,
      error: 'Only the Managing Director can approve staff purchase credit.',
      code: 'FORBIDDEN',
    };
  }

  const quotationRef = String(row.quotation_ref || '').trim();
  const jobs = listProductionJobs(db, 'ALL');
  const pay = quotationRef ? evaluateQuotationPaymentForDeliveryRelease(db, quotationRef, jobs) : { balanceNgn: amountNgn };
  const recognizeNgn = Math.min(amountNgn, Math.round(Number(pay.balanceNgn) || amountNgn));

  db.transaction(() => {
    db.prepare(
      `UPDATE hr_staff_obligation_accounts SET status = ?, deductions_active = 1, updated_at_iso = ? WHERE id = ?`
    ).run(OBLIGATION_STATUS.ACTIVE, now, id);
    if (recognizeNgn > 0) {
      postObligationTransaction(db, id, {
        type: OBLIGATION_TX_TYPE.PURCHASE_RECOGNITION,
        amountNgn: recognizeNgn,
        effectiveAtIso: now,
        sourceKind: 'quotation',
        sourceId: quotationRef,
        note: note || 'Staff purchase credit approved',
        recordedByUserId: actor?.id || null,
      });
    }
  })();

  if (quotationRef && recognizeNgn > 0) {
    applyStaffPurchaseCreditToQuotationPaid(db, quotationRef, recognizeNgn, id, actor);
  }

  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    action: 'hr.purchase_credit.approved',
    entityKind: 'hr_staff_obligation_account',
    entityId: id,
    details: { quotationRef, recognizeNgn, requiredLevel: 'md' },
  });

  return { ok: true, account: mapObligationAccountRow(db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ?`).get(id)) };
}

/**
 * Active staff purchase credit covering quotation balance (delivery gate).
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {number} balanceNgn
 */
export function resolveActiveStaffPurchaseCreditForQuotation(db, quotationRef, balanceNgn) {
  if (!staffObligationTablesReady(db)) return null;
  const ref = String(quotationRef || '').trim();
  const balance = Math.round(Number(balanceNgn) || 0);
  if (!ref || balance <= 0) return null;

  const row = db
    .prepare(
      `SELECT * FROM hr_staff_obligation_accounts
       WHERE quotation_ref = ? AND kind = ? AND status = ? AND deductions_active = 1`
    )
    .get(ref, OBLIGATION_KIND.PURCHASE, OBLIGATION_STATUS.ACTIVE);
  if (!row) return null;

  const outstanding = Math.round(Number(row.principal_outstanding_ngn) || 0);
  const approved = Math.round(Number(row.principal_original_ngn) || 0);
  const coversBalance = outstanding >= balance || approved >= balance;
  return {
    id: row.id,
    status: row.status,
    amountNgn: approved,
    outstandingNgn: outstanding,
    coversBalance,
    coverageGapNgn: coversBalance ? 0 : Math.max(0, balance - Math.max(outstanding, approved)),
    dueDateISO: row.due_date_iso,
    installmentNgn: Math.round(Number(row.installment_ngn) || 0),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function getQuotationStaffPurchaseCreditStatus(db, quotationRef) {
  const ref = String(quotationRef || '').trim();
  if (!ref || !staffObligationTablesReady(db)) {
    return { ok: true, quotationRef: ref, staffPurchaseCredit: null };
  }
  const row = db
    .prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE quotation_ref = ? ORDER BY created_at_iso DESC LIMIT 1`)
    .all(ref)[0];
  const jobs = listProductionJobs(db, 'ALL');
  const pay = evaluateQuotationPaymentForDeliveryRelease(db, ref, jobs);
  const balance = Math.round(Number(pay.balanceNgn) || 0);
  const active = row ? resolveActiveStaffPurchaseCreditForQuotation(db, ref, balance) : null;
  const staffUserId = staffUserIdForCustomer(db, db.prepare(`SELECT customer_id FROM quotations WHERE id = ?`).get(ref)?.customer_id);
  return {
    ok: true,
    quotationRef: ref,
    balanceNgn: balance,
    isStaffCustomer: Boolean(staffUserId),
    staffUserId: staffUserId || null,
    account: row ? mapObligationAccountRow(row) : null,
    activeCredit: active,
    policy: getStaffPurchaseCreditPolicy(db),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string; status?: string }} filter
 */
export function listStaffPurchaseCreditQueue(db, filter = {}) {
  if (!staffObligationTablesReady(db)) return [];
  let sql = `SELECT o.*, u.display_name AS staff_display_name
    FROM hr_staff_obligation_accounts o
    JOIN app_users u ON u.id = o.user_id
    WHERE o.kind = ?`;
  const args = [OBLIGATION_KIND.PURCHASE];
  if (filter.status) {
    sql += ` AND o.status = ?`;
    args.push(String(filter.status));
  } else {
    sql += ` AND o.status IN (?, ?)`;
    args.push(OBLIGATION_STATUS.PENDING_APPROVAL, OBLIGATION_STATUS.ACTIVE);
  }
  if (filter.branchId && filter.branchId !== 'ALL') {
    sql += ` AND o.branch_id = ?`;
    args.push(String(filter.branchId));
  }
  sql += ` ORDER BY o.updated_at_iso DESC LIMIT 200`;
  return db
    .prepare(sql)
    .all(...args)
    .map((row) => ({
      ...mapObligationAccountRow(row),
      staffDisplayName: row.staff_display_name,
    }));
}

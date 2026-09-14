/**
 * Detect when a refund payee bank account matches an HR staff payroll account.
 * Matching accounts force the claiming-staff (20%) company cut — even if the split
 * is labeled as quote customer (0%) or associated staff / transport-install (3%).
 * @module server/sales/refundPayoutStaffBankMatch
 */
import { decryptBankAccount } from '../hrBankCrypto.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { normalizeStaffAccountKey } from '../../shared/lib/hrStaffIdentity.js';
import { savedCustomerPayoutAccount } from './customerPayoutAccount.js';

/**
 * Active HR payroll account numbers (normalized digit keys) for refund payee checks.
 * @param {import('better-sqlite3').Database} db
 * @returns {Set<string>}
 */
export function buildHrStaffBankAccountKeySet(db) {
  const keys = new Set();
  if (!hasColumn(db, 'hr_staff_profiles', 'bank_account_no')) return keys;
  if (!hasColumn(db, 'app_users', 'id')) return keys;

  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT p.bank_account_no
         FROM hr_staff_profiles p
         JOIN app_users u ON u.id = p.user_id
         WHERE trim(IFNULL(p.bank_account_no, '')) != ''
           AND LOWER(TRIM(COALESCE(u.status, 'active'))) = 'active'`
      )
      .all();
  } catch {
    return keys;
  }

  for (const row of rows) {
    try {
      const plain = decryptBankAccount(row.bank_account_no) || '';
      const key = normalizeStaffAccountKey(plain);
      if (key) keys.add(key);
    } catch {
      /* skip undecryptable / empty */
    }
  }
  return keys;
}

/**
 * @param {string} accountNo
 * @param {Set<string>} [hrKeys]
 * @param {import('better-sqlite3').Database} [db]
 */
export function payeeAccountMatchesHrStaffBank(accountNo, hrKeys, db) {
  const key = normalizeStaffAccountKey(accountNo);
  if (!key) return false;
  const set = hrKeys instanceof Set ? hrKeys : db ? buildHrStaffBankAccountKeySet(db) : null;
  if (!set || set.size === 0) return false;
  return set.has(key);
}

function payeeAccountNoFromSplit(db, split) {
  const fromPayload = String(
    split?.payoutAccount?.payeeAccountNo ||
      split?.payeeAccountNo ||
      split?.payee_account_no ||
      ''
  ).trim();
  if (fromPayload) return fromPayload;

  const kind = String(split?.recipientKind || split?.payoutAccount?.partyKind || '')
    .trim()
    .toLowerCase();
  if (kind === 'associated_staff' || kind === 'staff') {
    const id = String(split?.recipientAssociatedStaffID || '').trim();
    if (!id) return '';
    try {
      const row = db
        .prepare(`SELECT bank_account_no FROM associated_staff WHERE id = ?`)
        .get(id);
      return String(row?.bank_account_no || '').trim();
    } catch {
      return '';
    }
  }

  const cid = String(split?.recipientCustomerID || '').trim();
  if (!cid) return '';
  try {
    return String(savedCustomerPayoutAccount(db, cid)?.payeeAccountNo || '').trim();
  } catch {
    return '';
  }
}

/**
 * Mark splits whose payout account number matches an HR staff bank — forces 20% cut downstream.
 * @param {import('better-sqlite3').Database} db
 * @param {Array<object>} splits
 * @param {{ hrKeys?: Set<string> }} [opts]
 */
export function markRefundSplitsStaffBankMatch(db, splits, opts = {}) {
  const list = Array.isArray(splits) ? splits : [];
  if (!list.length) return list;
  const hrKeys = opts.hrKeys instanceof Set ? opts.hrKeys : buildHrStaffBankAccountKeySet(db);
  if (!hrKeys.size) return list.map((s) => ({ ...s }));

  return list.map((s) => {
    if (payeeAccountMatchesHrStaffBank(payeeAccountNoFromSplit(db, s), hrKeys)) {
      return {
        ...s,
        forceClaimingStaffCut: true,
        staffBankAccountMatch: true,
      };
    }
    return { ...s };
  });
}

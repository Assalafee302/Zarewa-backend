/**
 * Read-only customer master quality scan (names / duplicate phones).
 * Does not mutate rows — operators review before any cleanup.
 */
import { listCustomers } from '../readModel.js';

const PLACEHOLDER_NAMES = new Set(['test', 'xxx', 'n/a', 'na', 'unknown', 'customer', 'none', '-']);

/**
 * @param {unknown} name
 * @returns {string[]}
 */
export function customerNameQualityFlags(name) {
  const n = String(name || '').trim();
  const flags = [];
  if (!n) {
    flags.push('empty_name');
    return flags;
  }
  if (n.startsWith('%')) flags.push('leading_percent');
  if (/^[^A-Za-zÀ-ÿ0-9]/.test(n)) flags.push('leading_symbol');
  const letters = n.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length < 2) flags.push('too_short');
  if (PLACEHOLDER_NAMES.has(n.toLowerCase())) flags.push('placeholder_name');
  return flags;
}

/**
 * Nigeria-oriented phone key: last 10 digits when the value is long enough.
 * @param {unknown} phone
 */
export function normalizeCustomerPhoneDigits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length >= 10) return d.slice(-10);
  return d;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} [branchScope]
 */
export function listCustomerMasterQualityIssues(db, branchScope = 'ALL') {
  const customers = listCustomers(db, branchScope, { unlimited: true });
  const byPhone = new Map();
  const nameIssues = [];

  for (const c of customers) {
    const flags = customerNameQualityFlags(c.name);
    if (flags.length) {
      nameIssues.push({
        customerID: c.customerID,
        name: c.name,
        phoneNumber: c.phoneNumber || '',
        branchId: c.branchId || '',
        flags,
      });
    }
    const key = normalizeCustomerPhoneDigits(c.phoneNumber);
    if (!key) continue;
    if (!byPhone.has(key)) byPhone.set(key, []);
    byPhone.get(key).push({
      customerID: c.customerID,
      name: c.name,
      phoneNumber: c.phoneNumber || '',
      branchId: c.branchId || '',
    });
  }

  const duplicatePhones = [...byPhone.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([phoneKey, rows]) => ({ phoneKey, count: rows.length, customers: rows }))
    .sort((a, b) => b.count - a.count || a.phoneKey.localeCompare(b.phoneKey));

  return {
    ok: true,
    branchScope,
    scanned: customers.length,
    nameIssueCount: nameIssues.length,
    duplicatePhoneGroupCount: duplicatePhones.length,
    nameIssues,
    duplicatePhones,
  };
}

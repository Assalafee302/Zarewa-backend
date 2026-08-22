/**
 * Supplier identity keys for duplicate detection within a branch.
 * Frontend copies via `npm run sync:shared` → src/shared/supplierIdentityKey.js
 */

import { normalizeCustomerEmailKey, normalizeCustomerPhoneKey } from './customerPhoneKey.js';

const NAME_SUFFIX =
  /\s+(ltd|limited|plc|inc|incorporated|co|company|enterprises|enterprise|nigeria|intl|international|group|holdings|ng)\s*$/i;

/** Company / trading name key — punctuation-stripped, suffix-normalized. */
export function normalizeSupplierNameKey(raw) {
  let s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[&.,'"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  let prev;
  do {
    prev = s;
    s = s.replace(NAME_SUFFIX, '').trim();
  } while (s !== prev && s.length > 2);
  return s.replace(/\s+/g, ' ').trim();
}

export function normalizeSupplierPhoneKey(raw) {
  return normalizeCustomerPhoneKey(raw);
}

export function normalizeSupplierEmailKey(raw) {
  return normalizeCustomerEmailKey(raw);
}

/** RC / VAT / TIN — alphanumeric only. */
export function normalizeSupplierRegistryKey(raw) {
  const k = String(raw ?? '')
    .replace(/\W/g, '')
    .toUpperCase();
  return k.length >= 5 ? k : '';
}

/** Bank account — digits only; min 8 to reduce false positives. */
export function normalizeSupplierAccountKey(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d : '';
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

/**
 * @param {string} name
 * @param {Record<string, unknown> | null | undefined} profile
 */
export function collectSupplierIdentityKeys(name, profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const nameKeys = [];
  const nk = normalizeSupplierNameKey(name);
  if (nk.length >= 3) nameKeys.push(nk);

  const phoneKeys = [];
  for (const field of ['phoneMain', 'whatsapp']) {
    const pk = normalizeSupplierPhoneKey(p[field]);
    if (pk) phoneKeys.push(pk);
  }
  const emailKeys = [];
  const companyEmail = normalizeSupplierEmailKey(p.companyEmail);
  if (companyEmail) emailKeys.push(companyEmail);

  const registryKeys = [];
  for (const field of ['vatTin', 'rcNumber']) {
    const rk = normalizeSupplierRegistryKey(p[field]);
    if (rk) registryKeys.push(rk);
  }

  const accountKeys = [];
  const banks = Array.isArray(p.bankAccounts) ? p.bankAccounts : [];
  for (const b of banks) {
    if (!b || typeof b !== 'object') continue;
    const ak = normalizeSupplierAccountKey(b.accountNumber);
    if (ak) accountKeys.push(ak);
  }

  const contacts = Array.isArray(p.contacts) ? p.contacts : [];
  for (const c of contacts) {
    if (!c || typeof c !== 'object') continue;
    const pk = normalizeSupplierPhoneKey(c.phone);
    if (pk) phoneKeys.push(pk);
    const ek = normalizeSupplierEmailKey(c.email);
    if (ek) emailKeys.push(ek);
  }

  return {
    nameKeys: uniq(nameKeys),
    phoneKeys: uniq(phoneKeys),
    emailKeys: uniq(emailKeys),
    registryKeys: uniq(registryKeys),
    accountKeys: uniq(accountKeys),
  };
}

/**
 * @param {ReturnType<typeof collectSupplierIdentityKeys>} a
 * @param {ReturnType<typeof collectSupplierIdentityKeys>} b
 * @returns {'name' | 'phone' | 'email' | 'registry' | 'account' | null}
 */
export function firstSupplierIdentityOverlap(a, b) {
  if (a.nameKeys.some((k) => b.nameKeys.includes(k))) return 'name';
  if (a.phoneKeys.some((k) => b.phoneKeys.includes(k))) return 'phone';
  if (a.emailKeys.some((k) => b.emailKeys.includes(k))) return 'email';
  if (a.registryKeys.some((k) => b.registryKeys.includes(k))) return 'registry';
  if (a.accountKeys.some((k) => b.accountKeys.includes(k))) return 'account';
  return null;
}

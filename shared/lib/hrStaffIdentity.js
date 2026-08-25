/**
 * Staff identity keys for duplicate detection.
 * NIN, phone, email, BVN, bank account, and employee ID must be unique.
 * Similar names are suspicion only — people can share a name.
 */

const NAME_TITLES = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'dr',
  'prof',
  'alhaji',
  'alhaja',
  'mallam',
  'malam',
  'chief',
  'hon',
  'sir',
  'eng',
  'engr',
  'pastor',
  'imam',
]);

export const STAFF_IDENTITY_FIELDS = [
  { key: 'nin', label: 'NIN' },
  { key: 'phone', label: 'phone number' },
  { key: 'email', label: 'email address' },
  { key: 'bvn', label: 'BVN' },
  { key: 'account', label: 'account number' },
  { key: 'employeeNo', label: 'employee ID' },
];

export function digitsOnly(raw) {
  return String(raw ?? '').replace(/\D/g, '');
}

/** Last 10 digits so 0803… and +234803… match. */
export function normalizeStaffPhoneKey(raw) {
  const d = digitsOnly(raw);
  if (d.length < 10) return '';
  return d.slice(-10);
}

export function normalizeStaffEmailKey(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export function normalizeStaffNinKey(raw) {
  const d = digitsOnly(raw);
  return d.length === 11 ? d : '';
}

export function normalizeStaffBvnKey(raw) {
  const d = digitsOnly(raw);
  return d.length === 11 ? d : '';
}

export function normalizeStaffAccountKey(raw) {
  const d = digitsOnly(raw);
  if (d.length < 8 || d.length > 12) return '';
  return d;
}

export function normalizeStaffEmployeeNoKey(raw) {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

export function normalizePersonNameKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ');
}

export function staffNameTokens(name) {
  return normalizePersonNameKey(name)
    .split(' ')
    .filter((t) => t && !NAME_TITLES.has(t) && t.length > 1);
}

export function levenshteinDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const prev = new Array(t.length + 1);
  const cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= t.length; j += 1) prev[j] = cur[j];
  }
  return prev[t.length];
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {null | { reason: 'exact' | 'same_tokens' | 'similar' | 'shared_name_parts' }}
 */
export function namesLookSuspicious(a, b) {
  const na = normalizePersonNameKey(a);
  const nb = normalizePersonNameKey(b);
  if (!na || !nb || na.length < 4 || nb.length < 4) return null;
  const ta = staffNameTokens(a);
  const tb = staffNameTokens(b);
  if (ta.length < 2 || tb.length < 2) return null;
  if (na === nb) return { reason: 'exact' };

  const sa = [...ta].sort().join(' ');
  const sb = [...tb].sort().join(' ');
  if (sa === sb) return { reason: 'same_tokens' };

  const setA = new Set(ta);
  const setB = new Set(tb);
  const smaller = ta.length <= tb.length ? ta : tb;
  const larger = ta.length <= tb.length ? setB : setA;
  if (smaller.length >= 2 && smaller.every((t) => larger.has(t))) {
    return { reason: 'shared_name_parts' };
  }

  if (na.length >= 8 && nb.length >= 8 && Math.abs(na.length - nb.length) <= 2) {
    const dist = levenshteinDistance(na, nb);
    if (dist > 0 && dist <= 2) return { reason: 'similar' };
  }
  return null;
}

export function identityConflictMessage(fieldLabel, existing) {
  const who = existing?.displayName || existing?.username || existing?.userId || 'another staff member';
  const emp = existing?.employeeNo ? ` (${existing.employeeNo})` : '';
  return `This ${fieldLabel} is already used by ${who}${emp}.`;
}

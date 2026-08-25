/**
 * Unique staff identity: NIN, phone, email, BVN, account number, employee ID.
 * Similar names are returned as warnings only.
 * @module server/hr/staffIdentityUniqueness
 */

import { decryptBankAccount } from '../hrBankCrypto.js';
import { hrTableExists } from '../hrTableChecks.js';
import {
  identityConflictMessage,
  namesLookSuspicious,
  normalizeStaffAccountKey,
  normalizeStaffBvnKey,
  normalizeStaffEmailKey,
  normalizeStaffEmployeeNoKey,
  normalizeStaffNinKey,
  normalizeStaffPhoneKey,
  staffNameTokens,
} from '../../shared/lib/hrStaffIdentity.js';

function parseExtra(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function memberLabel(row) {
  return {
    userId: row.userId,
    username: row.username,
    displayName: row.displayName,
    employeeNo: row.employeeNo || null,
    status: row.status,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listStaffIdentityRows(db) {
  if (!hrTableExists(db, 'hr_staff_profiles') || !hrTableExists(db, 'app_users')) return [];
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT u.id AS userId, u.username, u.display_name AS displayName, u.email, u.status, u.role_key AS roleKey,
                p.employee_no AS employeeNo, p.nin_number AS ninNumber, p.bvn_number AS bvnNumber,
                p.bank_account_no AS bankAccountNo, p.profile_extra_json AS profileExtraJson,
                p.job_title AS jobTitle, p.date_joined_iso AS dateJoinedIso, p.base_salary_ngn AS baseSalaryNgn,
                p.department AS department
         FROM app_users u
         INNER JOIN hr_staff_profiles p ON p.user_id = u.id
         WHERE u.role_key NOT IN ('admin', 'md')`
      )
      .all();
  } catch {
    return [];
  }

  return rows.map((r) => {
    const extra = parseExtra(r.profileExtraJson);
    const personal = extra?.personal && typeof extra.personal === 'object' ? extra.personal : {};
    const composedName = [personal.firstName, personal.middleName, personal.surname].filter(Boolean).join(' ');
    let account = '';
    try {
      account = decryptBankAccount(r.bankAccountNo) || '';
    } catch {
      account = '';
    }
    return {
      userId: r.userId,
      username: r.username,
      displayName: r.displayName,
      status: r.status,
      employeeNo: r.employeeNo,
      jobTitle: r.jobTitle,
      dateJoinedIso: r.dateJoinedIso,
      baseSalaryNgn: r.baseSalaryNgn,
      department: r.department,
      keys: {
        nin: normalizeStaffNinKey(r.ninNumber),
        bvn: normalizeStaffBvnKey(r.bvnNumber),
        phone: normalizeStaffPhoneKey(personal.phone),
        email: normalizeStaffEmailKey(personal.email || r.email),
        account: normalizeStaffAccountKey(account),
        employeeNo: normalizeStaffEmployeeNoKey(r.employeeNo),
      },
      nameForMatch: composedName || r.displayName || '',
    };
  });
}

function pushGroup(map, key, row) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(row);
}

function groupsFromMap(map, field) {
  const groups = [];
  for (const [value, members] of map.entries()) {
    const unique = [];
    const seen = new Set();
    for (const m of members) {
      if (seen.has(m.userId)) continue;
      seen.add(m.userId);
      unique.push(m);
    }
    if (unique.length < 2) continue;
    groups.push({
      field,
      value,
      members: unique.map(memberLabel),
    });
  }
  return groups;
}

/**
 * Existing staff who already share NIN / phone / email / BVN / account / employee ID.
 * @param {import('better-sqlite3').Database} db
 */
export function scanStaffIdentityDuplicates(db) {
  const rows = listStaffIdentityRows(db);
  const byNin = new Map();
  const byBvn = new Map();
  const byPhone = new Map();
  const byEmail = new Map();
  const byAccount = new Map();
  const byEmp = new Map();
  for (const row of rows) {
    pushGroup(byNin, row.keys.nin, row);
    pushGroup(byBvn, row.keys.bvn, row);
    pushGroup(byPhone, row.keys.phone, row);
    pushGroup(byEmail, row.keys.email, row);
    pushGroup(byAccount, row.keys.account, row);
    pushGroup(byEmp, row.keys.employeeNo, row);
  }

  const identityGroups = [
    ...groupsFromMap(byNin, 'nin'),
    ...groupsFromMap(byBvn, 'bvn'),
    ...groupsFromMap(byPhone, 'phone'),
    ...groupsFromMap(byEmail, 'email'),
    ...groupsFromMap(byAccount, 'account'),
    ...groupsFromMap(byEmp, 'employeeNo'),
  ];

  const identityUserIds = new Set();
  for (const g of identityGroups) {
    for (const m of g.members) identityUserIds.add(m.userId);
  }

  const tokenIndex = new Map();
  for (const row of rows) {
    const tokens = staffNameTokens(row.nameForMatch);
    const seenTok = new Set();
    for (const t of tokens) {
      if (t.length < 4 || seenTok.has(t)) continue;
      seenTok.add(t);
      if (!tokenIndex.has(t)) tokenIndex.set(t, []);
      tokenIndex.get(t).push(row);
    }
  }

  const namePairKeys = new Set();
  const nameSuspicions = [];
  for (const list of tokenIndex.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a.userId === b.userId) continue;
        const pair = [a.userId, b.userId].sort().join('|');
        if (namePairKeys.has(pair)) continue;
        const hit = namesLookSuspicious(a.nameForMatch, b.nameForMatch);
        if (!hit) continue;
        namePairKeys.add(pair);
        nameSuspicions.push({
          field: 'name',
          reason: hit.reason,
          members: [memberLabel(a), memberLabel(b)],
          identityOverlap: identityUserIds.has(a.userId) && identityUserIds.has(b.userId),
        });
      }
    }
  }

  return {
    ok: true,
    identityGroups,
    nameSuspicions,
    summary: {
      identityGroups: identityGroups.length,
      nameSuspicions: nameSuspicions.length,
    },
  };
}

/**
 * Block saving an identity value that another staff already has.
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   userId: string;
 *   ninNumber?: string | null;
 *   bvnNumber?: string | null;
 *   phone?: string | null;
 *   email?: string | null;
 *   bankAccountNo?: string | null;
 *   employeeNo?: string | null;
 *   displayName?: string | null;
 * }} fields
 */
export function assertStaffIdentityUnique(db, fields = {}) {
  const userId = String(fields.userId || '').trim();
  if (!userId) return { ok: false, error: 'Staff id required.' };

  const checks = [
    { field: 'nin', label: 'NIN', key: normalizeStaffNinKey(fields.ninNumber) },
    { field: 'bvn', label: 'BVN', key: normalizeStaffBvnKey(fields.bvnNumber) },
    { field: 'phone', label: 'phone number', key: normalizeStaffPhoneKey(fields.phone) },
    { field: 'email', label: 'email address', key: normalizeStaffEmailKey(fields.email) },
    { field: 'account', label: 'account number', key: normalizeStaffAccountKey(fields.bankAccountNo) },
    { field: 'employeeNo', label: 'employee ID', key: normalizeStaffEmployeeNoKey(fields.employeeNo) },
  ].filter((c) => c.key);

  if (!checks.length && !String(fields.displayName || '').trim()) {
    return { ok: true, nameWarnings: [] };
  }

  const rows = listStaffIdentityRows(db);
  for (const check of checks) {
    const hit = rows.find((r) => r.userId !== userId && r.keys[check.field] === check.key);
    if (hit) {
      return {
        ok: false,
        error: identityConflictMessage(check.label, hit),
        code: 'DUPLICATE_IDENTITY',
        field: check.field,
        existing: memberLabel(hit),
      };
    }
  }

  const incomingName = String(fields.displayName || '').trim();
  const nameWarnings = [];
  if (incomingName) {
    for (const row of rows) {
      if (row.userId === userId) continue;
      const hit = namesLookSuspicious(incomingName, row.nameForMatch);
      if (!hit) continue;
      nameWarnings.push({
        field: 'displayName',
        reason: hit.reason,
        message: `Name looks similar to ${row.displayName || row.username}${
          row.employeeNo ? ` (${row.employeeNo})` : ''
        }. Confirm this is not the same person.`,
        existing: memberLabel(row),
      });
      if (nameWarnings.length >= 5) break;
    }
  }

  return { ok: true, nameWarnings };
}

import {
  collectSupplierIdentityKeys,
  firstSupplierIdentityOverlap,
} from '../shared/supplierIdentityKey.js';
import { mergeSupplierProfilePatch, parseSupplierProfileJson } from './supplierProfile.js';

const SUPPLIER_REF_TABLES = [
  ['purchase_orders', 'supplier_id', 'supplier_name'],
  ['coil_lots', 'supplier_id', 'supplier_name'],
  ['material_incidents', 'supplier_id', null],
  ['coil_control_events', 'supplier_id', null],
];

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @param {{ name?: string, supplierProfile?: Record<string, unknown> }} payload
 * @param {string | null | undefined} excludeSupplierId
 * @returns {{ field: string, supplierId: string } | null}
 */
export function findSupplierIdentityConflict(db, branchId, payload, excludeSupplierId) {
  const bid = String(branchId || '').trim();
  if (!bid) return null;
  const incoming = collectSupplierIdentityKeys(
    String(payload?.name ?? '').trim(),
    payload?.supplierProfile
  );
  const hasAny =
    incoming.nameKeys.length ||
    incoming.phoneKeys.length ||
    incoming.emailKeys.length ||
    incoming.registryKeys.length ||
    incoming.accountKeys.length;
  if (!hasAny) return null;

  const ex = excludeSupplierId ? String(excludeSupplierId).trim() : '';
  const rows = db
    .prepare(`SELECT supplier_id, name, supplier_profile_json FROM suppliers WHERE branch_id = ?`)
    .all(bid);

  for (const r of rows) {
    if (ex && r.supplier_id === ex) continue;
    const existing = collectSupplierIdentityKeys(
      r.name,
      parseSupplierProfileJson(r.supplier_profile_json)
    );
    const field = firstSupplierIdentityOverlap(incoming, existing);
    if (field) return { field, supplierId: r.supplier_id };
  }
  return null;
}

const FIELD_LABELS = {
  name: 'company name',
  phone: 'phone number',
  email: 'email address',
  registry: 'RC/VAT registration',
  account: 'bank account number',
};

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @param {{ name?: string, supplierProfile?: Record<string, unknown> }} payload
 * @param {string | null | undefined} excludeSupplierId
 */
export function assertNoDuplicateSupplierIdentity(db, branchId, payload, excludeSupplierId) {
  const conflict = findSupplierIdentityConflict(db, branchId, payload, excludeSupplierId);
  if (!conflict) return;
  const label = FIELD_LABELS[conflict.field] || conflict.field;
  const e = new Error(
    `A supplier with this ${label} is already registered (${conflict.supplierId}). Open that profile or merge records instead of creating a duplicate.`
  );
  e.code = 'DUPLICATE_SUPPLIER_REGISTRATION';
  e.existingSupplierId = conflict.supplierId;
  e.conflictField = conflict.field;
  throw e;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} supplierId
 */
function purchaseOrderCount(db, supplierId) {
  return Number(
    db.prepare(`SELECT COUNT(*) AS c FROM purchase_orders WHERE supplier_id = ?`).get(supplierId)?.c ?? 0
  );
}

function compareSupplierIds(a, b) {
  const na = parseInt(String(a).replace(/\D/g, ''), 10);
  const nb = parseInt(String(b).replace(/\D/g, ''), 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{ supplier_id: string, name: string, supplier_profile_json?: string | null, branch_id: string }>} group
 */
export function pickCanonicalSupplierRow(db, group) {
  if (!group.length) return null;
  const scored = group.map((r) => ({
    row: r,
    poCount: purchaseOrderCount(db, r.supplier_id),
  }));
  scored.sort((a, b) => {
    if (b.poCount !== a.poCount) return b.poCount - a.poCount;
    return compareSupplierIds(a.row.supplier_id, b.row.supplier_id);
  });
  return scored[0].row;
}

/**
 * Cluster suppliers in a branch that share any identity key.
 * @param {Array<{ supplier_id: string, name: string, supplier_profile_json?: string | null, branch_id: string }>} rows
 */
export function clusterDuplicateSuppliers(rows) {
  const byBranch = new Map();
  for (const r of rows) {
    const bid = String(r.branch_id || '').trim();
    if (!byBranch.has(bid)) byBranch.set(bid, []);
    byBranch.get(bid).push(r);
  }

  const clusters = [];
  for (const branchRows of byBranch.values()) {
    const idToKeys = new Map();
    const keyToIds = new Map();

    const addKey = (key, id) => {
      if (!key) return;
      if (!keyToIds.has(key)) keyToIds.set(key, new Set());
      keyToIds.get(key).add(id);
    };

    for (const r of branchRows) {
      const keys = collectSupplierIdentityKeys(
        r.name,
        parseSupplierProfileJson(r.supplier_profile_json)
      );
      idToKeys.set(r.supplier_id, keys);
      for (const k of keys.nameKeys) addKey(`n:${k}`, r.supplier_id);
      for (const k of keys.phoneKeys) addKey(`p:${k}`, r.supplier_id);
      for (const k of keys.emailKeys) addKey(`e:${k}`, r.supplier_id);
      for (const k of keys.registryKeys) addKey(`r:${k}`, r.supplier_id);
      for (const k of keys.accountKeys) addKey(`a:${k}`, r.supplier_id);
    }

    const parent = new Map(branchRows.map((r) => [r.supplier_id, r.supplier_id]));
    const find = (id) => {
      let p = parent.get(id);
      while (p !== parent.get(p)) {
        parent.set(p, parent.get(parent.get(p)));
        p = parent.get(p);
      }
      parent.set(id, p);
      return p;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    for (const ids of keyToIds.values()) {
      const list = [...ids];
      for (let i = 1; i < list.length; i++) union(list[0], list[i]);
    }

    const groups = new Map();
    for (const r of branchRows) {
      const root = find(r.supplier_id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(r);
    }
    for (const g of groups.values()) {
      if (g.length > 1) clusters.push(g);
    }
  }
  return clusters;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function buildSupplierMergePlan(db) {
  const rows = db
    .prepare(
      `SELECT supplier_id, name, branch_id, supplier_profile_json FROM suppliers ORDER BY branch_id, supplier_id`
    )
    .all();
  const merges = [];
  const mergedLosers = new Set();

  for (const group of clusterDuplicateSuppliers(rows)) {
    const winner = pickCanonicalSupplierRow(db, group);
    if (!winner) continue;
    const winnerId = String(winner.supplier_id).trim();
    const winnerName = String(winner.name || '').trim();
    for (const loser of group) {
      const loserId = String(loser.supplier_id).trim();
      if (!loserId || loserId === winnerId || mergedLosers.has(loserId)) continue;
      mergedLosers.add(loserId);
      merges.push({
        branchId: String(loser.branch_id || winner.branch_id || '').trim(),
        fromId: loserId,
        fromName: String(loser.name || '').trim(),
        toId: winnerId,
        toName: winnerName,
      });
    }
  }
  return merges;
}

/**
 * @param {Record<string, unknown>} winnerProfile
 * @param {Record<string, unknown>} loserProfile
 */
export function mergeSupplierProfiles(winnerProfile, loserProfile) {
  const w = { ...winnerProfile };
  const l = loserProfile && typeof loserProfile === 'object' ? loserProfile : {};
  const fillStr = (k) => {
    if (String(w[k] ?? '').trim()) return;
    const v = String(l[k] ?? '').trim();
    if (v) w[k] = v;
  };
  for (const k of [
    'companyEmail',
    'website',
    'vatTin',
    'rcNumber',
    'registeredAddress',
    'billingAddress',
    'phoneMain',
    'whatsapp',
    'notesCommercial',
  ]) {
    fillStr(k);
  }
  const mergeArr = (key, max) => {
    const seen = new Set();
    const out = [];
    for (const src of [w[key], l[key]]) {
      if (!Array.isArray(src)) continue;
      for (const item of src) {
        if (!item || typeof item !== 'object') continue;
        const sig = JSON.stringify(item);
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(item);
        if (out.length >= max) return out;
      }
    }
    return out;
  };
  w.bankAccounts = mergeArr('bankAccounts', 6);
  w.contacts = mergeArr('contacts', 8);
  const agreements = mergeArr('agreements', 6);
  if (agreements.length) w.agreements = agreements;
  return w;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ fromId: string, toId: string, toName: string, fromName?: string }} merge
 */
export function applySupplierMerge(db, merge) {
  const fromId = String(merge.fromId || '').trim();
  const toId = String(merge.toId || '').trim();
  const toName = String(merge.toName || '').trim();
  const fromName = String(merge.fromName || '').trim();
  if (!fromId || !toId || fromId === toId) return;

  const winner = db
    .prepare(`SELECT supplier_profile_json FROM suppliers WHERE supplier_id = ?`)
    .get(toId);
  const loser = db
    .prepare(`SELECT supplier_profile_json FROM suppliers WHERE supplier_id = ?`)
    .get(fromId);
  if (!winner || !loser) return;

  const mergedProfile = mergeSupplierProfiles(
    parseSupplierProfileJson(winner.supplier_profile_json),
    parseSupplierProfileJson(loser.supplier_profile_json)
  );

  for (const [table, idCol, nameCol] of SUPPLIER_REF_TABLES) {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table)) continue;
    db.prepare(`UPDATE ${table} SET ${idCol} = ? WHERE ${idCol} = ?`).run(toId, fromId);
    if (nameCol) {
      db.prepare(
        `UPDATE ${table} SET ${nameCol} = ? WHERE ${idCol} = ? AND (
            trim(coalesce(${nameCol},'')) = '' OR trim(${nameCol}) = ?
          )`
      ).run(toName, toId, fromName);
    }
  }

  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='treasury_movements'`).get()) {
    db.prepare(
      `UPDATE treasury_movements SET counterparty_id = ?, counterparty_name = ?
         WHERE counterparty_kind = 'SUPPLIER' AND counterparty_id = ?`
    ).run(toId, toName, fromId);
  }

  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='accounts_payable'`).get()) {
    db.prepare(`UPDATE accounts_payable SET supplier_name = ? WHERE trim(supplier_name) = ?`).run(
      toName,
      fromName
    );
  }

  db.prepare(`UPDATE suppliers SET supplier_profile_json = ? WHERE supplier_id = ?`).run(
    JSON.stringify(mergedProfile),
    toId
  );
  db.prepare(`UPDATE suppliers SET name = ? WHERE supplier_id = ?`).run(toName, toId);
  db.prepare(`DELETE FROM suppliers WHERE supplier_id = ?`).run(fromId);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function migrateMergeDuplicateSuppliers(db) {
  const merges = buildSupplierMergePlan(db);
  if (!merges.length) return { merged: 0, merges: [] };
  db.transaction(() => {
    for (const m of merges) applySupplierMerge(db, m);
  })();
  return { merged: merges.length, merges };
}

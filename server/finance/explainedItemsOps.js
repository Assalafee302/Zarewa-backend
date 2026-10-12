/**
 * Explained-items register.
 *
 * A Locked record documents bank activity that management has explained and deliberately
 * left out of the ERP (for example a pass-through that is not a sale, purchase, refund or
 * company expense). Anything linked to a Locked record with do_not_raise = 1 is skipped by
 * reconciliation and exception checks and shown once as "Explained (locked): … – see register".
 *
 * The register never posts: no treasury movement, journal, or customer/supplier entry.
 * Balance tie-outs (e.g. treasury integrity) keep counting linked movements; they only
 * report the register alongside their figures.
 */
import { appendAuditLog } from '../controlOps.js';

export const EXPLAINED_ITEM_STATUSES = Object.freeze(['Locked', 'Open', 'Withdrawn']);

/** What a register record can be linked to. */
export const EXPLAINED_ENTITY_TYPES = Object.freeze([
  'bank_recon_line',
  'bank_statement_line',
  'treasury_movement',
  'sales_receipt',
  'ledger_entry',
]);

export function ensureExplainedItemsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS explained_items (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      title TEXT NOT NULL,
      short_label TEXT,
      explanation TEXT NOT NULL,
      amount_in_ngn REAL NOT NULL DEFAULT 0,
      amount_out_ngn REAL NOT NULL DEFAULT 0,
      treasury_account_id INTEGER,
      bank_account_label TEXT,
      period_key TEXT,
      approved_by_user_id TEXT,
      approved_by_name TEXT,
      approved_at_iso TEXT,
      status TEXT NOT NULL DEFAULT 'Locked',
      do_not_raise INTEGER NOT NULL DEFAULT 1,
      created_at_iso TEXT NOT NULL,
      created_by_name TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_explained_items_branch ON explained_items(branch_id, period_key);
    CREATE TABLE IF NOT EXISTS explained_item_links (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      fingerprint TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_explained_links_item ON explained_item_links(item_id);
    CREATE INDEX IF NOT EXISTS idx_explained_links_entity ON explained_item_links(entity_type, entity_id);
  `);
}

/** Statement-line identity that survives re-import: date | whole-naira amount | description. */
export function bankLineFingerprint(bankDateISO, amountNgn, description) {
  const day = String(bankDateISO || '').slice(0, 10);
  const amt = Math.round(Number(amountNgn) || 0);
  const desc = String(description || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return `${day}|${amt}|${desc}`;
}

export function explainedLabel(item) {
  const label = String(item?.short_label || item?.title || item?.id || '').trim();
  return `Explained (locked): ${label} – see register`;
}

/**
 * Pure: build a lookup from register rows + link rows.
 * Only Locked items with do_not_raise set suppress anything.
 */
export function buildExplainedIndex(items = [], links = []) {
  const active = new Map();
  for (const it of items) {
    if (String(it?.status || '') !== 'Locked') continue;
    if (Number(it?.do_not_raise ?? 1) !== 1) continue;
    active.set(String(it.id), it);
  }
  const byEntity = new Map();
  const byFingerprint = new Map();
  for (const l of links) {
    const item = active.get(String(l?.item_id || ''));
    if (!item) continue;
    byEntity.set(`${l.entity_type}:${String(l.entity_id)}`, item);
    if (l.fingerprint) byFingerprint.set(String(l.fingerprint), item);
  }
  return { items: active, byEntity, byFingerprint };
}

/** Pure: which Locked item (if any) covers this entity. */
export function lockedItemFor(index, entityType, entityId, fingerprint) {
  if (!index) return null;
  if (entityId != null && entityId !== '') {
    const hit = index.byEntity.get(`${entityType}:${String(entityId)}`);
    if (hit) return hit;
  }
  if (fingerprint) return index.byFingerprint.get(String(fingerprint)) || null;
  return null;
}

/**
 * Pure: split rows into those still to be raised and those covered by a Locked record.
 * `explained` lists each register record once, however many rows it covered.
 */
export function partitionExplained(rows = [], index, { entityType, idOf, fingerprintOf } = {}) {
  const kept = [];
  const seen = new Map();
  for (const row of rows) {
    const item = lockedItemFor(
      index,
      entityType,
      idOf ? idOf(row) : row?.id,
      fingerprintOf ? fingerprintOf(row) : null
    );
    if (!item) {
      kept.push(row);
      continue;
    }
    const prev = seen.get(item.id);
    if (prev) prev.lineCount += 1;
    else {
      seen.set(item.id, {
        itemId: item.id,
        title: item.title,
        label: explainedLabel(item),
        amountInNgn: Number(item.amount_in_ngn) || 0,
        amountOutNgn: Number(item.amount_out_ngn) || 0,
        lineCount: 1,
      });
    }
  }
  return { kept, explained: [...seen.values()] };
}

function tableReady(db) {
  try {
    db.prepare(`SELECT 1 FROM explained_items LIMIT 1`).get();
    db.prepare(`SELECT 1 FROM explained_item_links LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

/** Load the lookup from the database. Empty (never throws) when the register is not installed. */
export function loadExplainedIndex(db, branchId = null) {
  if (!tableReady(db)) return buildExplainedIndex([], []);
  const bid = String(branchId || '').trim();
  const items = bid
    ? db.prepare(`SELECT * FROM explained_items WHERE branch_id = ?`).all(bid)
    : db.prepare(`SELECT * FROM explained_items`).all();
  const links = db.prepare(`SELECT * FROM explained_item_links`).all();
  return buildExplainedIndex(items, links);
}

/** Register records summarised for reports (Locked only). */
export function listLockedExplainedSummaries(db, branchId = null) {
  const index = loadExplainedIndex(db, branchId);
  return [...index.items.values()].map((it) => ({
    itemId: it.id,
    title: it.title,
    label: explainedLabel(it),
    amountInNgn: Number(it.amount_in_ngn) || 0,
    amountOutNgn: Number(it.amount_out_ngn) || 0,
    periodKey: it.period_key || '',
  }));
}

function nextExplainedItemId(db, branchId) {
  const code = String(branchId || 'BR-KD').replace(/^BR-/, '');
  const yy = new Date().toISOString().slice(2, 4);
  const prefix = `EXP-${code}-${yy}-`;
  const row = db
    .prepare(`SELECT id FROM explained_items WHERE id LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`${prefix}%`);
  const n = row ? Number(String(row.id).slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(4, '0')}`;
}

function nextLinkId() {
  return `EXPL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a register record with its links. Locked by default.
 * @param {{ branchId: string, title: string, shortLabel?: string, explanation: string,
 *   amountInNgn?: number, amountOutNgn?: number, treasuryAccountId?: number, bankAccountLabel?: string,
 *   periodKey?: string, approvedByUserId?: string, approvedByName?: string, approvedAtISO?: string,
 *   status?: string, links?: Array<{ entityType: string, entityId: string, fingerprint?: string, note?: string }>,
 *   alreadyInTransaction?: boolean }} payload
 */
export function createExplainedItem(db, payload, actor = null) {
  const title = String(payload?.title || '').trim();
  const explanation = String(payload?.explanation || '').trim();
  const branchId = String(payload?.branchId || '').trim();
  if (!title || !explanation || !branchId) return { ok: false, error: 'Branch, title and explanation are required.' };
  const status = String(payload?.status || 'Locked');
  if (!EXPLAINED_ITEM_STATUSES.includes(status)) return { ok: false, error: `Unknown status ${status}.` };
  const links = Array.isArray(payload?.links) ? payload.links : [];
  for (const l of links) {
    if (!EXPLAINED_ENTITY_TYPES.includes(String(l?.entityType || ''))) {
      return { ok: false, error: `Unknown link type ${l?.entityType}.` };
    }
    if (!String(l?.entityId || '').trim()) return { ok: false, error: 'Each link needs an entity id.' };
  }
  // DDL commits an open MySQL transaction, so callers inside one must ensure the schema first.
  if (!payload?.alreadyInTransaction) ensureExplainedItemsSchema(db);
  const id = nextExplainedItemId(db, branchId);
  const now = new Date().toISOString();
  const run = () => {
    db.prepare(
      `INSERT INTO explained_items (
        id, branch_id, title, short_label, explanation, amount_in_ngn, amount_out_ngn, treasury_account_id,
        bank_account_label, period_key, approved_by_user_id, approved_by_name, approved_at_iso, status,
        do_not_raise, created_at_iso, created_by_name
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      branchId,
      title,
      String(payload?.shortLabel || '').trim() || null,
      explanation,
      Number(payload?.amountInNgn) || 0,
      Number(payload?.amountOutNgn) || 0,
      payload?.treasuryAccountId != null ? Number(payload.treasuryAccountId) : null,
      String(payload?.bankAccountLabel || '').trim() || null,
      String(payload?.periodKey || '').trim() || null,
      String(payload?.approvedByUserId || '').trim() || null,
      String(payload?.approvedByName || '').trim() || null,
      String(payload?.approvedAtISO || '').trim() || now,
      status,
      payload?.doNotRaise === false ? 0 : 1,
      now,
      String(actor?.displayName || actor?.name || '').trim() || null
    );
    const ins = db.prepare(
      `INSERT INTO explained_item_links (id, item_id, entity_type, entity_id, fingerprint, note) VALUES (?,?,?,?,?,?)`
    );
    for (const l of links) {
      ins.run(
        nextLinkId(),
        id,
        String(l.entityType),
        String(l.entityId),
        String(l.fingerprint || '').trim() || null,
        String(l.note || '').trim() || null
      );
    }
    appendAuditLog(db, {
      actor,
      action: 'explained_item.create',
      entityKind: 'explained_item',
      entityId: id,
      note: title,
      details: { status, links: links.map((l) => `${l.entityType}:${l.entityId}`) },
    });
  };
  if (payload?.alreadyInTransaction) run();
  else db.transaction(run)();
  return { ok: true, id };
}

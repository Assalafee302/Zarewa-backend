/**
 * Safe memory layers for Runa — topics and patterns only, never restricted payloads.
 */
import { sanitizeHelpMemoryPayload } from './helpDesignLimits.js';
import { fingerprintHelpQuery } from './helpSelfTrain.js';

/**
 * @param {import('better-sqlite3').Database | null | undefined} db
 * @param {string} table
 */
function hasTable(db, table) {
  if (!db) return false;
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'user' | 'branch'} scope
 * @param {string} scopeId
 * @param {string} key
 */
export function readHelpMemory(db, scope, scopeId, key) {
  const table = scope === 'user' ? 'help_user_memory' : 'help_branch_memory';
  const idCol = scope === 'user' ? 'user_id' : 'branch_id';
  if (!hasTable(db, table)) return null;
  const row = db
    .prepare(`SELECT payload_json FROM ${table} WHERE ${idCol} = ? AND memory_key = ?`)
    .get(String(scopeId || ''), String(key || ''));
  if (!row?.payload_json) return null;
  try {
    return JSON.parse(String(row.payload_json));
  } catch {
    return null;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'user' | 'branch'} scope
 * @param {string} scopeId
 * @param {string} key
 * @param {unknown} payload
 */
export function writeHelpMemory(db, scope, scopeId, key, payload) {
  const table = scope === 'user' ? 'help_user_memory' : 'help_branch_memory';
  const idCol = scope === 'user' ? 'user_id' : 'branch_id';
  if (!hasTable(db, table) || !scopeId || !key) return;
  const at = new Date().toISOString();
  const safePayload = sanitizeHelpMemoryPayload(payload ?? {});
  db.prepare(
    `INSERT INTO ${table} (${idCol}, memory_key, payload_json, updated_at_iso)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(${idCol}, memory_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       updated_at_iso = excluded.updated_at_iso`
  ).run(String(scopeId), String(key), JSON.stringify(safePayload), at);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ userId?: string; queryText?: string; articleIds?: string[]; agentRoute?: string }} opts
 */
export function recordUserQueryMemory(db, opts = {}) {
  const userId = String(opts.userId || '').trim();
  if (!userId || !db) return;
  const mem = readHelpMemory(db, 'user', userId, 'topics') || {
    articleHits: {},
    routes: {},
    fingerprints: {},
  };
  for (const id of opts.articleIds || []) {
    const k = String(id);
    if (!k) continue;
    mem.articleHits[k] = (mem.articleHits[k] || 0) + 1;
  }
  const route = String(opts.agentRoute || 'guide');
  mem.routes[route] = (mem.routes[route] || 0) + 1;
  const fp = fingerprintHelpQuery(String(opts.queryText || ''));
  if (fp !== 'empty') {
    mem.fingerprints[fp] = (mem.fingerprints[fp] || 0) + 1;
  }
  writeHelpMemory(db, 'user', userId, 'topics', mem);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @returns {Record<string, number>}
 */
export function memoryArticleBoosts(db, userId) {
  const mem = readHelpMemory(db, 'user', String(userId || ''), 'topics');
  if (!mem?.articleHits) return {};
  /** @type {Record<string, number>} */
  const boosts = {};
  for (const [id, hits] of Object.entries(mem.articleHits)) {
    boosts[id] = Math.min(6, Math.log10(Number(hits) + 1) * 3);
  }
  return boosts;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @returns {Record<string, number>}
 */
export function branchMemoryArticleBoosts(db, branchId) {
  const mem = readHelpMemory(db, 'branch', String(branchId || ''), 'workflow_patterns');
  if (!mem?.articleBoosts) return {};
  return { ...mem.articleBoosts };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function readCoachingSession(db, userId) {
  return readHelpMemory(db, 'user', userId, 'coaching_session');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {object | null} session
 */
export function writeCoachingSession(db, userId, session) {
  if (!session) {
    if (hasTable(db, 'help_user_memory')) {
      db.prepare(`DELETE FROM help_user_memory WHERE user_id = ? AND memory_key = ?`).run(
        String(userId),
        'coaching_session'
      );
    }
    return;
  }
  writeHelpMemory(db, 'user', userId, 'coaching_session', session);
}

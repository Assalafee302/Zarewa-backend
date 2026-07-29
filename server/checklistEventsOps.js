import crypto from 'node:crypto';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendAuditLog } from './controlOps.js';

function tableReady(db) {
  try {
    return Boolean(
      db.prepare(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`
      ).get('checklist_events')
    );
  } catch {
    try {
      return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get('checklist_events'));
    } catch {
      return false;
    }
  }
}

function mapRow(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    dayIso: row.day_iso,
    itemId: row.item_id,
    note: row.note || '',
    authorUserId: row.author_user_id || '',
    authorName: row.author_name || '',
    createdAtIso: row.created_at_iso,
  };
}

export function listChecklistEvents(db, opts = {}) {
  if (!tableReady(db)) return [];
  const branchId = String(opts.branchId || '').trim();
  const dayIso = String(opts.dayIso || '').trim().slice(0, 10);
  const args = [];
  let sql = `SELECT * FROM checklist_events WHERE 1 = 1`;
  if (branchId) {
    sql += ` AND branch_id = ?`;
    args.push(branchId);
  }
  if (dayIso) {
    sql += ` AND day_iso = ?`;
    args.push(dayIso);
  }
  sql += ` ORDER BY created_at_iso DESC LIMIT ?`;
  args.push(Math.min(500, Math.max(1, Number(opts.limit) || 100)));
  return db.prepare(sql).all(...args).map(mapRow);
}

export function createChecklistEvent(db, body, actor, workspaceBranchId = DEFAULT_BRANCH_ID) {
  if (!tableReady(db)) return { ok: false, error: 'Checklist events table not ready — run migrate.' };
  const branchId = String(body?.branchId || workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const dayIso = String(body?.dayIso || '').trim().slice(0, 10);
  const itemId = String(body?.itemId || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayIso) || !itemId) {
    return { ok: false, error: 'dayIso (YYYY-MM-DD) and itemId are required.' };
  }
  const id = `CHK-${crypto.randomBytes(6).toString('hex')}`;
  const createdAtIso = new Date().toISOString();
  const authorUserId = String(actor?.id || '').trim() || null;
  const authorName = String(actor?.displayName || actor?.username || actor?.email || '').trim() || null;
  db.prepare(
    `INSERT INTO checklist_events (id, branch_id, day_iso, item_id, note, author_user_id, author_name, created_at_iso)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, branchId, dayIso, itemId, String(body?.note || '').trim() || null, authorUserId, authorName, createdAtIso);
  appendAuditLog(db, {
    actor,
    action: 'checklist_event.create',
    entityKind: 'checklist_event',
    entityId: id,
    note: `Checklist event ${itemId} for ${branchId} ${dayIso}`,
    details: { branchId, dayIso, itemId },
  });
  return { ok: true, event: listChecklistEvents(db, { branchId, dayIso, limit: 20 }).find((event) => event.id === id) };
}

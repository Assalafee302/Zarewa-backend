/**
 * HR learning & development — training records per employee.
 * @module server/hrLearning
 */

import crypto from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

export function hrLearningTablesReady(db) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_training_records'`).get());
  } catch {
    return false;
  }
}

export function listHrTrainingRecords(db, userId) {
  if (!hrLearningTablesReady(db)) return [];
  const uid = String(userId || '').trim();
  let sql = `SELECT id, user_id AS userId, title, provider, completed_at_iso AS completedAtIso,
                    expiry_at_iso AS expiryAtIso, certificate_ref AS certificateRef, notes,
                    created_at_iso AS createdAtIso, created_by_user_id AS createdByUserId
             FROM hr_training_records`;
  const args = [];
  if (uid) {
    sql += ` WHERE user_id = ?`;
    args.push(uid);
  }
  sql += ` ORDER BY completed_at_iso DESC, created_at_iso DESC LIMIT 200`;
  return db.prepare(sql).all(...args);
}

export function createHrTrainingRecord(db, actor, body = {}) {
  if (!hrLearningTablesReady(db)) return { ok: false, error: 'Learning module not initialised.' };
  const userId = String(body.userId || '').trim();
  const title = String(body.title || '').trim();
  if (!userId) return { ok: false, error: 'userId is required.' };
  if (title.length < 2) return { ok: false, error: 'title is required.' };
  const id = newId('HRTRN');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_training_records (
      id, user_id, title, provider, completed_at_iso, expiry_at_iso, certificate_ref, notes,
      created_at_iso, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    userId,
    title,
    String(body.provider || '').trim() || null,
    String(body.completedAtIso || '').slice(0, 10) || now.slice(0, 10),
    String(body.expiryAtIso || '').slice(0, 10) || null,
    String(body.certificateRef || '').trim() || null,
    String(body.notes || '').trim() || null,
    now,
    actor?.id || null
  );
  return { ok: true, id };
}

export function deleteHrTrainingRecord(db, recordId, userId) {
  if (!hrLearningTablesReady(db)) return { ok: false, error: 'Learning module not initialised.' };
  const id = String(recordId || '').trim();
  const uid = String(userId || '').trim();
  const row = db.prepare(`SELECT id, user_id FROM hr_training_records WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Record not found.' };
  if (uid && row.user_id !== uid) return { ok: false, error: 'Record not found.' };
  db.prepare(`DELETE FROM hr_training_records WHERE id = ?`).run(id);
  return { ok: true };
}

/**
 * Mirror payment-request lifecycle into linked Office Desk threads (system messages).
 */

function newMessageId() {
  return `OM-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} requestId
 * @param {string} bodyText
 */
export function appendPaymentRequestTimelineToOfficeThreads(db, requestId, bodyText) {
  const rid = String(requestId || '').trim();
  const text = String(bodyText || '').trim();
  if (!rid || !text) return;
  try {
    const tbl = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='office_threads'`)
      .get();
    if (!tbl) return;
    const threads = db.prepare(`SELECT id FROM office_threads WHERE related_payment_request_id = ?`).all(rid);
    if (!threads.length) return;
    const now = new Date().toISOString();
    for (const row of threads) {
      const tid = String(row?.id || '').trim();
      if (!tid) continue;
      const mid = newMessageId();
      db.prepare(
        `INSERT INTO office_messages (id, thread_id, author_user_id, body, kind, created_at_iso) VALUES (?,?,?,?,?,?)`
      ).run(mid, tid, null, text, 'system', now);
      db.prepare(`UPDATE office_threads SET updated_at_iso = ? WHERE id = ?`).run(now, tid);
    }
  } catch (e) {
    console.error('appendPaymentRequestTimelineToOfficeThreads', e);
  }
}

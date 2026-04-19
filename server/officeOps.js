/**
 * Internal Office Desk: threads, messages, memo → payment request conversion.
 */
import { canUseAllBranchesRollup, userHasPermission } from './auth.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendAuditLog, insertPaymentRequest } from './controlOps.js';
import { hrListScope } from './hrOps.js';

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    const v = JSON.parse(String(raw));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function parseUserIdsJson(json) {
  const a = safeJsonParse(json, []);
  if (!Array.isArray(a)) return [];
  return a.map((x) => String(x || '').trim()).filter(Boolean);
}

function newThreadId() {
  return `OTD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function newMessageId() {
  return `OM-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const MAX_MEMO_ATTACHMENTS = 5;
const MAX_MEMO_ATTACHMENT_B64_LEN = 4_500_000;

/**
 * @param {unknown} raw
 * @returns {{ name: string, mime: string, dataBase64: string }[]}
 */
function normalizeMemoAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, MAX_MEMO_ATTACHMENTS)) {
    const name = String(a?.name ?? 'file').trim().slice(0, 200);
    const mime = String(a?.mime ?? 'application/octet-stream').split(';')[0].trim().slice(0, 120);
    const dataBase64 = String(a?.dataBase64 ?? '').trim();
    if (!dataBase64) continue;
    const allowed = mime.startsWith('image/') || mime === 'application/pdf';
    if (!allowed) continue;
    if (dataBase64.length > MAX_MEMO_ATTACHMENT_B64_LEN) continue;
    out.push({ name, mime, dataBase64 });
  }
  return out;
}

export function officeScopeFromReq(req) {
  return hrListScope({
    user: req.user,
    workspaceBranchId: req.workspaceBranchId,
    workspaceViewAll: req.workspaceViewAll,
  });
}

export function officeTablesReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='office_threads'`).get()
    );
  } catch {
    return false;
  }
}

function userCanSeeThreadWithUser(scope, user, row) {
  const uid = String(user?.id || '').trim();
  if (!uid || !row) return false;
  const rk = String(user?.roleKey || '').trim().toLowerCase();
  const payload = safeJsonParse(row.payload_json, {});
  const confidentiality = String(payload.confidentiality || 'internal').trim().toLowerCase();
  const to = parseUserIdsJson(row.to_user_ids_json);
  const cc = parseUserIdsJson(row.cc_user_ids_json);
  const participant =
    String(row.created_by_user_id || '').trim() === uid || to.includes(uid) || cc.includes(uid);

  const hqRollup = canUseAllBranchesRollup(user) && scope.viewAll;
  if (hqRollup && (rk === 'admin' || rk === 'md' || rk === 'ceo')) {
    // Confidential memos: executives must still be on distribution (or admin/*), not the whole branch roll-up.
    if (confidentiality === 'confidential') {
      if (rk === 'admin' || userHasPermission(user, '*')) return true;
      return participant;
    }
    return true;
  }
  const bid = String(row.branch_id || '').trim() || DEFAULT_BRANCH_ID;
  if (!scope.viewAll && bid !== String(scope.branchId || '').trim()) {
    return false;
  }
  if (userHasPermission(user, '*')) {
    return true;
  }
  if (String(row.created_by_user_id || '').trim() === uid) return true;
  return to.includes(uid) || cc.includes(uid);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 * @param {object} user
 * @param {{ mineOnly?: boolean }} [filter]
 */
export function listOfficeThreads(db, scope, user, filter = {}) {
  if (!officeTablesReady(db)) return [];
  const uid = String(user?.id || '').trim();
  const mineOnly = Boolean(filter.mineOnly);

  let sql = `SELECT * FROM office_threads WHERE 1=1`;
  const args = [];
  if (!scope.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(String(scope.branchId || '').trim() || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY updated_at_iso DESC LIMIT 400`;
  const rows = db.prepare(sql).all(...args);

  return rows
    .filter((row) => userCanSeeThreadWithUser(scope, user, row))
    .filter((row) => {
      if (!mineOnly) return true;
      return String(row.created_by_user_id || '').trim() === uid;
    })
    .map((row) => mapThreadRow(db, row));
}

function mapThreadRow(db, row) {
  const lastMsg = db
    .prepare(
      `SELECT id, author_user_id, kind, created_at_iso FROM office_messages WHERE thread_id = ? ORDER BY created_at_iso DESC LIMIT 1`
    )
    .get(row.id);
  return {
    id: row.id,
    branchId: row.branch_id,
    createdByUserId: row.created_by_user_id,
    kind: row.kind,
    status: row.status,
    documentClass: row.document_class || 'correspondence',
    officeKey: row.office_key || 'office_admin',
    relatedWorkItemId: row.related_work_item_id || null,
    subject: row.subject,
    body: row.body,
    toUserIds: parseUserIdsJson(row.to_user_ids_json),
    ccUserIds: parseUserIdsJson(row.cc_user_ids_json),
    relatedPaymentRequestId: row.related_payment_request_id || null,
    payload: safeJsonParse(row.payload_json, {}),
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
    lastMessageAtIso: lastMsg?.created_at_iso ?? row.updated_at_iso,
    lastMessageAuthorUserId: lastMsg?.author_user_id ?? null,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 * @param {object} user
 * @param {string} threadId
 */
export function getOfficeThread(db, scope, user, threadId) {
  if (!officeTablesReady(db)) return { ok: false, error: 'Office Desk is not available.' };
  const tid = String(threadId || '').trim();
  const row = db.prepare(`SELECT * FROM office_threads WHERE id = ?`).get(tid);
  if (!row) return { ok: false, error: 'Thread not found.' };
  if (!userCanSeeThreadWithUser(scope, user, row)) return { ok: false, error: 'Forbidden.' };
  const messages = db
    .prepare(
      `SELECT id, thread_id, author_user_id, body, kind, created_at_iso FROM office_messages WHERE thread_id = ? ORDER BY created_at_iso ASC`
    )
    .all(tid);
  const participants = new Set();
  participants.add(String(row.created_by_user_id || '').trim());
  for (const id of parseUserIdsJson(row.to_user_ids_json)) participants.add(id);
  for (const id of parseUserIdsJson(row.cc_user_ids_json)) participants.add(id);
  return {
    ok: true,
    thread: mapThreadRow(db, row),
    messages: messages.map((m) => ({
      id: m.id,
      threadId: m.thread_id,
      authorUserId: m.author_user_id,
      body: m.body,
      kind: m.kind,
      createdAtIso: m.created_at_iso,
    })),
    participantUserIds: [...participants].filter(Boolean),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {string} workspaceBranchId
 * @param {{ subject: string, body?: string, toUserIds?: string[], ccUserIds?: string[], kind?: string, memoDateIso?: string, attachments?: unknown[], payload?: object, documentClass?: string, officeKey?: string }} body
 */
export function createOfficeThread(db, actor, workspaceBranchId, body) {
  if (!officeTablesReady(db)) return { ok: false, error: 'Office Desk is not available.' };
  const subject = String(body?.subject ?? '').trim();
  if (subject.length < 2) return { ok: false, error: 'Subject is required.' };
  const msgBody = String(body?.body ?? '').trim();
  const toUserIds = Array.isArray(body?.toUserIds) ? body.toUserIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const ccUserIds = Array.isArray(body?.ccUserIds) ? body.ccUserIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const kind = String(body?.kind || 'memo').trim() || 'memo';
  const documentClass = String(body?.documentClass || 'correspondence').trim() || 'correspondence';
  const officeKey = String(body?.officeKey || 'office_admin').trim() || 'office_admin';
  const branchId = String(workspaceBranchId || '').trim() || DEFAULT_BRANCH_ID;
  const id = newThreadId();
  const now = nowIso();
  const uid = String(actor?.id || '').trim();
  if (!uid) return { ok: false, error: 'Sign in required.' };

  const memoDateIso = String(body?.memoDateIso ?? '').trim().slice(0, 10) || null;
  const attachments = normalizeMemoAttachments(body?.attachments);
  const extraPayload = body?.payload != null && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {};
  const payloadObj = {
    ...extraPayload,
    ...(memoDateIso ? { memoDateIso } : {}),
    uploadedAtIso: now,
    attachments,
  };
  const payloadJson = JSON.stringify(payloadObj);

  let firstMessageBody = msgBody || '—';
  if (attachments.length > 0) {
    const names = attachments.map((x) => x.name).join(', ');
    firstMessageBody = `${firstMessageBody}\n\n[Attachments: ${names}]`;
  }

  db.transaction(() => {
    db.prepare(
      `INSERT INTO office_threads (
        id, branch_id, created_by_user_id, kind, status, subject, body, to_user_ids_json, cc_user_ids_json,
        related_work_item_id, related_payment_request_id, document_class, office_key, payload_json, created_at_iso, updated_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      branchId,
      uid,
      kind,
      'open',
      subject,
      msgBody || null,
      JSON.stringify(toUserIds),
      JSON.stringify(ccUserIds),
      null,
      null,
      documentClass,
      officeKey,
      payloadJson,
      now,
      now
    );
    const mid = newMessageId();
    db.prepare(
      `INSERT INTO office_messages (id, thread_id, author_user_id, body, kind, created_at_iso) VALUES (?,?,?,?,?,?)`
    ).run(mid, id, uid, firstMessageBody, 'user', now);
    appendAuditLog(db, {
      actor,
      action: 'office.thread.create',
      entityKind: 'office_thread',
      entityId: id,
      note: subject.slice(0, 120),
      details: { branchId, kind, documentClass, officeKey },
    });
  })();

  const row = db.prepare(`SELECT * FROM office_threads WHERE id = ?`).get(id);
  return { ok: true, thread: mapThreadRow(db, row) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 * @param {object} actor
 * @param {string} workspaceBranchId
 * @param {string} threadId
 * @param {{ body: string }} body
 */
export function addOfficeMessage(db, scope, actor, workspaceBranchId, threadId, body) {
  if (!officeTablesReady(db)) return { ok: false, error: 'Office Desk is not available.' };
  const tid = String(threadId || '').trim();
  const row = db.prepare(`SELECT * FROM office_threads WHERE id = ?`).get(tid);
  if (!row) return { ok: false, error: 'Thread not found.' };
  if (!userCanSeeThreadWithUser(scope, actor, row)) return { ok: false, error: 'Forbidden.' };
  const text = String(body?.body ?? '').trim();
  if (text.length < 1) return { ok: false, error: 'Message is required.' };
  const uid = String(actor?.id || '').trim();
  const now = nowIso();
  const mid = newMessageId();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO office_messages (id, thread_id, author_user_id, body, kind, created_at_iso) VALUES (?,?,?,?,?,?)`
    ).run(mid, tid, uid, text, 'user', now);
    db.prepare(`UPDATE office_threads SET updated_at_iso = ? WHERE id = ?`).run(now, tid);
    appendAuditLog(db, {
      actor,
      action: 'office.message.create',
      entityKind: 'office_thread',
      entityId: tid,
      note: text.slice(0, 120),
    });
  })();
  return { ok: true, messageId: mid };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} threadId
 */
export function markOfficeThreadRead(db, userId, threadId) {
  if (!officeTablesReady(db)) return { ok: false, error: 'Office Desk is not available.' };
  const uid = String(userId || '').trim();
  const tid = String(threadId || '').trim();
  if (!uid || !tid) return { ok: false, error: 'Invalid.' };
  const now = nowIso();
  db.prepare(
    `INSERT INTO office_thread_reads (user_id, thread_id, last_read_at_iso) VALUES (?,?,?)
     ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_at_iso = excluded.last_read_at_iso`
  ).run(uid, tid, now);
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 * @param {object} actor
 * @param {string} workspaceBranchId
 * @param {string} threadId
 * @param {object} payload — same shape as insertPaymentRequest body (lineItems, expenseCategory, …)
 */
export function convertOfficeThreadToPaymentRequest(db, scope, actor, workspaceBranchId, threadId, payload) {
  if (!officeTablesReady(db)) return { ok: false, error: 'Office Desk is not available.' };
  const tid = String(threadId || '').trim();
  const row = db.prepare(`SELECT * FROM office_threads WHERE id = ?`).get(tid);
  if (!row) return { ok: false, error: 'Thread not found.' };
  if (!userCanSeeThreadWithUser(scope, actor, row)) return { ok: false, error: 'Forbidden.' };
  if (String(row.created_by_user_id || '').trim() !== String(actor?.id || '').trim()) {
    return { ok: false, error: 'Only the author can convert this thread to an expense request.' };
  }
  if (String(row.status || '') === 'converted' || row.related_payment_request_id) {
    return { ok: false, error: 'This thread was already converted.' };
  }

  const branchId = String(row.branch_id || workspaceBranchId || '').trim() || DEFAULT_BRANCH_ID;
  const preDesc = [String(row.subject || '').trim(), String(row.body || '').trim()].filter(Boolean).join('\n\n');
  const description = String(payload?.description ?? '').trim() || preDesc || '—';
  const requestReference = String(payload?.requestReference ?? '').trim() || `OFFICE-${tid}`;

  const payPayload = {
    ...payload,
    description,
    requestReference,
    workspaceBranchId: branchId,
    requestDate: String(payload?.requestDate ?? '').trim() || nowIso().slice(0, 10),
  };

  const ins = insertPaymentRequest(db, payPayload, actor);
  if (!ins.ok) return ins;

  const requestID = ins.requestID;
  const now = nowIso();
  const sysBody = `Converted to expense payment request ${requestID}. Track approval and payout under Accounts → Expenses & requests.`;

  db.transaction(() => {
    db.prepare(
      `UPDATE office_threads SET status = 'converted', kind = 'expense', related_payment_request_id = ?, updated_at_iso = ?, payload_json = ?
       WHERE id = ?`
    ).run(
      requestID,
      now,
      JSON.stringify({
        ...safeJsonParse(row.payload_json, {}),
        convertedAtIso: now,
        paymentRequestId: requestID,
      }),
      tid
    );
    const mid = newMessageId();
    db.prepare(
      `INSERT INTO office_messages (id, thread_id, author_user_id, body, kind, created_at_iso) VALUES (?,?,?,?,?,?)`
    ).run(mid, tid, null, sysBody, 'system', now);
    appendAuditLog(db, {
      actor,
      action: 'office.thread.convert_payment_request',
      entityKind: 'office_thread',
      entityId: tid,
      note: requestID,
      details: { paymentRequestId: requestID },
    });
  })();

  return { ok: true, requestID, threadId: tid };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 */
export function listOfficeDirectory(db, scope) {
  const viewAll = scope.viewAll;
  const branchId = String(scope.branchId || '').trim() || DEFAULT_BRANCH_ID;
  let sql = `
    SELECT u.id, u.username, u.display_name AS displayName, u.role_key AS roleKey,
           COALESCE(p.branch_id, '') AS branchId
    FROM app_users u
    LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
    WHERE u.status = 'active'
  `;
  const args = [];
  if (!viewAll) {
    sql += ` AND (p.branch_id = ? OR p.branch_id IS NULL OR TRIM(COALESCE(p.branch_id,'')) = '')`;
    args.push(branchId);
  }
  sql += ` ORDER BY u.display_name ASC LIMIT 500`;
  return db
    .prepare(sql)
    .all(...args)
    .map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.displayName,
      roleKey: r.roleKey,
      branchId: r.branchId || '',
    }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 * @param {object} user
 */
export function getOfficeSummary(db, scope, user) {
  if (!officeTablesReady(db)) {
    return { ok: true, unreadApprox: 0, pendingActionApprox: 0, threadCount: 0 };
  }
  const threads = listOfficeThreads(db, scope, user, {});
  const uid = String(user?.id || '').trim();
  let unreadApprox = 0;
  let pendingActionApprox = 0;

  for (const t of threads) {
    const row = db.prepare(`SELECT * FROM office_threads WHERE id = ?`).get(t.id);
    const last = db
      .prepare(
        `SELECT author_user_id, kind, created_at_iso FROM office_messages WHERE thread_id = ? ORDER BY created_at_iso DESC LIMIT 1`
      )
      .get(t.id);
    const read = db.prepare(`SELECT last_read_at_iso FROM office_thread_reads WHERE user_id = ? AND thread_id = ?`).get(
      uid,
      t.id
    );
    const lastAt = last?.created_at_iso || '';
    const readAt = read?.last_read_at_iso || '';
    if (lastAt && (!readAt || lastAt > readAt)) {
      unreadApprox += 1;
    }
    const to = parseUserIdsJson(row?.to_user_ids_json);
    const lastAuthor = String(last?.author_user_id || '').trim();
    const isTo = to.includes(uid);
    if (isTo && last && last.kind === 'user' && lastAuthor && lastAuthor !== uid && String(row?.status || '') === 'open') {
      pendingActionApprox += 1;
    }
  }

  return {
    ok: true,
    unreadApprox,
    pendingActionApprox,
    threadCount: threads.length,
  };
}

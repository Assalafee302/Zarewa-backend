/**
 * AI-assisted “filing cabinet” extracts for Office Desk threads (structured summary + cost + category).
 */
import { runOfficeThreadFilingExtract } from './aiAssist.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendAuditLog } from './controlOps.js';
import { getOfficeThread, listOfficeThreads, officeTablesReady } from './officeOps.js';

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

export function officeFilingTableReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='office_thread_filing'`).get()
    );
  } catch {
    return false;
  }
}

function mapFilingRow(row) {
  if (!row) return null;
  return {
    threadId: row.thread_id,
    branchId: row.branch_id,
    categoryKey: row.category_key,
    categoryLabel: row.category_label,
    summary: row.summary,
    costNgn: row.cost_ngn != null ? Number(row.cost_ngn) : null,
    tags: safeJsonParse(row.tags_json, []),
    keyFacts: safeJsonParse(row.key_facts_json, {}),
    relatedPaymentRequestId: row.related_payment_request_id || null,
    conversationDigest: row.conversation_digest || '',
    extractedAtIso: row.extracted_at_iso,
    updatedAtIso: row.updated_at_iso,
    modelHint: row.model_hint || '',
    threadSubject: row.thread_subject || '',
  };
}

function buildTranscriptFromDetail(t) {
  const lines = [`SUBJECT: ${t.thread.subject}`, `THREAD_ID: ${t.thread.id}`];
  if (t.thread.relatedPaymentRequestId) {
    lines.push(`LINKED_PAYMENT_REQUEST: ${t.thread.relatedPaymentRequestId}`);
  }
  for (const m of t.messages || []) {
    const role = m.kind === 'system' ? 'SYSTEM' : `USER:${m.authorUserId || 'unknown'}`;
    lines.push(`[${m.createdAtIso}] ${role}: ${m.body}`);
  }
  return lines.join('\n').slice(0, 65_000);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 * @param {object} user
 * @param {string} threadId
 */
export async function saveOfficeThreadFilingFromAi(db, scope, user, threadId) {
  if (!officeTablesReady(db)) return { ok: false, error: 'Office Desk is not available.' };
  if (!officeFilingTableReady(db)) {
    return { ok: false, error: 'Filing storage is not available. Run database migrations.' };
  }
  const tid = String(threadId || '').trim();
  const t = getOfficeThread(db, scope, user, tid);
  if (!t.ok) return t;

  const transcript = buildTranscriptFromDetail(t);
  let extracted;
  try {
    extracted = await runOfficeThreadFilingExtract({
      threadSubject: t.thread.subject,
      transcript,
      relatedPaymentRequestId: t.thread.relatedPaymentRequestId || '',
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e), code: e?.code };
  }

  const now = nowIso();
  const bid = String(t.thread.branchId || '').trim() || DEFAULT_BRANCH_ID;

  db.prepare(
    `INSERT INTO office_thread_filing (
      thread_id, branch_id, category_key, category_label, summary, cost_ngn, tags_json, key_facts_json,
      related_payment_request_id, conversation_digest, extracted_at_iso, updated_at_iso, model_hint
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(thread_id) DO UPDATE SET
      branch_id = excluded.branch_id,
      category_key = excluded.category_key,
      category_label = excluded.category_label,
      summary = excluded.summary,
      cost_ngn = excluded.cost_ngn,
      tags_json = excluded.tags_json,
      key_facts_json = excluded.key_facts_json,
      related_payment_request_id = excluded.related_payment_request_id,
      conversation_digest = excluded.conversation_digest,
      updated_at_iso = excluded.updated_at_iso,
      model_hint = excluded.model_hint`
  ).run(
    t.thread.id,
    bid,
    extracted.categoryKey,
    extracted.categoryLabel,
    extracted.summary || '—',
    extracted.costNgn,
    JSON.stringify(extracted.tags),
    JSON.stringify(extracted.keyFacts),
    t.thread.relatedPaymentRequestId || null,
    transcript.slice(0, 32_000),
    now,
    now,
    extracted.modelHint || ''
  );

  appendAuditLog(db, {
    actor: user,
    action: 'office.thread.filing_extract',
    entityKind: 'office_thread',
    entityId: tid,
    note: String(extracted.categoryLabel || '').slice(0, 120),
    details: { categoryKey: extracted.categoryKey, costNgn: extracted.costNgn },
  });

  const row = db
    .prepare(
      `SELECT f.*, t.subject AS thread_subject FROM office_thread_filing f
       INNER JOIN office_threads t ON t.id = f.thread_id WHERE f.thread_id = ?`
    )
    .get(tid);
  return { ok: true, filing: mapFilingRow(row) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 * @param {object} user
 * @param {string} threadId
 */
export function getOfficeThreadFiling(db, scope, user, threadId) {
  if (!officeTablesReady(db)) return { ok: false, error: 'Office Desk is not available.' };
  const tid = String(threadId || '').trim();
  const t = getOfficeThread(db, scope, user, tid);
  if (!t.ok) return t;
  if (!officeFilingTableReady(db)) return { ok: true, filing: null };
  const row = db
    .prepare(
      `SELECT f.*, t.subject AS thread_subject FROM office_thread_filing f
       INNER JOIN office_threads t ON t.id = f.thread_id WHERE f.thread_id = ?`
    )
    .get(tid);
  return { ok: true, filing: mapFilingRow(row) };
}

/**
 * Filing rows for threads the user can already see (same visibility as thread list).
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 * @param {object} user
 */
export function listOfficeThreadFilingForUser(db, scope, user) {
  if (!officeFilingTableReady(db) || !officeTablesReady(db)) return [];
  const visible = listOfficeThreads(db, scope, user, {});
  const ids = visible.map((x) => x.id).filter(Boolean);
  if (ids.length === 0) return [];
  const chunkSize = 80;
  const out = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const ph = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT f.*, t.subject AS thread_subject FROM office_thread_filing f
         INNER JOIN office_threads t ON t.id = f.thread_id
         WHERE f.thread_id IN (${ph})
         ORDER BY f.updated_at_iso DESC`
      )
      .all(...chunk);
    out.push(...rows.map(mapFilingRow));
  }
  out.sort((a, b) => String(b.updatedAtIso).localeCompare(String(a.updatedAtIso)));
  return out.slice(0, 400);
}

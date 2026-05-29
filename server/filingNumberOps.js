import { DEFAULT_BRANCH_ID } from './branches.js';
import { bumpHumanSerial, getBranchCodeUpper } from './humanId.js';

const PREFIX_BY_CATEGORY = {
  maintenance: 'MNT',
  fuel: 'FUEL',
  fuel_diesel: 'FUEL',
  finance: 'FIN',
  procurement: 'PROC',
  hr: 'HR',
  production: 'PROD',
  incident: 'INC',
  customer: 'CUS',
  management: 'MGT',
  general: 'GEN',
};

/**
 * @param {string} category
 */
export function filingPrefixForCategory(category) {
  const c = String(category || 'general')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  for (const [key, prefix] of Object.entries(PREFIX_BY_CATEGORY)) {
    if (c.includes(key)) return prefix;
  }
  return 'GEN';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string; category?: string }} opts
 */
export function allocateFilingNumber(db, opts = {}) {
  const branchId = String(opts.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const prefix = filingPrefixForCategory(opts.category);
  const code = getBranchCodeUpper(db, branchId);
  const yy = String(new Date().getFullYear()).slice(-2);
  const scope = `FILING|${prefix}|${code}|${new Date().getFullYear()}`;
  const seq = bumpHumanSerial(db, scope);
  return `${prefix}-${code}-${yy}-${String(seq).padStart(4, '0')}`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} threadId
 * @param {object} actor
 * @param {{ category?: string; branchId?: string }} opts
 */
export function fileOfficeThread(db, threadId, actor, opts = {}) {
  const tid = String(threadId || '').trim();
  if (!tid) return { ok: false, error: 'Thread id required.' };
  const row = db.prepare(`SELECT id, branch_id, payload_json, status FROM office_threads WHERE id = ?`).get(tid);
  if (!row) return { ok: false, error: 'Office record not found.' };

  let payload = {};
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    payload = {};
  }
  if (payload.filingNo) {
    return { ok: true, filingNo: payload.filingNo, alreadyFiled: true };
  }

  const filingNo = allocateFilingNumber(db, {
    branchId: opts.branchId || row.branch_id,
    category: opts.category || payload.smartMemo?.memoType || payload.recordType,
  });
  payload.filingNo = filingNo;
  payload.filedAtIso = new Date().toISOString();
  payload.filedByUserId = actor?.id;

  db.prepare(`UPDATE office_threads SET status = 'filed', payload_json = ?, updated_at_iso = ? WHERE id = ?`).run(
    JSON.stringify(payload),
    new Date().toISOString(),
    tid
  );

  const now = new Date().toISOString();
  const bid = String(row.branch_id || opts.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const catKey = String(opts.category || 'general').trim().toLowerCase();
  db.prepare(
    `INSERT INTO office_thread_filing (
      thread_id, branch_id, category_key, category_label, summary, cost_ngn, tags_json, key_facts_json,
      related_payment_request_id, conversation_digest, extracted_at_iso, updated_at_iso, model_hint
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(thread_id) DO UPDATE SET
      category_key = excluded.category_key,
      category_label = excluded.category_label,
      summary = excluded.summary,
      updated_at_iso = excluded.updated_at_iso`
  ).run(
    tid,
    bid,
    catKey,
    filingNo,
    `Filed by ${actor?.displayName || actor?.username || 'system'} · ${filingNo}`,
    null,
    JSON.stringify([filingNo]),
    JSON.stringify({ filingNo }),
    row.related_payment_request_id || null,
    '',
    now,
    now,
    'manual_file'
  );

  return { ok: true, filingNo };
}

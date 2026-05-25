/**
 * POST /api/help/memo-assist — rule-based memo writing assistant.
 */
import { runMemoAssist } from '../shared/lib/memoAssist.js';
import { appendAuditLog } from './controlOps.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} body
 */
export function handleMemoAssist(db, user, body = {}) {
  const action = String(body?.action || 'classify').trim().toLowerCase();
  const allowed = [
    'classify',
    'improve',
    'make_shorter',
    'make_formal',
    'fix_grammar',
    'checklist',
    'suggest_route',
    'suggest_expense_category',
    'suggest_filing_category',
    'manager_reply',
  ];
  if (!allowed.includes(action)) {
    return { ok: false, error: 'Invalid action.' };
  }

  const result = runMemoAssist({
    subject: body?.subject,
    body: body?.body,
    memoType: body?.memoType,
    guidedFields: body?.guidedFields,
    attachmentCount: body?.attachmentCount,
    templateId: body?.templateId,
    action,
  });

  if (db && user?.id) {
    try {
      appendAuditLog(db, {
        actor: user,
        action: 'help.memo_assist',
        entityKind: 'help',
        entityId: String(user.id),
        note: action,
        details: { memoType: result.memoType, confidence: result.confidence },
      });
    } catch {
      /* non-fatal */
    }
  }

  return { ok: true, ...result };
}

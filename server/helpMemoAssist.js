/**
 * POST /api/help/memo-assist — memo writing assistant (rules + optional frontier LLM polish).
 */
import { runMemoAssist } from '../shared/lib/memoAssist.js';
import { appendAuditLog } from './controlOps.js';
import { readAiAssistConfig, runMemoAssistPolish } from './aiAssist.js';
import { enrichMemoAssist } from './aiUnificationLayer/index.js';
import { processMemoAutomationHook } from './aiAutomationEngine/index.js';

const LLM_POLISH_ACTIONS = new Set(['improve', 'make_formal', 'make_shorter', 'fix_grammar']);

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} body
 */
export async function handleMemoAssist(db, user, body = {}) {
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
    'correction_memo',
    'transaction_issue',
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
    issueType: body?.issueType,
    transactionContext: body?.transactionContext,
    reason: body?.reason,
  });

  if (LLM_POLISH_ACTIONS.has(action) && readAiAssistConfig().enabled) {
    try {
      const polished = await runMemoAssistPolish({
        subject: body?.subject,
        body: body?.body,
        action,
      });
      if (polished?.subject) result.suggestedSubject = polished.subject;
      if (polished?.body) result.improvedBody = polished.body;
      result.aiPolished = true;
    } catch {
      /* rule-based result from runMemoAssist remains */
    }
  }

  if (db && user?.id) {
    try {
      appendAuditLog(db, {
        actor: user,
        action: 'help.memo_assist',
        entityKind: 'help',
        entityId: String(user.id),
        note: action,
        details: {
          memoType: result.memoType,
          confidence: result.confidence,
          aiPolished: Boolean(result.aiPolished),
        },
      });
    } catch {
      /* non-fatal */
    }
  }

  const enriched = await enrichMemoAssist(db, user, body, result);
  const withAutomation = await processMemoAutomationHook(db, user, body, enriched);
  return { ok: true, ...withAutomation };
}

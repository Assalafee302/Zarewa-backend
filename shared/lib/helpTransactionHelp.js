/**
 * Zare transaction help — issue classification, safe guidance, correction memos, next-best-action.
 */
import { HELP_BOT_NAME } from './helpBotBrand.js';
import { classifyZareIntent } from './helpZareIntent.js';
import { formatHelpErrorReply } from './helpErrorExplain.js';

/** @typedef {'draft' | 'posted' | 'approved' | 'settled' | 'restricted' | 'unknown'} TxLifecycle */

/** @type {Record<string, { memoType: string; subject: string; template: string; route: string[] }>} */
export const CORRECTION_MEMO_TEMPLATES = {
  wrong_payment_amount: {
    memoType: 'Payment Correction Memo',
    subject: 'Payment Amount Correction Request',
    route: ['Branch Manager', 'Finance'],
    template: `A payment was entered with an incorrect amount and requires review.

Transaction reference:
Incorrect amount:
Correct amount:
Customer:
Reason:
Supporting document:
Requested action:
Kindly review and approve the necessary correction.`,
  },
  duplicate_receipt: {
    memoType: 'Duplicate Receipt Report',
    subject: 'Duplicate Receipt Report',
    route: ['Finance', 'Branch Manager'],
    template: `A duplicate receipt may have been recorded and requires review.

Transaction reference(s):
Original receipt:
Duplicate receipt:
Reason:
Supporting document:
Requested action:
Please verify and advise on reversal or correction.`,
  },
  wrong_customer_payment: {
    memoType: 'Wrong Customer Payment Report',
    subject: 'Wrong Customer Payment Report',
    route: ['Branch Manager', 'Finance'],
    template: `A payment may have been posted to the wrong customer.

Transaction reference:
Posted customer:
Correct customer:
Amount:
Reason:
Supporting document:
Requested action:`,
  },
  reversal_request: {
    memoType: 'Receipt Reversal Request',
    subject: 'Receipt Reversal Request',
    route: ['Finance', 'Branch Manager'],
    template: `A posted receipt requires reversal for audit review.

Transaction reference:
Reason for reversal:
Supporting document:
Requested action:`,
  },
  wrong_expense_amount: {
    memoType: 'Expense Correction Request',
    subject: 'Expense Correction Request',
    route: ['Branch Manager', 'Finance'],
    template: `An expense was recorded with an incorrect amount.

Transaction reference:
Incorrect amount:
Correct amount:
Supplier/vendor:
Reason:
Supporting document:
Requested action:`,
  },
  wrong_vendor_or_supplier: {
    memoType: 'Supplier Payment Correction',
    subject: 'Supplier Payment Correction',
    route: ['Procurement', 'Finance'],
    template: `A supplier payment may have been applied incorrectly.

Transaction reference:
Incorrect supplier:
Correct supplier:
Amount:
Reason:
Supporting document:
Requested action:`,
  },
  cannot_approve: {
    memoType: 'Approval Error Report',
    subject: 'Approval Issue Report',
    route: ['Branch Manager'],
    template: `An approval action could not be completed.

Transaction reference:
Expected action:
Blocker observed:
Reason:
Requested action:`,
  },
  missing_attachment: {
    memoType: 'Missing Attachment Notice',
    subject: 'Missing Attachment Notice',
    route: ['Branch Manager'],
    template: `Required supporting proof is missing for this transaction.

Transaction reference:
Document needed:
Reason:
Requested action:`,
  },
};

export const TRANSACTION_ISSUE_CHIPS = [
  { id: 'wrong_payment_amount', label: 'Wrong amount' },
  { id: 'wrong_customer_payment', label: 'Wrong customer/vendor' },
  { id: 'duplicate_receipt', label: 'Duplicate transaction' },
  { id: 'wrong_payment_method', label: 'Wrong payment method' },
  { id: 'reversal_request', label: 'Need reversal' },
  { id: 'missing_attachment', label: 'Missing proof' },
  { id: 'cannot_approve', label: 'Cannot approve' },
  { id: 'transaction_stuck', label: 'Payment not showing' },
  { id: 'transaction_problem', label: 'Other issue' },
];

/**
 * @param {Record<string, unknown>} [ctx]
 * @returns {TxLifecycle}
 */
export function inferTransactionLifecycle(ctx = {}) {
  const status = String(ctx.status || ctx.approvalStatus || '').toLowerCase();
  const settlement = String(ctx.settlementStatus || '').toLowerCase();
  if (ctx.canView === false || ctx.restricted) return 'restricted';
  if (/\bdraft\b/i.test(status)) return 'draft';
  if (/\bposted\b/i.test(status)) return 'posted';
  if (/\b(approved|settled|paid)\b/i.test(status) || /\b(settled|paid)\b/i.test(settlement)) {
    if (/\bsettled|paid\b/i.test(settlement)) return 'settled';
    return 'approved';
  }
  if (/\bsaved|submitted\b/i.test(status)) return 'posted';
  return 'unknown';
}

/**
 * @param {TxLifecycle} lifecycle
 * @param {Record<string, unknown>} ctx
 * @returns {string[]}
 */
export function suggestNextBestActions(lifecycle, ctx = {}) {
  const actions = [];
  const canEdit = Boolean(ctx.canEdit);
  const canReverse = Boolean(ctx.canReverse);
  const canApprove = Boolean(ctx.canApprove);
  const canCreateMemo = ctx.canCreateMemo !== false;

  if (lifecycle === 'draft' && canEdit) {
    actions.push('Open the transaction and edit the draft while it is still editable.');
  } else if (lifecycle === 'draft' && !canEdit) {
    actions.push('You cannot edit this draft — ask a user with edit permission or raise a memo.');
  } else if (lifecycle === 'posted' || lifecycle === 'approved' || lifecycle === 'settled') {
    actions.push('Do not edit posted amounts directly — preserve the audit trail.');
    if (canCreateMemo) actions.push('Raise a correction memo with reference, wrong/correct values, reason, and proof.');
    if (canReverse && lifecycle !== 'settled') {
      actions.push('If your role allows, request reversal through Finance — never delete the record.');
    } else if (!canReverse) {
      actions.push('You cannot reverse this — escalate to Finance or Branch Manager via correction memo.');
    }
  } else if (lifecycle === 'restricted') {
    actions.push('You do not have permission to view full details — raise an issue memo if allowed.');
  }

  if (ctx.approvalStatus && !canApprove) {
    actions.push('Check clearance level, branch scope, required attachments, and period lock.');
  }

  return actions;
}

/**
 * @param {string} issueType
 * @param {Record<string, unknown>} [fields]
 */
export function buildCorrectionMemo(issueType, fields = {}) {
  const tpl = CORRECTION_MEMO_TEMPLATES[issueType] || CORRECTION_MEMO_TEMPLATES.wrong_payment_amount;
  let body = tpl.template;
  const ref = fields.referenceNo || fields.transactionReference;
  if (ref) body = body.replace('Transaction reference:', `Transaction reference: ${ref}`);
  if (fields.wrongValue) body = body.replace('Incorrect amount:', `Incorrect amount: ${fields.wrongValue}`);
  if (fields.correctValue) body = body.replace('Correct amount:', `Correct amount: ${fields.correctValue}`);
  if (fields.reason) body = body.replace('Reason:', `Reason: ${fields.reason}`);
  return {
    memoType: tpl.memoType,
    subject: tpl.subject,
    body,
    route: tpl.route,
    issueType,
  };
}

/**
 * Human-readable issue label.
 * @param {string} issueType
 */
export function describeTransactionIssue(issueType) {
  const map = {
    wrong_payment_amount: 'wrong payment amount',
    wrong_customer_payment: 'wrong customer payment',
    duplicate_receipt: 'duplicate receipt',
    wrong_payment_method: 'wrong payment method',
    wrong_branch: 'wrong branch',
    reversal_request: 'reversal request',
    cannot_approve: 'approval blocker',
    transaction_stuck: 'stuck or missing transaction',
    missing_attachment: 'missing attachment',
    correction_request: 'correction request',
  };
  return map[issueType] || 'transaction issue';
}

/**
 * @param {{
 *   message: string;
 *   history?: Array<{ role?: string; content?: string }>;
 *   pageContext?: Record<string, unknown>;
 *   transactionContext?: Record<string, unknown>;
 * }} opts
 */
export function buildTransactionHelpReply(opts = {}) {
  const message = String(opts.message || '').trim();
  const tx = opts.transactionContext || opts.pageContext?.transaction || {};
  const issueType = classifyZareIntent(message, opts.history || [], {
    ...opts.pageContext,
    issueType: opts.pageContext?.issueType,
    mode: opts.pageContext?.mode,
  });

  const errReply = formatHelpErrorReply(message);
  if (issueType === 'error_explanation' && errReply) {
    return { content: errReply, issueType, correctionMemo: null, nextActions: [] };
  }

  const lifecycle = inferTransactionLifecycle(tx);
  const issueLabel = describeTransactionIssue(
    CORRECTION_MEMO_TEMPLATES[issueType] ? issueType : 'correction_request'
  );

  const lines = [];
  lines.push(`This looks like a **${issueLabel}** issue.`);

  if (tx.referenceNo) {
    lines.push(`Reference: **${tx.referenceNo}** (${String(tx.transactionType || tx.module || 'transaction')}).`);
  }

  if (lifecycle === 'draft') {
    lines.push(
      'This record appears to be a **draft**. If your role allows, you may edit it directly before posting.'
    );
  } else if (lifecycle === 'posted' || lifecycle === 'approved' || lifecycle === 'settled') {
    lines.push(
      `This transaction is **${lifecycle}** — do not edit amounts directly. Use a correction or reversal workflow with approval.`
    );
  } else if (lifecycle === 'restricted') {
    lines.push('You do not have permission to view full transaction details. I can still guide you on safe steps.');
  }

  const nextActions = suggestNextBestActions(lifecycle, tx);
  if (nextActions.length) {
    lines.push('', '**Recommended next steps:**');
    nextActions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  }

  const tplKey = CORRECTION_MEMO_TEMPLATES[issueType] ? issueType : 'wrong_payment_amount';
  const correctionMemo =
    lifecycle !== 'draft' || !tx.canEdit
      ? buildCorrectionMemo(tplKey, {
          referenceNo: tx.referenceNo,
          wrongValue: tx.wrongValue,
          correctValue: tx.correctValue,
          reason: '',
        })
      : null;

  if (correctionMemo && tx.canCreateMemo !== false) {
    const route = correctionMemo.route.join(' and ');
    lines.push(
      '',
      `I can help you prepare a **${correctionMemo.memoType}** for ${route} review. Open Compose Memo, paste the draft, attach proof, and submit — **${HELP_BOT_NAME} will not post or approve for you.**`
    );
  }

  if (issueType === 'cannot_approve') {
    lines.push('', '**Common approval blockers:** clearance below required amount, wrong branch, missing attachment, already approved, or locked period.');
  }

  if (!tx.referenceNo) {
    lines.push('', 'Please share the **transaction reference number** if you have it so guidance can be more specific.');
  }

  return {
    content: lines.join('\n'),
    issueType: tplKey,
    correctionMemo,
    nextActions,
    lifecycle,
  };
}

/**
 * @param {string} pathname
 * @param {Record<string, unknown>} [tx]
 */
export function isTransactionHelpSurface(pathname, tx = null) {
  const p = String(pathname || '');
  if (tx?.referenceNo || tx?.transactionType) return true;
  return (
    /\/(sales|accounts|procurement|operations|manager)/.test(p) &&
    /\b(receipt|payment|refund|expense|quotation|po|procurement)\b/i.test(p)
  );
}

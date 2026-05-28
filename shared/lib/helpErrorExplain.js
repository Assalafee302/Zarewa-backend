/**
 * Plain-language ERP error explanations for Zare.
 */

/** @type {Record<string, { title: string; explanation: string; nextSteps: string[] }>} */
export const HELP_ERROR_DICTIONARY = {
  clearance_scope_denied: {
    title: 'Clearance denied',
    explanation:
      'You do not have clearance to perform this action. It must be handled by a manager with the required approval authority.',
    nextSteps: [
      'Check your role clearance in Settings or ask your branch manager.',
      'Raise a memo or correction request if the action is urgent.',
    ],
  },
  '403': {
    title: 'Access denied',
    explanation: 'Your account does not have permission for this action.',
    nextSteps: ['Confirm your role and branch scope.', 'Ask a manager or Finance user if approval is required.'],
  },
  amount_required: {
    title: 'Amount required',
    explanation: 'This request cannot be submitted because the amount field is empty.',
    nextSteps: ['Enter the estimated or confirmed amount before submitting.', 'Attach proof if amount is estimated.'],
  },
  PERIOD_LOCKED: {
    title: 'Period locked',
    explanation: 'This transaction belongs to a locked accounting period.',
    nextSteps: [
      'Do not edit posted amounts directly.',
      'Raise a correction memo for Finance/Admin review.',
      'Ask Finance to unlock the period in Settings → Governance if the month should still be open.',
    ],
  },
  LEDGER_POST_BLOCKED: {
    title: 'Ledger posting paused',
    explanation: 'Customer or quotation ledger posting is blocked until a compliance hold is cleared.',
    nextSteps: [
      'Open Manager dashboard → Transaction Intel for this customer.',
      'Finish or withdraw any in-progress refund before posting new cash.',
      'Ask a manager to release the hold when appropriate.',
    ],
  },
  period_locked: {
    title: 'Period locked',
    explanation: 'This transaction belongs to a locked accounting period.',
    nextSteps: [
      'Do not edit posted amounts directly.',
      'Raise a correction memo for Finance/Admin review.',
    ],
  },
  missing_attachment: {
    title: 'Attachment required',
    explanation: 'A required attachment is missing, so approval or submission is blocked.',
    nextSteps: ['Attach proof (quotation, receipt, mechanic report, etc.).', 'Save and resubmit for approval.'],
  },
  branch_scope_denied: {
    title: 'Branch scope',
    explanation: 'This item belongs to another branch. You may view it but cannot approve or change it.',
    nextSteps: ['Switch to the correct branch if your role allows.', 'Ask the owning branch manager to act.'],
  },
  already_approved: {
    title: 'Already approved',
    explanation: 'This item has already been approved and cannot be approved again.',
    nextSteps: ['Check status on the detail screen.', 'Use correction or reversal workflow if something is wrong.'],
  },
  duplicate_reference: {
    title: 'Duplicate reference',
    explanation: 'A record with this reference may already exist.',
    nextSteps: ['Search for the existing receipt or payment.', 'Raise a duplicate report instead of posting again.'],
  },
};

/**
 * @param {string} codeOrMessage
 * @returns {{ code: string; title: string; explanation: string; nextSteps: string[] } | null}
 */
export function explainHelpError(codeOrMessage) {
  const raw = String(codeOrMessage || '').trim().toLowerCase();
  if (!raw) return null;

  const direct = HELP_ERROR_DICTIONARY[raw] || HELP_ERROR_DICTIONARY[raw.replace(/\s+/g, '_')];
  if (direct) {
    return { code: raw, ...direct };
  }

  for (const [code, entry] of Object.entries(HELP_ERROR_DICTIONARY)) {
    if (raw.includes(code.replace(/_/g, ' ')) || raw.includes(code)) {
      return { code, ...entry };
    }
  }

  if (/\bclearance\b/i.test(raw)) return { code: 'clearance', ...HELP_ERROR_DICTIONARY.clearance_scope_denied };
  if (/\bperiod.*lock/i.test(raw)) return { code: 'period_locked', ...HELP_ERROR_DICTIONARY.period_locked };
  if (/\bamount.*required/i.test(raw)) return { code: 'amount_required', ...HELP_ERROR_DICTIONARY.amount_required };
  if (/\battachment/i.test(raw)) return { code: 'missing_attachment', ...HELP_ERROR_DICTIONARY.missing_attachment };

  return null;
}

/**
 * @param {string} codeOrMessage
 * @returns {string}
 */
export function formatHelpErrorReply(codeOrMessage) {
  const ex = explainHelpError(codeOrMessage);
  if (!ex) return '';
  const lines = [`**${ex.title}**`, '', ex.explanation];
  if (ex.nextSteps.length) {
    lines.push('', '**What you can do:**');
    ex.nextSteps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  return lines.join('\n');
}

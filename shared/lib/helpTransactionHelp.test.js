import { describe, expect, it } from 'vitest';
import {
  buildCorrectionMemo,
  buildTransactionHelpReply,
  inferTransactionLifecycle,
  suggestNextBestActions,
} from './helpTransactionHelp.js';
import { HELP_BOT_NAME } from './helpBotBrand.js';

describe('helpTransactionHelp', () => {
  it('suggests edit for draft when permitted', () => {
    const actions = suggestNextBestActions('draft', { canEdit: true });
    expect(actions.some((a) => /edit/i.test(a))).toBe(true);
  });

  it('does not suggest direct edit for posted', () => {
    const actions = suggestNextBestActions('posted', { canEdit: true });
    expect(actions.some((a) => /Do not edit/i.test(a))).toBe(true);
    expect(actions.some((a) => /correction memo/i.test(a))).toBe(true);
  });

  it('builds correction memo template', () => {
    const memo = buildCorrectionMemo('wrong_payment_amount', { referenceNo: 'RCP-100' });
    expect(memo.subject).toMatch(/Payment Amount Correction/i);
    expect(memo.body).toMatch(/RCP-100/);
  });

  it('returns permission-safe restricted guidance', () => {
    const reply = buildTransactionHelpReply({
      message: 'wrong amount',
      transactionContext: { canView: false, restricted: true, referenceNo: 'RCP-9' },
    });
    expect(reply.content).toMatch(/permission/i);
  });

  it('mentions Zare does not post for user', () => {
    const reply = buildTransactionHelpReply({
      message: 'wrong payment amount',
      transactionContext: { status: 'posted', referenceNo: 'RCP-1', canCreateMemo: true },
    });
    expect(reply.content).toMatch(/wrong payment amount/i);
    expect(reply.content).toMatch(HELP_BOT_NAME);
    expect(reply.correctionMemo).toBeTruthy();
  });
});

describe('inferTransactionLifecycle', () => {
  it('detects draft', () => {
    expect(inferTransactionLifecycle({ status: 'draft' })).toBe('draft');
  });

  it('detects posted', () => {
    expect(inferTransactionLifecycle({ status: 'posted' })).toBe('posted');
  });
});

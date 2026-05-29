/**
 * Help agent integration — exercises Zare routes without MySQL (db: null).
 */
import { describe, it, expect } from 'vitest';
import { runHelpAgent } from './helpAgent.js';
import { sanitizeZarePageContext } from '../shared/lib/workspaceSanitize.js';

const baseOpts = {
  db: null,
  messages: [],
  pathname: '/',
  user: { id: 'u-test', roleKey: 'finance_manager', displayName: 'Test User' },
  userId: 'u-test',
  branchId: 'BR-KD',
  roleKey: 'finance_manager',
};

describe('runHelpAgent Zare routes (no database)', () => {
  it('routes transaction_help for wrong payment on receipt', async () => {
    const r = await runHelpAgent({
      ...baseOpts,
      message: 'I entered the wrong payment amount on this receipt',
      pathname: '/sales',
      pageContext: sanitizeZarePageContext({
        mode: 'transaction_help',
        transaction: { type: 'receipt', referenceNo: 'RCP-TEST', status: 'posted' },
      }),
    });
    expect(r.source).toBe('transaction_help');
    expect(r.content).toMatch(/correction|payment|receipt/i);
    expect(r.agentRoute).toBe('troubleshoot');
  });

  it('routes error_explanation for known ERP codes', async () => {
    const r = await runHelpAgent({
      ...baseOpts,
      message: 'I got PERIOD_LOCKED when posting — what does it mean?',
      pathname: '/accounts',
    });
    expect(r.source).toBe('error_explain');
    expect(r.content).toMatch(/period|lock/i);
  });

  it('routes meta for who is Zare', async () => {
    const r = await runHelpAgent({
      ...baseOpts,
      message: 'Who is Zare?',
      pathname: '/',
    });
    expect(r.source).toBe('meta');
    expect(r.content).toMatch(/Zare/i);
  });

  it('returns briefing when snapshot has work items', async () => {
    const r = await runHelpAgent({
      ...baseOpts,
      message: 'Give me my daily briefing',
      pathname: '/',
      pageContext: {
        snapshot: {
          unifiedWorkItems: [
            { requiresApproval: true, documentType: 'payment_request', status: 'pending' },
            { requiresApproval: true, documentType: 'refund_request', status: 'pending' },
          ],
        },
      },
    });
    expect(r.source).toBe('briefing');
    expect(r.content).toMatch(/briefing/i);
  });

  it('returns kb answer for receipt how-to without db', async () => {
    const r = await runHelpAgent({
      ...baseOpts,
      message: 'How do I add a receipt?',
      pathname: '/sales',
      roleKey: 'sales_staff',
    });
    expect(['kb', 'synth', 'rag']).toContain(r.source);
    expect(r.content).toMatch(/receipt|payment/i);
  });
});

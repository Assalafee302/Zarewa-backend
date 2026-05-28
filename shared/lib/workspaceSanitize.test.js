import { describe, expect, it } from 'vitest';
import { runMemoAssist } from './memoAssist.js';
import {
  sanitizeRunaPageContext,
  sanitizeZarePageContext,
  sanitizeTransactionContextForZare,
  sanitizeWorkItemForClient,
} from './workspaceSanitize.js';

describe('memoAssist', () => {
  it('classifies diesel memo', () => {
    const r = runMemoAssist({
      action: 'classify',
      subject: 'Diesel purchase request',
      body: 'We are out of diesel fuel. Need 200 litres urgently for yard operations.',
    });
    expect(r.memoType).toBe('fuel_diesel');
    expect(r.priority).toBe('urgent');
  });

  it('makes memo shorter without inventing facts', () => {
    const body = 'The machine is broken. We need a mechanic urgently. Please approve payment.';
    const r = runMemoAssist({ action: 'make_shorter', subject: 'Repair', body });
    expect(r.improvedBody.length).toBeLessThanOrEqual(body.length + 20);
  });
});

describe('workspaceSanitize', () => {
  it('redacts Runa context for confidential selection', () => {
    const ctx = sanitizeRunaPageContext({
      surface: 'workspace_command_center',
      selectedWorkItem: {
        id: 'WI-1',
        title: 'Secret payroll',
        confidentiality: 'confidential',
      },
    });
    expect(ctx.selectedWorkItem.title).toBe('Restricted memo');
  });

  it('strips body from client list items', () => {
    const item = sanitizeWorkItemForClient({
      id: 'WI-2',
      title: 'Test',
      body: 'secret body',
      summary: 'sum',
    });
    expect(item.body).toBe('');
  });

  it('sanitizeZarePageContext is alias-safe', () => {
    const a = sanitizeZarePageContext({ pathname: '/sales', body: 'secret' });
    const b = sanitizeRunaPageContext({ pathname: '/sales', body: 'secret' });
    expect(a.body).toBeUndefined();
    expect(b.pathname).toBe('/sales');
  });

  it('redacts restricted transaction context', () => {
    const tx = sanitizeTransactionContextForZare({
      referenceNo: 'RCP-1',
      amountSummary: '50000 NGN',
      canView: false,
      restricted: true,
    });
    expect(tx.restricted).toBe(true);
    expect(tx.amountSummary).toBeUndefined();
    expect(tx.referenceNo).toBe('RCP-1');
  });
});

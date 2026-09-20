import { describe, it, expect } from 'vitest';
import {
  scoreWorkspaceSearchMatch,
  mergeWorkspaceSearchResults,
  groupWorkspaceSearchHits,
  splitSearchHighlight,
  filterNavSearchCommands,
  applyContextBoostToByKind,
  resolveGlobalSearchEnterFallback,
  resolveTransactionSearchHit,
  levenshteinDistance,
} from './workspaceSearchCore.js';

describe('workspaceSearchCore', () => {
  it('scoreWorkspaceSearchMatch prefers exact ID match', () => {
    const exact = scoreWorkspaceSearchMatch('QT-001', ['QT-001', 'Some customer']);
    const partial = scoreWorkspaceSearchMatch('QT-001', ['QT-00199', 'Other']);
    expect(exact).toBeGreaterThan(partial);
  });

  it('scoreWorkspaceSearchMatch tolerates one-letter typos in names', () => {
    const score = scoreWorkspaceSearchMatch('mousa', ['Musa Hassan']);
    expect(score).toBeGreaterThan(0);
  });

  it('levenshteinDistance is bounded', () => {
    expect(levenshteinDistance('musa', 'mousa', 1)).toBe(1);
    expect(levenshteinDistance('abc', 'xyz', 1)).toBeGreaterThan(1);
  });

  it('applyContextBoostToByKind boosts sales entities on /sales', () => {
    const boosted = applyContextBoostToByKind(
      {
        customer: [{ kind: 'customer', id: '1', label: 'A', path: '/', _score: 500 }],
        coil: [{ kind: 'coil', id: '2', label: 'B', path: '/', _score: 500 }],
      },
      '/sales'
    );
    expect(boosted.customer[0]._score).toBeGreaterThan(boosted.coil[0]._score);
  });

  it('resolveGlobalSearchEnterFallback routes PO references', () => {
    const fb = resolveGlobalSearchEnterFallback('PO-123');
    expect(fb?.path).toBe('/procurement');
  });

  it('resolveGlobalSearchEnterFallback opens expense and payment-request Accounts tabs', () => {
    const exp = resolveGlobalSearchEnterFallback('EXP-99');
    expect(exp).toEqual({
      path: '/accounts',
      state: { accountsTab: 'expenses', highlightExpenseId: 'EXP-99' },
    });
    const pr = resolveGlobalSearchEnterFallback('PR-12');
    expect(pr?.path).toBe('/accounts');
    expect(pr?.state?.accountsTab).toBe('requests');
    expect(pr?.state?.highlightPaymentRequestId).toBe('PR-12');
    const preq = resolveGlobalSearchEnterFallback('PREQ-1');
    expect(preq?.state?.accountsTab).toBe('requests');
    const pay = resolveGlobalSearchEnterFallback('PAY-1');
    expect(pay?.state?.accountsTab).toBe('requests');
  });

  it('resolveTransactionSearchHit opens manager intel for quotations', () => {
    const hit = resolveTransactionSearchHit(
      { kind: 'quotation', id: 'QT-9', label: 'QT-9', path: '/sales' },
      { openManagerIntel: true }
    );
    expect(hit.path).toBe('/manager?quoteRef=QT-9');
    expect(hit.state).toBeUndefined();
  });

  it('resolveTransactionSearchHit opens manager intel for refunds', () => {
    const hit = resolveTransactionSearchHit(
      { kind: 'refund', id: 'RF-1', label: 'RF-1', path: '/sales' },
      { openManagerIntel: true }
    );
    expect(hit.path).toBe('/manager?refundId=RF-1');
  });

  it('resolveTransactionSearchHit opens parent quote intel for receipts', () => {
    const hit = resolveTransactionSearchHit(
      {
        kind: 'receipt',
        id: 'RCP-1',
        label: 'RCP-1',
        path: '/sales',
        state: { quotationRef: 'QT-2' },
      },
      { openManagerIntel: true }
    );
    expect(hit.path).toBe('/manager?quoteRef=QT-2');
  });

  it('resolveTransactionSearchHit opens sales record without manager intel', () => {
    const hit = resolveTransactionSearchHit(
      { kind: 'quotation', id: 'QT-9', label: 'QT-9', path: '/sales' },
      { openManagerIntel: false }
    );
    expect(hit.path).toBe('/sales');
    expect(hit.state.openSalesRecord).toEqual({ type: 'quotation', id: 'QT-9' });
  });

  it('resolveGlobalSearchEnterFallback uses manager intel when requested', () => {
    const fb = resolveGlobalSearchEnterFallback('QT-55', { openManagerIntel: true });
    expect(fb?.path).toBe('/manager?quoteRef=QT-55');
  });

  it('scoreWorkspaceSearchMatch boosts digit fragments', () => {
    const score = scoreWorkspaceSearchMatch('2043', ['CL-26-2043']);
    expect(score).toBeGreaterThan(0);
  });

  it('mergeWorkspaceSearchResults reserves slots per kind', () => {
    const customers = Array.from({ length: 10 }, (_, i) => ({
      kind: 'customer',
      id: `C${i}`,
      label: `Customer ${i}`,
      path: '/',
      _score: 900 - i,
    }));
    const coils = [
      { kind: 'coil', id: 'CL-1', label: 'CL-1', path: '/', _score: 950 },
      { kind: 'coil', id: 'CL-2', label: 'CL-2', path: '/', _score: 940 },
    ];
    const merged = mergeWorkspaceSearchResults(
      { customer: customers, coil: coils },
      { totalCap: 6, minPerKind: 2 }
    );
    expect(merged.some((r) => r.kind === 'coil')).toBe(true);
    expect(merged.some((r) => r.kind === 'customer')).toBe(true);
    expect(merged.length).toBeLessThanOrEqual(6);
  });

  it('groupWorkspaceSearchHits preserves kind order', () => {
    const groups = groupWorkspaceSearchHits([
      { kind: 'customer', id: '1', label: 'A', path: '/' },
      { kind: 'coil', id: '2', label: 'B', path: '/' },
      { kind: 'customer', id: '3', label: 'C', path: '/' },
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['customer', 'coil']);
    expect(groups[0].items).toHaveLength(2);
  });

  it('splitSearchHighlight marks matched segment', () => {
    const parts = splitSearchHighlight('QT-001 Musa', 'musa');
    expect(parts.some((p) => p.match)).toBe(true);
  });

  it('filterNavSearchCommands returns sales nav for sales query', () => {
    const hasPermission = (p) => p === 'sales.view';
    const canAccessModule = (m) => m === 'sales';
    const hits = filterNavSearchCommands('sales', hasPermission, canAccessModule);
    expect(hits.some((h) => h.id === 'nav-sales')).toBe(true);
  });

  it('filterNavSearchCommands finds expense cash catch-up for finance.post', () => {
    const hasPermission = (p) => p === 'finance.post';
    const hits = filterNavSearchCommands('post imported', hasPermission, () => true);
    expect(hits.some((h) => h.id === 'nav-expense-cash-catchup')).toBe(true);
  });

  it('filterNavSearchCommands finds full cashier statement and duplicate delete', () => {
    const hasPermission = (p) => p === 'finance.post' || p === 'cashier.desk.view';
    const statement = filterNavSearchCommands('before 12th', hasPermission, () => true).find(
      (h) => h.id === 'nav-cashier-statement'
    );
    const duplicates = filterNavSearchCommands('duplicate expenses', hasPermission, () => true).find(
      (h) => h.id === 'nav-expense-duplicates'
    );
    expect(statement?.path).toBe('/expense-cash-catchup?view=statement');
    expect(duplicates?.path).toBe('/expense-cash-catchup?view=duplicates');
  });

  it('filterNavSearchCommands retitles accounting to collections when local GL is off', () => {
    const hasPermission = () => true;
    const hits = filterNavSearchCommands('creditors', hasPermission, () => true, {
      glPostingEnabled: false,
    });
    const accounting = hits.find((h) => h.id === 'nav-accounting');
    expect(accounting?.sublabel).toBe('Collections & registers');
  });
});

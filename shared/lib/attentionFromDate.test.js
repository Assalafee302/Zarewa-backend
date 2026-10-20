import { describe, expect, it } from 'vitest';
import {
  ATTENTION_FROM_DATE_DEFAULT,
  attentionFromDateLine,
  attentionItemIsBeforeFromDate,
  attentionRecordDay,
  countAttentionByType,
  formatAttentionFromDateLabel,
  selectAttentionItemsByFromDate,
} from './attentionFromDate.js';

const FROM = ATTENTION_FROM_DATE_DEFAULT;

function item(kind, date, extra = {}) {
  return {
    id: `${kind}:${date || 'none'}`,
    kind,
    atIso: date,
    recordDateIso: date,
    branchId: extra.branchId || 'BR-KD',
    amountNgn: extra.amountNgn ?? 1000,
    ...extra,
  };
}

describe('attention from-date filter', () => {
  it('hides a record dated before the start date and keeps the start date itself', () => {
    expect(attentionItemIsBeforeFromDate(item('clearance', '2026-07-31'), FROM)).toBe(true);
    expect(attentionItemIsBeforeFromDate(item('clearance', '2026-08-01'), FROM)).toBe(false);
    expect(attentionItemIsBeforeFromDate(item('refunds', '2026-10-16'), FROM)).toBe(false);
  });

  it('keeps a row with no record date', () => {
    const missing = {
      id: 'missing_bm:BR-YL',
      kind: 'governance',
      integrityKind: 'missing_branch_manager',
      atIso: null,
      row: { integrityKind: 'missing_branch_manager', branchId: 'BR-YL' },
    };
    expect(attentionRecordDay(missing)).toBe('');
    expect(attentionItemIsBeforeFromDate(missing, FROM)).toBe(false);
  });

  it('uses the quotation date for a flagged order, not only the flag time', () => {
    const flagged = {
      kind: 'flagged',
      atIso: '2026-10-02',
      row: { date_iso: '2026-05-26', manager_flagged_at_iso: '2026-10-02' },
    };
    expect(attentionRecordDay(flagged)).toBe('2026-05-26');
    expect(attentionItemIsBeforeFromDate(flagged, FROM)).toBe(true);
  });

  it('uses each branch start date when they differ', () => {
    const window = {
      dateISO: FROM,
      perBranch: { 'BR-KD': '2026-08-01', 'BR-YL': '2026-09-01' },
    };
    const kaduna = item('refunds', '2026-08-15', { branchId: 'BR-KD' });
    const yola = item('refunds', '2026-08-15', { branchId: 'BR-YL' });
    expect(selectAttentionItemsByFromDate([kaduna, yola], window, 'visible').map((r) => r.branchId)).toEqual([
      'BR-KD',
    ]);
    expect(selectAttentionItemsByFromDate([kaduna, yola], window, 'hidden').map((r) => r.branchId)).toEqual([
      'BR-YL',
    ]);
  });

  it('counts hidden and remaining items by list type', () => {
    const rows = [
      item('clearance', '2026-05-26'),
      item('clearance', '2026-07-14'),
      item('clearance', '2026-09-02'),
      item('refunds', '2026-08-20'),
      item('payments', '2026-10-01'),
      item('conversions', '2026-09-01'),
      item('governance', '2026-08-01'),
      item('edit_approvals', '2026-04-01'),
      { kind: 'stock_review', recordDateIso: '2026-05-30', listType: 'stock review' },
      { kind: 'stock_review', recordDateIso: '2026-08-31', listType: 'stock review' },
    ];
    const window = { dateISO: FROM, perBranch: {} };
    const hidden = selectAttentionItemsByFromDate(rows, window, 'hidden');
    const visible = selectAttentionItemsByFromDate(rows, window, 'visible');
    expect(countAttentionByType(hidden)).toEqual({
      orders: 2,
      cash: 0,
      floor: 0,
      control: 0,
      edits: 1,
      'stock review': 1,
    });
    expect(countAttentionByType(visible)).toEqual({
      orders: 1,
      cash: 2,
      floor: 1,
      control: 1,
      edits: 0,
      'stock review': 1,
    });
  });

  it('writes the line under the list', () => {
    expect(formatAttentionFromDateLabel('2026-08-01')).toBe('1 Aug 2026');
    expect(attentionFromDateLine('2026-08-01', 3)).toBe(
      'Showing items from 1 Aug 2026. 3 older items hidden.'
    );
    expect(attentionFromDateLine('2026-08-01', 1)).toBe(
      'Showing items from 1 Aug 2026. 1 older item hidden.'
    );
  });
});

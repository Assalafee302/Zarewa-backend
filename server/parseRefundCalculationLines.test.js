import { describe, expect, it } from 'vitest';
import { parseRefundCalculationLinesFromRow } from './controlOps.js';

describe('parseRefundCalculationLinesFromRow', () => {
  it('preserves category and include when normalizing approve payload', () => {
    const lines = parseRefundCalculationLinesFromRow(null, [
      {
        label: 'Unproduced metres',
        amountNgn: 50000,
        category: 'Unproduced meterage',
        include: true,
      },
    ]);
    expect(lines).toEqual([
      {
        label: 'Unproduced metres',
        amountNgn: 50000,
        category: 'Unproduced meterage',
        include: true,
      },
    ]);
  });

  it('backfills category from reason_category on legacy stored rows', () => {
    const lines = parseRefundCalculationLinesFromRow(
      {
        reason_category: '["Unproduced meterage"]',
        calculation_lines_json: JSON.stringify([{ label: 'Unproduced metres', amountNgn: 50000 }]),
      },
      null
    );
    expect(lines[0].category).toBe('Unproduced meterage');
    expect(lines[0].include).toBe(true);
  });
});

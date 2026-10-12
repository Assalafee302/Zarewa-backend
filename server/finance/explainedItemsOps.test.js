import { describe, expect, it } from 'vitest';
import {
  bankLineFingerprint,
  buildExplainedIndex,
  explainedLabel,
  lockedItemFor,
  partitionExplained,
} from './explainedItemsOps.js';
import { buildMonthEndDataPack } from '../../shared/lib/monthEndDataPack.js';

const AFNICE = {
  id: 'EXP-KD-26-0001',
  branch_id: 'BR-KD',
  title: 'AFNICE ₦20,000,000 pass-through – September 2026',
  short_label: 'AFNICE ₦20M',
  amount_in_ngn: 20000000,
  amount_out_ngn: 20000080,
  status: 'Locked',
  do_not_raise: 1,
  period_key: '2026-09',
};

const LINKS = [
  { item_id: AFNICE.id, entity_type: 'bank_recon_line', entity_id: 'BKR-KD-26-0347', fingerprint: bankLineFingerprint('2026-09-09', 20000000, 'trf - FROM AFNICE FURNITURES AND ELECTRONIC') },
  { item_id: AFNICE.id, entity_type: 'bank_recon_line', entity_id: 'BKR-KD-26-0350', fingerprint: bankLineFingerprint('2026-09-10', -8000020, 'TRANSFER TO ABDULRAHMAN ABUBAKAR SALISU') },
  { item_id: AFNICE.id, entity_type: 'treasury_movement', entity_id: 'TM-KD-26-2489' },
];

describe('explained-items register', () => {
  it('suppresses only Locked, do-not-raise records', () => {
    const open = buildExplainedIndex([{ ...AFNICE, status: 'Open' }], LINKS);
    expect(lockedItemFor(open, 'treasury_movement', 'TM-KD-26-2489')).toBeNull();
    const raised = buildExplainedIndex([{ ...AFNICE, do_not_raise: 0 }], LINKS);
    expect(lockedItemFor(raised, 'treasury_movement', 'TM-KD-26-2489')).toBeNull();
    const locked = buildExplainedIndex([AFNICE], LINKS);
    expect(lockedItemFor(locked, 'treasury_movement', 'TM-KD-26-2489')?.id).toBe(AFNICE.id);
  });

  it('matches a bank line by id or by statement fingerprint (re-import)', () => {
    const index = buildExplainedIndex([AFNICE], LINKS);
    expect(lockedItemFor(index, 'bank_recon_line', 'BKR-KD-26-0347')?.id).toBe(AFNICE.id);
    const fp = bankLineFingerprint('2026-09-09', 20000000, '  trf - FROM AFNICE  FURNITURES AND ELECTRONIC ');
    expect(lockedItemFor(index, 'bank_recon_line', 'BKR-NEW-0001', fp)?.id).toBe(AFNICE.id);
    expect(lockedItemFor(index, 'bank_recon_line', 'BKR-KD-26-0001', bankLineFingerprint('2026-09-09', 20000000, 'other'))).toBeNull();
  });

  it('skips linked rows and shows the record once instead of as exceptions', () => {
    const index = buildExplainedIndex([AFNICE], LINKS);
    const rows = [
      { id: 'BKR-KD-26-0347', status: 'Review' },
      { id: 'BKR-KD-26-0350', status: 'Review' },
      { id: 'BKR-KD-26-0400', status: 'Review' },
    ];
    const { kept, explained } = partitionExplained(rows, index, { entityType: 'bank_recon_line', idOf: (r) => r.id });
    expect(kept.map((r) => r.id)).toEqual(['BKR-KD-26-0400']);
    expect(explained).toHaveLength(1);
    expect(explained[0].lineCount).toBe(2);
    expect(explained[0].label).toBe('Explained (locked): AFNICE ₦20M – see register');
    expect(explainedLabel(AFNICE)).toBe(explained[0].label);
  });

  it('month-end pack lists the record under Explained (locked), not Not ready', () => {
    const pack = buildMonthEndDataPack({
      branchId: 'BR-KD',
      month: '2026-09',
      unmatchedReceipts: [],
      explainedLocked: [{ itemId: AFNICE.id, label: explainedLabel(AFNICE), amountInNgn: 20000000 }],
    });
    const byId = Object.fromEntries((pack.schedules || []).map((s) => [s.id, s]));
    expect(byId['explained-locked'].lines).toHaveLength(1);
    expect(byId['explained-locked'].lines[0].name).toMatch(/Explained \(locked\): AFNICE ₦20M/);
    expect(JSON.stringify(byId['not-ready'].lines)).not.toMatch(/AFNICE/);
  });
});

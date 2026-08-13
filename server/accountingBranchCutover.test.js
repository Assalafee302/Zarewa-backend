import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  resolveBranchOpeningCutover,
  setBranchOpeningCutoverDate,
} from './branches.js';
import { buildOpeningPackReport } from './accountingOpeningPackOps.js';
import {
  openingBalanceSourceId,
  openingBalanceSourceIdBaseFromDateISO,
} from '../shared/lib/accountingCutover.js';
import { isOpeningBalancePostedForBranch } from './accountingPostingOps.js';

describe('branch opening cutover date', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
  });

  afterEach(() => {
    db?.close();
  });

  it('defaults all branches to HQ cutover date for backward compatibility', () => {
    const kd = resolveBranchOpeningCutover(db, 'BR-KD');
    const yl = resolveBranchOpeningCutover(db, 'BR-YL');
    expect(kd.dateISO).toBe('2026-06-01');
    expect(kd.periodKey).toBe('2026-06');
    expect(yl.dateISO).toBe('2026-06-01');
    expect(openingBalanceSourceId('BR-KD', kd.dateISO)).toBe('OPENING_BALANCE_2026-06:BR-KD');
  });

  it('uses branch-specific cutover date in opening pack preview', () => {
    const set = setBranchOpeningCutoverDate(db, 'BR-YL', '2026-09-15');
    expect(set.ok).toBe(true);

    const cutover = resolveBranchOpeningCutover(db, 'BR-YL');
    expect(cutover.dateISO).toBe('2026-09-15');
    expect(cutover.periodKey).toBe('2026-09');
    expect(openingBalanceSourceId('BR-YL', cutover.dateISO)).toBe('OPENING_BALANCE_2026-09:BR-YL');

    const pack = buildOpeningPackReport(db, { branchScope: 'BR-YL', summaryOnly: true });
    expect(pack.entryDateISO).toBe('2026-09-15');
    expect(pack.openingCutoverDateIso).toBe('2026-09-15');
    expect(pack.openingPeriodKey).toBe('2026-09');
    expect(pack.inventoryPeriodKey).toBe('2026-08');
  });

  it('detects legacy Kaduna opening journal by org-wide source id', () => {
    db.exec(`
      INSERT INTO gl_journal_entries (
        id, entry_date_iso, memo, source_kind, source_id, branch_id, created_at_iso
      ) VALUES (
        'j-open-kd', '2026-06-01', 'HQ opening', 'OPENING_BALANCE', 'OPENING_BALANCE_2026-06', 'BR-KD', '2026-06-01T00:00:00.000Z'
      )
    `);
    expect(isOpeningBalancePostedForBranch(db, 'BR-KD')).toBe(true);
    expect(isOpeningBalancePostedForBranch(db, 'BR-YL')).toBe(false);
  });

  it('detects branch-scoped opening journal from cutover-derived source id', () => {
    db.exec(`
      INSERT INTO gl_journal_entries (
        id, entry_date_iso, memo, source_kind, source_id, branch_id, created_at_iso
      ) VALUES (
        'j-open-yl', '2026-09-15', 'Yola opening', 'OPENING_BALANCE',
        '${openingBalanceSourceId('BR-YL', '2026-09-15')}', 'BR-YL', '2026-09-15T00:00:00.000Z'
      )
    `);
    setBranchOpeningCutoverDate(db, 'BR-YL', '2026-09-15');
    expect(isOpeningBalancePostedForBranch(db, 'BR-YL')).toBe(true);
    expect(openingBalanceSourceIdBaseFromDateISO('2026-09-15')).toBe('OPENING_BALANCE_2026-09');
  });
});

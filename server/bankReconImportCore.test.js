import { describe, expect, it } from 'vitest';
import {
  buildBankReconFingerprintSetForBranch,
  partitionBankReconImportRows,
} from './bankReconImportCore.js';

describe('bankReconImportCore', () => {
  it('builds fingerprint set for one branch only', () => {
    const set = buildBankReconFingerprintSetForBranch(
      [
        { branchId: '1', bankDateISO: '2026-04-01', description: 'A', amountNgn: 100 },
        { branchId: '2', bankDateISO: '2026-04-01', description: 'B', amountNgn: 200 },
      ],
      '1'
    );
    expect(set.size).toBe(1);
  });

  it('partitions duplicate batch and existing', () => {
    const existing = new Set();
    existing.add('1|2026-04-01|fee|-500');
    const rows = [
      { bankDateISO: '2026-04-01', description: 'Fee', amountNgn: -500 },
      { bankDateISO: '2026-04-02', description: 'In', amountNgn: 1000 },
      { bankDateISO: '2026-04-02', description: 'In', amountNgn: 1000 },
    ];
    const { toInsert, skippedDuplicates } = partitionBankReconImportRows(rows, '1', existing);
    expect(toInsert.length).toBe(1);
    expect(skippedDuplicates.length).toBe(2);
  });
});

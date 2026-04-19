import { bankReconImportFingerprint } from '../shared/bankReconFingerprint.js';

/**
 * @param {Array<{ bankDateISO: string, description: string, amountNgn: number, branchId?: string }>} existingLines
 * @param {string} branchId
 * @returns {Set<string>}
 */
export function buildBankReconFingerprintSetForBranch(existingLines, branchId) {
  const bid = String(branchId || '').trim();
  const set = new Set();
  for (const line of existingLines || []) {
    if (String(line.branchId || '').trim() !== bid) continue;
    set.add(
      bankReconImportFingerprint({
        bankDateISO: line.bankDateISO,
        description: line.description,
        amountNgn: line.amountNgn,
        branchId: bid,
      })
    );
  }
  return set;
}

/**
 * Skip rows that match an existing fingerprint or duplicate earlier rows in the same batch.
 * @param {Array<{ bankDateISO: string, description: string, amountNgn: number }>} parsedLines
 * @param {string} branchId
 * @param {Set<string>} existingSet - mutated: new rows are added as accepted
 * @returns {{ toInsert: typeof parsedLines, skippedDuplicates: Array<{ index: number, reason: string }> }}
 */
export function partitionBankReconImportRows(parsedLines, branchId, existingSet) {
  const bid = String(branchId || '').trim();
  const toInsert = [];
  const skippedDuplicates = [];
  const set = existingSet instanceof Set ? existingSet : new Set(existingSet);

  for (let i = 0; i < (parsedLines || []).length; i += 1) {
    const row = parsedLines[i];
    const fp = bankReconImportFingerprint({
      bankDateISO: row.bankDateISO,
      description: row.description,
      amountNgn: row.amountNgn,
      branchId: bid,
    });
    if (set.has(fp)) {
      skippedDuplicates.push({ index: i, reason: 'duplicate_fingerprint' });
      continue;
    }
    set.add(fp);
    toInsert.push(row);
  }
  return { toInsert, skippedDuplicates };
}

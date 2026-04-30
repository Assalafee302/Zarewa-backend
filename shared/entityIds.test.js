import { describe, it, expect } from 'vitest';
import {
  formatAutoCoilLotNo,
  formatCuttingListId,
  maxCuttingListSerialFromIds,
  migrateLegacyCoilLotNo,
  migrateLegacyCuttingListId,
  nextCuttingListIdFromDbRows,
} from './entityIds.js';

describe('entityIds', () => {
  it('formats coil and cutting list ids with 2-digit year', () => {
    expect(formatAutoCoilLotNo(1, 2026)).toBe('C26-0001');
    expect(formatCuttingListId(42, 2026)).toBe('CL26-042');
  });

  it('maxCuttingListSerialFromIds parses legacy and new shapes', () => {
    expect(maxCuttingListSerialFromIds(['CL-2026-009', 'CL26-010', 'noise'])).toBe(10);
    expect(maxCuttingListSerialFromIds(['CL-1730000000000-x7k2m'])).toBe(0);
  });

  it('nextCuttingListIdFromDbRows increments from rows', () => {
    expect(nextCuttingListIdFromDbRows([{ id: 'CL26-005' }], 2026)).toBe('CL26-006');
    expect(nextCuttingListIdFromDbRows([], 2026)).toBe('CL26-001');
  });

  it('migrates legacy ids', () => {
    expect(migrateLegacyCuttingListId('CL-2026-1592')).toBe('CL26-1592');
    expect(migrateLegacyCoilLotNo('COIL-2026-0007')).toBe('C26-0007');
    expect(migrateLegacyCoilLotNo('CL-2026-0008')).toBe('C26-0008');
    expect(migrateLegacyCuttingListId('CL26-001')).toBe(null);
  });
});

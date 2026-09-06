import { describe, it, expect } from 'vitest';
import {
  jobHasPositiveOutputMetres,
  jobStoneRoofingMetres,
  jobTotalOutputMetres,
} from './jobOutputMetres.js';

describe('jobTotalOutputMetres', () => {
  it('sums R+C+F for hybrid stone without double-counting actualMeters', () => {
    expect(
      jobTotalOutputMetres({
        actualMeters: 25,
        actualRoofM: 60,
        actualCladdingM: 0,
        actualFlatsheetM: 25,
      })
    ).toBe(85);
  });

  it('uses roof alone when hybrid completes with zero flatsheet', () => {
    expect(
      jobTotalOutputMetres({
        actualMeters: 0,
        actualRoofM: 100,
        actualFlatsheetM: 0,
      })
    ).toBe(100);
    expect(jobHasPositiveOutputMetres({ actualMeters: 0, actualRoofM: 100 })).toBe(true);
  });

  it('does not double-count pure stone (actualMeters === actualRoofM)', () => {
    expect(jobTotalOutputMetres({ actualMeters: 80, actualRoofM: 80, actualFlatsheetM: 0 })).toBe(80);
  });

  it('falls back to actualMeters for legacy coil jobs with no split columns', () => {
    expect(jobTotalOutputMetres({ actualMeters: 42 })).toBe(42);
    expect(jobTotalOutputMetres({ actual_meters: 42 })).toBe(42);
  });

  it('prefers effectiveOutputMeters over actualMeters when no split', () => {
    expect(jobTotalOutputMetres({ actualMeters: 10, effectiveOutputMeters: 12.5 })).toBe(12.5);
  });
});

describe('jobStoneRoofingMetres', () => {
  it('uses roof / stone draw and ignores flatsheet actualMeters on hybrids', () => {
    expect(
      jobStoneRoofingMetres(
        { actualMeters: 25, actualRoofM: 60, actualFlatsheetM: 25 },
        60
      )
    ).toBe(60);
  });

  it('falls back to actualMeters for legacy pure stone without roof column', () => {
    expect(jobStoneRoofingMetres({ actualMeters: 80 }, 0)).toBe(80);
  });
});

import { describe, expect, it } from 'vitest';
import { correctionReasonBlock, userIsBranchManagerOrOm } from './coilCorrectionControl.js';

describe('coil correction control', () => {
  it('rejects a short reason and a keyboard mash', () => {
    expect(correctionReasonBlock('too short')).toMatch(/10 characters/);
    expect(correctionReasonBlock('qwertyuiouytrewqwertyuio')).toMatch(/keyboard pattern/);
    expect(correctionReasonBlock('aaaaaaaaaa')).toMatch(/keyboard pattern/);
    expect(correctionReasonBlock('ababababab')).toMatch(/keyboard pattern/);
  });

  it('accepts a real correction reason', () => {
    expect(correctionReasonBlock('Typed 407 instead of 40 on the finish-roll tail.')).toBe('');
  });

  it('treats branch manager, OM, admin, and MD as direct correction posters', () => {
    expect(userIsBranchManagerOrOm({ roleKey: 'sales_manager' })).toBe(true);
    expect(userIsBranchManagerOrOm({ roleKey: 'operations_manager' })).toBe(true);
    expect(userIsBranchManagerOrOm({ roleKey: 'admin' })).toBe(true);
    expect(userIsBranchManagerOrOm({ roleKey: 'md' })).toBe(true);
    expect(userIsBranchManagerOrOm({ roleKey: 'operations_officer' })).toBe(false);
  });
});

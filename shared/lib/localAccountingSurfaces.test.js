import { describe, expect, it } from 'vitest';
import {
  LOCAL_GL_SURFACES,
  ZAREWA_OPS_MONEY_SURFACES,
  accountingNavForLocalGl,
  localAccountingCapabilities,
} from './localAccountingSurfaces.js';

describe('localAccountingSurfaces', () => {
  it('keeps collections and cash when local GL is off', () => {
    const caps = localAccountingCapabilities(false);
    expect(caps.glPostingEnabled).toBe(false);
    expect(caps.localGl).toBe(false);
    expect(caps.opsMoney).toBe(true);
    for (const id of ZAREWA_OPS_MONEY_SURFACES) {
      expect(caps.surfaces[id]).toBe(true);
    }
    for (const id of LOCAL_GL_SURFACES) {
      expect(caps.surfaces[id]).toBe(false);
    }
  });

  it('shows statutory surfaces when local GL is on', () => {
    const caps = localAccountingCapabilities(true);
    expect(caps.surfaces.statements).toBe(true);
    expect(caps.surfaces.glJournals).toBe(true);
    expect(caps.surfaces.creditors).toBe(true);
  });

  it('retitles Accounting nav to collections when GL is off', () => {
    const on = accountingNavForLocalGl(
      { id: 'nav-accounting', sublabel: 'Accounting desk', keywords: ['gl'] },
      true
    );
    expect(on.sublabel).toBe('Accounting desk');
    const off = accountingNavForLocalGl(
      { id: 'nav-accounting', sublabel: 'Accounting desk', keywords: ['gl'] },
      false
    );
    expect(off.sublabel).toBe('Collections & registers');
    expect(off.keywords).toContain('creditors');
    expect(off.keywords).not.toContain('gl');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sent = [];
vi.mock('./workspaceRoomsOps.js', () => ({
  broadcastWorkspaceEvent: (event) => {
    if (event?.__throw) throw new Error('stream gone');
    sent.push(event);
  },
}));

const { broadcastWorkspaceDataChanged, notifyWorkspaceWrite, WRITE_DOMAINS } = await import(
  './workspaceDataEvents.js'
);

beforeEach(() => {
  sent.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('broadcastWorkspaceDataChanged', () => {
  it('sends an invalidation, not the data', () => {
    // Permissions and branch scoping are enforced when the client revalidates through the
    // normal path. Putting row data on the stream would move that decision here.
    broadcastWorkspaceDataChanged({ domains: ['sales'], branchId: 'KD', reason: 'quotation' });
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('workspace.data');
    expect(sent[0].domains).toEqual(['sales']);
    expect(sent[0].branchId).toBe('KD');
    expect(JSON.stringify(sent[0])).not.toMatch(/amount|customer|price/i);
  });

  it('drops unknown domains rather than passing them on', () => {
    broadcastWorkspaceDataChanged({ domains: ['sales', 'nonsense', 'FINANCE'] });
    expect(sent[0].domains).toEqual(['sales', 'finance']);
  });

  it('stays silent when nothing valid is named', () => {
    broadcastWorkspaceDataChanged({ domains: [] });
    broadcastWorkspaceDataChanged({ domains: ['nope'] });
    broadcastWorkspaceDataChanged({ domains: null });
    expect(sent).toHaveLength(0);
  });

  it('de-duplicates repeated domains', () => {
    broadcastWorkspaceDataChanged({ domains: ['finance', 'finance', 'sales'] });
    expect(sent[0].domains).toEqual(['finance', 'sales']);
  });

  it('never lets a broken stream fail the write that triggered it', async () => {
    // A notification is a courtesy. If it throws, the quotation must still be saved and
    // the poll still carries the change — the user simply waits as long as before.
    vi.resetModules();
    vi.doMock('./workspaceRoomsOps.js', () => ({
      broadcastWorkspaceEvent: () => {
        throw new Error('no clients');
      },
    }));
    const mod = await import('./workspaceDataEvents.js');
    expect(() => mod.broadcastWorkspaceDataChanged({ domains: ['sales'] })).not.toThrow();
  });
});

describe('notifyWorkspaceWrite', () => {
  it('maps a receipt to both desks that show it', () => {
    notifyWorkspaceWrite('receipt', 'KD');
    expect(sent[0].domains).toEqual(['sales', 'finance']);
  });

  it('maps a cutting list across sales and operations', () => {
    notifyWorkspaceWrite('cuttingList', 'KD');
    expect(sent[0].domains).toEqual(['sales', 'operations']);
  });

  it('ignores a kind it does not know instead of guessing', () => {
    notifyWorkspaceWrite('somethingElse', 'KD');
    expect(sent).toHaveLength(0);
  });

  it('only names real domains in the map', () => {
    const known = new Set(['sales', 'operations', 'finance', 'procurement']);
    for (const [kind, domains] of Object.entries(WRITE_DOMAINS)) {
      expect(domains.length, `${kind} names no domain`).toBeGreaterThan(0);
      for (const d of domains) expect(known.has(d), `${kind} → ${d}`).toBe(true);
    }
  });
});

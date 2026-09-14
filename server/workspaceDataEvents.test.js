import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sent = [];
vi.mock('./workspaceRoomsOps.js', () => ({
  broadcastWorkspaceEvent: (event) => {
    if (event?.__throw) throw new Error('stream gone');
    sent.push(event);
  },
}));

const {
  broadcastWorkspaceDataChanged,
  notifyWorkspaceWrite,
  WRITE_DOMAINS,
  workspaceDataEventMiddleware,
  domainsForApiPath,
} = await import(
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

describe('workspaceDataEventMiddleware', () => {
  /** Minimal req/res pair that records what the middleware broadcast. */
  function run({ method = 'POST', url = '/api/quotations', status = 200, body = { ok: true }, branchId = 'KD' }) {
    const req = { method, originalUrl: url, workspaceBranchId: branchId };
    const res = { statusCode: status, json: (b) => b };
    let nexted = false;
    workspaceDataEventMiddleware(req, res, () => {
      nexted = true;
    });
    res.json(body);
    return { nexted };
  }

  it('announces a successful write on the desks that resource feeds', () => {
    run({ url: '/api/quotations/QT-1', method: 'PATCH' });
    expect(sent).toHaveLength(1);
    expect(sent[0].domains).toEqual(['sales']);
    expect(sent[0].branchId).toBe('KD');
  });

  it('says nothing about a read', () => {
    run({ method: 'GET' });
    expect(sent).toHaveLength(0);
  });

  it('says nothing when the write failed', () => {
    // Several routes report a refusal as 200 with ok:false rather than by status code,
    // so status alone is not enough to decide something changed.
    run({ status: 400 });
    expect(sent).toHaveLength(0);
    run({ status: 200, body: { ok: false, error: 'blocked' } });
    expect(sent).toHaveLength(0);
  });

  it('crosses desks where the resource does', () => {
    run({ url: '/api/cutting-lists/CL-1/production/start' });
    expect(sent[0].domains).toEqual(['sales', 'operations']);
  });

  it('stays quiet for resources no desk pack reads', () => {
    // Sessions, help and AI change nothing a colleague's desk renders.
    for (const url of ['/api/session/login', '/api/help/ask', '/api/ai/suggest']) {
      run({ url });
    }
    expect(sent).toHaveLength(0);
  });

  it('always calls next, whatever it decides', () => {
    expect(run({ url: '/api/session/login' }).nexted).toBe(true);
    expect(run({ url: '/api/quotations' }).nexted).toBe(true);
    expect(run({ method: 'GET' }).nexted).toBe(true);
  });

  it('returns whatever the handler returned', () => {
    const req = { method: 'POST', originalUrl: '/api/quotations', workspaceBranchId: 'KD' };
    const payload = { ok: true, quotationId: 'QT-9' };
    const res = { statusCode: 201, json: (b) => b };
    workspaceDataEventMiddleware(req, res, () => {});
    expect(res.json(payload)).toBe(payload);
  });
});

describe('domainsForApiPath', () => {
  it('reads the resource from the path', () => {
    expect(domainsForApiPath('/api/refunds/RF-1/pay')).toEqual(['sales', 'finance']);
    expect(domainsForApiPath('/api/purchase-orders')).toEqual(['procurement']);
  });

  it('is empty for anything unmapped', () => {
    expect(domainsForApiPath('/api/session/login')).toEqual([]);
    expect(domainsForApiPath('/not-api/quotations')).toEqual([]);
    expect(domainsForApiPath('')).toEqual([]);
  });

  it('only names real domains', () => {
    const known = new Set(['sales', 'operations', 'finance', 'procurement']);
    for (const p of ['/api/quotations', '/api/treasury', '/api/work-items', '/api/coil-lots']) {
      for (const d of domainsForApiPath(p)) expect(known.has(d), `${p} → ${d}`).toBe(true);
    }
  });
});

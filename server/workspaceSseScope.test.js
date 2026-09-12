import { describe, it, expect, beforeEach } from 'vitest';
import { broadcastWorkspaceEvent, registerWorkspaceSseClient } from './workspaceRoomsOps.js';

/** Minimal ServerResponse stand-in that records what was written to it. */
function fakeRes() {
  const writes = [];
  return {
    writes,
    write: (s) => writes.push(s),
    end() {},
    on() {},
    events: () =>
      writes
        .filter((w) => w.startsWith('data: '))
        .map((w) => JSON.parse(w.slice(6))),
  };
}

describe('SSE client scoping', () => {
  let office;
  let deskOnly;

  beforeEach(() => {
    office = fakeRes();
    deskOnly = fakeRes();
    registerWorkspaceSseClient(office, { userId: 'u-office', branchId: 'KD', canOffice: true });
    registerWorkspaceSseClient(deskOnly, { userId: 'u-desk', branchId: 'KD', canOffice: false });
  });

  it('never sends room traffic to a client without office.use', () => {
    // The endpoint is auth-only now so every desk can receive data invalidations. If this
    // filter regressed, chat content would start reaching people who cannot open chat.
    broadcastWorkspaceEvent({ type: 'message.created', branchId: 'KD', roomId: 'R1' });
    expect(office.events().some((e) => e.type === 'message.created')).toBe(true);
    expect(deskOnly.events()).toHaveLength(0);
  });

  it('sends workspace.data to everyone signed in', () => {
    broadcastWorkspaceEvent({ type: 'workspace.data', domains: ['sales'], branchId: 'KD' });
    expect(office.events().some((e) => e.type === 'workspace.data')).toBe(true);
    expect(deskOnly.events().some((e) => e.type === 'workspace.data')).toBe(true);
  });

  it('still respects branch scope for data events', () => {
    broadcastWorkspaceEvent({ type: 'workspace.data', domains: ['sales'], branchId: 'YL' });
    expect(deskOnly.events()).toHaveLength(0);
  });

  it('still respects presence traffic gating', () => {
    broadcastWorkspaceEvent({ type: 'presence.changed', branchId: 'KD' });
    expect(deskOnly.events()).toHaveLength(0);
  });
});

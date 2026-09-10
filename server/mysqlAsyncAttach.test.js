import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { buildWorkspaceRevision, buildWorkspaceRevisionAsync } from './workspaceRevision.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

describe.skipIf(!mysqlOk)('async MySQL facade', () => {
  it('attaches db.async and revision async matches sync', async () => {
    const db = createDatabase(':memory:', { seed: false });
    expect(db.async?.prepare).toBeTypeOf('function');
    const sync = buildWorkspaceRevision(db, 'ALL');
    const asyncRev = await buildWorkspaceRevisionAsync(db, 'ALL');
    expect(asyncRev.revision).toBe(sync.revision);
    expect(asyncRev.ok).toBe(true);
    const row = await db.async.prepare('SELECT 1 AS n').get();
    expect(Number(row?.n)).toBe(1);
    db.close();
  });
});

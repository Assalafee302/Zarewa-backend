import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { hrCoreTablesReady, hrTableExists, getHrTableDiagnostics } from './hrTableChecks.js';

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

describe.skipIf(!mysqlOk)('hrTableChecks', () => {
  it('detects core HR tables after migrate', () => {
    const db = createDatabase(':memory:', { seed: false });
    expect(hrTableExists(db, 'hr_staff_profiles')).toBe(true);
    expect(hrCoreTablesReady(db)).toBe(true);
    const diag = getHrTableDiagnostics(db);
    expect(diag.missingCore).toEqual([]);
    db.close();
  });
});

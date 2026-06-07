import { describe, expect, it } from 'vitest';
import { buildCustomPermissionOverrideAudit } from './customPermissionAudit.js';

describe('customPermissionAudit', () => {
  it('flags users with extra HR/finance permissions', () => {
    const db = {
      prepare: () => ({
        all: () => [
          {
            id: 'U1',
            username: 'cashier1',
            displayName: 'Cashier One',
            roleKey: 'cashier',
            permissionsJson: JSON.stringify(['hr.directory.view', 'finance.approve']),
            status: 'active',
          },
        ],
      }),
    };

    const report = buildCustomPermissionOverrideAudit(db);
    expect(report.count).toBe(1);
    expect(report.users[0].username).toBe('cashier1');
    expect(report.users[0].extraPermissions).toContain('hr.directory.view');
    expect(['high', 'critical']).toContain(report.users[0].riskLevel);
  });
});

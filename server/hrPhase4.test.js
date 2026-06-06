import { describe, expect, it } from 'vitest';
import { listHrDepartments, upsertHrDepartment } from './hrMasterData.js';
import { createHrTransferRequest, listHrTransferRequests, TRANSFER_TYPES } from './hrTransferRequests.js';
import { exportPayrollBankUploadCsv, exportPayrollHrApprovalCsv } from './hrOps.js';

describe('hrPhase4', () => {
  it('master data module exports CRUD helpers', () => {
    expect(typeof listHrDepartments).toBe('function');
    expect(typeof upsertHrDepartment).toBe('function');
  });

  it('transfer module defines transfer types', () => {
    expect(TRANSFER_TYPES).toContain('inter_branch');
    expect(TRANSFER_TYPES).toContain('in_branch_department');
    expect(typeof createHrTransferRequest).toBe('function');
    expect(typeof listHrTransferRequests).toBe('function');
  });

  it('payroll export helpers exist', () => {
    expect(typeof exportPayrollBankUploadCsv).toBe('function');
    expect(typeof exportPayrollHrApprovalCsv).toBe('function');
  });
});

import { describe, expect, it } from 'vitest';
import { permissionsForRole } from '../auth.js';
import {
  parseChairmanOfficeLoanRepayment,
  parseChairmanOfficeLoanRequest,
  summarizeChairmanOfficeLoans,
} from './chairmanOfficeLoansOps.js';

function chairmanActor() {
  return {
    id: 'USR-CHAIRMAN',
    username: 'chairman',
    displayName: 'Chairman',
    roleKey: 'chairman',
    permissions: permissionsForRole('chairman'),
  };
}

describe('parseChairmanOfficeLoanRequest', () => {
  it('accepts a Chairman borrower with a purpose and amount', () => {
    const r = parseChairmanOfficeLoanRequest(chairmanActor(), {
      borrowerKind: 'chairman',
      amountNgn: 250_000,
      purpose: 'Short-term personal cash',
    });
    expect(r.ok).toBe(true);
    expect(r.parsed.borrowerKind).toBe('chairman');
    expect(r.parsed.relationship).toBe('self');
    expect(r.parsed.borrowerName).toBe('Chairman');
  });

  it('requires a named non-staff borrower and relationship', () => {
    const missingName = parseChairmanOfficeLoanRequest(chairmanActor(), {
      borrowerKind: 'non_staff',
      amountNgn: 80_000,
      purpose: 'School support for relative',
    });
    expect(missingName.ok).toBe(false);

    const missingRel = parseChairmanOfficeLoanRequest(chairmanActor(), {
      borrowerKind: 'non_staff',
      borrowerName: 'Aisha Bello',
      amountNgn: 80_000,
      purpose: 'School support for relative',
    });
    expect(missingRel.ok).toBe(false);

    const ok = parseChairmanOfficeLoanRequest(chairmanActor(), {
      borrowerKind: 'non_staff',
      borrowerName: 'Aisha Bello',
      borrowerRelationship: 'family',
      amountNgn: 80_000,
      purpose: 'School support for relative',
    });
    expect(ok.ok).toBe(true);
    expect(ok.parsed.kindLabel).toBe('Non-staff');
  });

  it('rejects staff-loan style kinds and CEO actors', () => {
    expect(
      parseChairmanOfficeLoanRequest(chairmanActor(), {
        borrowerKind: 'staff',
        amountNgn: 10_000,
        purpose: 'Would fake a staff loan',
      }).ok
    ).toBe(false);
    expect(
      parseChairmanOfficeLoanRequest(
        { roleKey: 'ceo', permissions: permissionsForRole('ceo') },
        { borrowerKind: 'chairman', amountNgn: 10_000, purpose: 'Should not be allowed' }
      ).code
    ).toBe('FORBIDDEN');
  });
});

describe('parseChairmanOfficeLoanRepayment', () => {
  const loan = { disbursedNgn: 100_000, outstandingNgn: 40_000 };

  it('requires cash to have been paid out first', () => {
    expect(parseChairmanOfficeLoanRepayment({ disbursedNgn: 0, outstandingNgn: 0 }, { amountNgn: 10 }).ok).toBe(
      false
    );
  });

  it('caps repayment at outstanding and requires how the money came back', () => {
    expect(parseChairmanOfficeLoanRepayment(loan, { amountNgn: 50_000, how: 'Cash at HQ till' }).ok).toBe(false);
    expect(parseChairmanOfficeLoanRepayment(loan, { amountNgn: 20_000, how: 'short' }).ok).toBe(false);
    const ok = parseChairmanOfficeLoanRepayment(loan, {
      amountNgn: 20_000,
      how: 'Cash received at HQ till',
    });
    expect(ok.ok).toBe(true);
    expect(ok.parsed.amountNgn).toBe(20_000);
  });
});

describe('summarizeChairmanOfficeLoans', () => {
  it('splits pending disbursement from outstanding receivable', () => {
    const s = summarizeChairmanOfficeLoans([
      { amountNgn: 100_000, disbursedNgn: 0, outstandingNgn: 0, unpaidDisbursement: true },
      { amountNgn: 80_000, disbursedNgn: 80_000, outstandingNgn: 50_000, unpaidDisbursement: false },
    ]);
    expect(s.pendingCount).toBe(1);
    expect(s.pendingDisbursementNgn).toBe(100_000);
    expect(s.outstandingNgn).toBe(50_000);
  });
});

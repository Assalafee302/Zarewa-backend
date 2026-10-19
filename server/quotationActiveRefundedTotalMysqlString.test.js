import { describe, it, expect } from 'vitest';
import { quotationActiveRefundedTotalNgn } from './controlOps.js';
import { quotationRefundHardCapNgn } from '../shared/lib/refundQuotationMoney.js';

/**
 * MySQL (mysql2) returns SUM() as a DECIMAL string. A fake db that answers like MySQL:
 * customer_refunds SUM → '1913200', unlinked refund_credit_applications SUM → '29200'.
 */
function mysqlLikeDb({ refundsSum = '1913200', creditOutSum = '29200' } = {}) {
  return {
    prepare(sql) {
      const fromCredit = /refund_credit_applications/i.test(sql);
      return {
        get: () => ({ s: fromCredit ? creditOutSum : refundsSum }),
        all: () => [],
      };
    },
  };
}

describe('quotationActiveRefundedTotalNgn with MySQL string SUMs (QT-KD-26-1777)', () => {
  it('adds the string SUMs as numbers, not text', () => {
    expect(quotationActiveRefundedTotalNgn(mysqlLikeDb(), 'QT-KD-26-1777')).toBe(1_942_400);
  });

  it('same with excludeRefundId', () => {
    expect(quotationActiveRefundedTotalNgn(mysqlLikeDb(), 'QT-KD-26-1777', 'RF-X')).toBe(1_942_400);
  });

  it('string zero SUMs give 0', () => {
    expect(quotationActiveRefundedTotalNgn(mysqlLikeDb({ refundsSum: '0', creditOutSum: '0' }), 'QT-1')).toBe(0);
  });

  it('refund hard cap keeps headroom instead of going ≤ 0', () => {
    const totalRefundedNgn = quotationActiveRefundedTotalNgn(mysqlLikeDb(), 'QT-KD-26-1777');
    const cap = quotationRefundHardCapNgn({ cashInNgn: 2_100_000, totalRefundedNgn });
    expect(cap).toBe(157_600);
  });
});

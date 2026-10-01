/**
 * Sign-by-type and floor rules for treasury money movements.
 * Frontend copies via `npm run sync:shared`.
 */

export const TREASURY_AMOUNT_FLOOR_NGN_DEFAULT = 100;

/** Inflows must be positive. */
export const TREASURY_POSITIVE_TYPES = new Set([
  'RECEIPT_IN',
  'ADVANCE_IN',
  'INTERNAL_TRANSFER_IN',
  'STAFF_OBLIGATION_IN',
  'STAFF_RECOVERY_IN',
  'FIXED_ASSET_SALE',
]);

/** Outflows must be negative. */
export const TREASURY_NEGATIVE_TYPES = new Set([
  'REFUND_PAYOUT',
  'EXPENSE',
  'PAYMENT_REQUEST_OUT',
  'AP_PAYMENT',
  'SUPPLIER_PAYMENT',
  'TRANSPORT_PAYMENT',
  'INTERNAL_TRANSFER_OUT',
  'ADVANCE_REFUND_OUT',
  'PAYROLL_OUT',
  'OT_PAYOUT',
  'REGISTER_SETTLEMENT_OUT',
  'REFUND_COMPANY_CUT_PAYOUT',
  'RECEIPT_REVERSAL_OUT',
]);

/** Customer/payout types that need a reason below the floor. Bank fees (2.3) are excluded. */
export const TREASURY_FLOOR_TYPES = new Set([
  'RECEIPT_IN',
  'ADVANCE_IN',
  'REFUND_PAYOUT',
  'AP_PAYMENT',
  'PAYMENT_REQUEST_OUT',
  'SUPPLIER_PAYMENT',
  'TRANSPORT_PAYMENT',
]);

export class TreasuryAmountError extends Error {
  constructor(message, code = 'INVALID_AMOUNT') {
    super(message);
    this.name = 'TreasuryAmountError';
    this.code = code;
  }
}

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

/**
 * @param {{
 *   type?: string,
 *   amountNgn?: number,
 *   floorNgn?: number,
 *   amountFloorReason?: string,
 *   skipFloor?: boolean,
 *   isReversal?: boolean,
 * }} opts
 */
export function assertTreasuryAmount(opts = {}) {
  const type = String(opts.type || '').trim().toUpperCase();
  const amountNgn = roundMoney(opts.amountNgn);
  if (amountNgn === 0) {
    throw new TreasuryAmountError('Treasury movement amount must be non-zero.', 'ZERO_AMOUNT');
  }
  // A reversal mirrors a row that already passed these checks; its sign is the original's negation.
  if (opts.isReversal) return { ok: true, amountNgn };
  if (TREASURY_POSITIVE_TYPES.has(type) && amountNgn < 0) {
    throw new TreasuryAmountError(`${type} must be a positive amount.`, 'WRONG_SIGN');
  }
  if (TREASURY_NEGATIVE_TYPES.has(type) && amountNgn > 0) {
    throw new TreasuryAmountError(`${type} must be a negative amount (money out).`, 'WRONG_SIGN');
  }
  if (opts.skipFloor) return { ok: true, amountNgn };
  if (!TREASURY_FLOOR_TYPES.has(type)) return { ok: true, amountNgn };
  const floor = Math.max(0, roundMoney(opts.floorNgn ?? TREASURY_AMOUNT_FLOOR_NGN_DEFAULT));
  if (floor > 0 && Math.abs(amountNgn) < floor) {
    const reason = String(opts.amountFloorReason || '').trim();
    if (!reason) {
      throw new TreasuryAmountError(
        `Amounts below ₦${floor.toLocaleString('en-NG')} need a confirmation reason.`,
        'AMOUNT_FLOOR'
      );
    }
  }
  return { ok: true, amountNgn };
}

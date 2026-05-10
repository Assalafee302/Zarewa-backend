/** Default payee fields for POST /api/refunds in integration tests (matches insertRefundRequest requirements). */
export const REFUND_TEST_PAYEE = {
  payeeName: 'Refund Test Beneficiary',
  payeeAccountNo: '0123456789',
  payeeBankName: 'Test Bank PLC',
};

export const REFUND_PAYEE = REFUND_TEST_PAYEE;

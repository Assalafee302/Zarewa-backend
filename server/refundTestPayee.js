/** Default payee fields for POST /api/refunds in integration tests (matches insertRefundRequest requirements). */
export const REFUND_TEST_PAYEE = {
  payeeName: 'Refund Test Beneficiary',
  payeeAccountNo: '0123456789',
  payeeBankName: 'Test Bank PLC',
};

export const REFUND_PAYEE = REFUND_TEST_PAYEE;

/** Persist the test payee on customer rows so POST /api/refunds is not blocked for no-bank customers. */
export function ensureRefundTestCustomerBanks(db, customerIds = ['CUS-001', 'CUS-002', 'CUS-NDA']) {
  const stmt = db.prepare(`
    UPDATE customers SET bank_account_name = ?, bank_name = ?, bank_account_no = ?
    WHERE customer_id = ?
  `);
  for (const id of customerIds) {
    stmt.run(REFUND_TEST_PAYEE.payeeName, REFUND_TEST_PAYEE.payeeBankName, REFUND_TEST_PAYEE.payeeAccountNo, id);
  }
}

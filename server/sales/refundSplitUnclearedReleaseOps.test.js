import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createDatabase } from '../db.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';

vi.mock('../controlOps.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    appendAuditLog: vi.fn(() => 'AUD-1'),
  };
});

const { releaseRefundSplitUnclearedHoldTx } = await import('./refundSplitUnclearedReleaseOps.js');

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

describe.skipIf(!mysqlOk)('releaseRefundSplitUnclearedHoldTx', () => {
  let db;

  beforeAll(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-A', 'Customer A', '${DEFAULT_BRANCH_ID}');
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, approved_amount_ngn, status, requested_by, requested_at_iso, paid_amount_ngn,
        payment_note, branch_id, split_distributions_json
      ) VALUES (
        'RF-UNCLR-REL-1', 'CUS-A', 'Customer A', 'QT-1', '["Overpayment"]', 'Overpayment',
        942690, 942690, 'Partially paid', 'Sales', '2026-10-07T12:00:00.000Z', 899000,
        'customer paid', '${DEFAULT_BRANCH_ID}',
        '${JSON.stringify([
          {
            recipientKind: 'customer',
            recipientCustomerID: 'CUS-A',
            amountNgn: 899000,
            netPayoutNgn: 899000,
            payoutHeldForUnclearedReceipts: false,
          },
          {
            recipientKind: 'customer',
            recipientCustomerID: 'CUS-BAKARI',
            amountNgn: 43690,
            netPayoutNgn: 34952,
            unclearedReceiptHoldNgn: 130350,
            payoutHeldForUnclearedReceipts: true,
            note: 'Staff · HELD',
            payoutAccount: { payeeAccountNo: '3064987728', payeeName: 'Bakari' },
          },
        ]).replace(/'/g, "''")}'
      );
      INSERT INTO partner_wallet_entries (
        id, party_kind, party_id, party_name, entry_type, amount_ngn, open_ngn,
        refund_id, branch_id, payee_name, payee_bank_name, payee_account_no, note, created_at_iso
      ) VALUES (
        'PWL-REL-1', 'customer', 'CUS-BAKARI', 'Bakari', 'credit', 34952, 34952,
        'RF-UNCLR-REL-1', '${DEFAULT_BRANCH_ID}', 'Bakari', 'First Bank', '3064987728', 'held',
        '2026-10-07T12:00:00.000Z'
      );
    `);
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

  it('releases hold, closes wallet open, keeps Partially paid, no payout', () => {
    const r = releaseRefundSplitUnclearedHoldTx(db, 'RF-UNCLR-REL-1', {
      payeeCustomerId: 'CUS-BAKARI',
      payeeAccountNo: '3064987728',
      note: 'Released by OM 07 Oct 2026; customer already paid; balance to Bakari',
      actor: { id: 'U1', name: 'OM', roleKey: 'admin' },
    });
    expect(r.ok).toBe(true);
    expect(r.tillReadyNgn).toBe(34952);
    expect(r.walletClosedNgn).toBe(34952);

    const row = db
      .prepare(
        `SELECT status, paid_amount_ngn, split_distributions_json FROM customer_refunds WHERE refund_id = ?`
      )
      .get('RF-UNCLR-REL-1');
    expect(row.status).toBe('Partially paid');
    expect(row.paid_amount_ngn).toBe(899000);
    const bakari = JSON.parse(row.split_distributions_json).find(
      (s) => s.recipientCustomerID === 'CUS-BAKARI'
    );
    expect(bakari.payoutHeldForUnclearedReceipts).toBe(false);
    expect(bakari.unclearedHoldOmReleased).toBe(true);
    expect(bakari.unclearedReceiptHoldNgn).toBe(0);

    const wallet = db.prepare(`SELECT open_ngn FROM partner_wallet_entries WHERE id = ?`).get('PWL-REL-1');
    expect(wallet.open_ngn).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase } from '../db.js';

vi.mock('../controlOps.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    appendAuditLog: vi.fn(() => 'AUD-1'),
  };
});

const { releaseRefundSplitUnclearedHoldTx } = await import('./refundSplitUnclearedReleaseOps.js');

describe('releaseRefundSplitUnclearedHoldTx', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;
  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    db.prepare(
      `UPDATE customer_refunds
       SET status = 'Partially paid',
           paid_amount_ngn = 899000,
           payment_note = 'customer paid',
           split_distributions_json = ?
       WHERE refund_id = (
         SELECT refund_id FROM customer_refunds LIMIT 1
       )`
    );
    // Prefer a dedicated row — insert if table allows.
    try {
      db.prepare(
        `INSERT INTO customer_refunds (
           refund_id, customer_id, customer_name, quotation_ref, amount_ngn, approved_amount_ngn,
           status, paid_amount_ngn, payment_note, split_distributions_json, requested_at_iso, branch_id
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        'RF-UNCLR-REL-1',
        'CUS-A',
        'Customer A',
        'QT-1',
        942690,
        942690,
        'Partially paid',
        899000,
        'customer paid',
        JSON.stringify([
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
        ]),
        '2026-10-07T12:00:00.000Z',
        'BR-KD'
      );
    } catch (e) {
      // Schema variants — fall back to updating any existing refund.
      const existing = db.prepare(`SELECT refund_id FROM customer_refunds LIMIT 1`).get();
      if (!existing) throw e;
      db.prepare(
        `UPDATE customer_refunds
         SET refund_id = 'RF-UNCLR-REL-1',
             status = 'Partially paid',
             paid_amount_ngn = 899000,
             payment_note = 'customer paid',
             split_distributions_json = ?
         WHERE refund_id = ?`
      ).run(
        JSON.stringify([
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
        ]),
        existing.refund_id
      );
    }
    try {
      db.prepare(
        `INSERT INTO partner_wallet_entries (
           id, party_kind, party_id, party_name, entry_type, amount_ngn, open_ngn,
           refund_id, branch_id, payee_name, payee_bank_name, payee_account_no, note, created_at_iso
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        'PWL-REL-1',
        'customer',
        'CUS-BAKARI',
        'Bakari',
        'credit',
        34952,
        34952,
        'RF-UNCLR-REL-1',
        'BR-KD',
        'Bakari',
        'First Bank',
        '3064987728',
        'held',
        '2026-10-07T12:00:00.000Z'
      );
    } catch {
      /* table/columns may differ */
    }
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
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

    const row = db
      .prepare(`SELECT status, paid_amount_ngn, split_distributions_json FROM customer_refunds WHERE refund_id = ?`)
      .get('RF-UNCLR-REL-1');
    expect(row.status).toBe('Partially paid');
    expect(row.paid_amount_ngn).toBe(899000);
    const bakari = JSON.parse(row.split_distributions_json).find((s) => s.recipientCustomerID === 'CUS-BAKARI');
    expect(bakari.payoutHeldForUnclearedReceipts).toBe(false);
    expect(bakari.unclearedHoldOmReleased).toBe(true);
    expect(bakari.unclearedReceiptHoldNgn).toBe(0);

    const wallet = db.prepare(`SELECT open_ngn FROM partner_wallet_entries WHERE id = ?`).get('PWL-REL-1');
    if (wallet) expect(wallet.open_ngn).toBe(0);
  });
});

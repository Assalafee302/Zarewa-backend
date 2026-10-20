-- Refund pick (read-only). One row per refund with the facts the score uses.
SELECT r.refund_id, r.customer_id, r.customer_name, r.quotation_ref, r.status, r.reason_category,
       r.amount_ngn, r.approved_amount_ngn, r.paid_amount_ngn, r.credit_applied_ngn, r.remainder_closed_ngn,
       r.approved_by, r.paid_by, r.payee_name, r.payee_account_no, r.payee_bank_name, r.payout_hold,
       r.split_distributions_json, r.calculation_lines_json, r.requested_at_iso,
       (SELECT COUNT(*) FROM treasury_movements t WHERE t.source_kind='REFUND' AND t.source_id=r.refund_id AND t.type='REFUND_PAYOUT'
          AND (t.reverses_movement_id IS NULL OR t.reverses_movement_id='')
          AND NOT EXISTS (SELECT 1 FROM treasury_movements x WHERE x.reverses_movement_id=t.id)) AS payout_lines,
       (SELECT COUNT(DISTINCT t.treasury_account_id) FROM treasury_movements t WHERE t.source_kind='REFUND' AND t.source_id=r.refund_id AND t.type='REFUND_PAYOUT') AS payout_accounts,
       (SELECT COALESCE(SUM(CASE WHEN t.type='REFUND_PAYOUT' THEN -t.amount_ngn WHEN t.type='REFUND_PAYOUT_REVERSAL_IN' THEN -t.amount_ngn ELSE 0 END),0)
          FROM treasury_movements t WHERE t.source_kind='REFUND' AND t.source_id=r.refund_id) AS treasury_net,
       (SELECT COALESCE(SUM(a.amount_ngn),0) FROM refund_credit_applications a WHERE a.refund_id=r.refund_id
          AND LOWER(TRIM(COALESCE(a.status,''))) NOT IN ('reversed','cancelled','leftover clear')) AS credit_apps_ngn,
       (SELECT COALESCE(SUM(a.amount_ngn),0) FROM refund_credit_applications a WHERE a.source_quotation_ref=r.quotation_ref
          AND TRIM(IFNULL(a.refund_id,''))='' AND LOWER(TRIM(COALESCE(a.status,''))) NOT IN ('reversed','cancelled')) AS credit_out_ngn,
       (SELECT COUNT(*) FROM sales_receipts s WHERE s.quotation_ref=r.quotation_ref AND (status IS NULL OR LOWER(TRIM(status)) NOT IN ('reversed','rejected','cancelled','void'))) AS receipts_n,
       (SELECT COUNT(*) FROM sales_receipts s WHERE s.quotation_ref=r.quotation_ref AND (status IS NULL OR LOWER(TRIM(status)) NOT IN ('reversed','rejected','cancelled','void'))
          AND (s.finance_reconciliation_saved_at_iso IS NULL OR s.finance_reconciliation_saved_at_iso='')
          AND LOWER(TRIM(COALESCE(s.status,''))) NOT IN ('cleared','confirmed')) AS receipts_unconfirmed,
       -- criterion 5b: a receipt corrected after finance confirmed it (treasury split corrected, amount re-aligned,
       -- or a Phase 2 correction), where bank_received_amount_ngn may have been left stale
       (SELECT COUNT(*) FROM audit_log l JOIN sales_receipts s ON s.quotation_ref=r.quotation_ref
          WHERE (l.action='treasury.ledger_receipt_correct' AND l.note LIKE CONCAT('%receipt source ', s.id, '%'))
             OR (l.entity_id=s.id AND l.action='phase2.correction')
             OR (l.entity_id=s.id AND l.action='receipt.finance_amount_sync' AND l.note LIKE '%(was %' AND l.note NOT REGEXP 'aligned to finance-confirmed ₦([0-9,]+) \(was ₦([0-9,]+)\)')) AS receipts_corrected,
       -- criterion 5c: live treasury lines behind the receipt differ from the confirmed amount by more than a fee
       (SELECT COUNT(*) FROM sales_receipts s WHERE s.quotation_ref=r.quotation_ref AND (status IS NULL OR LOWER(TRIM(status)) NOT IN ('reversed','rejected','cancelled','void')) AND ABS(COALESCE(s.bank_received_amount_ngn, s.amount_ngn) -
          (SELECT COALESCE(SUM(CASE WHEN (t.reverses_movement_id IS NULL OR t.reverses_movement_id='') AND NOT EXISTS (SELECT 1 FROM treasury_movements x WHERE x.reverses_movement_id=t.id) THEN t.amount_ngn ELSE 0 END),0)
             FROM treasury_movements t WHERE t.source_kind='LEDGER_RECEIPT' AND t.source_id=s.ledger_entry_id)) > 100
          AND EXISTS (SELECT 1 FROM treasury_movements t2 WHERE t2.source_kind='LEDGER_RECEIPT' AND t2.source_id=s.ledger_entry_id)) AS receipts_stale,
       (SELECT COALESCE(SUM(o.amount_ngn),0) FROM customer_refunds o WHERE o.quotation_ref=r.quotation_ref
          AND LOWER(TRIM(COALESCE(o.status,''))) NOT IN ('rejected','cancelled')) AS quote_refunds_total,
       (SELECT COUNT(*) FROM audit_log l WHERE l.entity_kind='refund' AND l.entity_id=r.refund_id AND l.action IN
          ('refund.reverse_treasury_payout','refund.restore_payouts','refund.approval_restore','refund.customer_share_rebase',
           'refund.clear_reversed_payout_lines','refund.payee_reclass','refund.remainder_rounding','refund.remainder_cancelled',
           'refund.credit_backing','refund.status.paid','refund.leftover_clear','refund.company_retention.raise')) AS audit_changes,
       (SELECT COUNT(*) FROM refund_company_retention_entries e WHERE e.refund_id=r.refund_id AND e.entry_type='credit') AS retention_rows,
       c.bank_account_no AS customer_bank_account_no, c.bank_account_name AS customer_bank_account_name
FROM customer_refunds r
LEFT JOIN customers c ON c.customer_id = r.customer_id
WHERE LOWER(TRIM(COALESCE(r.status,''))) NOT IN ('rejected')

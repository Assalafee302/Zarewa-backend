import { describe, expect, it } from 'vitest';
import {
  ATTENTION_ACTIONS,
  ATTENTION_GROUPS,
  ATTENTION_RULES,
  attentionDeepLink,
  attentionNgn,
  explainAttentionItem,
  summarizeAttention,
} from './attentionRules.js';

const NOW = '2026-10-19T09:00:00.000Z';
const LIMITS = { refundExecutiveThresholdNgn: 1_000_000, expenseExecutiveThresholdNgn: 500_000 };
const explain = (item) => explainAttentionItem(item, { nowIso: NOW, limits: LIMITS });

describe('attentionNgn', () => {
  it('formats integer naira with commas', () => {
    expect(attentionNgn(1408453)).toBe('₦1,408,453');
    expect(attentionNgn(57750.4)).toBe('₦57,750');
    expect(attentionNgn(0)).toBe('₦0');
  });
});

describe('every rule is fully defined', () => {
  it('has a group, label, severity, focus, known actions, message and evidence', () => {
    for (const [id, r] of Object.entries(ATTENTION_RULES)) {
      expect(ATTENTION_GROUPS[r.group], id).toBeTruthy();
      expect(r.label, id).toBeTruthy();
      expect(['critical', 'warning', 'info'], id).toContain(r.severity);
      expect(r.focus, id).toBeTruthy();
      expect(r.actions.length, id).toBeGreaterThan(0);
      for (const a of r.actions) expect(ATTENTION_ACTIONS[a], `${id}.${a}`).toBeTruthy();
      expect(typeof r.message, id).toBe('function');
      expect(typeof r.evidence, id).toBe('function');
    }
  });
});

describe('quotes', () => {
  it('paid above the quote leads, then the not-cleared sentence', () => {
    const a = explain({
      id: 'clearance:QT-KD-26-1522',
      kind: 'clearance',
      quotationRef: 'QT-KD-26-1522',
      amountNgn: 100000,
      atIso: '2026-10-08',
      row: { id: 'QT-KD-26-1522', total_ngn: 100000, paid_ngn: 140000, date_iso: '2026-10-08' },
    });
    expect(a.ruleIds).toEqual(['quote_overpaid', 'quote_not_cleared']);
    expect(a.sentence).toBe('Paid ₦140,000 against a ₦100,000 quote — ₦40,000 above');
    expect(a.flags[1].sentence).toBe(
      'QT-KD-26-1522: ₦140,000 paid of ₦100,000 (140%) and not yet cleared by a manager — 11 days'
    );
    expect(a.flags[0].evidence.map((e) => e.value)).toEqual(['₦100,000', '₦140,000', '₦40,000']);
    expect(a.links.exec).toBe('/exec?tab=decide&attention=clearance%3AQT-KD-26-1522');
    expect(a.links.manager).toBe('/manager?inbox=orders&quoteRef=QT-KD-26-1522&attention=clearance%3AQT-KD-26-1522');
    expect(a.ageLabel).toBe('11 days');
  });

  it('under 70% paid and large orders add their own sentences', () => {
    const a = explain({
      id: 'clearance:QT-1',
      kind: 'clearance',
      quotationRef: 'QT-1',
      row: { total_ngn: 2_000_000, paid_ngn: 500_000, date_iso: '2026-10-19' },
    });
    expect(a.ruleIds).toEqual(['quote_not_cleared', 'quote_below_production_gate', 'quote_high_value']);
    expect(a.sentence).toBe('QT-1: ₦500,000 paid of ₦2,000,000 (25%) and not yet cleared by a manager — since today');
    expect(a.flags[1].sentence).toBe('Only 25% paid (₦500,000 of ₦2,000,000) — 70% is needed before production');
    expect(a.flags[1].evidence[2]).toEqual({ label: 'Short of 70%', value: '₦900,000', tone: 'bad' });
    expect(a.flags[2].sentence).toBe('Quote ₦2,000,000 is at or above the ₦500,000 executive limit');
  });

  it('below floor names the worst line', () => {
    const a = explain({
      id: 'price:QT-9',
      kind: 'price_exception',
      quotationRef: 'QT-9',
      atIso: '2026-10-16',
      row: {
        total_ngn: 850_000,
        paid_ngn: 300_000,
        md_price_exception_snapshot_json: JSON.stringify([
          { lineName: 'Longspan', gauge: '0.45mm', floorPerMeter: 4500, quotedPerMeter: 4200 },
          { lineName: 'Ridge', gauge: '0.45mm', floorPerMeter: 3000, quotedPerMeter: 2950 },
        ]),
      },
    });
    expect(a.sentence).toBe(
      'QT-9: Longspan 0.45mm quoted ₦4,200/m vs floor ₦4,500/m (₦300/m below) and 1 more line; ₦300,000 already paid — needs BM or MD approval — 3 days'
    );
    expect(a.flags[0].actions.map((x) => x.label)).toEqual(['Approve', 'Reject']);
    expect(a.links.manager).toBe('/manager?inbox=orders&quoteRef=QT-9&review=price_exception&attention=price%3AQT-9');
  });

  it('below floor without a snapshot still says what is wrong', () => {
    const a = explain({ id: 'price:QT-8', kind: 'price_exception', quotationRef: 'QT-8', row: { total_ngn: 1, paid_ngn: 50_000 } });
    expect(a.sentence).toBe('QT-8: priced below the floor; ₦50,000 already paid — needs BM or MD approval');
  });

  it('flagged quote quotes the reason and the day', () => {
    const a = explain({
      id: 'flagged:QT-5',
      kind: 'flagged',
      quotationRef: 'QT-5',
      atIso: '2026-10-16T10:00:00Z',
      row: { total_ngn: 300_000, manager_flag_reason: 'Customer says paid twice' },
    });
    expect(a.sentence).toBe('QT-5 flagged for audit on 16 Oct: “Customer says paid twice” — 3 days');
    expect(a.group).toBe('controls');
  });
});

describe('production', () => {
  it('held cutting list says how much more is needed', () => {
    const a = explain({
      id: 'production_gate:QT-7',
      kind: 'production',
      quotationRef: 'QT-7',
      cuttingListId: 'CL-KD-26-0101',
      row: { id: 'CL-KD-26-0101', quotation_ref: 'QT-7', total_ngn: 1_000_000, paid_ngn: 450_000 },
    });
    expect(a.sentence).toBe(
      'Cutting list CL-KD-26-0101 for QT-7 is held: 45% paid (₦450,000 of ₦1,000,000) — ₦250,000 more needed for 70%'
    );
    expect(a.flags[0].actions.map((x) => x.id)).toEqual(['override', 'open']);
  });

  it('payment-gate breach on a completed job', () => {
    const a = explain({
      id: 'payment_gate:PRO-KD-26-1349',
      kind: 'governance',
      quotationRef: 'QT-1643',
      jobId: 'PRO-KD-26-1349',
      atIso: '2026-10-12T15:00:00Z',
      row: { jobId: 'PRO-KD-26-1349', totalNgn: 600_000, paidNgn: 240_000, paidPct: 40, outstandingNgn: 360_000 },
    });
    expect(a.ruleId).toBe('production_gate_breach');
    expect(a.sentence).toBe(
      'Job PRO-KD-26-1349 completed 12 Oct with only 40% paid (₦240,000 of ₦600,000) and no manager override — ₦360,000 outstanding'
    );
    expect(a.links.manager).toBe('/manager?inbox=qc&jobId=PRO-KD-26-1349&attention=payment_gate%3APRO-KD-26-1349');
  });

  it('conversion not signed off shows metres, kg and kg/m', () => {
    const a = explain({
      id: 'conversion:PRO-1',
      kind: 'conversions',
      jobId: 'PRO-1',
      quotationRef: 'QT-2',
      atIso: '2026-10-15T09:00:00Z',
      row: { actual_meters: 120, actual_weight_kg: 450, conversion_alert_state: 'High' },
    });
    expect(a.sentence).toBe('Job PRO-1 (QT-2) made 120 m from 450 kg (3.75 kg/m) — conversion HIGH, not signed off — 4 days');
    expect(a.links.manager).toBe('/manager?inbox=qc&jobId=PRO-1&attention=conversion%3APRO-1');
  });
});

describe('refunds', () => {
  it('pending refund above the limit with an MD discount lists all three flags', () => {
    const a = explain({
      id: 'refund:RF-KD-26-9500',
      kind: 'refunds',
      refundId: 'RF-KD-26-9500',
      quotationRef: 'QT-KD-26-1400',
      amountNgn: 1_408_453,
      atIso: '2026-10-16T08:00:00Z',
      row: { customer_name: 'Tahir Musa', amount_ngn: 1_408_453, reason_category: '["Overpayment","MD discount"]' },
    });
    expect(a.ruleIds).toEqual(['refund_pending', 'refund_above_limit', 'refund_md_discount']);
    expect(a.sentence).toBe(
      'Refund ₦1,408,453 to Tahir Musa (Overpayment, MD discount) requested 16 Oct is waiting for approval — 3 days'
    );
    expect(a.flags[1].sentence).toBe('₦1,408,453 is above the ₦1,000,000 refund limit — MD/CEO must approve');
    expect(a.flags[2].sentence).toBe('Reason includes an MD discount — only MD/CEO can approve');
    expect(a.links.manager).toBe('/manager?inbox=cash_out&refundId=RF-KD-26-9500&attention=refund%3ARF-KD-26-9500');
  });

  it('approved but unpaid refund (cashier desk)', () => {
    const a = explain({
      id: 'refund_unpaid:RF-1',
      ruleId: 'refund_unpaid',
      facts: { amountNgn: 1_408_453, atIso: '2026-10-16T11:00:00Z', approvedBy: 'Abdulrahman', paidNgn: 0 },
    });
    expect(a.sentence).toBe('Refund ₦1,408,453 approved 16 Oct is still unpaid — 3 days');
  });

  it('approver = payer and requester = approver name the person', () => {
    const a = explain({
      id: 'dual_control:RF-2:same_approver_payer',
      kind: 'governance',
      refundId: 'RF-2',
      row: { kind: 'same_approver_payer', refundId: 'RF-2', amountNgn: 52_000, approvedBy: 'Abdulrahman', paidBy: 'Abdulrahman' },
    });
    expect(a.sentence).toBe('Refund RF-2 ₦52,000 was approved and paid by the same person (Abdulrahman)');
    expect(a.flags[0].evidence.slice(0, 2)).toEqual([
      { label: 'Approved by', value: 'Abdulrahman', tone: 'bad' },
      { label: 'Paid by', value: 'Abdulrahman', tone: 'bad' },
    ]);
    expect(a.links.manager).toBe('/manager?inbox=cash_out&refundId=RF-2&attention=dual_control%3ARF-2%3Asame_approver_payer');
    expect(a.flags[0].actions.map((x) => x.label)).toEqual(['Acknowledge with note', 'Open record']);

    const b = explain({
      id: 'dual_control:RF-3:same_requester_approver',
      kind: 'governance',
      refundId: 'RF-3',
      row: { kind: 'same_requester_approver', amountNgn: 9_000, requestedBy: 'Musa', approvedBy: 'Musa' },
    });
    expect(b.sentence).toBe('Refund RF-3 ₦9,000 was requested and approved by the same person (Musa)');
  });
});

describe('cash out', () => {
  it('payment request above the expense limit', () => {
    const a = explain({
      id: 'payment:PR-0398',
      kind: 'payments',
      requestId: 'PR-0398',
      atIso: '2026-10-17',
      row: { amount_requested_ngn: 750_000, description: 'Transformer repair', expense_category: 'Maintenance', attachment_present: 0 },
    });
    expect(a.sentence).toBe(
      'Payment request ₦750,000 for “Transformer repair” (Maintenance) requested 17 Oct is waiting for approval — 2 days'
    );
    expect(a.flags[1].sentence).toBe('₦750,000 is above the ₦500,000 executive expense limit');
    expect(a.links.manager).toBe('/manager?inbox=cash_out&requestId=PR-0398&attention=payment%3APR-0398');
  });

  it('register withdrawal', () => {
    const a = explain({
      id: 'register_settlement:RS-1',
      kind: 'register_settlement',
      settlementId: 'RS-1',
      row: { amountNgn: 120_000, partyName: 'Zinc supplier', requestedAtIso: '2026-10-18T10:00:00Z' },
    });
    expect(a.sentence).toBe('Register withdrawal ₦120,000 to Zinc supplier requested 18 Oct is waiting for approval — 1 day');
    expect(a.links.manager).toBe('/manager?inbox=withdrawals&settlementId=RS-1&attention=register_settlement%3ARS-1');
  });

  it('inter-branch loan', () => {
    const a = explain({
      id: 'ibl:L-1',
      kind: 'inter_branch_loan',
      atIso: '2026-10-18',
      reviewContext: { subtitle: 'Kaduna (HQ) → Yola' },
      row: { loan_id: 'L-1', principal_ngn: 5_000_000 },
    });
    expect(a.sentence).toBe('Loan ₦5,000,000 from Kaduna (HQ) to Yola is waiting for MD approval — 1 day');
  });
});

describe('people, stock, edits, governance, office', () => {
  it('overtime', () => {
    const a = explain({
      id: 'ot:OT-1',
      kind: 'overtime',
      atIso: '2026-10-18',
      row: { totalPayableNgn: 15_000, dayIso: '2026-10-17', workType: 'production', quotationRef: 'QT-4', createdByName: 'Store' },
    });
    expect(a.sentence).toBe('Overtime ₦15,000 for 17 Oct (production, QT-4) by Store is waiting for approval — 1 day');
  });

  it('staff purchase credit', () => {
    const a = explain({
      id: 'staff_purchase_credit:SPC-1',
      kind: 'staff_purchase_credit',
      quotationRef: 'QT-3',
      atIso: '2026-10-19',
      row: { principalOriginalNgn: 240_000, installmentNgn: 20_000, staffDisplayName: 'Aisha Bello' },
    });
    expect(a.sentence).toBe(
      'Staff purchase credit ₦240,000 for Aisha Bello on QT-3 (₦20,000/month from payroll) needs MD approval — since today'
    );
  });

  it('payroll sign-off', () => {
    const a = explain({ id: 'payroll:PR-2026-09', kind: 'payroll', atIso: '2026-10-05', row: { period_yyyymm: '2026-09' } });
    expect(a.sentence).toBe('Payroll 2026-09 is a draft waiting for MD sign-off before it can be locked — 14 days');
    expect(a.flags[0].actions.map((x) => x.id)).toEqual(['sign_off']);
  });

  it('material exception', () => {
    const a = explain({
      id: 'material:MI-1',
      kind: 'material',
      title: 'MI-1',
      row: { id: 'MI-1', incident_type: 'damaged_coil', total_meters: 12.5, gauge_label: '0.45mm', colour: 'Bush Green', date_iso: '2026-10-17' },
    });
    expect(a.sentence).toBe('Damaged coil of 12.5 m 0.45mm Bush Green reported 17 Oct is waiting for approval — 2 days');
    expect(a.links.manager).toBe('/manager?inbox=material&materialIncidentId=MI-1&attention=material%3AMI-1');
  });

  it('edit second approval', () => {
    const a = explain({
      id: 'edit:E-1',
      kind: 'edit_approvals',
      atIso: '2026-10-19T07:00:00Z',
      row: { id: 'E-1', entityKind: 'purchase_order', entityId: 'PO-0070', changeSummary: 'unit price 1,738 → 1,800', requestedByDisplay: 'Musa' },
    });
    expect(a.sentence).toBe(
      'Musa changed purchase order PO-0070 (unit price 1,738 → 1,800) — it saves only after a second approval — since today'
    );
  });

  it('missing branch manager links to Team & access', () => {
    const a = explain({
      id: 'missing_bm:BR-YL',
      kind: 'governance',
      integrityKind: 'missing_branch_manager',
      row: { integrityKind: 'missing_branch_manager', branchId: 'BR-YL', branchName: 'Yola' },
    });
    expect(a.sentence).toBe('Yola has no Branch Manager — complaints, overtime and other branch approvals have no owner');
    expect(a.links.exec).toBe('/settings/team');
    expect(a.flags[0].actions.map((x) => x.label)).toEqual(['Assign Branch Manager']);
  });

  it('office memo and generic work item', () => {
    expect(
      explain({ id: 'office:T-1', kind: 'office_memo', atIso: '2026-10-17', reviewContext: { subject: 'Diesel budget' } }).sentence
    ).toBe('Memo “Diesel budget” is open for the executive office — last update 2 days ago');
    expect(
      explain({ id: 'work:W-1', kind: 'something_new', title: 'Vendor onboarding', status: 'Submitted', amountNgn: 0, atIso: '2026-10-19' })
        .sentence
    ).toBe('Vendor onboarding is submitted — since today');
  });
});

describe('cashier desk + reports rules (explicit ruleId)', () => {
  it('receipt with no bank line', () => {
    const item = {
      id: 'receipt_no_bank_line:RC-1',
      ruleId: 'receipt_no_bank_line',
      receiptId: 'RC-1',
      facts: { amountNgn: 57_750, customer: 'Ibrahim Sani', atIso: '2026-10-08' },
    };
    const a = explain(item);
    expect(a.sentence).toBe('Receipt ₦57,750 from Ibrahim Sani has no matching bank line after 11 days');
    expect(attentionDeepLink(item, 'cashier')).toBe('/cashier?receipt=RC-1&attention=receipt_no_bank_line%3ARC-1');
    expect(a.flags[0].actions.map((x) => x.label)).toEqual(['Ask cashier', 'Open record']);
  });

  it('customer with an open refund (hanging-refund chip on a receipt)', () => {
    const one = explain({
      id: 'hang:CUS-1',
      ruleId: 'customer_open_refund',
      facts: {
        customer: 'Tahir Musa',
        refunds: [{ refundId: 'RF-KD-26-9500', openNgn: 15_350, status: 'Approved', approvedAtIso: '2026-10-16' }],
        creditNgn: 0,
      },
    });
    expect(one.sentence).toBe(
      'Tahir Musa has refund RF-KD-26-9500 ₦15,350 approved 16 Oct and unpaid — check this receipt is not the same money'
    );
    const many = explain({
      id: 'hang:CUS-2',
      ruleId: 'customer_open_refund',
      facts: {
        customer: 'Ade',
        refunds: [
          { refundId: 'RF-1', openNgn: 10_000, status: 'Pending' },
          { refundId: 'RF-2', openNgn: 5_000, status: 'Approved' },
        ],
        creditNgn: 2_000,
      },
    });
    expect(many.sentence).toBe(
      'Ade has 2 open refunds totalling ₦15,000 plus ₦2,000 unused overpayment credit — check this receipt is not the same money'
    );
  });

  it('receipt under investigation', () => {
    const a = explain({
      id: 'x',
      ruleId: 'receipt_under_investigation',
      facts: { amountNgn: 31_030, customer: 'Farouq', caseId: 'INV-7', status: 'Suspended', atIso: '2026-10-15' },
    });
    expect(a.sentence).toBe(
      'Receipt ₦31,030 from Farouq is under investigation (case INV-7) — it cannot be confirmed until the case is cleared — 4 days'
    );
  });

  it('quotation paid mismatch', () => {
    const a = explain({
      id: 'ar:QT-1',
      ruleId: 'quotation_paid_mismatch',
      facts: { quotationRef: 'QT-1', paidOnQuoteNgn: 150_000, expectedPaidNgn: 100_000, receiptsNgn: 100_000, creditAppliedNgn: 0 },
    });
    expect(a.sentence).toBe('QT-1 shows ₦150,000 paid but receipts + applied credit come to ₦100,000 — ₦50,000 more on the quote');
  });
});

describe('summarizeAttention', () => {
  const items = [
    { id: 'refund:A', kind: 'refunds', amountNgn: 100, atIso: '2026-10-10', row: { amount_ngn: 100 } },
    { id: 'refund:B', kind: 'refunds', amountNgn: 200, atIso: '2026-10-18', row: { amount_ngn: 200 } },
    { id: 'payment:C', kind: 'payments', amountNgn: 50, atIso: '2026-10-15', row: { amount_requested_ngn: 50 } },
    { id: 'missing_bm:Y', kind: 'governance', integrityKind: 'missing_branch_manager', amountNgn: null, row: {} },
  ];

  it('groups in display order with counts and ₦ totals; newest first by default', () => {
    const s = summarizeAttention(items, { nowIso: NOW, limits: LIMITS });
    expect(s.total).toBe(4);
    expect(s.totalNgn).toBe(350);
    expect(s.groups.map((g) => [g.group, g.count, g.totalNgn])).toEqual([
      ['controls', 1, 0],
      ['refunds', 2, 300],
      ['cash_out', 1, 50],
    ]);
    expect(s.groups[1].rows.map((r) => r.item.id)).toEqual(['refund:B', 'refund:A']);
  });

  it('oldest first on request', () => {
    const s = summarizeAttention(items, { nowIso: NOW, order: 'oldest' });
    expect(s.groups[1].rows.map((r) => r.item.id)).toEqual(['refund:A', 'refund:B']);
  });

  it('uses the server explanation when the item already carries one', () => {
    const pre = { ...items[2], attention: { ...explain(items[2]), sentence: 'server text' } };
    const s = summarizeAttention([pre], { nowIso: NOW });
    expect(s.groups[0].rows[0].attention.sentence).toBe('server text');
  });
});

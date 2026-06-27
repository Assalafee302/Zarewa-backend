import { describe, it, expect } from 'vitest';
import {
  refundProductionAlignmentWarnings,
  suggestRefundCategoriesFromProduction,
  validateRefundProductionAlignmentAtSubmit,
  actorMayOverrideProductionAlignmentBlock,
  parseStoredProductionAlignmentAck,
  resolveRefundReasonCategoriesForDecision,
  mergeProductionAlignmentAckJson,
} from './refundProductionAlignment.js';

describe('refundProductionAlignment', () => {
  function memDb() {
    const db = {
      data: {
        quotations: [],
        production_jobs: [],
        customer_refunds: [],
        production_job_coils: [],
      },
      prepare(sql) {
        const s = String(sql);
        return {
          get(ref, jobId) {
            if (s.includes('FROM production_job_coils') && s.includes('SUM')) {
              const jid = String(jobId ?? ref ?? '').trim();
              const sum = db.data.production_job_coils
                .filter((c) => String(c.job_id || '').trim() === jid)
                .reduce((acc, c) => acc + (Number(c.meters_produced) || 0), 0);
              return { s: sum };
            }
            if (s.includes('FROM quotations')) {
              return db.data.quotations.find((q) => q.id === ref) || undefined;
            }
            return undefined;
          },
          all(ref) {
            if (s.includes('FROM production_jobs')) {
              return db.data.production_jobs.filter((j) => j.quotation_ref === ref);
            }
            if (s.includes('FROM customer_refunds')) {
              return db.data.customer_refunds.filter((r) => r.quotation_ref === ref);
            }
            return [];
          },
        };
      },
    };
    return db;
  }

  it('suggests unproduced meterage for cancelled job with no output', () => {
    const db = memDb();
    db.data.quotations.push({
      id: 'Q1',
      lines_json: JSON.stringify({ products: [{ name: 'Roofing Sheet', qty: '100', unitPrice: '1000' }] }),
    });
    db.data.production_jobs.push({
      quotation_ref: 'Q1',
      status: 'Cancelled',
      planned_meters: 100,
      actual_meters: 0,
    });
    expect(suggestRefundCategoriesFromProduction(db, 'Q1')).toContain('Unproduced meterage');
  });

  it('does not suggest unproduced when offcut output meets quoted metres', () => {
    const db = memDb();
    db.data.quotations.push({
      id: 'Q1',
      lines_json: JSON.stringify({ products: [{ name: 'Roofing Sheet', qty: '3', unitPrice: '3900' }] }),
    });
    db.data.production_jobs.push({
      job_id: 'J-OFF',
      quotation_ref: 'Q1',
      status: 'Completed',
      planned_meters: 5,
      actual_meters: 3,
    });
    expect(suggestRefundCategoriesFromProduction(db, 'Q1')).not.toContain('Unproduced meterage');
  });

  it('blocks unproduced refund when roofing output fully satisfies quote', () => {
    const db = memDb();
    db.data.quotations.push({
      id: 'Q1',
      lines_json: JSON.stringify({ products: [{ name: 'Roofing Sheet', qty: '3', unitPrice: '3900' }] }),
    });
    db.data.production_jobs.push({
      job_id: 'J-OFF',
      quotation_ref: 'Q1',
      status: 'Completed',
      planned_meters: 5,
      actual_meters: 3,
    });
    const blocked = validateRefundProductionAlignmentAtSubmit(db, 'Q1', ['Unproduced meterage'], {
      actor: { roleKey: 'sales' },
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.blockedCode).toBe('unproduced_with_full_production');
  });

  it('warns on cancellation with completed coil production', () => {
    const db = memDb();
    db.data.production_jobs.push({
      job_id: 'J1',
      quotation_ref: 'Q1',
      status: 'Completed',
      planned_meters: 100,
      actual_meters: 80,
    });
    db.data.production_job_coils.push({
      job_id: 'J1',
      meters_produced: 80,
    });
    const issues = refundProductionAlignmentWarnings(db, 'Q1', ['Order cancellation']);
    expect(issues.some((i) => i.code === 'cancellation_with_production')).toBe(true);
  });

  it('warns on cancellation when offcut output was recorded on completed job', () => {
    const db = memDb();
    db.data.production_jobs.push({
      job_id: 'J-OFF',
      quotation_ref: 'Q1',
      status: 'Completed',
      planned_meters: 100,
      actual_meters: 100,
    });
    const issues = refundProductionAlignmentWarnings(db, 'Q1', ['Order cancellation']);
    expect(issues.some((i) => i.code === 'cancellation_with_production')).toBe(true);
  });

  it('flags multi-category overlap across prior and current refunds', () => {
    const db = memDb();
    db.data.customer_refunds.push({
      quotation_ref: 'Q1',
      reason_category: 'Overpayment',
      status: 'Paid',
    });
    const issues = refundProductionAlignmentWarnings(db, 'Q1', ['Order cancellation']);
    const overlap = issues.find((i) => i.code === 'multi_category_overlap');
    expect(overlap).toBeTruthy();
    expect(String(overlap.message)).toMatch(/Prior refund/i);
    expect(overlap.priorRefundCategories).toEqual(['Overpayment']);
    expect(overlap.currentRequestCategories).toEqual(['Order cancellation']);
  });

  it('blocks same-request Overpayment plus Order cancellation', () => {
    const db = memDb();
    const issues = refundProductionAlignmentWarnings(db, 'Q1', ['Overpayment', 'Order cancellation']);
    const overlap = issues.find((i) => i.code === 'multi_category_overlap_same_request');
    expect(overlap).toBeTruthy();
    expect(overlap.submitAction).toBeUndefined();
    const enriched = validateRefundProductionAlignmentAtSubmit(db, 'Q1', ['Overpayment', 'Order cancellation'], {
      actor: { roleKey: 'sales' },
    });
    expect(enriched.ok).toBe(false);
    expect(enriched.blockedCode).toBe('multi_category_overlap_same_request');
  });

  it('does not flag Overpayment plus Unproduced meterage on the same request', () => {
    const db = memDb();
    const issues = refundProductionAlignmentWarnings(db, 'Q1', ['Overpayment', 'Unproduced meterage']);
    expect(issues.some((i) => String(i.code || '').includes('multi_category_overlap'))).toBe(false);
  });

  it('blocks cancellation with coil production unless BM override note', () => {
    const db = memDb();
    db.data.production_jobs.push({
      job_id: 'J2',
      quotation_ref: 'Q1',
      status: 'Completed',
      planned_meters: 100,
      actual_meters: 100,
    });
    db.data.production_job_coils.push({
      job_id: 'J2',
      meters_produced: 100,
    });
    const blocked = validateRefundProductionAlignmentAtSubmit(db, 'Q1', ['Order cancellation'], {
      actor: { roleKey: 'sales' },
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('PRODUCTION_ALIGNMENT_BLOCKED');

    const overridden = validateRefundProductionAlignmentAtSubmit(db, 'Q1', ['Order cancellation'], {
      actor: { roleKey: 'branch_manager' },
      overrideNote: 'Customer confirmed full cancellation despite completed run.',
    });
    expect(overridden.ok).toBe(true);
    expect(overridden.overrideUsed).toBe(true);
  });

  it('requires acknowledgement for partial coil production cancellation', () => {
    const db = memDb();
    db.data.production_jobs.push({
      job_id: 'J3',
      quotation_ref: 'Q1',
      status: 'Completed',
      planned_meters: 100,
      actual_meters: 50,
    });
    db.data.production_job_coils.push({
      job_id: 'J3',
      meters_produced: 50,
    });
    const needAck = validateRefundProductionAlignmentAtSubmit(db, 'Q1', ['Order cancellation'], {
      actor: { roleKey: 'branch_manager' },
      overrideNote: 'Customer confirmed full cancellation despite partial run.',
    });
    expect(needAck.ok).toBe(false);
    expect(needAck.code).toBe('PRODUCTION_ALIGNMENT_ACK_REQUIRED');

    const ok = validateRefundProductionAlignmentAtSubmit(db, 'Q1', ['Order cancellation'], {
      actor: { roleKey: 'branch_manager' },
      overrideNote: 'Customer confirmed full cancellation despite partial run.',
      acknowledgedCodes: ['partial_production_cancellation'],
    });
    expect(ok.ok).toBe(true);
  });

  it('allows BM override authority check', () => {
    expect(actorMayOverrideProductionAlignmentBlock({ roleKey: 'branch_manager' })).toBe(true);
    expect(actorMayOverrideProductionAlignmentBlock({ roleKey: 'sales' })).toBe(false);
    expect(actorMayOverrideProductionAlignmentBlock({ roleKey: 'md' })).toBe(true);
  });

  it('parses stored alignment ack and merges at approval', () => {
    const stored = parseStoredProductionAlignmentAck(
      JSON.stringify({
        acknowledgedCodes: ['partial_production_cancellation'],
        overrideUsed: true,
        overrideNote: 'Customer confirmed cancellation despite run.',
      })
    );
    expect(stored.overrideUsed).toBe(true);
    expect(stored.acknowledgedCodes).toContain('partial_production_cancellation');

    const merged = mergeProductionAlignmentAckJson(
      stored,
      {
        ok: true,
        acknowledgedCodes: ['partial_production_cancellation'],
        overrideUsed: true,
        overrideNote: 'Customer confirmed cancellation despite run.',
      },
      'approval'
    );
    expect(merged).toContain('approval');

    const cats = resolveRefundReasonCategoriesForDecision(
      { reason_category: '["Order cancellation"]' },
      { calculationLines: [{ category: 'Unproduced meterage', include: true, amountNgn: 100 }] },
      (raw) => {
        const v = JSON.parse(String(raw));
        return Array.isArray(v) ? v : [];
      }
    );
    expect(cats).toEqual(['Unproduced meterage']);
  });
});

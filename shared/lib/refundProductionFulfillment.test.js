import { describe, it, expect } from 'vitest';
import { buildRefundProductionFulfillmentSummary } from './refundProductionFulfillment.js';

function memDb(coilByJob = {}) {
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        get(jobId) {
          if (s.includes('FROM production_job_coils') && s.includes('SUM')) {
            const jid = String(jobId ?? '').trim();
            return { s: Number(coilByJob[jid]) || 0 };
          }
          return undefined;
        },
      };
    },
  };
}

describe('refundProductionFulfillment', () => {
  it('treats offcut-only completion as fully produced when quote metres match', () => {
    const db = memDb({});
    const quote = {
      lines_json: JSON.stringify({
        products: [{ name: 'Roofing Sheet', qty: '3', unitPrice: '3900' }],
      }),
    };
    const jobs = [{ job_id: 'PRO-OFF', status: 'Completed', actual_meters: 3, planned_meters: 5 }];
    const summary = buildRefundProductionFulfillmentSummary(db, quote, jobs);
    expect(summary.quotedMeters).toBe(3);
    expect(summary.producedMetersForUnproduced).toBe(3);
    expect(summary.unproducedMetres).toBe(0);
    expect(summary.fullyProducedRoofing).toBe(true);
    expect(summary.offcutFgMeters).toBe(3);
    expect(summary.jobs[0].outputSource).toBe('offcut_or_accessories');
  });
});

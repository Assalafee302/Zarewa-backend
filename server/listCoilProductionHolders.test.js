import { describe, it, expect } from 'vitest';
import { listCoilProductionHolders } from './productionTraceability.js';

describe('listCoilProductionHolders', () => {
  it('selects cutting_lists.customer_name (not cl.customer)', () => {
    let capturedSql = '';
    const db = {
      prepare(sql) {
        capturedSql = String(sql);
        return {
          all() {
            return [
              {
                id: 'PJC-1',
                job_id: 'PRO-1',
                coil_no: 'CL-KD-001',
                opening_weight_kg: 1000,
                closing_weight_kg: 800,
                consumed_weight_kg: 200,
                meters_produced: 50,
                allocation_status: 'Completed',
                allocated_at_iso: '2026-06-01T10:00:00.000Z',
                job_status: 'Completed',
                cutting_list_id: 'CLIST-1',
                quotation_ref: 'QT-1',
                cutting_list_customer: 'Acme Ltd',
                conversion_alert_state: '',
              },
            ];
          },
        };
      },
    };

    const holders = listCoilProductionHolders(db, 'CL-KD-001');
    expect(capturedSql).toContain('cl.customer_name AS cutting_list_customer');
    expect(capturedSql).not.toMatch(/\bcl\.customer\b(?!_name)/);
    expect(holders).toHaveLength(1);
    expect(holders[0].customer).toBe('Acme Ltd');
    expect(holders[0].jobID).toBe('PRO-1');
  });

  it('returns empty array when coil number is blank', () => {
    const db = { prepare: () => ({ all: () => [] }) };
    expect(listCoilProductionHolders(db, '')).toEqual([]);
    expect(listCoilProductionHolders(db, '   ')).toEqual([]);
  });
});

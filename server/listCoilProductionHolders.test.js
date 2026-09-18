import { describe, it, expect } from 'vitest';
import {
  holderBookedKgUsed,
  listCoilProductionHolders,
  stockMovementDetailRefersToCoilNo,
} from './productionTraceability.js';

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

describe('holderBookedKgUsed', () => {
  it('uses opening − closing on completed jobs even when stored consumed drifted low', () => {
    expect(
      holderBookedKgUsed({
        jobStatus: 'Completed',
        allocationStatus: 'Completed',
        openingWeightKg: 3540,
        closingWeightKg: 72,
        consumedWeightKg: 500,
      })
    ).toBe(3468);
  });

  it('does not treat planned or running allocations as coil consumption', () => {
    expect(
      holderBookedKgUsed({
        jobStatus: 'Planned',
        allocationStatus: 'Allocated',
        openingWeightKg: 800,
        closingWeightKg: 0,
        consumedWeightKg: 0,
      })
    ).toBe(0);
    expect(
      holderBookedKgUsed({
        jobStatus: 'Running',
        allocationStatus: 'Running',
        openingWeightKg: 800,
        closingWeightKg: 100,
        consumedWeightKg: 700,
      })
    ).toBe(0);
  });

  it('counts a completed correction that increased consumption (lower closing kg)', () => {
    expect(
      holderBookedKgUsed({
        jobStatus: 'Completed',
        allocationStatus: 'Completed',
        openingWeightKg: 800,
        closingWeightKg: 100,
        consumedWeightKg: 700,
      })
    ).toBe(700);
  });
});

describe('stockMovementDetailRefersToCoilNo', () => {
  it('matches production consume and completion-correction restore wording', () => {
    expect(stockMovementDetailRefersToCoilNo('8405 consumed for 226.40 m on PRO-YL-26-0110', '8405')).toBe(
      true
    );
    expect(
      stockMovementDetailRefersToCoilNo(
        'Completion coil correction — restore 500.00 kg to 8405 (PRO-YL-26-0110)',
        '8405'
      )
    ).toBe(true);
  });

  it('does not treat a coil number as a substring of another coil or a job id', () => {
    expect(stockMovementDetailRefersToCoilNo('18405 consumed for 9.50 m on PRO-1', '8405')).toBe(false);
    expect(stockMovementDetailRefersToCoilNo('84050 consumed for 9.50 m on PRO-1', '8405')).toBe(false);
    expect(stockMovementDetailRefersToCoilNo('PRO-YL-26-0110 consumed for 9.50 m on PRO-YL-26-0110', '26')).toBe(
      false
    );
    expect(stockMovementDetailRefersToCoilNo('CL-10 consumed for 9.50 m on PRO-1', 'CL-1')).toBe(false);
  });
});

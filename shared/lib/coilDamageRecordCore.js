import { conversionKgPerMFromMass, roundConv2 } from './conversionKgPerM.js';

export const COIL_DAMAGE_INCIDENT_TYPES = new Set(['coil_stain', 'production_error']);

/**
 * @param {number | string | null | undefined} beforeKg
 * @param {number | string | null | undefined} afterKg
 * @returns {number | null}
 */
export function coilDamageKgDeducted(beforeKg, afterKg) {
  const before = Number(beforeKg);
  const after = Number(afterKg);
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= after) return null;
  return roundConv2(before - after);
}

/**
 * @param {object} [input]
 * @returns {{
 *   kgDeducted: number | null;
 *   actualConversionKgPerM: number | null;
 *   supplierConversionKgPerM: number | null;
 *   variancePct: number | null;
 *   maxRemoveKg: number | null;
 *   impliedMetersFromSupplier: number | null;
 * }}
 */
export function coilDamagePreview(input = {}) {
  const kgDeducted = coilDamageKgDeducted(input.beforeKg, input.afterKg);
  const meters = Number(input.meters);
  const actualConversionKgPerM =
    kgDeducted != null && Number.isFinite(meters) && meters > 0 ? conversionKgPerMFromMass(kgDeducted, meters) : null;
  const supplierConversionKgPerM = roundConv2(input.supplierConversionKgPerM);
  let variancePct = null;
  if (actualConversionKgPerM != null && supplierConversionKgPerM != null && supplierConversionKgPerM > 0) {
    variancePct = Math.round(((actualConversionKgPerM - supplierConversionKgPerM) / supplierConversionKgPerM) * 1000) / 10;
  }
  const maxRemoveKg = Number.isFinite(Number(input.maxRemoveKg)) ? Number(input.maxRemoveKg) : null;
  const impliedMetersFromSupplier =
    kgDeducted != null && supplierConversionKgPerM != null ? roundConv2(kgDeducted / supplierConversionKgPerM) : null;
  return {
    kgDeducted,
    actualConversionKgPerM,
    supplierConversionKgPerM,
    variancePct,
    maxRemoveKg,
    impliedMetersFromSupplier,
  };
}

/**
 * @param {object} payload
 * @param {{ maxRemoveKg?: number; supplierConversionKgPerM?: number }} [opts]
 */
export function validateCoilDamagePayload(payload = {}, opts = {}) {
  const coilNo = String(payload.coilNo ?? payload.coil_no ?? '').trim();
  const beforeKg = Number(payload.beforeKg ?? payload.before_kg);
  const afterKg = Number(payload.afterKg ?? payload.after_kg);
  const meters = Number(payload.meters ?? payload.metersDamaged ?? payload.meters_damaged);
  const note = String(payload.note ?? payload.storekeeperRemark ?? payload.storekeeper_remark ?? '').trim();
  const returnDisposition = String(payload.returnDisposition ?? payload.return_disposition ?? 'offcut_pool').trim();

  if (!coilNo) return { ok: false, error: 'Coil number is required.' };
  if (!Number.isFinite(beforeKg) || beforeKg <= 0) {
    return { ok: false, error: 'Before kg must be greater than 0.' };
  }
  if (!Number.isFinite(afterKg) || afterKg < 0) {
    return { ok: false, error: 'After kg is required (0 if no good steel remains on the roll).' };
  }
  if (afterKg >= beforeKg - 1e-6) {
    return { ok: false, error: 'After kg must be less than before kg — steel was removed from the coil.' };
  }
  if (!Number.isFinite(meters) || meters <= 0) {
    return { ok: false, error: 'Damaged metres must be greater than 0.' };
  }
  if (note.length < 8) {
    return { ok: false, error: 'Enter a damage note (at least 8 characters) for the audit trail.' };
  }
  if (returnDisposition !== 'offcut_pool' && returnDisposition !== 'scrap') {
    return { ok: false, error: 'Disposition must be offcut pool (reusable) or scrap (reject).' };
  }

  const kgDeducted = beforeKg - afterKg;
  const maxRemove = Number(opts.maxRemoveKg);
  if (Number.isFinite(maxRemove) && kgDeducted > maxRemove + 1e-6) {
    return {
      ok: false,
      error: `Cannot remove more than ${maxRemove.toFixed(2)} kg (unreserved balance on this coil).`,
    };
  }

  return {
    ok: true,
    kgDeducted,
    preview: coilDamagePreview({
      beforeKg,
      afterKg,
      meters,
      supplierConversionKgPerM: opts.supplierConversionKgPerM,
      maxRemoveKg: maxRemove,
    }),
  };
}

/**
 * @param {object} incident
 * @returns {boolean}
 */
export function isCoilDamageIncident(incident) {
  return COIL_DAMAGE_INCIDENT_TYPES.has(String(incident?.incidentType ?? incident?.incident_type ?? '').trim());
}

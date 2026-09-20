/**
 * Plain-language stain screens for Sales, Store, Production, and Reports.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/stainMaterialUi.js
 * Wire these strings/helpers so staff never see codes like coil_stain or stain_meter.
 */
import { formatNgn } from './formatNgn.js';
import {
  isStainInventoryModel,
  isStainMaterialTypeId,
  STAIN_FLOOR_DISCOUNT_NGN,
  STAIN_INCIDENT_TYPE,
  STAIN_INVENTORY_MODEL,
  STAIN_MATERIAL_TYPE_ID,
} from './stainMaterialPolicy.js';

export const STAIN_TYPE_LABEL = 'Stain';

export const STAIN_TYPE_HELP =
  'Damaged or stained steel sold cheaper than a good coil. Pick the same colour, gauge, and profile as the good material.';

export function stainFloorFieldLabel() {
  return `Stain floor (normal price − ${formatNgn(STAIN_FLOOR_DISCOUNT_NGN)} per metre)`;
}

/**
 * @param {number | null | undefined} stainFloorNgn
 * @param {number | null | undefined} [parentFloorNgn]
 */
export function stainFloorCaption(stainFloorNgn, parentFloorNgn) {
  const stain = formatNgn(stainFloorNgn);
  if (parentFloorNgn != null && Number(parentFloorNgn) > 0) {
    return `Sell at ${stain} per metre. That is ${formatNgn(STAIN_FLOOR_DISCOUNT_NGN)} below the normal ${formatNgn(parentFloorNgn)} floor — no extra approval at this price.`;
  }
  return `Sell at ${stain} per metre (₦1,000 below the normal floor). Quoting this price does not need a price exception.`;
}

export function stainProfileFieldHelp() {
  return 'Use the same profile as the good coil (for example Longspan). This sets the stain price from that material’s workbook.';
}

export const STAIN_QUOTATION_STEPS = [
  { step: 1, title: 'Type of material', body: 'Choose Stain.' },
  { step: 2, title: 'Colour, gauge, profile', body: 'Match the stained steel you will sell (same as the parent coil).' },
  { step: 3, title: 'Price', body: 'The stain floor is already ₦1,000 cheaper. Only go lower if a manager approves.' },
];

export function stainStockCheckCopy() {
  return {
    tabLabel: 'Stain stock',
    pageTitle: 'Stain in the yard',
    pageHelp: 'These metres were cut from stained coils. Sell them as Type = Stain. Good steel on the same coil is still normal stock.',
    columns: {
      spec: 'Colour / gauge',
      source: 'From (good material)',
      meters: 'Metres left',
      kg: 'Kg left',
      coil: 'Coil',
      lot: 'Ticket',
    },
    emptyTitle: 'No stain in the yard yet',
    emptyBody:
      'When a coil has a stained section, Store records “Stain on coil”. After the branch manager approves, those metres appear here.',
    emptyAction: 'Operations → Material exceptions → Stain on coil',
    unitMeters: 'm',
    unitKg: 'kg',
  };
}

export function stainInventoryEmptyState() {
  const c = stainStockCheckCopy();
  return { title: c.emptyTitle, body: c.emptyBody, action: c.emptyAction };
}

/**
 * @param {object} [lot]
 */
export function formatStainLotDisplay(lot = {}) {
  const colour = String(lot.colour || '').trim() || '—';
  const gauge = String(lot.gaugeLabel || '').trim() || '—';
  const source = String(lot.sourceMaterialTypeName || '').trim();
  const m = Number(lot.metersAvailable ?? lot.estMeters) || 0;
  const kg = Number(lot.kgBooked ?? lot.kg) || 0;
  const coil = String(lot.coilNo || '').trim();
  const mLabel = `${m.toLocaleString('en-NG', { maximumFractionDigits: 1 })} m`;
  const kgBit = kg > 0 ? ` · ${kg.toLocaleString('en-NG', { maximumFractionDigits: 1 })} kg` : '';
  return {
    displayTitle: `Stain · ${colour} · ${gauge}`,
    displaySpec: [source, colour, gauge].filter((x) => x && x !== '—').join(' · ') || `${colour} · ${gauge}`,
    displayStock: `${mLabel} remaining${kgBit}`,
    displayOrigin: coil ? `Cut from coil ${coil}` : 'Yard stain stock',
    displayHint: coil
      ? `${mLabel} of stained ${source || 'steel'} from coil ${coil}. Quote Type = Stain.`
      : `${mLabel} of stained ${source || 'steel'} in the yard. Quote Type = Stain.`,
  };
}

function metersLabel(n) {
  return `${(Number(n) || 0).toLocaleString('en-NG', { maximumFractionDigits: 1 })} m`;
}

/**
 * Attach display* fields so the SPA can render cards without extra mapping.
 * @param {{ lots?: object[]; bySpec?: object[]; totals?: object } | null | undefined} snapshot
 */
export function decorateStainInventoryForUi(snapshot) {
  const lots = (snapshot?.lots || []).map((lot) => ({ ...lot, ...formatStainLotDisplay(lot) }));
  const bySpec = (snapshot?.bySpec || []).map((row) => ({ ...row, ...formatStainLotDisplay(row) }));
  const totals = snapshot?.totals || { lotCount: 0, metersAvailable: 0, kgBooked: 0 };
  const n = Number(totals.lotCount) || lots.length;
  const m = Number(totals.metersAvailable) || 0;
  return {
    ...snapshot,
    lots,
    bySpec,
    totals: {
      ...totals,
      displaySummary:
        n <= 0
          ? 'No stain metres in the yard'
          : `${n} stain ${n === 1 ? 'lot' : 'lots'} · ${metersLabel(m)} ready to sell`,
    },
    howto: stainStockCheckCopy().pageHelp,
  };
}

export function stainProductionCopy() {
  return {
    startWithoutCoil:
      'You can start this stain job without a coil. Finish it by picking stain metres from the yard, or add a matching coil if you will run stained steel still on a roll.',
    allocateCoilHelp:
      'Optional. Put a matching coil here only if the stained steel is still on that roll. Otherwise leave coils empty and use yard stain stock when you complete.',
    completeFromYard:
      'Pick the stain tickets that match this colour and gauge. Those metres leave stain stock and become this job’s output.',
    completeFromCoil: 'This job has a coil. Produce as usual — stained steel on the roll is the material for this order.',
    missingYardStock:
      'Pick stain metres from the yard (stained steel already cut), or put a matching coil on this job first.',
  };
}

export const STAIN_COMPLETE_NEEDS_YARD_STOCK = stainProductionCopy().missingYardStock;

export function stainIncidentTypeOptions() {
  return [
    {
      value: STAIN_INCIDENT_TYPE,
      label: 'Stain on coil',
      help: 'Cut out the stained section. Good steel stays on the coil — and on the job if that coil is already running.',
    },
    {
      value: 'production_error',
      label: 'Production error',
      help: 'Trim or mistake on a job. Goes to generic offcut, not stain sales.',
    },
    {
      value: 'yard_offcut',
      label: 'Yard offcut',
      help: 'Spare / scratch pieces for other jobs. Not sold as Stain.',
    },
    {
      value: 'customer_return',
      label: 'Customer return',
      help: 'Returned sheets. Choose sellable stock or offcut.',
    },
    {
      value: 'supplier_defect',
      label: 'Supplier defect',
      help: 'Fault on a received coil. Optional kg remove.',
    },
  ];
}

export function stainIncidentTypeLabel(incidentType) {
  const hit = stainIncidentTypeOptions().find((o) => o.value === String(incidentType || '').trim());
  return hit?.label || String(incidentType || '').trim() || 'Material exception';
}

export function stainDamageFormCopy() {
  return {
    title: 'Stain on coil',
    help: 'Weigh the coil before and after you cut the stained band. Enter the stained metres. If this coil is already on a job, the good remainder stays on that job.',
    beforeKg: 'Weight before cut (kg)',
    afterKg: 'Weight after cut (kg)',
    meters: 'Stained metres cut out',
    jobField: 'Production job (if this coil is running)',
    jobHelp: 'Needed when the stained steel was already booked for a job. Leave blank if the coil is free stock.',
    submit: 'Send to branch manager',
  };
}

export const STAIN_RESERVED_KG_NEEDS_JOB =
  'This stain is on steel already booked for a job. Choose that production job so the good metres stay on the run and only the stained metres become stain stock.';

/**
 * Stock-check / quotation: whether the header is Stain.
 * @param {{ materialTypeId?: string; inventoryModel?: string } | string | null | undefined} headerOrId
 */
export function headerIsStainMaterial(headerOrId) {
  if (headerOrId && typeof headerOrId === 'object') {
    return (
      isStainMaterialTypeId(headerOrId.materialTypeId ?? headerOrId.material_type_id) ||
      isStainInventoryModel(headerOrId.inventoryModel ?? headerOrId.inventory_model)
    );
  }
  return isStainMaterialTypeId(headerOrId) || isStainInventoryModel(headerOrId);
}

export function stainReportSectionTitle() {
  return 'Stain stock (damaged steel for sale)';
}

export { STAIN_MATERIAL_TYPE_ID, STAIN_INVENTORY_MODEL, STAIN_INCIDENT_TYPE, STAIN_FLOOR_DISCOUNT_NGN };

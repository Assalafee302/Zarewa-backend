/** Mirrors `src/Data/lagacyCuttingListDemo.js` for Node seed (no Vite). */

const ROOF = [
  [9.9, 30],
  [9.8, 2],
  [9.2, 2],
  [8.9, 18],
  [8.3, 2],
  [7.9, 2],
  [7.4, 1],
  [7.1, 2],
  [6.9, 29],
  [6.85, 40],
  [6.8, 28],
  [6.7, 4],
  [6.5, 1],
  [6.3, 1],
  [6.1, 4],
  [5.95, 35],
  [5.7, 1],
  [5.6, 26],
  [5.1, 1],
  [5.0, 2],
  [4.95, 1],
  [4.9, 1],
  [4.8, 4],
  [4.65, 15],
  [4.6, 5],
  [4.5, 14],
  [4.4, 5],
  [4.2, 1],
  [4.1, 3],
  [3.4, 1],
  [3.3, 2],
  [3.2, 1],
];

export const LAGACY_LINES_JSON = {
  materialGauge: '0.70mm',
  materialColor: 'P RED',
  materialDesign: 'Longspan (Indus6)',
  products: [
    { id: 'lag-p1', name: 'Roofing sheet', qty: '1888.85', unitPrice: '12000' },
    { id: 'lag-p2', name: 'Flat sheet', qty: '132.5', unitPrice: '12000' },
    { id: 'lag-p3', name: 'Bending', qty: '1', unitPrice: '7500' },
  ],
  accessories: [
    { id: 'lag-a1', name: 'Silicon tube', qty: '4', unitPrice: '3500' },
    { id: 'lag-a2', name: 'Rivet pins', qty: '4', unitPrice: '6500' },
    { id: 'lag-a3', name: 'Tapping screw', qty: '12000', unitPrice: '120' },
  ],
  services: [
    { id: 'lag-s1', name: 'Installation', qty: '1', unitPrice: '1250000' },
    { id: 'lag-s2', name: 'Transportation', qty: '1', unitPrice: '100000' },
  ],
};

function buildCuttingLines() {
  const lines = [];
  let n = 0;
  for (const [lengthM, sheets] of ROOF) {
    n += 1;
    const totalM = Math.round(sheets * lengthM * 100) / 100;
    lines.push({ lineNo: n, lineType: 'Roof', sheets, lengthM, totalM });
  }
  lines.push({
    lineNo: n + 1,
    lineType: 'Flatsheet',
    sheets: 1,
    lengthM: 132.5,
    totalM: 132.5,
  });
  return lines;
}

export const LAGACY_CUTTING_LINES = buildCuttingLines();

const sheetsSum = LAGACY_CUTTING_LINES.reduce((s, l) => s + l.sheets, 0);
const metersSum = LAGACY_CUTTING_LINES.reduce((s, l) => s + l.totalM, 0);

export const LAGACY_CUTTING_LIST_SEED = {
  id: 'CL-2026-1592',
  customerID: 'CUS-NDA',
  customer: 'NDA',
  quotationRef: 'QT-2026-027',
  productID: 'FG-101',
  productName: 'Longspan (Indus6) · P RED · 0.70mm',
  date: '11 Aug',
  dateISO: '2026-08-11',
  sheetsToCut: sheetsSum,
  totalMeters: metersSum,
  total: `${metersSum.toLocaleString('en-NG', { maximumFractionDigits: 2 })} m`,
  status: 'Waiting',
  machineName: 'Machine 01 (Longspan)',
  operatorName: '',
  productionRegistered: false,
  productionRegisterRef: '',
  handledBy: 'Auwal Idris',
  lines: LAGACY_CUTTING_LINES,
};

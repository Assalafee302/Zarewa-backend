#!/usr/bin/env node
/**
 * QA mega stress: 20 customers, 100 quotations (Jan–Apr 2026), linked receipts, cutting lists,
 * production, refunds (apply / approve / pay mix), 10 suppliers with coil/stone/accessory paths,
 * partial GRN / in-transit / transport / supplier payments, expenses (all categories × 3),
 * payment requests (approve/pay mix), management review (approve_production / flag),
 * cancelled quotations & POs, coil scrap, material requests, coil requests, Office convert threads.
 *
 * Requires API with admin (finance.post, finance.pay, production.manage, inventory.receive, office.use, …).
 * Prefer dedicated DB: ZAREWA_DB=data/stress.sqlite — see docs/STRESS-DEDICATED-DB.md
 *
 *   npm run server
 *   npm run stress:qa-mega
 *
 * Env: STRESS_API_URL, STRESS_USERNAME, STRESS_PASSWORD, STRESS_RUN_KEY, STRESS_BRANCH_ID, STRESS_VIEW_ALL_BRANCHES
 *
 * Throttling (server enforces a rolling ledger POST limit per user; see `ZAREWA_LEDGER_POST_MAX` in
 * `docs/ENVIRONMENT.md`): defaults add ~1.45s after each customer receipt and expense payment request pay.
 * Override with MEGA_LEDGER_GAP_MS (0 to disable only if the API is started with ZAREWA_TEST_SKIP_RATE_LIMIT=1).
 * MEGA_QUOTE_STEP_MS adds a short pause between quote chains (default 120ms).
 *
 * Scale: `MEGA_QUOTE_COUNT` (default 100), `MEGA_CUSTOMER_COUNT` (default 20). End-of-run invariant checks
 * require ≥50% successful quote chains and non-negative coil quantities in bootstrap.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPENSE_CATEGORY_OPTIONS } from '../shared/expenseCategories.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_BASE = (process.env.STRESS_API_URL || process.env.STRESS_BASE_URL || 'http://127.0.0.1:8787').replace(
  /\/$/,
  ''
);
const UI_BASE = (process.env.STRESS_UI_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');

const RUN_KEY_RAW = process.env.STRESS_RUN_KEY || `MEGA-${Date.now().toString(36)}`;
const RUN_KEY = String(RUN_KEY_RAW).replace(/[^A-Za-z0-9_-]/g, '');

const SUPPLIER_KG_PER_M_REF = 3000 / 1327;
/** Must match `COIL_TAIL_FINISH_MAX_KG` in `server/productionTraceability.js` (tail / spool acknowledgement). */
const COIL_TAIL_FINISH_MAX_KG = 85;

const N_CUSTOMERS = Math.max(1, Math.min(50, Number(process.env.MEGA_CUSTOMER_COUNT) || 20));
const N_QUOTES = Math.max(1, Math.min(500, Number(process.env.MEGA_QUOTE_COUNT) || 100));
const RECEIPT_FRAC = 0.8;
const CUTTING_OF_RECEIPTED_FRAC = 0.8;
const PRODUCE_OF_CUTTING_FRAC = 0.8;
const REFUND_PAPER_FRAC = 0.9;
const REFUND_APPLY_OF_PAPER_FRAC = 0.8;
const REFUND_APPROVE_OF_APPLIED_FRAC = 0.69;
const REFUND_PAY_OF_APPROVED_FRAC = 0.4;
const EXPENSE_APPROVE_FRAC = 0.8;
const EXPENSE_PAY_OF_APPROVED_FRAC = 0.6;

/** Ledger POST routes share a 45/min per-user bucket — stay under it for long runs. */
const LEDGER_GAP_MS = Math.max(0, Number(process.env.MEGA_LEDGER_GAP_MS) || 1450);
const QUOTE_STEP_MS = Math.max(0, Number(process.env.MEGA_QUOTE_STEP_MS) || 120);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashToInt(value) {
  let h = 0;
  const s = String(value);
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const RUN_PHONE_BASE = String(hashToInt(RUN_KEY) % 100000).padStart(5, '0');

function pctGate(seed, thresholdPct) {
  const v = (hashToInt(String(seed)) % 1000) / 1000;
  return v < thresholdPct;
}

async function loginWithCredentials(username, password) {
  const r = await fetch(`${API_BASE}/api/session/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`login ${username} ${r.status} ${await r.text()}`);
  const rawSetCookie = r.headers.get('set-cookie') || '';
  const sessionCookie = (rawSetCookie.match(/zarewa_session=[^;]+/) || [''])[0];
  const csrfCookie = (rawSetCookie.match(/zarewa_csrf=[^;]+/) || [''])[0];
  const cookie = [sessionCookie, csrfCookie].filter(Boolean).join('; ');
  const csrfToken = (csrfCookie.split('=')[1] || '').trim();
  if (!sessionCookie) throw new Error('no session cookie');
  if (!csrfToken) throw new Error('no csrf token');
  return { cookie, csrfToken };
}

async function login() {
  return loginWithCredentials(process.env.STRESS_USERNAME || 'admin', process.env.STRESS_PASSWORD || 'Admin@123');
}

async function api(path, opts = {}) {
  const { method = 'GET', body, session } = opts;
  const sessionCookie = opts.sessionCookie ?? session?.cookie;
  const csrfToken = opts.csrfToken ?? session?.csrfToken;
  const isWrite = String(method || 'GET').toUpperCase() !== 'GET';
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      ...(isWrite && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { _raw: text };
  }
  return { ok: r.ok, status: r.status, data };
}

async function setWorkspace(session, { currentBranchId, viewAllBranches } = {}) {
  if (currentBranchId == null && viewAllBranches === undefined) return;
  const r = await api('/api/session/workspace', {
    method: 'PATCH',
    session,
    body: {
      ...(currentBranchId != null ? { currentBranchId } : {}),
      ...(viewAllBranches !== undefined ? { viewAllBranches: Boolean(viewAllBranches) } : {}),
    },
  });
  if (!r.ok || !r.data?.ok) {
    throw new Error(`workspace: ${r.status} ${JSON.stringify(r.data)}`);
  }
  return r.data;
}

function dateIsoForIndex(i) {
  const t0 = new Date('2026-01-06T12:00:00.000Z').getTime();
  const t1 = new Date('2026-04-28T12:00:00.000Z').getTime();
  const span = t1 - t0;
  const t = t0 + Math.floor((span * i) / Math.max(1, N_QUOTES - 1));
  return new Date(t).toISOString().slice(0, 10);
}

function plannedMetersFromCuttingLines(lines) {
  return lines.reduce((sum, row) => sum + Number(row.sheets) * Number(row.lengthM), 0);
}

function cuttingLinesVariant(i) {
  const patterns = [
    [{ sheets: 6, lengthM: 3.2 }],
    [{ sheets: 4, lengthM: 4.5 }],
    [
      { sheets: 3, lengthM: 2.8 },
      { sheets: 3, lengthM: 3.5 },
    ],
    [
      { sheets: 2, lengthM: 3.0 },
      { sheets: 2, lengthM: 3.6 },
      { sheets: 2, lengthM: 4.1 },
    ],
    [{ sheets: 10, lengthM: 2.5 }],
    [{ sheets: 8, lengthM: 5.0 }],
    [{ sheets: 5, lengthM: 4.0 }],
    [{ sheets: 12, lengthM: 3.3 }],
  ];
  return patterns[i % patterns.length];
}

function normalCompletionRows(allocRows, totalMeters) {
  const kgM = SUPPLIER_KG_PER_M_REF;
  const parts = Math.max(1, allocRows.length);
  const metersEach = totalMeters / parts;
  return allocRows.map((a) => {
    const opening = Number(a.openingWeightKg) || 2000;
    const consumed = kgM * metersEach;
    const closing = Math.max(0, opening - consumed);
    return {
      allocationId: a.id,
      coilNo: a.coilNo,
      closingWeightKg: closing,
      metersProduced: metersEach,
      ...(closing < COIL_TAIL_FINISH_MAX_KG ? { finishCoil: true } : {}),
    };
  });
}

const CUSTOMER_PROFILES = [
  { name: 'Alhaji Musa Roofing', city: 'Kano', tier: 'Wholesale', terms: 'Net 30', company: 'Musa & Sons Ltd' },
  { name: 'Chioma Eze — Site 14', city: 'Enugu', tier: 'Regular', terms: 'Due on receipt', company: 'Eze Construction' },
  { name: 'Ibrahim Dantata Works', city: 'Kaduna', tier: 'Retail', terms: 'Cash', company: 'IDW Projects' },
  { name: 'Fatima Bello (Government)', city: 'Abuja', tier: 'Wholesale', terms: 'Net 45', company: 'FB Public Works' },
  { name: 'Oluwaseun Adeyemi', city: 'Ibadan', tier: 'Regular', terms: 'Net 14', company: 'OA Sheetings' },
  { name: 'Emeka Okonkwo Traders', city: 'Onitsha', tier: 'Wholesale', terms: 'Net 30', company: 'EOT Holdings' },
  { name: 'Amina Sarki Retail', city: 'Sokoto', tier: 'Retail', terms: 'Cash', company: 'AS Retail' },
  { name: 'Tunde Bakare Sites', city: 'Lagos', tier: 'Regular', terms: 'Net 21', company: 'TB Sites Nig.' },
  { name: 'Halima Yusuf Estate', city: 'Jos', tier: 'Wholesale', terms: 'Net 30', company: 'HY Estate Dev.' },
  { name: 'Ngozi Okafor', city: 'Port Harcourt', tier: 'Retail', terms: 'Due on receipt', company: 'NO Homes' },
  { name: 'Garba Tanko Industrial', city: 'Kano', tier: 'Wholesale', terms: 'Net 60', company: 'GTI Roofing' },
  { name: 'Blessing Akpan', city: 'Uyo', tier: 'Regular', terms: 'Net 14', company: 'BA Contractors' },
  { name: 'Yakubu Mohammed', city: 'Maiduguri', tier: 'Retail', terms: 'Cash', company: 'YM Supplies' },
  { name: 'Rosemary Chukwu', city: 'Owerri', tier: 'Regular', terms: 'Net 30', company: 'RC Sheet Metal' },
  { name: 'Danjuma Gambo', city: 'Bauchi', tier: 'Wholesale', terms: 'Net 30', company: 'DG Agro-Sheds' },
  { name: 'Kemi Adesanya', city: 'Lagos', tier: 'Wholesale', terms: 'Net 21', company: 'KA Warehousing' },
  { name: 'Sani Lawal Government', city: 'Zaria', tier: 'Regular', terms: 'Net 45', company: 'SL Civic' },
  { name: 'Patience George', city: 'Calabar', tier: 'Retail', terms: 'Cash', company: 'PG Mini-mall' },
  { name: 'Victor Bassey', city: 'Akure', tier: 'Regular', terms: 'Net 14', company: 'VB Projects' },
  { name: 'Zainab Abubakar Exports', city: 'Kano', tier: 'Wholesale', terms: 'Net 30', company: 'ZAE Trading' },
];

async function ensureAccessoryCatalog(session) {
  await api('/api/setup/quote-items/SQI-005', {
    method: 'PATCH',
    session,
    body: {
      itemType: 'accessory',
      name: 'Tapping Screw',
      unit: 'box',
      defaultUnitPriceNgn: 0,
      active: true,
      sortOrder: 10,
    },
  });
}

async function seedCustomers(session) {
  const out = [];
  for (let i = 0; i < N_CUSTOMERS; i += 1) {
    const p = CUSTOMER_PROFILES[i % CUSTOMER_PROFILES.length];
    const customerID = `${RUN_KEY}-C-${String(i).padStart(2, '0')}`;
    const phoneDigits = `${RUN_PHONE_BASE.slice(0, 5)}${String(i).padStart(5, '0')}`;
    const phoneNumber = `+234${phoneDigits}`;
    const email = `mega.${RUN_KEY.toLowerCase()}.c${i}@stress.zarewa.test`;
    const r = await api('/api/customers', {
      method: 'POST',
      session,
      body: {
        customerID,
        name: `${p.name} [MEGA-${i}]`,
        phoneNumber,
        email,
        addressShipping: `${p.city} — MEGA stress yard ${i}`,
        addressBilling: p.city,
        status: 'Active',
        tier: p.tier,
        paymentTerms: p.terms,
        createdBy: 'QA mega',
        companyName: p.company,
        leadSource: 'mega-stress',
        preferredContact: i % 2 === 0 ? 'Phone' : 'WhatsApp',
        crmTags: ['mega-stress', RUN_KEY],
        crmProfileNotes: `Profile slot ${i}: ${p.city} / ${p.tier}`,
      },
    });
    if (!r.ok) throw new Error(`customer ${i}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`);
    out.push({ customerID, name: `${p.name} [MEGA-${i}]`, profile: p });
  }
  return out;
}

/**
 * Seeds 10 suppliers + mixed procurement; returns { coilNumbers: string[], supplierRows, poMeta }
 */
async function seedSuppliersAndProcurement(session, treasuryAccountId) {
  const coilNumbers = [];
  const supplierRows = [];
  const poMeta = [];

  for (let s = 0; s < 10; s += 1) {
    const supplierID = `${RUN_KEY}-SUP-${s}`;
    const supName = `MEGA Supplier ${s} — ${['Coils', 'Stone', 'Parts', 'Logistics', 'Multi'][s % 5]}`;
    const r = await api('/api/suppliers', {
      method: 'POST',
      session,
      body: {
        supplierID,
        name: supName,
        city: CUSTOMER_PROFILES[s % N_CUSTOMERS].city,
        paymentTerms: s % 2 === 0 ? 'Net 14' : 'Net 30',
        qualityScore: 60 + (s % 35),
        notes: `MEGA procurement family ${RUN_KEY}-${s}`,
      },
    });
    if (!r.ok) throw new Error(`supplier ${s}: ${r.status} ${JSON.stringify(r.data)}`);
    supplierRows.push({ supplierID: r.data?.supplierID || supplierID, name: supName });

    // Coil PO — vary full / partial GRN, transport, payments
    const slugCoil = `S${s}-coil`;
    const lineKey = `LK-${RUN_KEY}-${slugCoil}`;
    const coilA = `${RUN_KEY}-CL-${slugCoil}-A`;
    const coilB = `${RUN_KEY}-CL-${slugCoil}-B`;
    const orderDateISO = dateIsoForIndex(s * 9);
    const poID = `${RUN_KEY}-PO-${slugCoil}`;

    let r2 = await api('/api/purchase-orders', {
      method: 'POST',
      session,
      body: {
        poID,
        supplierID,
        supplierName: supName,
        orderDateISO,
        expectedDeliveryISO: '',
        status: s % 4 === 0 ? 'In Transit' : 'Approved',
        lines: [
          {
            lineKey,
            productID: 'COIL-ALU',
            productName: 'Aluminium coil (kg)',
            color: 'IV',
            gauge: '0.24',
            metersOffered: 1327,
            conversionKgPerM: SUPPLIER_KG_PER_M_REF,
            qtyOrdered: 8000,
            unitPricePerKgNgn: 100,
            unitPriceNgn: 100,
            qtyReceived: 0,
          },
        ],
      },
    });
    if (!r2.ok) throw new Error(`coil PO ${s}: ${r2.status} ${JSON.stringify(r2.data)}`);

    if (s % 3 === 0 && treasuryAccountId) {
      await api(`/api/purchase-orders/${encodeURIComponent(poID)}/link-transport`, {
        method: 'PATCH',
        session,
        body: {
          transportAgentId: `TA-${RUN_KEY}-${s}`,
          transportAgentName: `Haulier ${s}`,
          transportReference: `WB-${RUN_KEY}-${s}`,
          transportNote: 'MEGA in-transit link',
        },
      });
      await api(`/api/purchase-orders/${encodeURIComponent(poID)}/post-transport`, {
        method: 'POST',
        session,
        body: {
          treasuryAccountId,
          amountNgn: 50_000 + s * 5000,
          reference: `MEGA-HAUL-${RUN_KEY}-${s}`,
          dateISO: orderDateISO,
          note: 'MEGA transport post',
        },
      });
    }

    const partial = s % 5 === 1;
    const grnEntries = partial
      ? [
          {
            lineKey,
            productID: 'COIL-ALU',
            qtyReceived: 2800,
            weightKg: 2800,
            coilNo: coilA,
            location: `Bay MEGA-${s}`,
            gaugeLabel: '0.24mm',
            materialTypeName: 'Aluminium',
            supplierExpectedMeters: 1327,
            supplierConversionKgPerM: SUPPLIER_KG_PER_M_REF,
          },
        ]
      : [
          {
            lineKey,
            productID: 'COIL-ALU',
            qtyReceived: 3200,
            weightKg: 3200,
            coilNo: coilA,
            location: `Bay MEGA-${s}-A`,
            gaugeLabel: '0.24mm',
            materialTypeName: 'Aluminium',
            supplierExpectedMeters: 1327,
            supplierConversionKgPerM: SUPPLIER_KG_PER_M_REF,
          },
          {
            lineKey,
            productID: 'COIL-ALU',
            qtyReceived: 3200,
            weightKg: 3200,
            coilNo: coilB,
            location: `Bay MEGA-${s}-B`,
            gaugeLabel: '0.24mm',
            materialTypeName: 'Aluminium',
            supplierExpectedMeters: 1327,
            supplierConversionKgPerM: SUPPLIER_KG_PER_M_REF,
          },
        ];

    r2 = await api(`/api/purchase-orders/${encodeURIComponent(poID)}/grn`, {
      method: 'POST',
      session,
      body: {
        entries: grnEntries,
        supplierID,
        supplierName: supName,
      },
    });
    if (!r2.ok) throw new Error(`coil GRN ${s}: ${r2.status} ${JSON.stringify(r2.data)}`);

    for (const e of grnEntries) {
      coilNumbers.push(e.coilNo);
    }

    if (s % 7 === 0) {
      await api(`/api/coil-lots/${encodeURIComponent(coilA)}/scrap`, {
        method: 'POST',
        session,
        body: {
          kg: 25 + s,
          reason: 'Damage',
          note: `MEGA edge damage s${s}`,
          dateISO: orderDateISO,
          creditScrapInventory: true,
          scrapProductID: 'SCRAP-COIL',
        },
      });
    }

    if (treasuryAccountId) {
      if (s % 3 === 0) {
        await api(`/api/purchase-orders/${encodeURIComponent(poID)}/supplier-payment`, {
          method: 'POST',
          session,
          body: {
            amountNgn: 900_000 + s * 20_000,
            note: `MEGA full-ish pay ${s}`,
            treasuryAccountId,
            reference: `MEGA-SUPPAY-F-${RUN_KEY}-${s}`,
            dateISO: orderDateISO,
          },
        });
      } else if (s % 3 === 1) {
        await api(`/api/purchase-orders/${encodeURIComponent(poID)}/supplier-payment`, {
          method: 'POST',
          session,
          body: {
            amountNgn: 120_000 + s * 1000,
            note: `MEGA partial pay ${s}`,
            treasuryAccountId,
            reference: `MEGA-SUPPAY-P-${RUN_KEY}-${s}`,
            dateISO: orderDateISO,
          },
        });
      }
    }

    poMeta.push({ poID, kind: 'coil', supplierID, partial });

    // Stone + accessory mix on even suppliers
    if (s % 2 === 0) {
      const ens = await api('/api/inventory/ensure-stone-product', {
        method: 'POST',
        session,
        body: {
          designLabel: `MegaStone${s}`,
          colourLabel: 'Slate',
          gaugeLabel: '0.45mm',
        },
      });
      const stonePid = ens.data?.productId;
      if (stonePid && ens.ok) {
        const stPo = `${RUN_KEY}-PO-ST-${s}`;
        const lk = `L-ST-${RUN_KEY}-${s}`;
        const spo = await api('/api/purchase-orders', {
          method: 'POST',
          session,
          body: {
            poID: stPo,
            supplierID,
            supplierName: supName,
            orderDateISO,
            status: s % 6 === 0 ? 'In Transit' : 'Approved',
            lines: [
              {
                lineKey: lk,
                productID: stonePid,
                productName: `Mega stone ${s}`,
                color: 'Slate',
                gauge: '0.45mm',
                metersOffered: 40,
                conversionKgPerM: null,
                unitPricePerKgNgn: null,
                unitPriceNgn: 1800,
                qtyOrdered: 40,
                qtyReceived: 0,
              },
            ],
          },
        });
        if (spo.ok) {
          const recv = s % 6 === 0 ? 18 : 40;
          await api(`/api/purchase-orders/${encodeURIComponent(stPo)}/grn`, {
            method: 'POST',
            session,
            body: {
              entries: [{ lineKey: lk, productID: stonePid, qtyReceived: recv, location: 'Stone MEGA' }],
              supplierID,
              supplierName: supName,
            },
          });
          poMeta.push({ poID: stPo, kind: 'stone', supplierID });
        }
      }

      const accPid = 'ACC-TAPPING-SCREW-PCS';
      const apo = `${RUN_KEY}-PO-ACC-${s}`;
      const alk = `L-ACC-${RUN_KEY}-${s}`;
      const accPo = await api('/api/purchase-orders', {
        method: 'POST',
        session,
        body: {
          poID: apo,
          supplierID,
          supplierName: supName,
          orderDateISO,
          status: 'In Transit',
          lines: [
            {
              lineKey: alk,
              productID: accPid,
              productName: 'Tapping screws',
              color: '',
              gauge: '',
              metersOffered: null,
              conversionKgPerM: null,
              unitPricePerKgNgn: 20,
              unitPriceNgn: 20,
              qtyOrdered: 400,
              qtyReceived: 0,
            },
          ],
        },
      });
      if (accPo.ok) {
        if (s % 4 !== 0) {
          await api(`/api/purchase-orders/${encodeURIComponent(apo)}/grn`, {
            method: 'POST',
            session,
            body: {
              entries: [{ lineKey: alk, productID: accPid, qtyReceived: 400, location: 'Parts MEGA' }],
              supplierID,
              supplierName: supName,
            },
          });
        }
        poMeta.push({ poID: apo, kind: 'accessory', supplierID, inTransitOnly: s % 4 === 0 });
      }
    }

    if (s === 9 && poMeta.length) {
      const cancelPo = poMeta.find((p) => p.kind === 'accessory' && p.inTransitOnly);
      if (cancelPo) {
        await api(`/api/purchase-orders/${encodeURIComponent(cancelPo.poID)}/status`, {
          method: 'PATCH',
          session,
          body: { status: 'Cancelled' },
        });
      }
    }
  }

  return { coilNumbers, supplierRows, poMeta };
}

function quotationLinesForIndex(i) {
  const baseProducts = [
    [{ name: 'Roofing Sheet', qty: '12', unitPrice: '11500' }],
    [
      { name: 'Roofing Sheet', qty: '8', unitPrice: '11800' },
      { name: 'Ridge', qty: '2', unitPrice: '4500' },
    ],
    [{ name: 'Roofing Sheet', qty: '20', unitPrice: '10200' }],
    [{ name: 'Roofing Sheet', qty: '6', unitPrice: '12500' }],
  ];
  const products = baseProducts[i % baseProducts.length];
  const accessories =
    i % 4 === 0 ? [{ id: 'SQI-005', name: 'Tapping Screw', qty: '3', unitPrice: '6500' }] : [];
  const services =
    i % 5 === 0
      ? [{ name: 'Site delivery (local)', qty: '1', unitPrice: '25000' }]
      : i % 7 === 2
        ? [
            { name: 'Installation assist', qty: '2', unitPrice: '8000' },
            { name: 'Crane hire', qty: '1', unitPrice: '40000' },
          ]
        : [];
  return { products, accessories, services };
}

function designsForIndex(i) {
  const designs = ['Longspan', 'Classic', 'Longspan'];
  return designs[i % designs.length];
}

async function seedExpenses(session, treasuryAccountId) {
  const rows = [];
  let seq = 0;
  const boot = await api('/api/bootstrap', { session });
  const accounts = boot.data?.treasuryAccounts || [];
  const [a0, a1] = accounts;

  for (const cat of EXPENSE_CATEGORY_OPTIONS) {
    for (let k = 0; k < 3; k += 1) {
      const expenseID = `EXP-${RUN_KEY}-${seq}`;
      const paymentRequestId = `PREQ-${RUN_KEY}-${seq}`;
      const dateISO = dateIsoForIndex((seq * 17) % N_QUOTES);
      const amt = 12_000 + (seq % 50) * 800;
      const r = await api('/api/expenses', {
        method: 'POST',
        session,
        body: {
          expenseID,
          expenseType: `MEGA ${cat.slice(0, 24)} #${k}`,
          amountNgn: amt,
          date: dateISO,
          category: cat,
          paymentMethod: 'Transfer',
          treasuryAccountId,
          reference: `MEGA-EXP-${RUN_KEY}-${seq}`,
        },
      });
      if (!r.ok) throw new Error(`expense ${seq}: ${r.status} ${JSON.stringify(r.data)}`);

      const pr = await api('/api/payment-requests', {
        method: 'POST',
        session,
        body: {
          expenseID,
          requestID: paymentRequestId,
          amountRequestedNgn: amt,
          requestDate: dateISO,
          description: `MEGA PR ${cat} ${k}`,
        },
      });
      if (!pr.ok) throw new Error(`payment-request ${seq}: ${pr.status} ${JSON.stringify(pr.data)}`);

      const approve = pctGate(`ea-${seq}`, EXPENSE_APPROVE_FRAC);
      await api(`/api/payment-requests/${encodeURIComponent(paymentRequestId)}/decision`, {
        method: 'POST',
        session,
        body: approve
          ? { status: 'Approved', note: `MEGA ok ${seq}` }
          : { status: 'Rejected', note: `MEGA reject ${seq}` },
      });

      if (approve && treasuryAccountId && pctGate(`ep-${seq}`, EXPENSE_PAY_OF_APPROVED_FRAC)) {
        const payLines = a1
          ? (() => {
              const p1 = Math.floor(amt * 0.55);
              return [
                { treasuryAccountId: a0.id, amountNgn: p1, reference: `MEGA-P1-${seq}` },
                { treasuryAccountId: a1.id, amountNgn: amt - p1, reference: `MEGA-P2-${seq}` },
              ];
            })()
          : [{ treasuryAccountId: a0.id, amountNgn: amt, reference: `MEGA-PAY-${seq}` }];
        await api(`/api/payment-requests/${encodeURIComponent(paymentRequestId)}/pay`, {
          method: 'POST',
          session,
          body: { note: `MEGA payout ${seq}`, paymentLines: payLines },
        });
        if (LEDGER_GAP_MS) await sleep(LEDGER_GAP_MS);
      }

      rows.push({ expenseID, paymentRequestId, category: cat, seq });
      seq += 1;
    }
  }
  return rows;
}

async function officeThreadsSample(session) {
  const converted = [];
  for (let t = 0; t < 6; t += 1) {
    const cr = await api('/api/office/threads', {
      method: 'POST',
      session,
      body: {
        subject: `MEGA office memo ${RUN_KEY} ${t}`,
        body: `Requesting logistics payment slot ${t}. Ref ${RUN_KEY}.`,
        kind: 'memo',
      },
    });
    if (!cr.ok) continue;
    const tid = cr.data?.thread?.id;
    if (!tid) continue;
    if (t % 2 === 0) {
      const conv = await api(`/api/office/threads/${encodeURIComponent(tid)}/convert-payment-request`, {
        method: 'POST',
        session,
        body: {
          requestDate: dateIsoForIndex(t * 11),
          description: `MEGA converted from thread ${t}`,
          requestReference: `MEGA-OFF-${RUN_KEY}-${t}`,
          expenseCategory: 'Logistics & haulage',
          lineItems: [{ item: `Haulage line ${t}`, unit: 1, unitPriceNgn: 18_000 + t * 1000 }],
        },
      });
      if (conv.ok) converted.push({ threadId: tid, requestID: conv.data?.requestID });
    } else {
      await api(`/api/office/threads/${encodeURIComponent(tid)}/messages`, {
        method: 'POST',
        session,
        body: { body: `Closed thread note MEGA ${t} — no conversion.` },
      });
    }
  }
  return converted;
}

async function materialAndCoilRequests(session) {
  const materialHits = [];
  for (let m = 0; m < 8; m += 1) {
    const r = await api('/api/material-requests', {
      method: 'POST',
      session,
      body: {
        requestCategory: 'raw_material',
        urgency: m % 3 === 0 ? 'high' : 'normal',
        summary: `MEGA MR ${RUN_KEY} ${m}`,
        note: 'Automated procurement test',
        requestedAtIso: `${dateIsoForIndex(m * 13)}T10:00:00.000Z`,
        lines: [
          {
            itemCategory: 'raw_material',
            gauge: '0.24',
            colour: 'IV',
            materialType: 'Aluminium',
            unit: 'kg',
            qtyRequested: 800 + m * 50,
            note: `MEGA coil need ${m}`,
          },
        ],
      },
    });
    materialHits.push({ ok: r.ok, status: r.status, id: r.data?.request?.id || r.data?.id });
  }
  const coilHits = [];
  for (let c = 0; c < 5; c += 1) {
    const r = await api('/api/coil-requests', {
      method: 'POST',
      session,
      body: {
        gauge: '0.24',
        colour: 'IV',
        materialType: 'Aluminium',
        requestedKg: 600 + c * 40,
        note: `MEGA coil-request ${RUN_KEY} ${c}`,
      },
    });
    const id = r.data?.row?.id || r.data?.id;
    if (r.ok && id && c % 2 === 0) {
      await api(`/api/coil-requests/${encodeURIComponent(id)}/acknowledge`, { method: 'PATCH', session });
    }
    coilHits.push({ ok: r.ok, id });
  }
  return { materialHits, coilHits };
}

async function safeOpeningKgForCoil(session, coilNo, cap = 2000) {
  const boot = await api('/api/bootstrap', { session });
  const lot = (boot.data?.coilLots || []).find((c) => String(c.coilNo || '').trim() === String(coilNo).trim());
  const w = Number(lot?.weightKg);
  if (!Number.isFinite(w) || w <= 0) return 0;
  return Math.min(cap, Math.max(100, Math.floor(w * 0.9)));
}

async function directInventoryReceipts(session) {
  await api('/api/inventory/stone-receipt', {
    method: 'POST',
    session,
    body: {
      designLabel: 'MegaDirect',
      colourLabel: 'Grey',
      gaugeLabel: '0.40mm',
      metresReceived: 22,
    },
  });
  await api('/api/inventory/accessory-receipt', {
    method: 'POST',
    session,
    body: { productID: 'ACC-TAPPING-SCREW-PCS', qtyReceived: 120 },
  });
}

async function runQuoteChain(session, i, customers, coilNumbers, treasuryAccountId, treasuryAltId) {
  const row = { i, ok: true, errors: [], ids: {} };
  const fail = (step, err) => {
    row.ok = false;
    row.errors.push({ step, error: String(err?.message || err) });
  };

  try {
    const cust = customers[i % N_CUSTOMERS];
    const dateISO = dateIsoForIndex(i);
    const coilNo = coilNumbers[i % coilNumbers.length];
    const coilB = coilNumbers[(i + 1) % coilNumbers.length];

    const cancelEarly = i % 19 === 7;
    const wantsReceipt = pctGate(`rc-${i}`, RECEIPT_FRAC);
    const payPattern = i % 5;
    const payFraction = payPattern === 0 ? 1 : payPattern === 1 ? 0.85 : payPattern === 2 ? 0.72 : payPattern === 3 ? 0.5 : 0.3;
    const needsManagerProd = payFraction < 0.7 && payFraction > 0;

    const lines = quotationLinesForIndex(i);
    const r = await api('/api/quotations', {
      method: 'POST',
      session,
      body: {
        customerID: cust.customerID,
        projectName: `MEGA project Q${i} ${RUN_KEY}`,
        dateISO,
        materialGauge: '0.24',
        materialColor: 'IV',
        materialDesign: designsForIndex(i),
        lines: {
          products: lines.products,
          accessories: lines.accessories,
          services: lines.services,
        },
      },
    });
    if (!r.ok) throw new Error(`quotation: ${r.status} ${JSON.stringify(r.data)}`);
    const quotationId = r.data.quotationId;
    const totalNgn = r.data.quotation.totalNgn;
    row.ids.quotationId = quotationId;

    await api(`/api/quotations/${encodeURIComponent(quotationId)}`, {
      method: 'PATCH',
      session,
      body: { status: 'Approved', customerFeedback: `MEGA approved Q${i}` },
    });

    if (i % 23 === 11) {
      await api('/api/management/review', {
        method: 'POST',
        session,
        body: {
          quotationId,
          decision: 'approve_production',
          reason: `MEGA early production gate Q${i}`,
        },
      });
    }

    if (cancelEarly) {
      await api(`/api/quotations/${encodeURIComponent(quotationId)}`, {
        method: 'PATCH',
        session,
        body: { status: 'Cancelled' },
      });
      row.cancelledEarly = true;
      return row;
    }

    let payAmount = 0;
    if (wantsReceipt && totalNgn > 0) {
      payAmount = Math.round(totalNgn * payFraction);
      if (payAmount > 0) {
        const receiptLines =
          treasuryAltId && i % 6 === 0
            ? (() => {
                const a = Math.floor(payAmount * 0.55);
                return [
                  { treasuryAccountId: treasuryAccountId, amountNgn: a, reference: `MEGA-RCP-A-${i}-${RUN_KEY}` },
                  {
                    treasuryAccountId: treasuryAltId,
                    amountNgn: payAmount - a,
                    reference: `MEGA-RCP-B-${i}-${RUN_KEY}`,
                  },
                ];
              })()
            : [{ treasuryAccountId: treasuryAccountId, amountNgn: payAmount, reference: `MEGA-RCP-${i}-${RUN_KEY}` }];
        const payMethod = i % 3 === 0 ? 'Transfer' : i % 3 === 1 ? 'POS' : 'Cash';
        const rcp = await api('/api/ledger/receipt', {
          method: 'POST',
          session,
          body: {
            customerID: cust.customerID,
            quotationId,
            amountNgn: payAmount,
            paymentMethod: payMethod,
            dateISO,
            bankReference: `MEGA-RCP-${i}-${RUN_KEY}`,
            paymentLines: receiptLines,
          },
        });
        if (!rcp.ok) throw new Error(`receipt: ${rcp.status} ${JSON.stringify(rcp.data)}`);
        if (LEDGER_GAP_MS) await sleep(LEDGER_GAP_MS);
      }
    }

    if (needsManagerProd) {
      await api('/api/management/review', {
        method: 'POST',
        session,
        body: {
          quotationId,
          decision: 'approve_production',
          reason: `MEGA manager gate for partial pay Q${i}`,
        },
      });
    }

    const cutEligible = wantsReceipt && payAmount > 0 && pctGate(`ct-${i}`, CUTTING_OF_RECEIPTED_FRAC);
    if (cutEligible) {
      const cutLines = cuttingLinesVariant(i);
      const plannedMeters = plannedMetersFromCuttingLines(cutLines);
      const cl = await api('/api/cutting-lists', {
        method: 'POST',
        session,
        body: {
          quotationRef: quotationId,
          customerID: cust.customerID,
          productID: 'FG-101',
          productName: 'Longspan thin',
          dateISO,
          machineName: `MEGA-Line-${(i % 4) + 1}`,
          operatorName: `MEGA Op ${i}`,
          lines: cutLines,
        },
      });
      if (!cl.ok) throw new Error(`cutting-list: ${cl.status} ${JSON.stringify(cl.data)}`);
      row.ids.cuttingListId = cl.data.id;

      const produce = pctGate(`pr-${i}`, PRODUCE_OF_CUTTING_FRAC);
      if (produce) {
        const oaPre = await safeOpeningKgForCoil(session, coilNo, 2000);
        const obPre =
          i % 9 === 0 && coilNo !== coilB ? await safeOpeningKgForCoil(session, coilB, 2000) : null;
        if (oaPre < 150 || (obPre != null && obPre < 150)) {
          row.skippedProduction = 'insufficient_coil_weight';
        } else {
          const pj = await api('/api/production-jobs', {
            method: 'POST',
            session,
            body: {
              cuttingListId: row.ids.cuttingListId,
              productID: 'FG-101',
              productName: 'Longspan thin',
              plannedMeters,
              plannedSheets: cutLines.reduce((s, ln) => s + Number(ln.sheets), 0),
              status: 'Planned',
            },
          });
          if (!pj.ok) throw new Error(`production-job: ${pj.status} ${JSON.stringify(pj.data)}`);
          row.ids.jobId = pj.data.jobID;

          const useDual = i % 9 === 0 && coilNo !== coilB;
          const oa = await safeOpeningKgForCoil(session, coilNo, 2000);
          const ob = useDual ? await safeOpeningKgForCoil(session, coilB, 2000) : null;
          const allocPayload = useDual
            ? [
                { coilNo, openingWeightKg: oa },
                { coilNo: coilB, openingWeightKg: ob },
              ]
            : [{ coilNo, openingWeightKg: oa }];

          let ar = await api(`/api/production-jobs/${encodeURIComponent(row.ids.jobId)}/allocations`, {
            method: 'POST',
            session,
            body: { allocations: allocPayload },
          });
          if (!ar.ok) throw new Error(`allocations: ${ar.status} ${JSON.stringify(ar.data)}`);

          ar = await api(`/api/production-jobs/${encodeURIComponent(row.ids.jobId)}/start`, {
            method: 'POST',
            session,
            body: { startedAtISO: `${dateISO}T08:00:00.000Z` },
          });
          if (!ar.ok) throw new Error(`start: ${ar.status} ${JSON.stringify(ar.data)}`);

          const list = await api(`/api/production-jobs/${encodeURIComponent(row.ids.jobId)}/coil-allocations`, {
            session,
          });
          const allocRows = list.data?.allocations || [];
          const completionPayload = normalCompletionRows(allocRows, plannedMeters);

          const conversionPreviewBody = { allocations: completionPayload };
          if (lines.accessories.length) {
            conversionPreviewBody.accessoriesSupplied = [
              { quoteLineId: 'SQI-005', name: 'Tapping Screw', suppliedQty: Number(lines.accessories[0].qty) || 1 },
            ];
          }
          await api(`/api/production-jobs/${encodeURIComponent(row.ids.jobId)}/conversion-preview`, {
            method: 'POST',
            session,
            body: conversionPreviewBody,
          });

          const completeBody = {
            completedAtISO: `${dateISO}T16:00:00.000Z`,
            allocations: completionPayload,
          };
          if (lines.accessories.length) {
            completeBody.accessoriesSupplied = [
              { quoteLineId: 'SQI-005', name: 'Tapping Screw', suppliedQty: Number(lines.accessories[0].qty) || 1 },
            ];
          }
          ar = await api(`/api/production-jobs/${encodeURIComponent(row.ids.jobId)}/complete`, {
            method: 'POST',
            session,
            body: completeBody,
          });
          if (!ar.ok) throw new Error(`complete: ${ar.status} ${JSON.stringify(ar.data)}`);
          if (ar.data?.managerReviewRequired) {
            const sign = await api(`/api/production-jobs/${encodeURIComponent(row.ids.jobId)}/manager-review-signoff`, {
              method: 'PATCH',
              session,
              body: { remark: `MEGA signoff Q${i}` },
            });
            if (!sign.ok) throw new Error(`manager-review: ${sign.status} ${JSON.stringify(sign.data)}`);
          }
        }
      }
    }

    if (wantsReceipt && payAmount > 0 && pctGate(`rfp-${i}`, REFUND_PAPER_FRAC)) {
      await api(`/api/refunds/intelligence?quotationRef=${encodeURIComponent(quotationId)}`, { session });
      if (pctGate(`rfa-${i}`, REFUND_APPLY_OF_PAPER_FRAC)) {
        const refundAmt = Math.min(totalNgn, Math.max(40_000, Math.floor(totalNgn * 0.1)));
        const refundID = `RF-${RUN_KEY}-Q${i}`;
        const fr = await api('/api/refunds', {
          method: 'POST',
          session,
          body: {
            customerID: cust.customerID,
            customer: cust.name,
            quotationRef: quotationId,
            refundID,
            reasonCategory: i % 2 === 0 ? 'Goodwill adjustment' : 'Pricing correction',
            reason: `MEGA refund application Q${i}`,
            amountNgn: refundAmt,
            calculationLines: [{ label: 'MEGA reversal', amountNgn: refundAmt }],
          },
        });
        if (fr.ok && fr.data?.refundID) {
          row.ids.refundId = fr.data.refundID;
          if (pctGate(`rfd-${i}`, REFUND_APPROVE_OF_APPLIED_FRAC)) {
            await api(`/api/refunds/${encodeURIComponent(row.ids.refundId)}/decision`, {
              method: 'POST',
              session,
              body: {
                status: 'Approved',
                approvalDate: dateISO,
                managerComments: 'MEGA approved',
                approvedAmountNgn: refundAmt,
              },
            });
            if (pctGate(`rfpay-${i}`, REFUND_PAY_OF_APPROVED_FRAC)) {
              const payR = await api(`/api/refunds/${encodeURIComponent(row.ids.refundId)}/pay`, {
                method: 'POST',
                session,
                body: { treasuryAccountId, reference: `MEGA-RFD-${i}-${RUN_KEY}` },
              });
              if (!payR.ok) throw new Error(`refund-pay: ${payR.status} ${JSON.stringify(payR.data)}`);
              if (LEDGER_GAP_MS) await sleep(LEDGER_GAP_MS);
            }
          } else {
            await api(`/api/refunds/${encodeURIComponent(row.ids.refundId)}/decision`, {
              method: 'POST',
              session,
              body: {
                status: 'Rejected',
                approvalDate: dateISO,
                managerComments: 'MEGA insufficient docs',
              },
            });
          }
        }
      }
    }

    if (i % 11 === 5 && row.ids.quotationId) {
      await api('/api/management/review', {
        method: 'POST',
        session,
        body: {
          quotationId: row.ids.quotationId,
          decision: 'flag',
          reason: `MEGA audit flag sample Q${i}`,
        },
      });
      row.flagged = true;
    }
  } catch (e) {
    fail('chain', e);
  }
  if (QUOTE_STEP_MS) await sleep(QUOTE_STEP_MS);
  return row;
}

async function assertMegaInvariants(session, quoteRows, seededCustomers) {
  const boot = await api('/api/bootstrap', { session });
  if (!boot.ok || !boot.data?.ok) {
    throw new Error(`Invariant bootstrap failed: ${boot.status} ${JSON.stringify(boot.data)}`);
  }
  const d = boot.data;
  const expectedIds = new Set((seededCustomers || []).map((c) => c.customerID));
  const bootCustomers = Array.isArray(d.customers) ? d.customers : [];
  let found = 0;
  for (const c of bootCustomers) {
    const id = c.customerID || c.customer_id;
    if (expectedIds.has(id)) found += 1;
  }
  if (found < expectedIds.size) {
    throw new Error(`Invariant: expected ${expectedIds.size} stress customers in bootstrap, found ${found}`);
  }
  const succeeded = quoteRows.filter((r) => r.ok).length;
  const minOk = Math.max(1, Math.floor(N_QUOTES * 0.5));
  if (succeeded < minOk) {
    throw new Error(`Invariant: too many quote failures (${N_QUOTES - succeeded} failed, need >=${minOk} ok)`);
  }
  const coils = Array.isArray(d.coilLots) ? d.coilLots : [];
  for (const cl of coils) {
    const rem = Number(cl.qtyRemaining ?? cl.qty_remaining);
    const res = Number(cl.qtyReserved ?? cl.qty_reserved);
    if (Number.isFinite(rem) && rem < -0.0001) {
      throw new Error(`Invariant: negative qtyRemaining on coil ${cl.coilNo}`);
    }
    if (Number.isFinite(res) && res < -0.0001) {
      throw new Error(`Invariant: negative qtyReserved on coil ${cl.coilNo}`);
    }
  }
  console.log(
    JSON.stringify(
      { phase: 'invariants', stressCustomersFound: found, quotesOk: succeeded, quotesTotal: N_QUOTES, coilRows: coils.length },
      null,
      2
    )
  );
}

async function main() {
  const t0 = Date.now();
  console.log(JSON.stringify({ phase: 'config', api: API_BASE, runKey: RUN_KEY }, null, 2));

  const session = await login();
  const branch = process.env.STRESS_BRANCH_ID;
  const viewAllRaw = process.env.STRESS_VIEW_ALL_BRANCHES;
  const viewAllBranches =
    viewAllRaw === undefined ? undefined : viewAllRaw === '1' || viewAllRaw === 'true' ? true : false;
  if (branch || viewAllBranches !== undefined) {
    const ws = await setWorkspace(session, { currentBranchId: branch, viewAllBranches });
    console.log(JSON.stringify({ phase: 'workspace', ...ws }, null, 2));
  }

  await ensureAccessoryCatalog(session);
  const boot = await api('/api/bootstrap', { session });
  const treasuryAccountId = boot.data?.treasuryAccounts?.[0]?.id;
  const treasuryAltId = boot.data?.treasuryAccounts?.[1]?.id;
  if (!treasuryAccountId) throw new Error('No treasury account in bootstrap');

  const customers = await seedCustomers(session);
  const { coilNumbers } = await seedSuppliersAndProcurement(session, treasuryAccountId);
  if (!coilNumbers.length) throw new Error('No coils in pool');

  const quoteRows = [];
  for (let i = 0; i < N_QUOTES; i += 1) {
    const row = await runQuoteChain(session, i, customers, coilNumbers, treasuryAccountId, treasuryAltId);
    quoteRows.push(row);
    const icon = row.ok ? 'ok' : 'FAIL';
    console.log(`${icon} quote ${i} ${row.errors.map((e) => e.error).join(' | ') || ''}`);
  }

  const expenseRows = await seedExpenses(session, treasuryAccountId);
  const office = await officeThreadsSample(session);
  const mr = await materialAndCoilRequests(session);
  await directInventoryReceipts(session);

  const failed = quoteRows.filter((r) => !r.ok);
  const outPath = join(__dirname, 'output', 'qa-operations-mega-report.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        api: API_BASE,
        ui: UI_BASE,
        runKey: RUN_KEY,
        customers: N_CUSTOMERS,
        quotations: N_QUOTES,
        quotesFailed: failed.length,
        expenseRequests: expenseRows.length,
        officeConverted: office.length,
        materialRequests: mr.materialHits.filter((x) => x.ok).length,
        coilRequests: mr.coilHits.filter((x) => x.ok).length,
        quoteRows,
        expenseSample: expenseRows.slice(0, 5),
        office,
        links: {
          sales: `${UI_BASE}/sales`,
          operations: `${UI_BASE}/operations`,
          finance: `${UI_BASE}/accounts`,
          officeDesk: `${UI_BASE}/office`,
        },
      },
      null,
      2
    ),
    'utf8'
  );

  const dash = await api('/api/dashboard/summary', { session });
  const rep = await api('/api/reports/summary', { session });
  console.log(
    JSON.stringify(
      {
        phase: 'summary',
        ms: Date.now() - t0,
        reportPath: outPath,
        dashboard_ok: dash.ok,
        reports_ok: rep.ok,
        quoteFailures: failed.length,
      },
      null,
      2
    )
  );

  try {
    await assertMegaInvariants(session, quoteRows, customers);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }

  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

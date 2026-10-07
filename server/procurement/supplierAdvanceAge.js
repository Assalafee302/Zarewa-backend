/**
 * Supplier advances (cash paid ahead of goods received) and how long they have sat.
 * Days outstanding run from the first payment to the as-of date.
 */

export const SUPPLIER_ADVANCE_STALE_DAYS = 30;

export function daysOutstanding(paidOn, asOf) {
  const from = String(paidOn || '').slice(0, 10);
  const to = String(asOf || '').slice(0, 10);
  const left = Date.parse(`${from}T00:00:00.000Z`);
  const right = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round((right - left) / 86_400_000);
}

function money(value) {
  return Math.round(Number(value) || 0);
}

function iso(value) {
  return String(value || '').slice(0, 10);
}

/**
 * Advances whose first payment is more than 30 days before asOf.
 * Advance = paid − goods received, using the same treasury and receipt sources as the month-end pack.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [branchScope]
 * @param {string} [asOf]
 */
export function listStaleSupplierAdvances(db, branchScope = 'ALL', asOf = '') {
  const day = iso(asOf) || new Date().toISOString().slice(0, 10);
  if (!db) return [];
  let pos = [];
  try {
    const branch = String(branchScope || 'ALL').trim();
    const sql = branch && branch !== 'ALL'
      ? `SELECT po_id, supplier_name, branch_id, expected_delivery_iso FROM purchase_orders WHERE branch_id = ?`
      : `SELECT po_id, supplier_name, branch_id, expected_delivery_iso FROM purchase_orders`;
    pos = branch && branch !== 'ALL' ? db.prepare(sql).all(branch) : db.prepare(sql).all();
  } catch {
    return [];
  }
  const endExclusive = nextDay(day);
  const paid = new Map();
  const firstPaid = new Map();
  const received = new Map();
  const rememberPaid = (po, amount, postedAt) => {
    const id = String(po || '');
    if (!id) return;
    paid.set(id, (paid.get(id) || 0) + amount);
    const when = iso(postedAt);
    if (when && (!firstPaid.has(id) || when < firstPaid.get(id))) firstPaid.set(id, when);
  };
  try {
    const rows = db.prepare(
      `SELECT ap.po_ref AS po, tm.amount_ngn, tm.posted_at_iso
       FROM treasury_movements tm
       JOIN accounts_payable ap ON ap.ap_id = tm.source_id AND tm.source_kind = 'ACCOUNTS_PAYABLE'
       WHERE tm.posted_at_iso < ? AND tm.type = 'AP_PAYMENT'`
    ).all(endExclusive);
    for (const row of rows) rememberPaid(row.po, -money(row.amount_ngn), row.posted_at_iso);
  } catch { /* no AP link */ }
  try {
    const rows = db.prepare(
      `SELECT source_id AS po, amount_ngn, posted_at_iso
       FROM treasury_movements
       WHERE posted_at_iso < ?
         AND (
           (type = 'SUPPLIER_PAYMENT' AND source_kind = 'PURCHASE_ORDER')
           OR (type = 'SUPPLIER_OVERPAYMENT' AND source_kind = 'SUPPLIER_OVERPAYMENT')
         )`
    ).all(endExclusive);
    for (const row of rows) rememberPaid(row.po, -money(row.amount_ngn), row.posted_at_iso);
  } catch { /* no direct payments */ }
  try {
    const lots = db.prepare(
      `SELECT c.po_id, c.weight_kg, c.qty_received, c.unit_cost_ngn_per_kg, l.unit_price_per_kg_ngn
       FROM coil_lots c
       LEFT JOIN purchase_order_lines l ON l.po_id = c.po_id AND l.line_key = c.line_key
       WHERE c.received_at_iso < ?`
    ).all(endExclusive);
    for (const lot of lots) {
      const rate = money(lot.unit_price_per_kg_ngn) || money(lot.unit_cost_ngn_per_kg);
      const weight = Number(lot.weight_kg ?? lot.qty_received) || 0;
      received.set(lot.po_id, (received.get(lot.po_id) || 0) + money(weight * rate));
    }
  } catch { /* coils optional */ }
  try {
    const stones = db.prepare(
      `SELECT ref, value_ngn, qty, unit_price_ngn, at_iso, date_iso
       FROM stock_movements
       WHERE type IN ('STORE_GRN_STONE', 'STORE_GRN_STONE_FLATSHEET', 'STORE_GRN_ACCESSORY', 'STORE_ACCESSORY_DIRECT')`
    ).all();
    for (const row of stones) {
      const when = iso(row.at_iso) || iso(row.date_iso);
      if (!when || when >= endExclusive) continue;
      const value = money(row.value_ngn) || money(Math.abs(Number(row.qty) || 0) * money(row.unit_price_ngn));
      received.set(row.ref, (received.get(row.ref) || 0) + value);
    }
  } catch { /* stone optional */ }

  const stale = [];
  for (const po of pos) {
    const paidNgn = paid.get(po.po_id) || 0;
    const receivedNgn = received.get(po.po_id) || 0;
    const advanceNgn = paidNgn - receivedNgn;
    if (advanceNgn <= 0) continue;
    const paidOn = firstPaid.get(po.po_id) || '';
    const days = daysOutstanding(paidOn, day);
    if (days == null || days <= SUPPLIER_ADVANCE_STALE_DAYS) continue;
    stale.push({
      poId: po.po_id,
      supplierName: po.supplier_name || '',
      branchId: po.branch_id || '',
      paidOn,
      promisedDelivery: iso(po.expected_delivery_iso),
      daysOutstanding: days,
      advanceNgn,
    });
  }
  stale.sort((a, b) => b.daysOutstanding - a.daysOutstanding);
  return stale;
}

function nextDay(isoDay) {
  const [y, m, d] = isoDay.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

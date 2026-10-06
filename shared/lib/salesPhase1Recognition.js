/**
 * Phase 1 sales definitions. Built beside the Management report; it does not replace it.
 *
 * Revenue is never a receipt amount.
 *   Goods: each completed production job, metres × the quotation's unit price.
 *   Accessories and non-metre product lines (ridge, flashing, …) on a goods quote
 *   are recognised once, on the first completed job.
 *   Installation, transport, and other service lines, and accessory-only quotes,
 *   are recognised on the delivery/dispatch date, or — when there is no delivery —
 *   on the date every live cutting list for the quote is Finished.
 * Void quotes are excluded.
 *
 * Cash, advances, and debtors use the bank-statement date on the treasury line,
 * not the confirmation tick and not the receipt document date. September
 * reconciliation wrote that statement date onto the treasury posting. A receipt
 * with an open treasury line counts as bank-confirmed even when the tick is later.
 * A receipt with no treasury line still uses the confirmation tick.
 * Suspended, Reversed, and a treasury line that has been fully reversed are not cash,
 * unless a live bank-deposit allocation funds that receipt. The allocation then
 * counts, on the deposit's bank date, and the receipt is not marked Reversed again.
 * A partly reversed receipt counts only the treasury amount that is still open.
 * A reversal is applied on the date it was posted.
 *
 * An ADVANCE_IN treasury line is customer cash on its posting date. Applying that
 * advance to a quote settles the quote. The application does not add cash a second time.
 * A staff purchase credit settles the customer and leaves a staff receivable.
 *
 * Goods metres recognised for a quote cannot exceed the quoted metres on that line.
 * Metres above the quote are reported and are not revenue.
 *
 * Customer position = bank-confirmed paid − revenue recognised − refunds paid
 *   − credit applied to another customer + credit received from another customer.
 * Positive is an advance (we hold their money). Negative is a debtor.
 */

import { jobTotalOutputMetres } from './jobOutputMetres.js';
import { payeeAccountDigits, payeeAccountRejection } from './refundPayeeAccount.js';
import { quotationLineQtyNumber, quotationLineUnitPriceNumber } from './quotationLineNumericForRefund.js';

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function roundMetres(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function toIsoDate(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function inRange(iso, startDate, endDate) {
  if (!iso) return false;
  if (startDate && iso < startDate) return false;
  if (endDate && iso > endDate) return false;
  return true;
}

function onOrBefore(iso, asAt) {
  return Boolean(iso) && (!asAt || iso <= asAt);
}

export function isVoidQuotationStatus(status) {
  return String(status || '').trim().toLowerCase() === 'void';
}

function normStatus(status) {
  return String(status || '').trim().toLowerCase();
}

export function receiptStatusIsSuspended(status) {
  return normStatus(status).includes('suspended');
}

export function receiptStatusIsReversed(status) {
  return normStatus(status) === 'reversed';
}

function lineAmountNgn(line) {
  const name = String(line?.name || '').trim();
  if (!name) return 0;
  const qty = quotationLineQtyNumber(line);
  const unit = quotationLineUnitPriceNumber(line);
  let amt = roundMoney(qty * unit);
  if (amt <= 0) {
    amt = roundMoney(
      Number(String(line?.value ?? line?.lineTotal ?? line?.line_total_ngn ?? '').replace(/,/g, '')) || 0
    );
  }
  return amt;
}

/**
 * Metre-sheet lines carry the quote unit price for production metres.
 * Ridge, flashing, and similar piece lines are recognised with accessories.
 * @param {object} line
 * @returns {'empty'|'piece'|'stone'|'flatsheet'|'cladding'|'roofing'}
 */
export function quotationProductLineRole(line) {
  const kind = String(line?.lineKind || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  const name = String(line?.name || '').trim().toLowerCase();
  if (!name) {
    if (kind === 'ridge' || kind === 'flashing') return 'piece';
    if (kind === 'stone_coated') return 'stone';
    if (kind === 'roofing') return 'roofing';
    // The sheet row is sometimes saved with the gauge and colour filled in and the name left blank.
    if (quotationLineQtyNumber(line) > 0 && quotationLineUnitPriceNumber(line) > 0) return 'roofing';
    return 'empty';
  }
  if (kind === 'ridge' || kind === 'flashing') return 'piece';
  if (/flat\s*sheet|flatsheet/.test(name)) return 'flatsheet';
  if (name.includes('cladding')) return 'cladding';
  if (kind === 'stone_coated' || (name.includes('stone') && !name.includes('flat'))) return 'stone';
  if (kind === 'roofing' || name.includes('roofing') || name === 'offcut') return 'roofing';
  return 'piece';
}

function roleUnitPrice(lines) {
  let qty = 0;
  let amt = 0;
  const prices = [];
  for (const line of lines || []) {
    const unit = quotationLineUnitPriceNumber(line);
    if (!(unit > 0)) continue;
    prices.push(unit);
    const q = quotationLineQtyNumber(line);
    if (q > 0) {
      qty += q;
      amt += q * unit;
    }
  }
  if (qty > 0) return Math.round(amt / qty);
  if (!prices.length) return 0;
  return Math.round(prices.reduce((s, p) => s + p, 0) / prices.length);
}

function priceBookForQuote(lines) {
  const groups = { stone: [], roofing: [], flatsheet: [], cladding: [], piece: [] };
  for (const line of lines?.products || []) {
    const role = quotationProductLineRole(line);
    if (groups[role]) groups[role].push(line);
  }
  const price = {
    stone: roleUnitPrice(groups.stone),
    roofing: roleUnitPrice(groups.roofing),
    flatsheet: roleUnitPrice(groups.flatsheet),
    cladding: roleUnitPrice(groups.cladding),
  };
  const present = ['stone', 'roofing', 'flatsheet', 'cladding'].filter((role) => price[role] > 0);
  const distinct = new Set(present.map((role) => price[role]));
  let fallback = 0;
  let method = 'none';
  if (distinct.size === 1) {
    fallback = [...distinct][0];
    method = 'quote_unit_price';
  } else if (distinct.size > 1) {
    let qty = 0;
    let amt = 0;
    for (const role of present) {
      for (const line of groups[role]) {
        const q = quotationLineQtyNumber(line);
        const unit = quotationLineUnitPriceNumber(line);
        if (q > 0 && unit > 0) {
          qty += q;
          amt += q * unit;
        }
      }
    }
    fallback = qty > 0 ? Math.round(amt / qty) : [...distinct][0];
    method = 'weighted_metre_prices';
  }
  const pieceNgn = groups.piece.reduce((s, line) => s + lineAmountNgn(line), 0);
  const accessoryNgn = (lines?.accessories || []).reduce((s, line) => s + lineAmountNgn(line), 0);
  const serviceNgn = (lines?.services || []).reduce((s, line) => s + lineAmountNgn(line), 0);
  return {
    price,
    fallback,
    method,
    hasMetre: present.length > 0,
    pieceNgn: roundMoney(pieceNgn),
    accessoryNgn: roundMoney(accessoryNgn),
    serviceNgn: roundMoney(serviceNgn),
  };
}

function num(value) {
  return Number(value) || 0;
}

function cuttingMixMetres(mix) {
  if (!mix) return null;
  const stone = Math.max(0, num(mix.stone));
  const roof = Math.max(0, num(mix.roof));
  const flat = Math.max(0, num(mix.flat));
  const clad = Math.max(0, num(mix.clad));
  const total = stone + roof + flat + clad;
  if (total <= 1e-9) return null;
  return { stone, roof, flat, clad, total };
}

/**
 * @param {object} job
 * @param {ReturnType<typeof priceBookForQuote>} book
 * @param {object | null} mix cutting-list metres by portion
 */
export function goodsRevenueForCompletedJob(job, book, mix) {
  const metres = jobTotalOutputMetres(job);
  if (!(metres > 1e-9)) {
    return { revenueNgn: 0, metres: 0, unitPriceNgn: 0, method: 'no_metres' };
  }
  const roof = num(job.actualRoofM ?? job.actual_roof_m);
  const flat = num(job.actualFlatsheetM ?? job.actual_flatsheet_m);
  const clad = num(job.actualCladdingM ?? job.actual_cladding_m);
  // Plain coil completion copies output into actual_flatsheet_m. That is not a
  // separate flatsheet sale. Split prices only when roof and coil portions both exist.
  const hybrid = roof > 1e-6 && flat > 1e-6;
  if (hybrid) {
    const stoneP = book.price.stone || book.price.roofing || book.fallback;
    const flatP = book.price.flatsheet || book.price.roofing || book.fallback;
    const cladP = book.price.cladding || book.price.roofing || flatP || book.fallback;
    if (!(stoneP > 0) && !(flatP > 0)) {
      return { revenueNgn: 0, metres, unitPriceNgn: 0, method: 'missing_unit_price' };
    }
    const revenue = roof * (stoneP || flatP) + flat * (flatP || stoneP) + clad * (cladP || stoneP || flatP);
    return { revenueNgn: roundMoney(revenue), metres: roof + flat + clad, unitPriceNgn: null, method: 'split_output' };
  }
  if (roof > 1e-6 && flat <= 1e-6 && clad <= 1e-6) {
    const unit = book.price.stone || book.price.roofing || book.fallback;
    if (!(unit > 0)) return { revenueNgn: 0, metres, unitPriceNgn: 0, method: 'missing_unit_price' };
    return { revenueNgn: roundMoney(metres * unit), metres, unitPriceNgn: unit, method: 'quote_unit_price' };
  }
  const portions = cuttingMixMetres(mix);
  if (book.method === 'weighted_metre_prices' && portions) {
    const scale = metres / portions.total;
    const parts = [
      [portions.stone * scale, book.price.stone || book.price.roofing],
      [portions.roof * scale, book.price.roofing || book.price.stone],
      [portions.flat * scale, book.price.flatsheet || book.price.roofing],
      [portions.clad * scale, book.price.cladding || book.price.roofing],
    ];
    let revenue = 0;
    let priced = 0;
    for (const [m, p] of parts) {
      if (!(m > 1e-9) || !(p > 0)) continue;
      revenue += m * p;
      priced += m;
    }
    if (priced > 1e-6) {
      return { revenueNgn: roundMoney(revenue), metres, unitPriceNgn: null, method: 'cutting_list_mix' };
    }
  }
  if (!(book.fallback > 0)) {
    return { revenueNgn: 0, metres, unitPriceNgn: 0, method: 'missing_unit_price' };
  }
  return {
    revenueNgn: roundMoney(metres * book.fallback),
    metres,
    unitPriceNgn: book.fallback,
    method: book.method,
  };
}

const METRE_ROLES = ['roofing', 'stone', 'flatsheet', 'cladding'];

function blankRoleMetres() {
  return { roofing: 0, stone: 0, flatsheet: 0, cladding: 0 };
}

function quotedMetresByRole(lines) {
  const qty = blankRoleMetres();
  for (const line of lines?.products || []) {
    const role = quotationProductLineRole(line);
    if (!Object.prototype.hasOwnProperty.call(qty, role)) continue;
    const q = quotationLineQtyNumber(line);
    if (q > 0) qty[role] += q;
  }
  return qty;
}

function sumRoleMetres(metres) {
  return METRE_ROLES.reduce((s, role) => s + (Number(metres?.[role]) || 0), 0);
}

function portionUnitPrice(role, book) {
  if (role === 'stone') return book.price.stone || book.price.roofing || book.fallback || 0;
  if (role === 'roofing') return book.price.roofing || book.price.stone || book.fallback || 0;
  if (role === 'flatsheet') return book.price.flatsheet || book.price.roofing || book.fallback || 0;
  if (role === 'cladding') return book.price.cladding || book.price.roofing || book.price.flatsheet || book.fallback || 0;
  return book.fallback || 0;
}

/**
 * Metres a completed job is trying to recognise, split by quote role when the job says so.
 * A plain coil job is one pool: completion copies output into actual_flatsheet_m, which is not a flatsheet sale.
 * @returns {{ kind: 'none'|'pool'|'split', metres: number, portions: Record<string, number>|null, method: string }}
 */
function jobMetrePortions(job, book, mix) {
  const metres = jobTotalOutputMetres(job);
  if (!(metres > 1e-9)) return { kind: 'none', metres: 0, portions: null, method: 'no_metres' };
  const roof = num(job.actualRoofM ?? job.actual_roof_m);
  const flat = num(job.actualFlatsheetM ?? job.actual_flatsheet_m);
  const clad = num(job.actualCladdingM ?? job.actual_cladding_m);
  const hybrid = roof > 1e-6 && flat > 1e-6;
  if (hybrid) {
    const portions = blankRoleMetres();
    portions.flatsheet = flat;
    portions.cladding = clad;
    if ((book.price.stone || 0) > 0) portions.stone = roof;
    else portions.roofing = roof;
    return { kind: 'split', metres: roof + flat + clad, portions, method: 'split_output' };
  }
  if (roof > 1e-6 && flat <= 1e-6 && clad <= 1e-6) {
    const portions = blankRoleMetres();
    if ((book.price.stone || 0) > 0) portions.stone = metres;
    else portions.roofing = metres;
    return { kind: 'split', metres, portions, method: 'quote_unit_price' };
  }
  // Cutting-list "Flatsheet" on a plain coil is the coil output, not the flat-sheet quote line.
  // Cap that job against the quote's total metres. A real hybrid still splits on the job's own roof and flat columns.
  void mix;
  return { kind: 'pool', metres, portions: null, method: book.method || 'quote_unit_price' };
}

function priceRoleMetres(portions, book) {
  let revenue = 0;
  for (const role of METRE_ROLES) {
    const metres = Number(portions?.[role]) || 0;
    if (metres <= 1e-9) continue;
    const unit = portionUnitPrice(role, book);
    if (!(unit > 0)) continue;
    revenue += metres * unit;
  }
  return roundMoney(revenue);
}

function consumePool(remaining, metres) {
  let left = metres;
  for (const role of METRE_ROLES) {
    if (left <= 1e-9) break;
    const allow = Math.max(0, remaining[role] || 0);
    const use = Math.min(allow, left);
    remaining[role] = allow - use;
    left -= use;
  }
  return left;
}

function fitsCap(allocation, remaining) {
  if (allocation.kind === 'pool') return allocation.metres <= sumRoleMetres(remaining) + 1e-6;
  return METRE_ROLES.every((role) => (allocation.portions[role] || 0) <= (remaining[role] || 0) + 1e-6);
}

/**
 * Recognise one job's goods, refusing metres above the quoted quantity still open on the quote.
 * Jobs are applied in completion order, so an earlier job uses the quoted metres first.
 */
function recogniseCappedJob(job, book, mix, remaining) {
  const allocation = jobMetrePortions(job, book, mix);
  const completedByRole = blankRoleMetres();
  const excessByRole = blankRoleMetres();
  if (allocation.kind === 'none') {
    return { goods: { revenueNgn: 0, metres: 0, unitPriceNgn: 0, method: 'no_metres' }, excessMetres: 0, excessValueNgn: 0, completedByRole, excessByRole };
  }
  if (fitsCap(allocation, remaining)) {
    if (allocation.kind === 'pool') consumePool(remaining, allocation.metres);
    else {
      for (const role of METRE_ROLES) {
        remaining[role] = Math.max(0, (remaining[role] || 0) - (allocation.portions[role] || 0));
        completedByRole[role] += allocation.portions[role] || 0;
      }
    }
    if (allocation.kind === 'pool') {
      // Pool metres are not tied to a role; the quote report totals them.
    }
    const goods = goodsRevenueForCompletedJob(job, book, mix);
    return { goods, excessMetres: 0, excessValueNgn: 0, completedByRole, excessByRole };
  }
  if (allocation.kind === 'pool') {
    const allow = sumRoleMetres(remaining);
    const take = Math.min(allocation.metres, Math.max(0, allow));
    const excess = Math.max(0, allocation.metres - take);
    consumePool(remaining, take);
    const unit = book.fallback || 0;
    return {
      goods: {
        revenueNgn: unit > 0 ? roundMoney(take * unit) : 0,
        metres: take,
        unitPriceNgn: unit,
        method: take > 1e-9 ? allocation.method : 'no_metres',
      },
      excessMetres: excess,
      excessValueNgn: unit > 0 ? roundMoney(excess * unit) : 0,
      completedByRole,
      excessByRole,
    };
  }
  let recognisedMetres = 0;
  for (const role of METRE_ROLES) {
    const want = allocation.portions[role] || 0;
    const allow = Math.max(0, remaining[role] || 0);
    const take = Math.min(want, allow);
    remaining[role] = allow - take;
    completedByRole[role] += want;
    excessByRole[role] += Math.max(0, want - take);
    recognisedMetres += take;
  }
  const taken = blankRoleMetres();
  for (const role of METRE_ROLES) taken[role] = Math.max(0, (allocation.portions[role] || 0) - excessByRole[role]);
  const excessMetres = sumRoleMetres(excessByRole);
  return {
    goods: {
      revenueNgn: priceRoleMetres(taken, book),
      metres: recognisedMetres,
      unitPriceNgn: null,
      method: allocation.method,
    },
    excessMetres,
    excessValueNgn: priceRoleMetres(excessByRole, book),
    completedByRole,
    excessByRole,
  };
}

function jobCompleted(job) {
  return String(job?.status || '').trim() === 'Completed';
}

function jobDate(job) {
  return toIsoDate(job?.completedAtISO || job?.completed_at_iso || job?.endDateISO || job?.end_date_iso || '');
}

function deliveryDate(row) {
  const status = normStatus(row?.status);
  if (status === 'cancelled' || status === 'void') return '';
  return toIsoDate(row?.deliveredDateISO || row?.delivered_date_iso || row?.shipDate || row?.ship_date || '');
}

/**
 * Date the quote's cutting lists are all Finished, when none are still open.
 * @returns {string}
 */
function quoteFinishedDate(quotationRef, cuttingLists, jobs) {
  const lists = (cuttingLists || []).filter((row) => String(row.quotationRef || '') === quotationRef);
  const live = lists.filter((row) => normStatus(row.status) !== 'cancelled');
  if (!live.length) return '';
  if (live.some((row) => normStatus(row.status) !== 'finished')) return '';
  const listIds = new Set(live.map((row) => String(row.id || '')));
  const dates = [];
  for (const job of jobs || []) {
    if (!jobCompleted(job)) continue;
    if (String(job.quotationRef || '') !== quotationRef) continue;
    const listId = String(job.cuttingListId || job.cutting_list_id || '');
    if (listId && !listIds.has(listId)) continue;
    const iso = jobDate(job);
    if (iso) dates.push(iso);
  }
  if (dates.length) return dates.sort().at(-1);
  const listDates = live.map((row) => toIsoDate(row.dateISO || row.date_iso)).filter(Boolean);
  return listDates.sort().at(-1) || '';
}

/**
 * Why services or accessories on this quote are still unrecognised.
 * (a) every live job is Completed and a cutting list is not Finished
 * (b) no completed job yet
 * (c) accessory/service-only quote with no cutting list
 * @returns {'completed_but_list_open'|'no_completed_job'|'no_cutting_list'|'jobs_still_open'}
 */
function unrecognisedBucket(quote, book, quoteJobs, cuttingLists) {
  const ref = String(quote?.id || '');
  const lists = (cuttingLists || []).filter(
    (row) => String(row.quotationRef || '') === ref && normStatus(row.status) !== 'cancelled'
  );
  const liveJobs = (quoteJobs || []).filter((job) => normStatus(job.status) !== 'cancelled');
  const completed = liveJobs.filter(jobCompleted);
  if (!book?.hasMetre && lists.length === 0) return 'no_cutting_list';
  if (completed.length === 0) return 'no_completed_job';
  const allCompleted = liveJobs.length > 0 && liveJobs.every(jobCompleted);
  const listOpen = lists.length === 0 || lists.some((row) => normStatus(row.status) !== 'finished');
  if (allCompleted && listOpen) return 'completed_but_list_open';
  return 'jobs_still_open';
}

function cuttingListStatusSummary(quotationRef, cuttingLists) {
  const lists = (cuttingLists || []).filter(
    (row) => String(row.quotationRef || '') === quotationRef && normStatus(row.status) !== 'cancelled'
  );
  if (!lists.length) return '';
  const counts = new Map();
  for (const row of lists) {
    const status = String(row.status || '').trim() || 'Unknown';
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  return [...counts.entries()].map(([status, n]) => `${status} ${n}`).join(', ');
}

function earliestDeliveryDate(quotationRef, deliveries) {
  const dates = [];
  for (const row of deliveries || []) {
    if (String(row.quotationRef || row.quotation_ref || '') !== quotationRef) continue;
    const iso = deliveryDate(row);
    if (iso) dates.push(iso);
  }
  dates.sort();
  return dates[0] || '';
}

function movementsForReceipt(receipt, bySource) {
  const seen = new Set();
  const lines = [];
  for (const key of [receipt?.id, receipt?.ledgerEntryId, receipt?.ledger_entry_id]) {
    const id = String(key || '').trim();
    if (!id || !bySource.has(id)) continue;
    for (const line of bySource.get(id)) {
      const mid = String(line.id || '');
      if (mid && seen.has(mid)) continue;
      if (mid) seen.add(mid);
      lines.push(line);
    }
  }
  return lines;
}

function isReceiptTreasuryLine(line) {
  const type = String(line?.type || '').trim().toUpperCase();
  return type === 'RECEIPT_IN' || type === 'RECEIPT_REVERSAL_OUT';
}

/**
 * Bank remainder of a receipt as at a date. Reversal lines are negative.
 * @returns {{ netNgn: number, hasTreasury: boolean, hasReversal: boolean, reversedNgn: number }}
 */
export function receiptTreasuryNetAsAt(receipt, movements, asAt) {
  let net = 0;
  let hasTreasury = false;
  let hasReversal = false;
  let reversedNgn = 0;
  for (const line of movements || []) {
    if (!isReceiptTreasuryLine(line)) continue;
    const posted = toIsoDate(line.postedAtISO || line.posted_at_iso);
    if (asAt && posted && posted > asAt) continue;
    hasTreasury = true;
    const amt = roundMoney(line.amountNgn ?? line.amount_ngn);
    const type = String(line.type || '').trim().toUpperCase();
    if (type === 'RECEIPT_REVERSAL_OUT' || line.reversesMovementId || line.reverses_movement_id) {
      hasReversal = true;
      reversedNgn += Math.abs(amt);
    }
    net += amt;
  }
  return { netNgn: net, hasTreasury, hasReversal, reversedNgn: roundMoney(reversedNgn) };
}

function reversedMovementIds(movements, asAt) {
  const ids = new Set();
  for (const line of movements || []) {
    const revId = String(line.reversesMovementId || line.reverses_movement_id || '').trim();
    if (!revId) continue;
    const posted = toIsoDate(line.postedAtISO || line.posted_at_iso);
    if (asAt && posted && posted > asAt) continue;
    ids.add(revId);
  }
  return ids;
}

/** RECEIPT_IN lines still open at asAt. An empty asAt treats every reversal as already applied. */
function openReceiptInLines(movements, asAt) {
  const reversed = reversedMovementIds(movements, asAt);
  const out = [];
  for (const line of movements || []) {
    if (String(line?.type || '').trim().toUpperCase() !== 'RECEIPT_IN') continue;
    if (line.reversesMovementId || line.reverses_movement_id) continue;
    const posted = toIsoDate(line.postedAtISO || line.posted_at_iso);
    if (asAt && posted && posted > asAt) continue;
    const id = String(line.id || '').trim();
    if (id && reversed.has(id)) continue;
    out.push(line);
  }
  return out;
}

/**
 * Open customer receipts whose treasury posting (the bank-statement date) falls in the period
 * and is still open at asAt.
 */
function periodOpenReceiptIn(movements, startDate, endDate, asAt) {
  let amountNgn = 0;
  let bankDateISO = '';
  for (const line of openReceiptInLines(movements, asAt)) {
    const posted = toIsoDate(line.postedAtISO || line.posted_at_iso);
    if (!inRange(posted, startDate, endDate)) continue;
    amountNgn = roundMoney(amountNgn + roundMoney(line.amountNgn ?? line.amount_ngn));
    if (!bankDateISO || posted < bankDateISO) bankDateISO = posted;
  }
  return { amountNgn, bankDateISO };
}

/**
 * Bank value date. An open treasury line uses its posting date — the September
 * reconciliation stored the bank-statement date there. The confirmation tick is
 * not the cash date when that line exists. With no treasury line, the tick
 * (then the finance reconciliation date) is the value date.
 * @param {object} receipt
 * @param {object[]} [movements]
 * @param {string} [asAt]
 * @returns {string}
 */
export function receiptBankValueDate(receipt, movements, asAt) {
  let earliest = '';
  for (const line of openReceiptInLines(movements, asAt || '')) {
    const posted = toIsoDate(line.postedAtISO || line.posted_at_iso);
    if (!posted) continue;
    if (!earliest || posted < earliest) earliest = posted;
  }
  if (earliest) return earliest;
  const confirmed = toIsoDate(receipt?.bankConfirmedAtISO || receipt?.bank_confirmed_at_iso);
  if (confirmed) return confirmed;
  const recon = toIsoDate(receipt?.financeReconciliationSavedAtISO || receipt?.finance_reconciliation_saved_at_iso);
  if (recon) return recon;
  return '';
}

/**
 * Bank-confirmed cash still on the receipt as at a date.
 * An open treasury line counts even when the confirmation tick is after asAt.
 * A reversal counts from its posting date, so current status Reversed does not
 * remove cash that was still open at the as-at date.
 * Fully reversed treasury counts as zero even when the receipt status is still Cleared.
 */
export function bankConfirmedCashAsAt(receipt, movements, asAt, funding = null) {
  if (receiptStatusIsSuspended(receipt?.status)) return { amountNgn: 0, reason: 'suspended' };
  const treasury = receiptTreasuryNetAsAt(receipt, movements, asAt);
  const valueDate = receiptBankValueDate(receipt, movements, asAt);
  const funded = funding && funding.amountNgn > 0 ? funding : null;
  if (treasury.hasTreasury) {
    if (treasury.netNgn <= 0) {
      if (funded && onOrBefore(funded.bankDateISO, asAt)) {
        return {
          amountNgn: funded.amountNgn,
          reason: 'bank_deposit',
          treasury,
          valueDate: funded.bankDateISO,
          depositId: funded.depositId || '',
        };
      }
      return { amountNgn: 0, reason: 'treasury_reversed', treasury, valueDate };
    }
    if (!valueDate || !onOrBefore(valueDate, asAt)) return { amountNgn: 0, reason: 'outside_date', treasury, valueDate };
    return {
      amountNgn: treasury.netNgn,
      reason: treasury.hasReversal ? 'partial_treasury_reversal' : 'bank_confirmed',
      treasury,
      valueDate,
    };
  }
  if (!valueDate) {
    if (receiptStatusIsReversed(receipt?.status)) return { amountNgn: 0, reason: 'reversed', treasury, valueDate };
    return { amountNgn: 0, reason: 'not_bank_confirmed', treasury, valueDate };
  }
  if (!onOrBefore(valueDate, asAt)) return { amountNgn: 0, reason: 'outside_date', treasury, valueDate };
  if (receiptStatusIsReversed(receipt?.status)) return { amountNgn: 0, reason: 'reversed', treasury, valueDate };
  const bank = receipt?.bankReceivedAmountNgn ?? receipt?.bank_received_amount_ngn;
  const amount = bank != null && Number(bank) > 0 ? roundMoney(bank) : roundMoney(receipt?.amountNgn ?? receipt?.amount_ngn);
  if (amount <= 0) return { amountNgn: 0, reason: 'zero', treasury, valueDate };
  return { amountNgn: amount, reason: 'bank_confirmed', treasury, valueDate };
}

function indexMovements(movements) {
  const bySource = new Map();
  for (const line of movements || []) {
    const sourceId = String(line.sourceId || line.source_id || '').trim();
    if (!sourceId) continue;
    if (!bySource.has(sourceId)) bySource.set(sourceId, []);
    bySource.get(sourceId).push(line);
  }
  return bySource;
}

function indexDepositAllocations(rows) {
  const byReceipt = new Map();
  for (const row of rows || []) {
    const receiptId = String(row.receiptId || row.allocatedToId || row.allocated_to_id || '').trim();
    if (!receiptId) continue;
    if (!byReceipt.has(receiptId)) byReceipt.set(receiptId, []);
    byReceipt.get(receiptId).push(row);
  }
  return byReceipt;
}

/** Live bank-deposit allocation that funds a receipt whose own treasury line is gone. */
export function openDepositFunding(receipt, depositAllocations, asAt) {
  const byReceipt = depositAllocations instanceof Map ? depositAllocations : indexDepositAllocations(depositAllocations);
  const ids = [receipt?.id, receipt?.ledgerEntryId, receipt?.ledger_entry_id]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  let amountNgn = 0;
  let bankDateISO = '';
  let depositId = '';
  const depositTotals = new Map();
  const seen = new Set();
  for (const id of ids) {
    for (const row of byReceipt.get(id) || []) {
      const key = `${row.allocationId || row.id || ''}:${row.depositId || row.deposit_id || ''}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const status = normStatus(row.depositStatus || row.status);
      if (status === 'reversed' || status === 'cancelled') continue;
      const reversedAt = toIsoDate(row.reversedAtISO || row.reversed_at_iso);
      if (reversedAt && (!asAt || reversedAt <= asAt)) continue;
      const bankDate = toIsoDate(row.bankDateISO || row.bank_date_iso);
      if (asAt && bankDate && bankDate > asAt) continue;
      const amount = roundMoney(row.amountNgn ?? row.amount_ngn);
      if (amount <= 0) continue;
      amountNgn = roundMoney(amountNgn + amount);
      const depId = String(row.depositId || row.deposit_id || '');
      const depAmt = roundMoney(row.depositAmountNgn ?? row.deposit_amount_ngn);
      if (depId && depAmt > 0) depositTotals.set(depId, depAmt);
      if (!bankDateISO || (bankDate && bankDate < bankDateISO)) bankDateISO = bankDate;
      depositId = depositId || depId;
    }
  }
  // The allocation can be the quote total while the receipt and the deposit are the full bank inflow.
  if (depositTotals.size === 1) {
    const depositAmount = [...depositTotals.values()][0];
    const receiptAmount = roundMoney(receipt?.amountNgn ?? receipt?.amount_ngn);
    if (receiptAmount === depositAmount && depositAmount > amountNgn) amountNgn = depositAmount;
  }
  return { amountNgn, bankDateISO, depositId };
}

function staffCoveredSnapshot(credits, revenueByQuote, asAt) {
  const usedByQuote = new Map();
  const byCustomer = new Map();
  const rows = [];
  for (const credit of credits || []) {
    const dateISO = toIsoDate(credit.dateISO || credit.atISO || credit.at_iso);
    if (!onOrBefore(dateISO, asAt)) continue;
    const quotationRef = String(credit.quotationRef || credit.quotation_ref || '').trim();
    if (!quotationRef) continue;
    const revenue = roundMoney(revenueByQuote.get(quotationRef) || 0);
    const already = usedByQuote.get(quotationRef) || 0;
    const covered = Math.min(roundMoney(credit.amountNgn ?? credit.amount_ngn), Math.max(0, revenue - already));
    if (!(covered > 0)) continue;
    usedByQuote.set(quotationRef, roundMoney(already + covered));
    const customerId = String(credit.customerId || credit.customer_id || '');
    const customerName = String(credit.customerName || credit.customer_name || '');
    const key = customerKey(customerId, customerName) || '(no customer)';
    const prev = byCustomer.get(key) || { customerId, customerName, amountNgn: 0 };
    prev.amountNgn = roundMoney(prev.amountNgn + covered);
    byCustomer.set(key, prev);
    rows.push({
      customerId,
      customerName,
      quotationRef,
      obligationId: String(credit.obligationId || credit.obligation_id || ''),
      dateISO,
      creditNgn: roundMoney(credit.amountNgn ?? credit.amount_ngn),
      revenueNgn: revenue,
      staffReceivableNgn: covered,
    });
  }
  rows.sort((a, b) => b.staffReceivableNgn - a.staffReceivableNgn || a.customerName.localeCompare(b.customerName));
  return { byCustomer, rows, totalNgn: roundMoney(rows.reduce((sum, row) => sum + row.staffReceivableNgn, 0)) };
}

function openAdvanceInLines(movements, asAt) {
  const reversed = reversedMovementIds(movements, asAt);
  const out = [];
  for (const line of movements || []) {
    if (String(line?.type || '').trim().toUpperCase() !== 'ADVANCE_IN') continue;
    const posted = toIsoDate(line.postedAtISO || line.posted_at_iso);
    if (asAt && posted && posted > asAt) continue;
    const id = String(line.id || '').trim();
    if (id && reversed.has(id)) continue;
    out.push(line);
  }
  return out;
}

/**
 * Cleared receipts whose treasury cash is fully reversed. Partial reversals stay Cleared;
 * only the reversed portion is left out of cash. A receipt funded by a live bank-deposit
 * allocation stays Cleared: the deposit is the bank line, so it must not be marked Reversed.
 * @param {object[]} receipts
 * @param {object[]} movements
 * @param {object[]} [depositAllocations]
 */
export function selectReceiptsToMarkReversed(receipts, movements, depositAllocations = []) {
  const bySource = indexMovements(movements);
  const byDeposit = indexDepositAllocations(depositAllocations);
  const out = [];
  for (const receipt of receipts || []) {
    const status = normStatus(receipt?.status);
    if (status !== 'cleared' && status !== 'confirmed') continue;
    if (openDepositFunding(receipt, byDeposit, '').amountNgn > 0) continue;
    const lines = movementsForReceipt(receipt, bySource);
    const treasury = receiptTreasuryNetAsAt(receipt, lines, '');
    if (!treasury.hasReversal) continue;
    if (treasury.netNgn > 0) continue;
    out.push({
      id: String(receipt.id || ''),
      ledgerEntryId: String(receipt.ledgerEntryId || receipt.ledger_entry_id || ''),
      quotationRef: String(receipt.quotationRef || receipt.quotation_ref || ''),
      customerId: String(receipt.customerId || receipt.customer_id || ''),
      customerName: String(receipt.customerName || receipt.customer_name || ''),
      amountNgn: roundMoney(receipt.amountNgn ?? receipt.amount_ngn),
      netNgn: treasury.netNgn,
      reversedNgn: treasury.reversedNgn,
      reason: 'treasury_fully_reversed',
    });
  }
  return out;
}

function customerKey(id, name) {
  const cid = String(id || '').trim();
  if (cid) return cid;
  const n = String(name || '').trim().toLowerCase();
  return n ? `name:${n}` : '';
}

function addMap(map, key, amount) {
  if (!key || !amount) return;
  map.set(key, roundMoney((map.get(key) || 0) + amount));
}

/**
 * @param {object} input normalised rows
 */
export function buildSalesPhase1Report(input) {
  const startDate = toIsoDate(input?.startDate);
  const endDate = toIsoDate(input?.endDate);
  const openingAsAt = toIsoDate(input?.openingAsAt);
  const closingAsAt = toIsoDate(input?.closingAsAt || endDate);
  const quotations = input?.quotations || [];
  const jobs = input?.jobs || [];
  const cuttingLists = input?.cuttingLists || [];
  const deliveries = input?.deliveries || [];
  const receipts = input?.receipts || [];
  const movements = input?.treasuryMovements || [];
  const refundMovements = input?.refundMovements || [];
  const creditApplications = input?.creditApplications || [];

  const quoteById = new Map();
  for (const q of quotations) {
    const id = String(q.id || '').trim();
    if (id) quoteById.set(id, q);
  }

  const books = new Map();
  function bookFor(quotationRef) {
    if (books.has(quotationRef)) return books.get(quotationRef);
    const q = quoteById.get(quotationRef);
    const book = q && !isVoidQuotationStatus(q.status) ? priceBookForQuote(q.lines) : null;
    books.set(quotationRef, book);
    return book;
  }

  const jobsByQuote = new Map();
  const completedByQuote = new Map();
  for (const job of jobs) {
    const ref = String(job.quotationRef || '').trim();
    if (!ref) continue;
    if (!jobsByQuote.has(ref)) jobsByQuote.set(ref, []);
    jobsByQuote.get(ref).push(job);
    if (!jobCompleted(job)) continue;
    if (!completedByQuote.has(ref)) completedByQuote.set(ref, []);
    completedByQuote.get(ref).push(job);
  }

  /** @type {object[]} */
  const revenueEvents = [];
  /** @type {object[]} */
  const unrecognised = [];
  /** @type {object[]} */
  const exceptions = [];
  /** @type {object[]} */
  const overQuoteMetres = [];

  for (const q of quotations) {
    const ref = String(q.id || '').trim();
    if (!ref || isVoidQuotationStatus(q.status)) continue;
    const book = bookFor(ref);
    if (!book) continue;
    const quoteJobs = (completedByQuote.get(ref) || [])
      .slice()
      .sort((a, b) => jobDate(a).localeCompare(jobDate(b)) || String(a.jobId || '').localeCompare(String(b.jobId || '')));
    const firstJob = quoteJobs[0] || null;
    const firstJobDate = firstJob ? jobDate(firstJob) : '';
    const quoted = quotedMetresByRole(q.lines);
    const remaining = { ...quoted };
    let completedMetres = 0;
    let recognisedMetres = 0;
    let excessMetres = 0;
    let excessValueNgn = 0;
    let excessValueInPeriodNgn = 0;
    const completedByRole = blankRoleMetres();
    const excessByRole = blankRoleMetres();

    for (const job of quoteJobs) {
      if (!book.hasMetre) continue;
      const dateISO = jobDate(job);
      if (!dateISO) continue;
      const capped = recogniseCappedJob(job, book, job.cuttingMix || null, remaining);
      const produced = roundMetres(capped.goods.metres + capped.excessMetres);
      completedMetres = roundMetres(completedMetres + produced);
      recognisedMetres = roundMetres(recognisedMetres + capped.goods.metres);
      excessMetres = roundMetres(excessMetres + capped.excessMetres);
      excessValueNgn = roundMoney(excessValueNgn + capped.excessValueNgn);
      if (inRange(dateISO, startDate, endDate)) excessValueInPeriodNgn = roundMoney(excessValueInPeriodNgn + capped.excessValueNgn);
      for (const role of METRE_ROLES) {
        completedByRole[role] += capped.completedByRole[role] || 0;
        excessByRole[role] += capped.excessByRole[role] || 0;
      }
      if (capped.goods.method === 'missing_unit_price' && capped.goods.metres > 0) {
        exceptions.push({
          quotationRef: ref,
          customerId: String(q.customerId || ''),
          customerName: String(q.customerName || job.customerName || ''),
          jobId: String(job.jobId || ''),
          dateISO,
          metres: capped.goods.metres,
          code: 'goods_missing_unit_price',
          detail: 'Completed metres have no quote unit price, so no goods revenue was recognised.',
        });
      }
      if (!(capped.goods.revenueNgn > 0)) continue;
      revenueEvents.push({
        kind: 'goods',
        dateISO,
        quotationRef: ref,
        customerId: String(q.customerId || job.customerId || ''),
        customerName: String(q.customerName || job.customerName || ''),
        branchId: String(q.branchId || ''),
        amountNgn: capped.goods.revenueNgn,
        metres: capped.goods.metres,
        unitPriceNgn: capped.goods.unitPriceNgn,
        jobId: String(job.jobId || ''),
        method: capped.goods.method,
        basis: 'production_job',
      });
    }

    if (excessMetres > 0.001) {
      const roleLines = METRE_ROLES.filter((role) => (completedByRole[role] || 0) > 0.001 || (excessByRole[role] || 0) > 0.001).map((role) => ({
        role,
        quotedMetres: roundMetres(quoted[role] || 0),
        completedMetres: roundMetres(completedByRole[role] || 0),
        excessMetres: roundMetres(excessByRole[role] || 0),
        excessValueNgn: priceRoleMetres({ ...blankRoleMetres(), [role]: excessByRole[role] || 0 }, book),
      }));
      overQuoteMetres.push({
        quotationRef: ref,
        customerId: String(q.customerId || ''),
        customerName: String(q.customerName || ''),
        branchId: String(q.branchId || ''),
        quotedMetres: roundMetres(sumRoleMetres(quoted)),
        completedMetres,
        recognisedMetres,
        excessMetres,
        excessValueNgn,
        excessValueInPeriodNgn,
        lines: roleLines.length
          ? roleLines
          : [
              {
                role: 'metres',
                quotedMetres: roundMetres(sumRoleMetres(quoted)),
                completedMetres,
                excessMetres,
                excessValueNgn,
              },
            ],
      });
    }

    const accessoryLike = roundMoney(book.accessoryNgn + book.pieceNgn);
    const deliveryISO = earliestDeliveryDate(ref, deliveries);
    const finishedISO = quoteFinishedDate(ref, cuttingLists, jobs);
    const serviceDate = deliveryISO || finishedISO;
    const serviceBasis = deliveryISO ? 'delivery' : finishedISO ? 'finished' : '';
    const holdBucket = unrecognisedBucket(q, book, jobsByQuote.get(ref) || [], cuttingLists);
    const listStatus = cuttingListStatusSummary(ref, cuttingLists);
    function hold(partial) {
      unrecognised.push({
        quotationRef: ref,
        customerId: String(q.customerId || ''),
        customerName: String(q.customerName || ''),
        branchId: String(q.branchId || ''),
        bucket: holdBucket,
        cuttingListStatus: listStatus,
        accessoryNgn: 0,
        serviceNgn: 0,
        ...partial,
      });
    }

    if (book.hasMetre) {
      if (accessoryLike > 0) {
        if (firstJobDate) {
          revenueEvents.push({
            kind: 'accessories',
            dateISO: firstJobDate,
            quotationRef: ref,
            customerId: String(q.customerId || ''),
            customerName: String(q.customerName || ''),
            branchId: String(q.branchId || ''),
            amountNgn: accessoryLike,
            accessoryNgn: book.accessoryNgn,
            pieceNgn: book.pieceNgn,
            jobId: String(firstJob?.jobId || ''),
            basis: 'first_job',
          });
        } else {
          hold({
            accessoryNgn: accessoryLike,
            reason: 'Accessories are waiting for the first completed production job.',
          });
        }
      }
      if (book.serviceNgn > 0) {
        if (serviceDate) {
          revenueEvents.push({
            kind: 'services',
            dateISO: serviceDate,
            quotationRef: ref,
            customerId: String(q.customerId || ''),
            customerName: String(q.customerName || ''),
            branchId: String(q.branchId || ''),
            amountNgn: book.serviceNgn,
            basis: serviceBasis,
          });
        } else {
          hold({
            serviceNgn: book.serviceNgn,
            reason: 'Services have no delivery and the cutting list is not Finished.',
          });
        }
      }
    } else if (accessoryLike > 0 || book.serviceNgn > 0) {
      if (serviceDate) {
        if (accessoryLike > 0) {
          revenueEvents.push({
            kind: 'accessories',
            dateISO: serviceDate,
            quotationRef: ref,
            customerId: String(q.customerId || ''),
            customerName: String(q.customerName || ''),
            branchId: String(q.branchId || ''),
            amountNgn: accessoryLike,
            accessoryNgn: book.accessoryNgn,
            pieceNgn: book.pieceNgn,
            basis: serviceBasis,
          });
        }
        if (book.serviceNgn > 0) {
          revenueEvents.push({
            kind: 'services',
            dateISO: serviceDate,
            quotationRef: ref,
            customerId: String(q.customerId || ''),
            customerName: String(q.customerName || ''),
            branchId: String(q.branchId || ''),
            amountNgn: book.serviceNgn,
            basis: serviceBasis,
          });
        }
      } else {
        hold({
          accessoryNgn: accessoryLike,
          serviceNgn: book.serviceNgn,
          reason: 'Accessory-only quote has no delivery and the cutting list is not Finished.',
        });
      }
    }
  }

  const bySource = indexMovements(movements);
  const depositByReceipt = indexDepositAllocations(input?.depositAllocations || []);
  const advanceMovements = input?.advanceMovements || [];
  const receiptIds = new Set(
    receipts.flatMap((receipt) => [receipt?.id, receipt?.ledgerEntryId, receipt?.ledger_entry_id].map((value) => String(value || '').trim()).filter(Boolean))
  );

  function fundingAt(receipt, asAt) {
    return openDepositFunding(receipt, depositByReceipt, asAt);
  }

  function addPaid(byQuote, byCustomer, ref, customerId, customerName, amountNgn) {
    if (!(amountNgn > 0)) return;
    addMap(byQuote, ref || '(no quote)', amountNgn);
    const key = customerKey(customerId, customerName) || '(no customer)';
    const prev = byCustomer.get(key) || { customerId, customerName, amountNgn: 0 };
    prev.amountNgn = roundMoney(prev.amountNgn + amountNgn);
    byCustomer.set(key, prev);
  }

  function paidSnapshot(asAt) {
    /** @type {Map<string, number>} */
    const byQuote = new Map();
    /** @type {Map<string, { customerId: string, customerName: string, amountNgn: number }>} */
    const byCustomer = new Map();
    const unassignedByBranch = new Map();
    for (const receipt of receipts) {
      const lines = movementsForReceipt(receipt, bySource);
      const cash = bankConfirmedCashAsAt(receipt, lines, asAt, fundingAt(receipt, asAt));
      if (!(cash.amountNgn > 0)) continue;
      const ref = String(receipt.quotationRef || receipt.quotation_ref || '').trim();
      addPaid(byQuote, byCustomer, ref, String(receipt.customerId || receipt.customer_id || ''), String(receipt.customerName || receipt.customer_name || ''), cash.amountNgn);
      if (!ref) addMap(unassignedByBranch, String(receipt.branchId || receipt.branch_id || '') || '(unallocated)', cash.amountNgn);
    }
    for (const line of openAdvanceInLines(advanceMovements, asAt)) {
      const sourceId = String(line.sourceId || line.source_id || '').trim();
      if (sourceId && receiptIds.has(sourceId)) continue;
      const ref = String(line.quotationRef || '').trim();
      addPaid(
        byQuote,
        byCustomer,
        ref,
        String(line.customerId || line.counterpartyId || ''),
        String(line.customerName || line.counterpartyName || ''),
        roundMoney(line.amountNgn ?? line.amount_ngn)
      );
      if (!ref) addMap(unassignedByBranch, String(line.accountBranchId || line.branchId || '') || '(unallocated)', roundMoney(line.amountNgn ?? line.amount_ngn));
    }
    return { byQuote, byCustomer, unassignedByBranch };
  }

  const cashRows = [];
  const cashExclusions = [];
  const timingRows = [];
  for (const receipt of receipts) {
    const lines = movementsForReceipt(receipt, bySource);
    const tickDate = toIsoDate(receipt.bankConfirmedAtISO || receipt.bank_confirmed_at_iso);
    const valueDate = receiptBankValueDate(receipt, lines, closingAsAt);
    const receiptDateISO = toIsoDate(receipt.dateISO || receipt.date_iso);
    const funded = fundingAt(receipt, closingAsAt);
    const atEnd = bankConfirmedCashAsAt(receipt, lines, closingAsAt, funded);
    const treasury = atEnd.treasury || receiptTreasuryNetAsAt(receipt, lines, closingAsAt);
    const inPeriod = periodOpenReceiptIn(lines, startDate, endDate, closingAsAt);
    const suspended = receiptStatusIsSuspended(receipt.status);
    const depositInPeriod = funded.amountNgn > 0 && !(treasury.hasTreasury && treasury.netNgn > 0) && inRange(funded.bankDateISO, startDate, endDate);
    const cashNgn = suspended
      ? 0
      : treasury.hasTreasury && treasury.netNgn > 0
        ? inPeriod.amountNgn
        : depositInPeriod
          ? funded.amountNgn
          : !treasury.hasTreasury && inRange(valueDate, startDate, endDate)
            ? atEnd.amountNgn
            : 0;
    const bankValueDateISO = depositInPeriod
      ? funded.bankDateISO
      : treasury.hasTreasury && treasury.netNgn > 0
        ? inPeriod.bankDateISO || valueDate
        : atEnd.valueDate || valueDate;
    const touchesPeriod =
      cashNgn > 0 ||
      inRange(bankValueDateISO, startDate, endDate) ||
      inRange(receiptDateISO, startDate, endDate) ||
      inRange(tickDate, startDate, endDate);
    if (!touchesPeriod) continue;
    const base = {
      receiptId: String(receipt.id || ''),
      ledgerEntryId: String(receipt.ledgerEntryId || receipt.ledger_entry_id || ''),
      dateISO: bankValueDateISO || receiptDateISO,
      bankValueDateISO,
      tickDateISO: tickDate,
      receiptDateISO,
      branchId: String(receipt.branchId || receipt.branch_id || ''),
      customerId: String(receipt.customerId || receipt.customer_id || ''),
      customerName: String(receipt.customerName || receipt.customer_name || ''),
      quotationRef: String(receipt.quotationRef || receipt.quotation_ref || ''),
      status: String(receipt.status || ''),
      amountNgn: roundMoney(receipt.amountNgn ?? receipt.amount_ngn),
      bankReceivedAmountNgn:
        receipt.bankReceivedAmountNgn != null || receipt.bank_received_amount_ngn != null
          ? roundMoney(receipt.bankReceivedAmountNgn ?? receipt.bank_received_amount_ngn)
          : null,
    };
    if (cashNgn > 0) {
      cashRows.push({
        ...base,
        kind: depositInPeriod ? 'bank_deposit' : 'receipt',
        cashNgn,
        reason: depositInPeriod ? 'bank_deposit' : atEnd.reason === 'partial_treasury_reversal' ? atEnd.reason : 'bank_confirmed',
        reversedTreasuryNgn: treasury.hasReversal ? treasury.reversedNgn : 0,
        depositId: depositInPeriod ? funded.depositId : '',
      });
      if (!tickDate || tickDate > endDate) {
        timingRows.push({
          ...base,
          cashNgn,
          tickDateISO: tickDate,
          detail: tickDate
            ? `In the bank on ${bankValueDateISO}. Confirmation tick is ${tickDate}, after the period.`
            : `In the bank on ${bankValueDateISO}. There is no confirmation tick.`,
        });
      }
      if (treasury.hasReversal && treasury.reversedNgn > 0) {
        cashExclusions.push({
          ...base,
          excludedNgn: treasury.reversedNgn,
          reason: 'partial_treasury_reversal',
          detail: `Treasury reversal of ₦${treasury.reversedNgn.toLocaleString('en-NG')} is excluded. ₦${cashNgn.toLocaleString('en-NG')} is still open on the bank and is counted.`,
        });
      }
    } else {
      const valueInPeriod = inRange(bankValueDateISO, startDate, endDate);
      const reason = atEnd.amountNgn > 0 && !valueInPeriod ? 'bank_confirmed_outside_period' : atEnd.reason;
      cashExclusions.push({
        ...base,
        excludedNgn: atEnd.amountNgn > 0 ? atEnd.amountNgn : treasury.hasTreasury ? Math.max(base.amountNgn, treasury.reversedNgn) : base.amountNgn,
        reason,
        detail: exclusionDetail(reason),
      });
    }
  }
  for (const line of openAdvanceInLines(advanceMovements, closingAsAt)) {
    const posted = toIsoDate(line.postedAtISO || line.posted_at_iso);
    if (!inRange(posted, startDate, endDate)) continue;
    const sourceId = String(line.sourceId || line.source_id || '').trim();
    if (sourceId && receiptIds.has(sourceId)) continue;
    const amountNgn = roundMoney(line.amountNgn ?? line.amount_ngn);
    if (!(amountNgn > 0)) continue;
    cashRows.push({
      kind: 'advance_in',
      receiptId: sourceId || String(line.id || ''),
      ledgerEntryId: sourceId,
      dateISO: posted,
      bankValueDateISO: posted,
      tickDateISO: '',
      receiptDateISO: posted,
      branchId: String(line.accountBranchId || line.branchId || ''),
      customerId: String(line.customerId || line.counterpartyId || ''),
      customerName: String(line.customerName || line.counterpartyName || ''),
      quotationRef: String(line.quotationRef || ''),
      status: 'Advance',
      amountNgn,
      bankReceivedAmountNgn: amountNgn,
      cashNgn: amountNgn,
      reason: 'advance_in',
      reversedTreasuryNgn: 0,
      treasuryAccountId: line.treasuryAccountId ?? line.treasury_account_id ?? '',
    });
  }
  cashRows.sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.receiptId.localeCompare(b.receiptId));
  timingRows.sort((a, b) => b.cashNgn - a.cashNgn || a.receiptId.localeCompare(b.receiptId));

  function refundNetAt(asAt) {
    const byQuote = new Map();
    const byCustomer = new Map();
    const byRefund = new Map();
    for (const line of refundMovements || []) {
      const posted = toIsoDate(line.postedAtISO || line.posted_at_iso);
      if (!onOrBefore(posted, asAt)) continue;
      const type = String(line.type || '').trim().toUpperCase();
      if (type !== 'REFUND_PAYOUT' && type !== 'REFUND_PAYOUT_REVERSAL_IN') continue;
      if (line.reversesMovementId || line.reverses_movement_id) {
        const original = String(line.reversesMovementId || line.reverses_movement_id);
        const prev = byRefund.get(original) || { amountNgn: 0, quotationRef: '', customerId: '', customerName: '', refundId: '' };
        prev.amountNgn = roundMoney(prev.amountNgn - Math.abs(roundMoney(line.amountNgn ?? line.amount_ngn)));
        byRefund.set(original, prev);
        continue;
      }
      const id = String(line.id || '');
      const prev = byRefund.get(id) || {
        amountNgn: 0,
        quotationRef: String(line.quotationRef || ''),
        customerId: String(line.customerId || ''),
        customerName: String(line.customerName || ''),
        refundId: String(line.refundId || line.sourceId || ''),
        postedAtISO: posted,
      };
      // Payouts are stored negative (cash out). A reversal-in is positive.
      const signedOut = type === 'REFUND_PAYOUT' ? Math.abs(roundMoney(line.amountNgn ?? line.amount_ngn)) : -Math.abs(roundMoney(line.amountNgn ?? line.amount_ngn));
      prev.amountNgn = roundMoney(prev.amountNgn + signedOut);
      prev.quotationRef = prev.quotationRef || String(line.quotationRef || '');
      prev.customerId = prev.customerId || String(line.customerId || '');
      prev.customerName = prev.customerName || String(line.customerName || '');
      byRefund.set(id, prev);
    }
    for (const row of byRefund.values()) {
      if (row.amountNgn === 0) continue;
      addMap(byQuote, row.quotationRef || '(no quote)', row.amountNgn);
      const key = customerKey(row.customerId, row.customerName) || '(no customer)';
      const prev = byCustomer.get(key) || { customerId: row.customerId, customerName: row.customerName, amountNgn: 0 };
      prev.amountNgn = roundMoney(prev.amountNgn + row.amountNgn);
      byCustomer.set(key, prev);
    }
    return { byQuote, byCustomer, lines: [...byRefund.entries()].map(([id, row]) => ({ id, ...row })) };
  }

  function refundRowsInPeriod() {
    const rows = [];
    for (const line of refundMovements || []) {
      const type = String(line.type || '').trim().toUpperCase();
      if (type !== 'REFUND_PAYOUT') continue;
      if (line.reversesMovementId || line.reverses_movement_id) continue;
      const posted = toIsoDate(line.postedAtISO || line.posted_at_iso);
      if (!inRange(posted, startDate, endDate)) continue;
      const reversedLater = (refundMovements || []).some((rev) => {
        const revId = String(rev.reversesMovementId || rev.reverses_movement_id || '');
        if (revId !== String(line.id || '')) return false;
        const revDate = toIsoDate(rev.postedAtISO || rev.posted_at_iso);
        return onOrBefore(revDate, closingAsAt);
      });
      if (reversedLater) continue;
      rows.push({
        movementId: String(line.id || ''),
        refundId: String(line.refundId || line.sourceId || ''),
        dateISO: posted,
        customerId: String(line.customerId || ''),
        customerName: String(line.customerName || ''),
        quotationRef: String(line.quotationRef || ''),
        amountNgn: Math.abs(roundMoney(line.amountNgn ?? line.amount_ngn)),
        refundBranchId: String(line.branchId || line.branch_id || ''),
      });
    }
    rows.sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.movementId.localeCompare(b.movementId));
    return rows;
  }

  function creditSnapshot(asAt) {
    const outByCustomer = new Map();
    const inByCustomer = new Map();
    const outByQuote = new Map();
    const inByQuote = new Map();
    for (const app of creditApplications || []) {
      const created = toIsoDate(app.createdAtISO || app.created_at_iso);
      if (!onOrBefore(created, asAt)) continue;
      const reversedAt = toIsoDate(app.reversedAtISO || app.reversed_at_iso);
      const status = normStatus(app.status);
      if (status === 'reversed' || status === 'cancelled') {
        if (!reversedAt || reversedAt <= asAt) continue;
      } else if (reversedAt && reversedAt <= asAt) continue;
      const amount = roundMoney(app.amountNgn ?? app.amount_ngn);
      if (amount <= 0) continue;
      const sourceRef = String(app.sourceQuotationRef || '').trim();
      const targetRef = String(app.targetQuotationRef || '').trim();
      const sourceQuote = quoteById.get(sourceRef);
      const targetQuote = quoteById.get(targetRef);
      const sourceCustomer = String(app.sourceCustomerId || sourceQuote?.customerId || app.customerId || '').trim();
      const targetCustomer = String(app.targetCustomerId || targetQuote?.customerId || '').trim();
      const sourceName = String(sourceQuote?.customerName || app.customerName || '');
      const targetName = String(targetQuote?.customerName || '');
      if (!targetCustomer || targetCustomer === sourceCustomer) continue;
      const sourceKey = customerKey(sourceCustomer, sourceName);
      const targetKey = customerKey(targetCustomer, targetName);
      if (sourceKey) {
        const prev = outByCustomer.get(sourceKey) || { customerId: sourceCustomer, customerName: sourceName, amountNgn: 0 };
        prev.amountNgn = roundMoney(prev.amountNgn + amount);
        outByCustomer.set(sourceKey, prev);
        addMap(outByQuote, sourceRef || '(no quote)', amount);
      }
      if (targetKey) {
        const prev = inByCustomer.get(targetKey) || { customerId: targetCustomer, customerName: targetName, amountNgn: 0 };
        prev.amountNgn = roundMoney(prev.amountNgn + amount);
        inByCustomer.set(targetKey, prev);
        addMap(inByQuote, targetRef || '(no quote)', amount);
      }
    }
    return { outByCustomer, inByCustomer, outByQuote, inByQuote };
  }

  function revenueSnapshot(asAt) {
    const byQuote = new Map();
    const byCustomer = new Map();
    for (const event of revenueEvents) {
      if (!onOrBefore(event.dateISO, asAt)) continue;
      addMap(byQuote, event.quotationRef, event.amountNgn);
      const key = customerKey(event.customerId, event.customerName) || '(no customer)';
      const prev = byCustomer.get(key) || { customerId: event.customerId, customerName: event.customerName, amountNgn: 0 };
      prev.amountNgn = roundMoney(prev.amountNgn + event.amountNgn);
      byCustomer.set(key, prev);
    }
    return { byQuote, byCustomer };
  }

  const postedAdjustments = input?.postedAdjustments || [];
  const debtorHoldIds = postedAdjustments
    .filter((row) => row.kind === 'DEBTOR_HOLD')
    .map((row) => String(row.customerId || '').trim())
    .filter(Boolean);
  for (const row of postedAdjustments) {
    if (row.kind !== 'CREDIT_NOTE' && row.kind !== 'DISCOUNT_ALLOWED') continue;
    const amountNgn = -Math.abs(roundMoney(row.amountNgn));
    if (!amountNgn) continue;
    const quotationRef = String(row.quotationRef || '').trim();
    const quote = quoteById.get(quotationRef);
    revenueEvents.push({
      dateISO: toIsoDate(row.dateISO),
      quotationRef: quotationRef || '(no quote)',
      customerId: String(row.customerId || quote?.customerId || ''),
      customerName: String(row.customerName || quote?.customerName || ''),
      branchId: String(row.branchId || quote?.branchId || ''),
      kind: row.kind === 'CREDIT_NOTE' ? 'credit_note' : 'discount_allowed',
      amountNgn,
      jobId: String(row.entityId || row.id || ''),
    });
  }

  const openingPaid = paidSnapshot(openingAsAt);
  const closingPaid = paidSnapshot(closingAsAt);
  const openingRevenue = revenueSnapshot(openingAsAt);
  const closingRevenue = revenueSnapshot(closingAsAt);
  const openingRefunds = refundNetAt(openingAsAt);
  const closingRefunds = refundNetAt(closingAsAt);
  const openingCredit = creditSnapshot(openingAsAt);
  const closingCredit = creditSnapshot(closingAsAt);
  const openingStaff = staffCoveredSnapshot(input?.staffPurchaseCredits || [], openingRevenue.byQuote, openingAsAt);
  const closingStaff = staffCoveredSnapshot(input?.staffPurchaseCredits || [], closingRevenue.byQuote, closingAsAt);

  function positionRows(paid, revenue, refunds, credit, staff) {
    const keys = new Set([
      ...paid.byCustomer.keys(),
      ...revenue.byCustomer.keys(),
      ...refunds.byCustomer.keys(),
      ...credit.outByCustomer.keys(),
      ...credit.inByCustomer.keys(),
      ...staff.byCustomer.keys(),
    ]);
    const rows = [];
    for (const key of keys) {
      const paidRow = paid.byCustomer.get(key);
      const revRow = revenue.byCustomer.get(key);
      const refRow = refunds.byCustomer.get(key);
      const outRow = credit.outByCustomer.get(key);
      const inRow = credit.inByCustomer.get(key);
      const staffRow = staff.byCustomer.get(key);
      const sample = paidRow || revRow || refRow || outRow || inRow || staffRow;
      const paidNgn = paidRow?.amountNgn || 0;
      const revenueNgn = revRow?.amountNgn || 0;
      const refundsNgn = refRow?.amountNgn || 0;
      const creditOutNgn = outRow?.amountNgn || 0;
      const creditInNgn = inRow?.amountNgn || 0;
      const staffSettledNgn = staffRow?.amountNgn || 0;
      const positionNgn = roundMoney(paidNgn + creditInNgn + staffSettledNgn - revenueNgn - refundsNgn - creditOutNgn);
      if (positionNgn === 0 && paidNgn === 0 && revenueNgn === 0) continue;
      rows.push({
        customerId: sample?.customerId || '',
        customerName: sample?.customerName || '',
        paidNgn,
        revenueNgn,
        refundsPaidNgn: refundsNgn,
        creditAppliedElsewhereNgn: creditOutNgn,
        creditReceivedNgn: creditInNgn,
        staffSettledNgn,
        positionNgn,
        kind: positionNgn > 0 ? 'advance' : positionNgn < 0 ? 'debtor' : 'nil',
      });
    }
    rows.sort((a, b) => a.customerName.localeCompare(b.customerName) || a.customerId.localeCompare(b.customerId));
    return rows;
  }

  function positionTotals(rows, staffReceivableNgn) {
    let advances = 0;
    let debtors = 0;
    for (const row of rows) {
      if (row.positionNgn > 0) advances += row.positionNgn;
      else if (row.positionNgn < 0) debtors += -row.positionNgn;
    }
    debtors += staffReceivableNgn || 0;
    return {
      advancesNgn: roundMoney(advances),
      debtorsNgn: roundMoney(debtors),
      netNgn: roundMoney(advances - debtors),
      rows,
      staffReceivableNgn: roundMoney(staffReceivableNgn || 0),
    };
  }

  const opening = positionTotals(
    positionRows(openingPaid, openingRevenue, openingRefunds, openingCredit, openingStaff),
    openingStaff.totalNgn
  );
  const closing = positionTotals(
    positionRows(closingPaid, closingRevenue, closingRefunds, closingCredit, closingStaff),
    closingStaff.totalNgn
  );

  const periodEvents = revenueEvents.filter((event) => inRange(event.dateISO, startDate, endDate));
  const byQuoteRevenue = new Map();
  for (const event of periodEvents) {
    const prev = byQuoteRevenue.get(event.quotationRef) || {
      quotationRef: event.quotationRef,
      customerId: event.customerId,
      customerName: event.customerName,
      branchId: event.branchId,
      goodsNgn: 0,
      accessoryNgn: 0,
      serviceNgn: 0,
      creditNoteNgn: 0,
      discountAllowedNgn: 0,
      metres: 0,
      jobs: [],
    };
    if (event.kind === 'goods') {
      prev.goodsNgn = roundMoney(prev.goodsNgn + event.amountNgn);
      prev.metres = Math.round((prev.metres + (event.metres || 0)) * 1000) / 1000;
      prev.jobs.push({
        jobId: event.jobId,
        dateISO: event.dateISO,
        metres: event.metres,
        unitPriceNgn: event.unitPriceNgn,
        revenueNgn: event.amountNgn,
        method: event.method,
      });
    } else if (event.kind === 'accessories') prev.accessoryNgn = roundMoney(prev.accessoryNgn + event.amountNgn);
    else if (event.kind === 'credit_note') prev.creditNoteNgn = roundMoney(prev.creditNoteNgn + event.amountNgn);
    else if (event.kind === 'discount_allowed') prev.discountAllowedNgn = roundMoney(prev.discountAllowedNgn + event.amountNgn);
    else prev.serviceNgn = roundMoney(prev.serviceNgn + event.amountNgn);
    byQuoteRevenue.set(event.quotationRef, prev);
  }
  const revenueByQuote = [...byQuoteRevenue.values()]
    .map((row) => ({
      ...row,
      totalNgn: roundMoney(row.goodsNgn + row.accessoryNgn + row.serviceNgn + row.creditNoteNgn + row.discountAllowedNgn),
    }))
    .sort((a, b) => b.totalNgn - a.totalNgn || a.quotationRef.localeCompare(b.quotationRef));

  const revenueNgn = roundMoney(periodEvents.reduce((s, event) => s + event.amountNgn, 0));
  const goodsNgn = roundMoney(periodEvents.filter((e) => e.kind === 'goods').reduce((s, e) => s + e.amountNgn, 0));
  const accessoryNgn = roundMoney(periodEvents.filter((e) => e.kind === 'accessories').reduce((s, e) => s + e.amountNgn, 0));
  const serviceNgn = roundMoney(periodEvents.filter((e) => e.kind === 'services').reduce((s, e) => s + e.amountNgn, 0));
  const creditNotesNgn = roundMoney(-periodEvents.filter((e) => e.kind === 'credit_note').reduce((s, e) => s + e.amountNgn, 0));
  const discountAllowedNgn = roundMoney(-periodEvents.filter((e) => e.kind === 'discount_allowed').reduce((s, e) => s + e.amountNgn, 0));
  const cashReceivedNgn = roundMoney(cashRows.reduce((s, row) => s + row.cashNgn, 0));
  const refundRows = refundRowsInPeriod();
  const refundsPaidNgn = roundMoney(refundRows.reduce((s, row) => s + row.amountNgn, 0));

  const impliedClosingNetNgn = roundMoney(opening.netNgn + cashReceivedNgn - refundsPaidNgn - revenueNgn);
  const differenceNgn = roundMoney(closing.netNgn - impliedClosingNetNgn);

  const causingQuotes = differenceNgn === 0 ? [] : bridgeCauseQuotes({
    openingPaid,
    closingPaid,
    openingRefunds,
    closingRefunds,
    openingRevenue,
    closingRevenue,
    openingCredit,
    closingCredit,
    cashRows,
    refundRows,
    periodEvents,
  });

  const byBranch = new Map();
  for (const row of revenueByQuote) {
    const key = row.branchId || '(no branch)';
    const prev = byBranch.get(key) || { branchId: key, revenueNgn: 0, quotes: 0 };
    prev.revenueNgn = roundMoney(prev.revenueNgn + row.totalNgn);
    prev.quotes += 1;
    byBranch.set(key, prev);
  }

  overQuoteMetres.sort((a, b) => b.excessValueNgn - a.excessValueNgn || a.quotationRef.localeCompare(b.quotationRef));
  const debtorView = buildClosingDebtorView({
    closingRows: closing.rows,
    quotations,
    closingPaid,
    closingRevenue,
    closingRefunds,
    closingCredit,
    receipts,
    bySource,
    closingAsAt,
    overQuoteMetres,
  });
  debtorView.buckets = buildDebtorBuckets({
    rows: closing.rows,
    timingRows,
    refundLines: closingRefunds.lines,
    refundDetails: input?.refunds || [],
  });
  debtorView.composition = buildDebtorComposition(closing.rows, closingStaff, debtorHoldIds);
  debtorView.composition.payeeRecovery = buildPayeeRecovery({
    excessCustomers: debtorView.composition.refundExcess.customers,
    refundCustomers: debtorView.buckets.refundExceedsOverpayment.customers,
    staffPayees: input?.staffPayees || [],
    statementBeneficiaries: input?.statementBeneficiaries || [],
  });
  debtorView.composition.refundExcess.reclassifiedNgn = debtorView.composition.payeeRecovery.totalNgn;
  debtorView.composition.refundExcess.note =
    'Reclassified into Refund overpaid – recoverable from payee. Staff payees are staff receivable lines inside that total. Cash, refunds, and revenue are unchanged.';
  if (discountAllowedNgn > 0) {
    debtorView.composition.roundingWriteOff.applied = debtorView.composition.roundingWriteOff.totalNgn === 0;
    debtorView.composition.roundingWriteOff.postedNgn = discountAllowedNgn;
    debtorView.composition.roundingWriteOff.note = debtorView.composition.roundingWriteOff.totalNgn === 0
      ? 'Posted as discount allowed on 30 September. No customer-debtor gap under ₦1,500 remains.'
      : 'Discount allowed is posted. A further gap under ₦1,500 is still open.';
  }
  const refundReview = buildRefundClassReview({
    periodRows: refundRows,
    refundDetails: input?.refunds || [],
    advanceReturnRefunds: input?.advanceReturnRefunds || [],
    postedAdjustments,
    excessCustomers: debtorView.buckets.refundExceedsOverpayment.customers,
    passThrough: input?.passThroughRefunds || [],
  });
  const moniepointCashCheck = buildMoniepointCashCheck({
    accountId: '4',
    tieOutReceiptIns: input?.tieOutReceiptIns || [],
    tieOutReversals: input?.tieOutReversals || [],
    receipts,
    cashRows,
    closingAsAt,
    nonSalesPassThrough: input?.nonSalesPassThrough || [],
  });
  const kadunaCashTieOut = buildKadunaCashTieOut({
    cashRows,
    receipts,
    bySource,
    quoteById,
    tieOutReceiptIns: input?.tieOutReceiptIns || [],
    tieOutReversals: input?.tieOutReversals || [],
    startDate,
    endDate,
    closingAsAt,
  });

  const branchBridge = buildBranchBridge({
    quoteById,
    openingPaid,
    closingPaid,
    openingRevenue,
    closingRevenue,
    openingRefunds,
    closingRefunds,
    openingCredit,
    closingCredit,
    cashRows,
    refundRows,
    periodEvents,
    openingNetNgn: opening.netNgn,
    closingNetNgn: closing.netNgn,
  });
  const acceptancePreview = buildAcceptancePreview({
    openingRows: opening.rows,
    closingRows: closing.rows,
    openingStaff: openingStaff,
    closingStaff,
    cashReceivedNgn,
    refundsPaidNgn,
    revenueNgn,
    openingNetNgn: opening.netNgn,
    closingNetNgn: closing.netNgn,
    refundLines: closingRefunds.lines,
    cashRows,
    refundDetails: input?.refunds || [],
    passThrough: input?.passThroughRefunds || [],
    priceReductionPosted: creditNotesNgn > 0,
    startDate,
    endDate,
    openingAsAt,
  });

  return {
    ok: true,
    scope: {
      branchScope: input?.branchScope || 'ALL',
      note: 'Revenue, cash, and refunds in this pack cover every branch. A refund is placed in the branch of its quotation, which is the branch of the revenue.',
    },
    definitions: {
      revenue:
        'Completed production metres × quote unit price, capped at the quoted metres. Metres above the quote are listed and are not revenue. Accessories (and ridge/flashing piece lines) on a goods quote go with the first completed job. Installation, transport, other services, and accessory-only quotes go on the delivery date, or when every live cutting list is Finished if there is no delivery. Void quotes are excluded. Receipts are not revenue.',
      cash: 'Customer receipts and advance receipts whose treasury line is posted in the period. That posting is the bank-statement date, not the confirmation tick. A receipt funded only by a bank-deposit allocation uses the deposit date. Suspended receipts, fully reversed treasury, and lines with no sales receipt are excluded. A partial reversal counts only the amount still open.',
      position:
        'Per customer, as at the date: bank-confirmed paid, including advance receipts and deposit-funded receipts, plus staff purchase credit that settled a quote, minus revenue, minus refunds, minus credit applied elsewhere, plus credit received. Positive is an advance. Negative is a customer debtor. Staff purchase credit is not customer cash; it is a staff receivable.',
      debtors:
        'Customer debtors are unpaid goods after bank cash and advances. Staff receivables are quotes settled by a staff purchase credit, plus refund excess paid to a staff account. Refund overpaid – recoverable from payee is the rest of the refund excess, grouped by the payee account. These three are the debtor total. Timing receipts are already in paid.',
      bridge:
        'Opening advances − opening debtors + cash received − refunds paid − revenue, compared with closing advances − closing debtors. Debtors include customer debtors, staff receivables, and refund excess. Cash and the paid balance use the same bank dates, including advances.',
    },
    period: { startDate, endDate, openingAsAt, closingAsAt },
    revenue: {
      totalNgn: revenueNgn,
      goodsNgn,
      accessoryNgn,
      serviceNgn,
      creditNotesNgn,
      discountAllowedNgn,
      quoteCount: revenueByQuote.length,
      byQuote: revenueByQuote,
      byBranch: [...byBranch.values()].sort((a, b) => b.revenueNgn - a.revenueNgn),
      overQuote: {
        quoteCount: overQuoteMetres.length,
        excessMetres: roundMetres(overQuoteMetres.reduce((s, row) => s + row.excessMetres, 0)),
        excessValueNgn: roundMoney(overQuoteMetres.reduce((s, row) => s + row.excessValueNgn, 0)),
        excessValueInPeriodNgn: roundMoney(overQuoteMetres.reduce((s, row) => s + row.excessValueInPeriodNgn, 0)),
        quotes: overQuoteMetres,
      },
    },
    unrecognised: collapseUnrecognised(unrecognised),
    exceptions,
    cash: {
      totalNgn: cashReceivedNgn,
      receiptCount: cashRows.length,
      rows: cashRows,
      exclusions: cashExclusions,
      inBankNotTicked: {
        totalNgn: roundMoney(timingRows.reduce((s, row) => s + row.cashNgn, 0)),
        count: timingRows.length,
        rows: timingRows,
      },
    },
    kadunaCashTieOut,
    moniepointCashCheck,
    branchBridge,
    acceptancePreview,
    heldPassThrough: buildHeldPassThrough({
      passThrough: input?.passThroughRefunds || [],
      closingRows: closing.rows,
      revenueEvents,
      cashRows,
      refundLines: closingRefunds.lines,
      cashReceivedNgn,
      refundsPaidNgn,
      revenueNgn,
      openingNetNgn: opening.netNgn,
      staffReceivableNgn: closing.staffReceivableNgn,
      startDate,
      endDate,
    }),
    posted: {
      creditNotesNgn,
      discountAllowedNgn,
      advanceReturnAccepted: postedAdjustments.some((row) => row.kind === 'ADVANCE_RETURN_ACCEPTED'),
      passThrough: 'held',
      septemberLocked: Boolean(input?.periodLocked),
    },
    advanceApplications: input?.advanceApplications || [],
    refunds: {
      totalNgn: refundsPaidNgn,
      count: refundRows.length,
      rows: refundReview.september.rows,
      review: refundReview,
    },
    opening: { asAt: openingAsAt, advancesNgn: opening.advancesNgn, debtorsNgn: opening.debtorsNgn, netNgn: opening.netNgn, customers: opening.rows },
    closing: {
      asAt: closingAsAt,
      advancesNgn: closing.advancesNgn,
      debtorsNgn: closing.debtorsNgn,
      netNgn: closing.netNgn,
      customers: closing.rows,
      debtors: debtorView,
    },
    bridge: {
      openingAdvancesNgn: opening.advancesNgn,
      openingDebtorsNgn: opening.debtorsNgn,
      openingNetNgn: opening.netNgn,
      cashReceivedNgn,
      refundsPaidNgn,
      revenueNgn,
      impliedClosingNetNgn,
      closingAdvancesNgn: closing.advancesNgn,
      closingDebtorsNgn: closing.debtorsNgn,
      closingNetNgn: closing.netNgn,
      differenceNgn,
      balances: differenceNgn === 0,
      causingQuotes,
    },
  };
}

function collapseUnrecognised(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const prev = map.get(row.quotationRef) || {
      quotationRef: row.quotationRef,
      customerId: row.customerId,
      customerName: row.customerName,
      branchId: row.branchId || '',
      bucket: row.bucket || 'jobs_still_open',
      cuttingListStatus: row.cuttingListStatus || '',
      accessoryNgn: 0,
      serviceNgn: 0,
      reasons: [],
    };
    prev.accessoryNgn = roundMoney(prev.accessoryNgn + (row.accessoryNgn || 0));
    prev.serviceNgn = roundMoney(prev.serviceNgn + (row.serviceNgn || 0));
    if (row.reason && !prev.reasons.includes(row.reason)) prev.reasons.push(row.reason);
    if (row.bucket) prev.bucket = row.bucket;
    if (row.cuttingListStatus) prev.cuttingListStatus = row.cuttingListStatus;
    if (row.branchId) prev.branchId = row.branchId;
    map.set(row.quotationRef, prev);
  }
  const list = [...map.values()]
    .map((row) => ({
      quotationRef: row.quotationRef,
      customerId: row.customerId,
      customerName: row.customerName,
      branchId: row.branchId,
      bucket: row.bucket,
      cuttingListStatus: row.cuttingListStatus,
      accessoryNgn: row.accessoryNgn,
      serviceNgn: row.serviceNgn,
      totalNgn: roundMoney(row.accessoryNgn + row.serviceNgn),
      reason: row.reasons.join(' '),
    }))
    .sort((a, b) => b.totalNgn - a.totalNgn || a.quotationRef.localeCompare(b.quotationRef));
  function pack(bucket, includeRows) {
    const subset = list.filter((row) => row.bucket === bucket);
    return {
      totalNgn: roundMoney(subset.reduce((s, row) => s + row.totalNgn, 0)),
      count: subset.length,
      ...(includeRows ? { rows: subset } : {}),
    };
  }
  return {
    totalNgn: roundMoney(list.reduce((s, row) => s + row.totalNgn, 0)),
    count: list.length,
    rows: list,
    completedButListOpen: pack('completed_but_list_open', true),
    noCompletedJob: pack('no_completed_job', false),
    noCuttingList: pack('no_cutting_list', false),
    jobsStillOpen: pack('jobs_still_open', true),
  };
}

function exclusionDetail(reason) {
  if (reason === 'suspended') return 'Receipt is Suspended.';
  if (reason === 'reversed') return 'Receipt status is Reversed.';
  if (reason === 'treasury_reversed') return 'The treasury line for this receipt is reversed.';
  if (reason === 'not_bank_confirmed') return 'This receipt has no treasury line and no confirmation tick.';
  if (reason === 'bank_confirmed_outside_period') return 'The bank-statement date is outside this period. It is in the advance/debtor balance for that date, not in this period\'s cash.';
  if (reason === 'zero') return 'Receipt amount is zero.';
  if (reason === 'outside_date') return 'Bank-confirmation date is after this cutoff.';
  return reason || 'Excluded.';
}

function unconfirmedOrSuspended(receipt, lines, asAt) {
  const doc = toIsoDate(receipt?.dateISO || receipt?.date_iso);
  const treasury = receiptTreasuryNetAsAt(receipt, lines, asAt);
  const existed = onOrBefore(doc, asAt) || treasury.hasTreasury;
  if (!existed) return { unconfirmedNgn: 0, suspendedNgn: 0 };
  if (treasury.hasTreasury && treasury.netNgn <= 0) return { unconfirmedNgn: 0, suspendedNgn: 0 };
  const valueDate = receiptBankValueDate(receipt, lines, asAt);
  if (valueDate && onOrBefore(valueDate, asAt) && !receiptStatusIsSuspended(receipt?.status) && !receiptStatusIsReversed(receipt?.status)) {
    return { unconfirmedNgn: 0, suspendedNgn: 0 };
  }
  if (receiptStatusIsReversed(receipt?.status)) return { unconfirmedNgn: 0, suspendedNgn: 0 };
  const amount = treasury.hasTreasury
    ? Math.max(0, treasury.netNgn)
    : roundMoney(
        (receipt?.bankReceivedAmountNgn ?? receipt?.bank_received_amount_ngn) > 0
          ? receipt.bankReceivedAmountNgn ?? receipt.bank_received_amount_ngn
          : receipt?.amountNgn ?? receipt?.amount_ngn
      );
  if (!(amount > 0)) return { unconfirmedNgn: 0, suspendedNgn: 0 };
  if (receiptStatusIsSuspended(receipt?.status)) return { unconfirmedNgn: 0, suspendedNgn: amount };
  if (valueDate && onOrBefore(valueDate, asAt)) return { unconfirmedNgn: 0, suspendedNgn: 0 };
  return { unconfirmedNgn: amount, suspendedNgn: 0 };
}

function refundDetailText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function salesReductionMarkers(text) {
  const s = String(text || '').toLowerCase();
  const hits = [];
  if (s.includes('substitution difference')) hits.push('Substitution difference');
  if (s.includes('unproduced meterage')) hits.push('Unproduced meterage');
  if (/\bdiscount\b/.test(s)) hits.push('discount');
  if (/\bprice\b/.test(s)) hits.push('price');
  return hits;
}

function parseStaffSplits(raw) {
  let rows = raw;
  if (typeof raw === 'string') {
    try {
      rows = JSON.parse(raw || '[]');
    } catch {
      rows = [];
    }
  }
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const account = row?.payoutAccount || {};
    return {
      name: String(account.partyName || row?.name || row?.staffName || row?.staff_name || account.payeeName || row?.payeeName || ''),
      bankName: String(account.payeeBankName || row?.bankName || row?.bank_name || row?.payeeBankName || ''),
      accountNo: String(account.payeeAccountNo || row?.accountNo || row?.account_no || row?.payeeAccountNo || ''),
      amountNgn: roundMoney(row?.amountNgn ?? row?.amount_ngn ?? row?.amount ?? 0),
    };
  });
}

/**
 * (a) revenue above bank-confirmed paid, before refunds.
 * (b) paid covers revenue, but refunds are larger than the overpayment.
 * (c) in the bank this period, confirmation tick after the period end.
 */
function buildDebtorBuckets(ctx) {
  const details = new Map();
  for (const refund of ctx.refundDetails || []) {
    const id = String(refund.refundId || refund.refund_id || '').trim();
    if (id) details.set(id, refund);
  }
  const refundsByCustomer = new Map();
  for (const line of ctx.refundLines || []) {
    if (!(line.amountNgn > 0)) continue;
    const refundId = String(line.refundId || '').trim();
    const key = customerKey(line.customerId, line.customerName) || '(no customer)';
    if (!refundsByCustomer.has(key)) refundsByCustomer.set(key, new Map());
    const byId = refundsByCustomer.get(key);
    const prev = byId.get(refundId || line.id) || {
      refundId: refundId || String(line.id || ''),
      quotationRef: String(line.quotationRef || ''),
      paidNgn: 0,
    };
    prev.paidNgn = roundMoney(prev.paidNgn + line.amountNgn);
    prev.quotationRef = prev.quotationRef || String(line.quotationRef || '');
    byId.set(refundId || line.id, prev);
  }

  const unpaidGoods = [];
  const refundExceeds = [];
  for (const row of ctx.rows || []) {
    const paidNgn = row.paidNgn || 0;
    const revenueNgn = row.revenueNgn || 0;
    const refundsNgn = row.refundsPaidNgn || 0;
    const key = customerKey(row.customerId, row.customerName) || '(no customer)';
    if (revenueNgn > paidNgn) {
      unpaidGoods.push({
        customerId: row.customerId,
        customerName: row.customerName,
        revenueNgn,
        paidNgn,
        refundsPaidNgn: refundsNgn,
        unpaidGoodsNgn: roundMoney(revenueNgn - paidNgn),
      });
    } else if (refundsNgn > paidNgn - revenueNgn) {
      const overpaymentNgn = roundMoney(paidNgn - revenueNgn);
      const refunds = [...(refundsByCustomer.get(key)?.values() || [])].map((refund) => {
        const meta = details.get(refund.refundId) || {};
        const reasonCategory = refundDetailText(meta.reasonCategory || meta.reason_category);
        const reason = refundDetailText(meta.reason);
        const calculation = refundDetailText(meta.calculationText || meta.calculation_lines_json);
        const markers = salesReductionMarkers(`${reasonCategory} ${reason} ${calculation}`);
        return {
          refundId: refund.refundId,
          quotationRef: refund.quotationRef || String(meta.quotationRef || meta.quotation_ref || ''),
          paidNgn: refund.paidNgn,
          reasonCategory,
          reason,
          payeeName: String(meta.payeeName || meta.payee_name || ''),
          payeeBankName: String(meta.payeeBankName || meta.payee_bank_name || ''),
          payeeAccountNo: String(meta.payeeAccountNo || meta.payee_account_no || ''),
          staffSplits: parseStaffSplits(meta.splits || meta.split_distributions_json),
          candidateSalesReduction: markers.length > 0,
          salesReductionMarkers: markers,
        };
      });
      refunds.sort((a, b) => b.paidNgn - a.paidNgn || a.refundId.localeCompare(b.refundId));
      refundExceeds.push({
        customerId: row.customerId,
        customerName: row.customerName,
        revenueNgn,
        paidNgn,
        refundsPaidNgn: refundsNgn,
        overpaymentNgn,
        excessRefundNgn: roundMoney(refundsNgn - overpaymentNgn),
        refunds,
      });
    }
  }
  unpaidGoods.sort((a, b) => b.unpaidGoodsNgn - a.unpaidGoodsNgn || a.customerName.localeCompare(b.customerName));
  refundExceeds.sort((a, b) => b.excessRefundNgn - a.excessRefundNgn || a.customerName.localeCompare(b.customerName));
  const timing = ctx.timingRows || [];
  const flagged = refundExceeds.reduce((s, row) => s + row.refunds.filter((refund) => refund.candidateSalesReduction).length, 0);
  const refundCount = refundExceeds.reduce((s, row) => s + row.refunds.length, 0);
  return {
    unpaidGoods: {
      totalNgn: roundMoney(unpaidGoods.reduce((s, row) => s + row.unpaidGoodsNgn, 0)),
      customerCount: unpaidGoods.length,
      customers: unpaidGoods,
    },
    refundExceedsOverpayment: {
      totalNgn: roundMoney(refundExceeds.reduce((s, row) => s + row.excessRefundNgn, 0)),
      customerCount: refundExceeds.length,
      refundCount,
      candidateSalesReductionCount: flagged,
      customers: refundExceeds,
    },
    timing: {
      totalNgn: roundMoney(timing.reduce((s, row) => s + row.cashNgn, 0)),
      count: timing.length,
      rows: timing,
      note: 'These receipts are already in bank-confirmed paid. The tick is after the period end.',
    },
  };
}

function buildClosingDebtorView(ctx) {
  const excessByQuote = new Map((ctx.overQuoteMetres || []).map((row) => [row.quotationRef, row]));
  const unconfirmedByQuote = new Map();
  const suspendedByQuote = new Map();
  const unconfirmedByCustomer = new Map();
  const suspendedByCustomer = new Map();
  for (const receipt of ctx.receipts || []) {
    const lines = movementsForReceipt(receipt, ctx.bySource);
    const parts = unconfirmedOrSuspended(receipt, lines, ctx.closingAsAt);
    if (!(parts.unconfirmedNgn > 0) && !(parts.suspendedNgn > 0)) continue;
    const ref = String(receipt.quotationRef || receipt.quotation_ref || '').trim();
    const key = customerKey(receipt.customerId || receipt.customer_id, receipt.customerName || receipt.customer_name) || '(no customer)';
    if (parts.unconfirmedNgn > 0) {
      addMap(unconfirmedByQuote, ref || '(no quote)', parts.unconfirmedNgn);
      addMap(unconfirmedByCustomer, key, parts.unconfirmedNgn);
    }
    if (parts.suspendedNgn > 0) {
      addMap(suspendedByQuote, ref || '(no quote)', parts.suspendedNgn);
      addMap(suspendedByCustomer, key, parts.suspendedNgn);
    }
  }

  const quotesByCustomer = new Map();
  const seenQuote = new Set();
  function ensureQuote(ref, customerId, customerName) {
    const id = String(ref || '').trim();
    if (!id) return;
    const key = customerKey(customerId, customerName);
    if (!key || seenQuote.has(`${key}|${id}`)) return;
    const paid = ctx.closingPaid.byQuote.get(id) || 0;
    const revenue = ctx.closingRevenue.byQuote.get(id) || 0;
    const refunds = ctx.closingRefunds.byQuote.get(id) || 0;
    const creditOut = ctx.closingCredit.outByQuote.get(id) || 0;
    const creditIn = ctx.closingCredit.inByQuote.get(id) || 0;
    const excess = excessByQuote.get(id);
    const unconfirmedNgn = unconfirmedByQuote.get(id) || 0;
    const suspendedNgn = suspendedByQuote.get(id) || 0;
    if (!(paid || revenue || refunds || creditOut || creditIn || excess || unconfirmedNgn || suspendedNgn)) return;
    seenQuote.add(`${key}|${id}`);
    const row = {
      quotationRef: id,
      branchId: String(excess?.branchId || ''),
      revenueNgn: revenue,
      paidNgn: paid,
      refundsPaidNgn: refunds,
      creditAppliedElsewhereNgn: creditOut,
      creditReceivedNgn: creditIn,
      positionNgn: roundMoney(paid + creditIn - revenue - refunds - creditOut),
      unconfirmedReceiptsNgn: unconfirmedNgn,
      suspendedReceiptsNgn: suspendedNgn,
      excessMetres: excess?.excessMetres || 0,
      excessValueNgn: excess?.excessValueNgn || 0,
    };
    if (!quotesByCustomer.has(key)) quotesByCustomer.set(key, []);
    quotesByCustomer.get(key).push(row);
  }
  for (const q of ctx.quotations || []) {
    const excess = excessByQuote.get(String(q.id || ''));
    ensureQuote(q.id, q.customerId, q.customerName);
    const list = quotesByCustomer.get(customerKey(q.customerId, q.customerName));
    const row = list?.find((item) => item.quotationRef === String(q.id || ''));
    if (row && q.branchId) row.branchId = String(q.branchId);
    if (row && excess && !row.excessValueNgn) {
      row.excessMetres = excess.excessMetres;
      row.excessValueNgn = excess.excessValueNgn;
    }
  }

  const debtors = (ctx.closingRows || []).filter((row) => row.positionNgn < 0);
  const branchTotals = new Map();
  let unconfirmedInDebtors = 0;
  let suspendedInDebtors = 0;
  let overQuoteWouldAdd = 0;
  const top = [];
  for (const row of debtors) {
    const key = customerKey(row.customerId, row.customerName) || '(no customer)';
    const debtorNgn = -row.positionNgn;
    const quotes = quotesByCustomer.get(key) || [];
    const unconfirmedNgn = unconfirmedByCustomer.get(key) || 0;
    const suspendedNgn = suspendedByCustomer.get(key) || 0;
    const fromUnconfirmed = Math.min(debtorNgn, unconfirmedNgn);
    const afterUnconfirmed = debtorNgn - fromUnconfirmed;
    const fromSuspended = Math.min(afterUnconfirmed, suspendedNgn);
    unconfirmedInDebtors += fromUnconfirmed;
    suspendedInDebtors += fromSuspended;
    const excessValueNgn = roundMoney(quotes.reduce((s, q) => s + (q.excessValueNgn || 0), 0));
    const excessMetres = roundMetres(quotes.reduce((s, q) => s + (q.excessMetres || 0), 0));
    const worse = roundMoney(row.positionNgn - excessValueNgn);
    const added = Math.max(0, -worse) - debtorNgn;
    overQuoteWouldAdd += added;
    const negQuotes = quotes.filter((q) => q.positionNgn < 0);
    const negSum = negQuotes.reduce((s, q) => s + -q.positionNgn, 0);
    const branchShares = new Map();
    if (negSum > 0) {
      let left = debtorNgn;
      negQuotes.forEach((q, index) => {
        const branchId = q.branchId || '(no branch)';
        const share = index === negQuotes.length - 1 ? left : roundMoney((debtorNgn * -q.positionNgn) / negSum);
        left = roundMoney(left - share);
        branchShares.set(branchId, roundMoney((branchShares.get(branchId) || 0) + share));
      });
    } else {
      branchShares.set('(unallocated)', debtorNgn);
    }
    for (const [branchId, amount] of branchShares) {
      branchTotals.set(branchId, roundMoney((branchTotals.get(branchId) || 0) + amount));
    }
    const branchList = [...branchShares.entries()].sort((a, b) => b[1] - a[1]);
    let cause = 'genuine unpaid';
    if (fromUnconfirmed >= debtorNgn && fromUnconfirmed > 0) cause = 'unconfirmed receipts';
    else if (fromUnconfirmed > 0) cause = 'unconfirmed receipts and genuine unpaid';
    else if (fromSuspended >= debtorNgn && fromSuspended > 0) cause = 'suspended receipts';
    else if (fromSuspended > 0) cause = 'suspended receipts and genuine unpaid';
    top.push({
      customerId: row.customerId,
      customerName: row.customerName,
      branchId: branchList[0]?.[0] || '',
      branches: branchList.map(([branchId, debtorsNgn]) => ({ branchId, debtorsNgn })),
      quotes: quotes.sort((a, b) => a.positionNgn - b.positionNgn || a.quotationRef.localeCompare(b.quotationRef)),
      revenueNgn: row.revenueNgn,
      paidNgn: row.paidNgn,
      refundsPaidNgn: row.refundsPaidNgn,
      creditAppliedElsewhereNgn: row.creditAppliedElsewhereNgn,
      creditReceivedNgn: row.creditReceivedNgn,
      positionNgn: row.positionNgn,
      unconfirmedReceiptsNgn: unconfirmedNgn,
      suspendedReceiptsNgn: suspendedNgn,
      excessMetres,
      excessValueNgn,
      cause,
    });
  }
  top.sort((a, b) => a.positionNgn - b.positionNgn || a.customerName.localeCompare(b.customerName));
  const debtorTotal = roundMoney(debtors.reduce((s, row) => s + -row.positionNgn, 0));
  const unconfirmedReceiptsNgn = roundMoney(unconfirmedInDebtors);
  const suspendedReceiptsNgn = roundMoney(suspendedInDebtors);
  const genuineUnpaidNgn = roundMoney(debtorTotal - unconfirmedReceiptsNgn - suspendedReceiptsNgn);
  return {
    totalNgn: debtorTotal,
    byBranch: [...branchTotals.entries()]
      .map(([branchId, debtorsNgn]) => ({ branchId, debtorsNgn }))
      .sort((a, b) => b.debtorsNgn - a.debtorsNgn),
    top20: top.slice(0, 20),
    causes: {
      overQuoteMetresNgn: roundMoney(overQuoteWouldAdd),
      overQuoteMetresInDebtorTotal: false,
      unconfirmedReceiptsNgn,
      suspendedReceiptsNgn,
      genuineUnpaidNgn,
      note: 'The debtor total is unconfirmed receipts + suspended receipts + genuine unpaid. Over-quote metres are not revenue, so they are not inside the debtor total. overQuoteMetresNgn is how much debtors would rise if those extra metres were recognised.',
    },
  };
}

/**
 * Review label only. The headline report does not apply it.
 * ADVANCE_RETURN is unproduced meterage: it returns advance and does not reduce revenue.
 * PRICE_REDUCTION is substitution, price, or discount: a credit note, and it does reduce revenue once accepted.
 * PASS_THROUGH drops both the receipt and the refund. EXCESS stays a receivable from the payee.
 * A refund that mentions unproduced meterage is ADVANCE_RETURN even when it also mentions price.
 */
export function classifyPhase1Refund(refundId, markers, passThroughIds, advanceReturnIds) {
  const id = String(refundId || '');
  if (passThroughIds && passThroughIds.has(id)) return 'PASS_THROUGH';
  if (advanceReturnIds && advanceReturnIds.has(id)) return 'ADVANCE_RETURN';
  const list = markers || [];
  if (list.includes('Unproduced meterage')) return 'ADVANCE_RETURN';
  if (list.includes('Substitution difference') || list.includes('price') || list.includes('discount')) return 'PRICE_REDUCTION';
  return 'EXCESS';
}

function buildRefundClassReview(ctx) {
  const details = new Map();
  for (const refund of ctx.refundDetails || []) {
    const id = String(refund.refundId || refund.refund_id || '').trim();
    if (id) details.set(id, refund);
  }
  const passThrough = new Map();
  for (const row of ctx.passThrough || []) {
    const id = String(row.refundId || '').trim();
    if (id) passThrough.set(id, row);
  }
  const advanceReturnIds = new Set(
    (ctx.advanceReturnRefunds || []).map((row) => String(row.refundId || '').trim()).filter(Boolean)
  );
  function describe(refundId) {
    const meta = details.get(refundId) || {};
    const reasonCategory = refundDetailText(meta.reasonCategory || meta.reason_category);
    const reason = refundDetailText(meta.reason);
    const calculation = refundDetailText(meta.calculationText || meta.calculation_lines_json);
    return {
      meta,
      reasonCategory,
      reason,
      markers: salesReductionMarkers(`${reasonCategory} ${reason} ${calculation}`),
    };
  }
  const postedIds = new Set(
    (ctx.postedAdjustments || [])
      .filter((row) => row.kind === 'CREDIT_NOTE' || row.kind === 'ADVANCE_RETURN_ACCEPTED' || row.kind === 'REFUND_FLAG')
      .map((row) => String(row.entityId || row.refundId || '').trim())
  );
  const septemberRows = (ctx.periodRows || []).map((row) => {
    const info = describe(row.refundId);
    const pair = passThrough.get(row.refundId);
    const refundClass = classifyPhase1Refund(row.refundId, info.markers, passThrough, advanceReturnIds);
    const postedKind = refundClass === 'PRICE_REDUCTION' || refundClass === 'ADVANCE_RETURN';
    return {
      ...row,
      reasonCategory: info.reasonCategory,
      reason: info.reason,
      payeeName: String(info.meta.payeeName || info.meta.payee_name || ''),
      payeeBankName: String(info.meta.payeeBankName || info.meta.payee_bank_name || ''),
      payeeAccountNo: String(info.meta.payeeAccountNo || info.meta.payee_account_no || ''),
      salesReductionMarkers: info.markers,
      refundClass,
      linkedReceiptId: pair ? String(pair.receiptId || '') : '',
      applied: postedKind && postedIds.has(String(row.refundId || '')),
      flag: postedIds.has(String(row.refundId || '')) && (ctx.postedAdjustments || []).some((item) => item.kind === 'REFUND_FLAG' && String(item.entityId || '') === String(row.refundId || ''))
        ? 'refund without confirmed cash'
        : '',
    };
  });
  const seen = new Set();
  const candidates = [];
  function pushCandidate(row) {
    const id = String(row.refundId || '').trim();
    if (!id || seen.has(id) || passThrough.has(id)) return;
    if (!(row.salesReductionMarkers || []).length && !row.candidateSalesReduction) return;
    seen.add(id);
    candidates.push({
      refundId: id,
      customerName: row.customerName || '',
      quotationRef: row.quotationRef || '',
      paidNgn: row.paidNgn || row.amountNgn || 0,
      reasonCategory: row.reasonCategory || '',
      payeeName: row.payeeName || '',
      payeeBankName: row.payeeBankName || '',
      salesReductionMarkers: row.salesReductionMarkers || row.markers || [],
      refundClass: classifyPhase1Refund(id, row.salesReductionMarkers || row.markers || [], passThrough, advanceReturnIds),
      inSeptember: septemberRows.some((item) => item.refundId === id),
      applied: false,
    });
  }
  for (const row of septemberRows) {
    if (row.refundClass === 'PRICE_REDUCTION' || row.refundClass === 'ADVANCE_RETURN') pushCandidate(row);
  }
  for (const customer of ctx.excessCustomers || []) {
    for (const refund of customer.refunds || []) {
      pushCandidate({ ...refund, customerName: customer.customerName });
    }
  }
  candidates.sort((a, b) => b.paidNgn - a.paidNgn || a.refundId.localeCompare(b.refundId));
  function total(klass) {
    return roundMoney(septemberRows.filter((row) => row.refundClass === klass).reduce((sum, row) => sum + row.amountNgn, 0));
  }
  const pricePosted = septemberRows.some((row) => row.refundClass === 'PRICE_REDUCTION' && row.applied);
  const advancePosted = septemberRows.some((row) => row.refundClass === 'ADVANCE_RETURN' && row.applied);
  return {
    applied: pricePosted || advancePosted,
    note: pricePosted
      ? 'PRICE_REDUCTION is posted as a credit note and reduces revenue. ADVANCE_RETURN is accepted and does not reduce revenue. PASS_THROUGH is not posted.'
      : 'Review only. Nothing was posted. ADVANCE_RETURN gives back unproduced-meterage advance and does not reduce revenue. PRICE_REDUCTION is a credit note and would reduce revenue. PASS_THROUGH would leave out both the receipt and the refund. EXCESS stays a receivable from the payee.',
    september: {
      count: septemberRows.length,
      advanceReturnNgn: total('ADVANCE_RETURN'),
      advanceReturnCount: septemberRows.filter((row) => row.refundClass === 'ADVANCE_RETURN').length,
      priceReductionNgn: total('PRICE_REDUCTION'),
      priceReductionCount: septemberRows.filter((row) => row.refundClass === 'PRICE_REDUCTION').length,
      passThroughNgn: total('PASS_THROUGH'),
      passThroughCount: septemberRows.filter((row) => row.refundClass === 'PASS_THROUGH').length,
      excessNgn: total('EXCESS'),
      excessCount: septemberRows.filter((row) => row.refundClass === 'EXCESS').length,
      rows: septemberRows,
    },
    priceReductionCandidates: candidates.filter((row) => row.refundClass === 'PRICE_REDUCTION'),
    advanceReturnCandidates: candidates.filter((row) => row.refundClass === 'ADVANCE_RETURN'),
  };
}

function quoteBranchId(quoteById, ref) {
  const id = String(ref || '').trim();
  if (!id || id === '(no quote)') return '';
  return String(quoteById.get(id)?.branchId || '');
}

function buildBranchBridge(ctx) {
  const quoteById = ctx.quoteById;
  function branchOf(ref, fallback) {
    return quoteBranchId(quoteById, ref) || fallback || '(unallocated)';
  }
  function blank() {
    return { paidNgn: 0, revenueNgn: 0, refundsNgn: 0, creditInNgn: 0, creditOutNgn: 0 };
  }
  function nets(paid, revenue, refunds, credit) {
    const rows = new Map();
    function bump(branch, field, amount) {
      if (!amount) return;
      const key = branch || '(unallocated)';
      const row = rows.get(key) || blank();
      row[field] = roundMoney(row[field] + amount);
      rows.set(key, row);
    }
    for (const [ref, amount] of paid.byQuote || []) {
      if (ref === '(no quote)') continue;
      bump(branchOf(ref), 'paidNgn', amount);
    }
    for (const [branch, amount] of paid.unassignedByBranch || []) bump(branch, 'paidNgn', amount);
    for (const [ref, amount] of revenue.byQuote || []) bump(branchOf(ref), 'revenueNgn', amount);
    for (const [ref, amount] of refunds.byQuote || []) bump(branchOf(ref), 'refundsNgn', amount);
    for (const [ref, amount] of credit.inByQuote || []) bump(branchOf(ref), 'creditInNgn', amount);
    for (const [ref, amount] of credit.outByQuote || []) bump(branchOf(ref), 'creditOutNgn', amount);
    const netsByBranch = new Map();
    for (const [branch, row] of rows) {
      netsByBranch.set(branch, roundMoney(row.paidNgn + row.creditInNgn - row.revenueNgn - row.refundsNgn - row.creditOutNgn));
    }
    return netsByBranch;
  }
  const openingNets = nets(ctx.openingPaid, ctx.openingRevenue, ctx.openingRefunds, ctx.openingCredit);
  const closingNets = nets(ctx.closingPaid, ctx.closingRevenue, ctx.closingRefunds, ctx.closingCredit);
  const period = new Map();
  function addPeriod(branch, field, amount) {
    const key = branch || '(unallocated)';
    const row = period.get(key) || { cashNgn: 0, refundsNgn: 0, revenueNgn: 0 };
    row[field] = roundMoney(row[field] + amount);
    period.set(key, row);
  }
  for (const row of ctx.cashRows || []) addPeriod(branchOf(row.quotationRef, row.branchId), 'cashNgn', row.cashNgn);
  const refundBranchMismatches = [];
  for (const row of ctx.refundRows || []) {
    const quoteBranch = quoteBranchId(quoteById, row.quotationRef);
    const recorded = String(row.refundBranchId || '');
    addPeriod(branchOf(row.quotationRef, recorded), 'refundsNgn', row.amountNgn);
    if (quoteBranch && recorded && quoteBranch !== recorded) {
      refundBranchMismatches.push({
        refundId: row.refundId,
        quotationRef: row.quotationRef,
        amountNgn: row.amountNgn,
        revenueBranchId: quoteBranch,
        refundBranchId: recorded,
      });
    }
  }
  for (const event of ctx.periodEvents || []) addPeriod(event.branchId || '(unallocated)', 'revenueNgn', event.amountNgn);
  const keys = new Set([...openingNets.keys(), ...closingNets.keys(), ...period.keys()]);
  const branches = [...keys].sort().map((branchId) => {
    const flow = period.get(branchId) || { cashNgn: 0, refundsNgn: 0, revenueNgn: 0 };
    const openingNetNgn = openingNets.get(branchId) || 0;
    const closingNetNgn = closingNets.get(branchId) || 0;
    const impliedClosingNetNgn = roundMoney(openingNetNgn + flow.cashNgn - flow.refundsNgn - flow.revenueNgn);
    return {
      branchId,
      openingNetNgn,
      cashNgn: flow.cashNgn,
      refundsNgn: flow.refundsNgn,
      revenueNgn: flow.revenueNgn,
      closingNetNgn,
      impliedClosingNetNgn,
      differenceNgn: roundMoney(closingNetNgn - impliedClosingNetNgn),
    };
  });
  const sum = branches.reduce(
    (total, row) => ({
      openingNetNgn: roundMoney(total.openingNetNgn + row.openingNetNgn),
      cashNgn: roundMoney(total.cashNgn + row.cashNgn),
      refundsNgn: roundMoney(total.refundsNgn + row.refundsNgn),
      revenueNgn: roundMoney(total.revenueNgn + row.revenueNgn),
      closingNetNgn: roundMoney(total.closingNetNgn + row.closingNetNgn),
      differenceNgn: roundMoney(total.differenceNgn + row.differenceNgn),
    }),
    { openingNetNgn: 0, cashNgn: 0, refundsNgn: 0, revenueNgn: 0, closingNetNgn: 0, differenceNgn: 0 }
  );
  return {
    note: 'Each branch uses the quotation branch for revenue, cash on that quote, and refunds. A refund recorded on another branch is still reported with its quotation. Unassigned cash has no quotation.',
    branches,
    totals: sum,
    agreesWithPack: sum.differenceNgn === 0 && sum.openingNetNgn === ctx.openingNetNgn && sum.closingNetNgn === ctx.closingNetNgn && sum.cashNgn === roundMoney((ctx.cashRows || []).reduce((s, row) => s + row.cashNgn, 0)),
    refundBranchMismatches,
  };
}

function buildHeldPassThrough(ctx) {
  const pairs = ctx.passThrough || [];
  const receiptIds = new Set(pairs.map((row) => String(row.receiptId || '')).filter(Boolean));
  const refundIds = new Set(pairs.map((row) => String(row.refundId || '')).filter(Boolean));
  const quoteByRefund = new Map();
  let cashCut = 0;
  let refundCut = 0;
  let revenueCut = 0;
  const cashByCustomer = new Map();
  const refundByCustomer = new Map();
  const revenueByCustomer = new Map();
  for (const row of ctx.refundLines || []) {
    if (!refundIds.has(String(row.refundId || ''))) continue;
    if (row.quotationRef) quoteByRefund.set(String(row.refundId), String(row.quotationRef));
    const posted = toIsoDate(row.postedAtISO);
    if (!inRange(posted, ctx.startDate, ctx.endDate) || !(row.amountNgn > 0)) continue;
    refundCut = roundMoney(refundCut + row.amountNgn);
    addMap(refundByCustomer, customerKey(row.customerId, row.customerName) || '(no customer)', row.amountNgn);
  }
  for (const row of ctx.cashRows || []) {
    if (!receiptIds.has(String(row.receiptId || ''))) continue;
    if (!inRange(toIsoDate(row.bankValueDateISO || row.dateISO), ctx.startDate, ctx.endDate)) continue;
    cashCut = roundMoney(cashCut + row.cashNgn);
    addMap(cashByCustomer, customerKey(row.customerId, row.customerName) || '(no customer)', row.cashNgn);
  }
  const quoteIds = new Set([...quoteByRefund.values(), ...pairs.map((row) => String(row.quotationRef || '')).filter(Boolean)]);
  for (const event of ctx.revenueEvents || []) {
    if (!quoteIds.has(String(event.quotationRef || ''))) continue;
    if (event.kind !== 'services' && event.kind !== 'goods' && event.kind !== 'accessories') continue;
    if (event.kind !== 'services') continue;
    if (!inRange(event.dateISO, ctx.startDate, ctx.endDate)) continue;
    revenueCut = roundMoney(revenueCut + event.amountNgn);
    addMap(revenueByCustomer, customerKey(event.customerId, event.customerName) || '(no customer)', event.amountNgn);
  }
  const rows = (ctx.closingRows || []).map((row) => {
    const key = customerKey(row.customerId, row.customerName) || '(no customer)';
    const paidNgn = roundMoney((row.paidNgn || 0) - (cashByCustomer.get(key) || 0));
    const revenueNgn = roundMoney((row.revenueNgn || 0) - (revenueByCustomer.get(key) || 0));
    const refundsPaidNgn = roundMoney((row.refundsPaidNgn || 0) - (refundByCustomer.get(key) || 0));
    const positionNgn = roundMoney(paidNgn + (row.creditReceivedNgn || 0) + (row.staffSettledNgn || 0) - revenueNgn - refundsPaidNgn - (row.creditAppliedElsewhereNgn || 0));
    return { ...row, paidNgn, revenueNgn, refundsPaidNgn, positionNgn };
  });
  const isa = rows.find((row) => row.customerId === 'CUS-KD-26-0510') || null;
  const closing = positionFromRows(rows, ctx.staffReceivableNgn || 0);
  const revenueNgn = roundMoney((ctx.revenueNgn || 0) - revenueCut);
  const cashNgn = roundMoney((ctx.cashReceivedNgn || 0) - cashCut);
  const refundsNgn = roundMoney((ctx.refundsPaidNgn || 0) - refundCut);
  const implied = roundMoney((ctx.openingNetNgn || 0) + cashNgn - refundsNgn - revenueNgn);
  return {
    applied: false,
    held: true,
    reason: 'Held until the owner confirms the additional services on QT-KD-26-1643 were not Zarewa work.',
    removes: ['receipt', 'refund', 'service revenue'],
    cashNgn: cashCut,
    refundsNgn: refundCut,
    revenueNgn: revenueCut,
    revenueAfterNgn: revenueNgn,
    qsIsaPositionNgn: isa ? isa.positionNgn : null,
    bridge: {
      impliedClosingNetNgn: implied,
      closingNetNgn: closing.netNgn,
      differenceNgn: roundMoney(closing.netNgn - implied),
    },
  };
}

function markersForRefund(meta) {
  const reasonCategory = refundDetailText(meta?.reasonCategory || meta?.reason_category);
  const reason = refundDetailText(meta?.reason);
  const calculation = refundDetailText(meta?.calculationText || meta?.calculation_lines_json);
  return salesReductionMarkers(`${reasonCategory} ${reason} ${calculation}`);
}

function buildAcceptancePreview(ctx) {
  const details = new Map();
  for (const refund of ctx.refundDetails || []) {
    const id = String(refund.refundId || '').trim();
    if (id) details.set(id, refund);
  }
  const passThrough = new Map();
  const passReceiptIds = new Set();
  for (const row of ctx.passThrough || []) {
    const id = String(row.refundId || '').trim();
    if (!id) continue;
    passThrough.set(id, row);
    if (row.receiptId) passReceiptIds.add(String(row.receiptId));
  }
  function klass(refundId) {
    return classifyPhase1Refund(refundId, markersForRefund(details.get(refundId)), passThrough);
  }
  function customerAdjustments(asAt) {
    const priceReduction = new Map();
    const passRefund = new Map();
    for (const line of ctx.refundLines || []) {
      const posted = toIsoDate(line.postedAtISO);
      if (!onOrBefore(posted, asAt) || !(line.amountNgn > 0)) continue;
      const key = customerKey(line.customerId, line.customerName) || '(no customer)';
      const kind = klass(line.refundId);
      if (kind === 'PRICE_REDUCTION' && !ctx.priceReductionPosted) addMap(priceReduction, key, line.amountNgn);
      if (kind === 'PASS_THROUGH') addMap(passRefund, key, line.amountNgn);
    }
    return { priceReduction, passRefund };
  }
  function passPaidAt(asAt) {
    const byCustomer = new Map();
    let total = 0;
    for (const row of ctx.cashRows || []) {
      if (!passReceiptIds.has(String(row.receiptId || ''))) continue;
      const posted = toIsoDate(row.bankValueDateISO || row.dateISO);
      if (!onOrBefore(posted, asAt)) continue;
      total = roundMoney(total + row.cashNgn);
      addMap(byCustomer, customerKey(row.customerId, row.customerName) || '(no customer)', row.cashNgn);
    }
    return { total, byCustomer };
  }
  const openingAdj = customerAdjustments(ctx.openingAsAt);
  const closingAdj = customerAdjustments(ctx.closingAsAt || ctx.endDate);
  const openingPassPaid = passPaidAt(ctx.openingAsAt);
  const closingPassPaid = passPaidAt(ctx.closingAsAt || ctx.endDate);
  function adjustRows(rows, adj, passPaid) {
    return (rows || []).map((row) => {
      const key = customerKey(row.customerId, row.customerName) || '(no customer)';
      const revenueCut = adj.priceReduction.get(key) || 0;
      const refundCut = adj.passRefund.get(key) || 0;
      const paidCut = passPaid.byCustomer.get(key) || 0;
      const paidNgn = roundMoney((row.paidNgn || 0) - paidCut);
      const revenueNgn = roundMoney((row.revenueNgn || 0) - revenueCut);
      const refundsPaidNgn = roundMoney((row.refundsPaidNgn || 0) - refundCut);
      const positionNgn = roundMoney(paidNgn + (row.creditReceivedNgn || 0) + (row.staffSettledNgn || 0) - revenueNgn - refundsPaidNgn - (row.creditAppliedElsewhereNgn || 0));
      return { ...row, paidNgn, revenueNgn, refundsPaidNgn, positionNgn, kind: positionNgn > 0 ? 'advance' : positionNgn < 0 ? 'debtor' : 'nil' };
    }).filter((row) => !(row.positionNgn === 0 && row.paidNgn === 0 && row.revenueNgn === 0 && row.refundsPaidNgn === 0));
  }
  const openingRows = adjustRows(ctx.openingRows, openingAdj, openingPassPaid);
  const closingRows = adjustRows(ctx.closingRows, closingAdj, closingPassPaid);
  const opening = positionFromRows(openingRows, ctx.openingStaff?.totalNgn || 0);
  const closing = positionFromRows(closingRows, ctx.closingStaff?.totalNgn || 0);
  let periodPriceReduction = 0;
  let periodPassRefund = 0;
  for (const line of ctx.refundLines || []) {
    const posted = toIsoDate(line.postedAtISO);
    if (!inRange(posted, ctx.startDate, ctx.endDate) || !(line.amountNgn > 0)) continue;
    const kind = klass(line.refundId);
    if (kind === 'PRICE_REDUCTION' && !ctx.priceReductionPosted) periodPriceReduction = roundMoney(periodPriceReduction + line.amountNgn);
    if (kind === 'PASS_THROUGH') periodPassRefund = roundMoney(periodPassRefund + line.amountNgn);
  }
  let periodPassCash = 0;
  for (const row of ctx.cashRows || []) {
    if (!passReceiptIds.has(String(row.receiptId || ''))) continue;
    if (!inRange(toIsoDate(row.bankValueDateISO || row.dateISO), ctx.startDate, ctx.endDate)) continue;
    periodPassCash = roundMoney(periodPassCash + row.cashNgn);
  }
  const revenuePreview = roundMoney(ctx.revenueNgn - periodPriceReduction);
  const refundsPreview = roundMoney(ctx.refundsPaidNgn - periodPassRefund);
  const cashPreview = roundMoney(ctx.cashReceivedNgn - periodPassCash);
  const implied = roundMoney(opening.netNgn + cashPreview - refundsPreview - revenuePreview);
  const composition = buildDebtorComposition(closingRows, ctx.closingStaff || { totalNgn: 0, rows: [] });
  return {
    applied: false,
    accepts: ['PASS_THROUGH', 'PRICE_REDUCTION'],
    notAccepted: ['ADVANCE_RETURN', 'EXCESS'],
    note: 'Preview only. PASS_THROUGH removes the receipt from cash and the refund from refunds. PRICE_REDUCTION reduces revenue on the refund date and leaves the cash refund in place. ADVANCE_RETURN is not accepted here: it does not reduce revenue.',
    priceReductionNgn: periodPriceReduction,
    passThroughCashNgn: periodPassCash,
    passThroughRefundNgn: periodPassRefund,
    revenueNgn: revenuePreview,
    refundsNgn: refundsPreview,
    cashNgn: cashPreview,
    opening: { advancesNgn: opening.advancesNgn, debtorsNgn: opening.debtorsNgn, netNgn: opening.netNgn },
    closing: { advancesNgn: closing.advancesNgn, debtorsNgn: closing.debtorsNgn, netNgn: closing.netNgn },
    debtors: composition,
    bridge: {
      impliedClosingNetNgn: implied,
      closingNetNgn: closing.netNgn,
      differenceNgn: roundMoney(closing.netNgn - implied),
      balances: roundMoney(closing.netNgn - implied) === 0,
    },
  };
}

function positionFromRows(rows, staffReceivableNgn) {
  let advances = 0;
  let debtors = 0;
  for (const row of rows || []) {
    if (row.positionNgn > 0) advances += row.positionNgn;
    else if (row.positionNgn < 0) debtors += -row.positionNgn;
  }
  debtors += staffReceivableNgn || 0;
  return {
    advancesNgn: roundMoney(advances),
    debtorsNgn: roundMoney(debtors),
    netNgn: roundMoney(advances - debtors),
  };
}

function payeeNameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\(staff\)/g, ' ')
    .replace(/·[\s\S]*$/, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 3);
}

function matchingStaffPayee(payeeName, accountDigits, staffPayees) {
  const tokens = new Set(payeeNameTokens(payeeName));
  for (const staff of staffPayees || []) {
    const staffDigits = payeeAccountDigits(staff.accountNo || staff.bank_account_no);
    if (accountDigits && staffDigits && accountDigits === staffDigits) return staff;
    const shared = payeeNameTokens(staff.name).filter((token) => tokens.has(token));
    if (shared.length >= 2) return staff;
  }
  return null;
}

function allocateLargestRemainder(weights, owedNgn) {
  const clean = weights.map((weight) => Math.max(0, roundMoney(weight)));
  const total = clean.reduce((sum, weight) => sum + weight, 0);
  if (owedNgn <= 0 || !clean.length) return clean.map(() => 0);
  if (total <= 0) return clean.map((_, index) => (index === 0 ? owedNgn : 0));
  const exact = clean.map((weight) => (owedNgn * weight) / total);
  const base = exact.map((value) => Math.floor(value + 1e-9));
  let left = owedNgn - base.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - base[index] }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const row of order) {
    if (left <= 0) break;
    base[row.index] += 1;
    left -= 1;
  }
  return base;
}

/**
 * Moves refund excess out of customer debtors into the payee who received it.
 * Statement account wins when the bank line has one. Staff payees stay inside this total.
 */
export function buildPayeeRecovery({ excessCustomers, refundCustomers, staffPayees, statementBeneficiaries } = {}) {
  const refundsByCustomer = new Map();
  for (const customer of refundCustomers || []) {
    const id = String(customer.customerId || '');
    if (id) refundsByCustomer.set(id, customer.refunds || []);
  }
  const statementByRefund = new Map();
  for (const row of statementBeneficiaries || []) {
    const id = String(row.refundId || '').trim();
    if (id) statementByRefund.set(id, row);
  }
  const groups = new Map();
  const unresolved = [];
  for (const customer of excessCustomers || []) {
    const refunds = refundsByCustomer.get(String(customer.customerId || '')) || [];
    const parts = [];
    for (const refund of refunds) {
      const splits = (refund.staffSplits || []).filter((split) => roundMoney(split.amountNgn) > 0);
      if (splits.length) {
        for (const split of splits) {
          parts.push({
            refundId: refund.refundId,
            weight: split.amountNgn,
            payeeName: split.name || refund.payeeName,
            payeeBankName: split.bankName || refund.payeeBankName,
            payeeAccountNo: split.accountNo || refund.payeeAccountNo,
          });
        }
      } else {
        parts.push({
          refundId: refund.refundId,
          weight: refund.paidNgn,
          payeeName: refund.payeeName,
          payeeBankName: refund.payeeBankName,
          payeeAccountNo: refund.payeeAccountNo,
        });
      }
    }
    if (!parts.length) {
      parts.push({ refundId: '', weight: customer.owedNgn, payeeName: '', payeeBankName: '', payeeAccountNo: '' });
    }
    const shares = allocateLargestRemainder(parts.map((part) => part.weight), roundMoney(customer.owedNgn));
    parts.forEach((part, index) => {
      const allocatedNgn = shares[index] || 0;
      if (!(allocatedNgn > 0)) return;
      const statement = statementByRefund.get(String(part.refundId || '')) || {};
      const statementAccount = String(statement.accountNo || '');
      const recordedAccount = String(part.payeeAccountNo || '');
      const fromStatement = !payeeAccountRejection(statementAccount);
      const fromRecorded = !payeeAccountRejection(recordedAccount);
      const accountNo = fromStatement ? statementAccount : recordedAccount;
      const accountSource = fromStatement ? 'statement' : fromRecorded ? 'recorded' : 'unresolved';
      const digits = accountSource === 'unresolved' ? '' : payeeAccountDigits(accountNo);
      const payeeName = String(statement.name || part.payeeName || '').trim();
      const staff = matchingStaffPayee(payeeName, digits, staffPayees);
      const line = {
        customerId: customer.customerId,
        customerName: customer.customerName,
        refundId: part.refundId,
        allocatedNgn,
        payeeName,
        payeeBankName: String(statement.bankName || part.payeeBankName || ''),
        accountNo: digits,
        accountSource,
        staffName: staff ? String(staff.name || '') : '',
      };
      if (accountSource === 'unresolved') {
        unresolved.push(line);
        return;
      }
      const key = `${staff ? 'staff' : 'payee'}|${digits}`;
      const group = groups.get(key) || {
        accountNo: digits,
        payeeName,
        bankName: line.payeeBankName,
        staff: Boolean(staff),
        staffName: line.staffName,
        accountSource,
        amountNgn: 0,
        refundCount: 0,
      };
      group.amountNgn = roundMoney(group.amountNgn + allocatedNgn);
      group.refundCount += 1;
      if (fromStatement) group.accountSource = 'statement';
      if (!group.payeeName) group.payeeName = payeeName;
      groups.set(key, group);
    });
  }
  const rows = [...groups.values()].sort((a, b) => b.amountNgn - a.amountNgn || a.accountNo.localeCompare(b.accountNo));
  const staffRows = rows.filter((row) => row.staff);
  const otherRows = rows.filter((row) => !row.staff);
  const unresolvedNgn = roundMoney(unresolved.reduce((sum, row) => sum + row.allocatedNgn, 0));
  const staffNgn = roundMoney(staffRows.reduce((sum, row) => sum + row.amountNgn, 0));
  const otherNgn = roundMoney(otherRows.reduce((sum, row) => sum + row.amountNgn, 0));
  return {
    label: 'Refund overpaid – recoverable from payee',
    totalNgn: roundMoney(staffNgn + otherNgn + unresolvedNgn),
    staffNgn,
    otherNgn,
    unresolvedNgn,
    staffRows,
    groups: otherRows,
    unresolved,
    note: 'Moved out of customer debtors. Grouped by the statement beneficiary account when the bank line has one, otherwise by the account on the refund. Staff payees are staff receivable lines inside this total. Cash, refunds, and revenue are unchanged.',
  };
}

function buildDebtorComposition(rows, staff, holdCustomerIds = []) {
  const holds = new Set(holdCustomerIds || []);
  const customerDebtors = [];
  const refundExcess = [];
  for (const row of rows || []) {
    if (!(row.positionNgn < 0)) continue;
    const item = {
      customerId: row.customerId,
      customerName: row.customerName,
      owedNgn: -row.positionNgn,
      paidNgn: row.paidNgn,
      revenueNgn: row.revenueNgn,
      refundsPaidNgn: row.refundsPaidNgn,
    };
    const goodsGap = Math.max(0, roundMoney((row.revenueNgn || 0) - (row.paidNgn || 0) - (row.staffSettledNgn || 0)));
    if (holds.has(String(row.customerId || ''))) {
      customerDebtors.push({
        ...item,
        goodsGapNgn: goodsGap,
        flag: 'refund without confirmed cash',
      });
      continue;
    }
    const goodsOwed = Math.min(item.owedNgn, goodsGap);
    const refundOwed = roundMoney(item.owedNgn - goodsOwed);
    if (goodsOwed > 0) customerDebtors.push({ ...item, owedNgn: goodsOwed, goodsGapNgn: goodsGap, refundsPaidNgn: row.refundsPaidNgn });
    if (refundOwed > 0) refundExcess.push({ ...item, owedNgn: refundOwed, goodsGapNgn: goodsGap });
  }
  customerDebtors.sort((a, b) => b.owedNgn - a.owedNgn || a.customerName.localeCompare(b.customerName));
  refundExcess.sort((a, b) => b.owedNgn - a.owedNgn || a.customerName.localeCompare(b.customerName));
  const staffRows = staff?.rows || [];
  return {
    customerDebtors: {
      totalNgn: roundMoney(customerDebtors.reduce((sum, row) => sum + row.owedNgn, 0)),
      customerCount: customerDebtors.length,
      customers: customerDebtors,
    },
    staffReceivables: {
      totalNgn: roundMoney(staff?.totalNgn || 0),
      count: staffRows.length,
      rows: staffRows,
      note: 'The customer is settled. This balance is owed by the staff member on the purchase credit.',
    },
    refundExcess: {
      totalNgn: roundMoney(refundExcess.reduce((sum, row) => sum + row.owedNgn, 0)),
      customerCount: refundExcess.length,
      customers: refundExcess,
      note: 'Paid covers the goods, or the balance left after the unpaid-goods gap is the refund. A refund-driven balance is not an unpaid-goods debtor.',
    },
    roundingWriteOff: roundingWriteOffProposal(customerDebtors),
  };
}

const ROUNDING_WRITE_OFF_NGN = 1500;

function roundingWriteOffProposal(customerDebtors) {
  const customers = (customerDebtors || [])
    .filter((row) => row.owedNgn > 0 && row.owedNgn < ROUNDING_WRITE_OFF_NGN)
    .map((row) => ({
      customerId: row.customerId,
      customerName: row.customerName,
      writeOffNgn: row.owedNgn,
      revenueNgn: row.revenueNgn,
      paidNgn: row.paidNgn,
    }));
  return {
    applied: false,
    thresholdNgn: ROUNDING_WRITE_OFF_NGN,
    totalNgn: roundMoney(customers.reduce((sum, row) => sum + row.writeOffNgn, 0)),
    count: customers.length,
    customers,
    note: 'Proposed only. Differences under ₦1,500 stay in customer debtors until a write-off is posted.',
  };
}

function buildMoniepointCashCheck(ctx) {
  const accountId = String(ctx.accountId ?? '4');
  const lines = (ctx.tieOutReceiptIns || []).filter((line) => String(line.treasuryAccountId ?? line.treasury_account_id ?? '') === accountId);
  const revByTarget = new Map();
  for (const rev of ctx.tieOutReversals || []) {
    const target = String(rev.reversesMovementId || rev.reverses_movement_id || '').trim();
    if (!target) continue;
    const posted = toIsoDate(rev.postedAtISO || rev.posted_at_iso);
    if (ctx.closingAsAt && posted && posted > ctx.closingAsAt) continue;
    revByTarget.set(target, rev);
  }
  const cashIds = new Set(
    (ctx.cashRows || []).filter((row) => !row.kind || row.kind === 'receipt').map((row) => String(row.receiptId || ''))
  );
  const excluded = [];
  let treasuryNgn = 0;
  let inReportNgn = 0;
  for (const line of lines) {
    const amount = roundMoney(line.amountNgn ?? line.amount_ngn);
    treasuryNgn = roundMoney(treasuryNgn + amount);
    const sourceId = String(line.sourceId || line.source_id || '');
    const receipt = (ctx.receipts || []).find(
      (item) => String(item.id || '') === sourceId || String(item.ledgerEntryId || item.ledger_entry_id || '') === sourceId
    );
    const rev = revByTarget.get(String(line.id || ''));
    let reason = '';
    let detail = '';
    if (rev) {
      reason = 'reversed';
      const revDate = toIsoDate(rev.postedAtISO || rev.posted_at_iso);
      detail = `Reversed by ${rev.id || 'a later line'} on ${revDate}. ${String(rev.note || '').trim()}`.trim();
    } else if (!receipt) {
      reason = 'no_sales_receipt';
      detail = 'Treasury line has no sales receipt.';
    } else if (receiptStatusIsSuspended(receipt.status)) {
      reason = 'suspended';
      detail = 'Receipt is suspended, so this open line is not customer cash.';
    } else if (amount === 0) {
      reason = 'zero';
      detail = String(line.note || '').trim() || 'Amount is zero, so it is not customer cash.';
    } else if (!cashIds.has(String(receipt.id || ''))) {
      reason = 'not_in_cash';
      detail = 'The sales receipt is not in Phase 1 cash for this period.';
    } else {
      inReportNgn = roundMoney(inReportNgn + amount);
      continue;
    }
    excluded.push({
      movementId: String(line.id || ''),
      dateISO: toIsoDate(line.postedAtISO || line.posted_at_iso),
      amountNgn: amount,
      sourceId,
      receiptId: receipt ? String(receipt.id || '') : '',
      customerName: String(receipt?.customerName || receipt?.customer_name || line.counterpartyName || line.counterparty_name || ''),
      quotationRef: String(receipt?.quotationRef || receipt?.quotation_ref || ''),
      reason,
      detail,
    });
  }
  excluded.sort((a, b) => b.amountNgn - a.amountNgn || a.dateISO.localeCompare(b.dateISO) || a.movementId.localeCompare(b.movementId));
  const excludedNgn = roundMoney(excluded.reduce((sum, row) => sum + row.amountNgn, 0));
  return {
    accountId,
    treasuryReceiptInNgn: treasuryNgn,
    inReportNgn,
    excludedNgn,
    differenceNgn: roundMoney(inReportNgn - treasuryNgn),
    excluded,
    nonSalesPassThrough: (ctx.nonSalesPassThrough || []).map((row) => ({
      name: String(row.name || ''),
      dateISO: toIsoDate(row.dateISO),
      amountNgn: roundMoney(row.amountNgn),
      klass: 'NON_SALES',
      postedAsCustomerReceipt: false,
      detail: String(row.detail || 'Bank inflow. Not customer cash.'),
    })),
  };
}

function kadunaAccountGroup(name, bankName) {
  const n = `${name || ''} ${bankName || ''}`.toLowerCase();
  if (n.includes('moniepoint')) return 'Moniepoint';
  if (n.includes('taj')) return 'Taj';
  if (n.includes('cash office') || n.includes('cashoffice')) return 'Cash Office';
  return 'Other Kaduna';
}

function accountOfLine(line) {
  return {
    id: line?.treasuryAccountId ?? line?.treasury_account_id ?? '',
    name: String(line?.accountName || line?.account_name || ''),
    bankName: String(line?.accountBankName || line?.account_bank_name || line?.bankName || ''),
    branchId: String(line?.accountBranchId || line?.account_branch_id || ''),
  };
}

function buildKadunaCashTieOut(ctx) {
  const groups = new Map();
  const accounts = new Map();
  function bucket(group, accountName) {
    if (!groups.has(group)) {
      groups.set(group, { group, receiptsNgn: 0, receiptCount: 0, treasuryReceiptInNgn: 0, treasuryLineCount: 0, reversalOutNgn: 0 });
    }
    const key = `${group}|${accountName || ''}`;
    if (!accounts.has(key)) {
      accounts.set(key, { group, accountName: accountName || '', receiptsNgn: 0, receiptCount: 0, treasuryReceiptInNgn: 0, treasuryLineCount: 0, reversalOutNgn: 0 });
    }
    return { groupRow: groups.get(group), accountRow: accounts.get(key) };
  }
  const cashIds = new Set((ctx.cashRows || []).map((row) => row.receiptId));
  const receiptsWithoutTreasuryLine = [];
  const confirmedInPeriodTreasuryOutside = [];

  for (const row of ctx.cashRows || []) {
    if (row.kind && row.kind !== 'receipt') continue;
    const receipt = (ctx.receipts || []).find((item) => String(item.id || '') === row.receiptId);
    const lines = receipt ? movementsForReceipt(receipt, ctx.bySource) : [];
    const nets = new Map();
    let postedInPeriod = 0;
    for (const line of lines) {
      if (!isReceiptTreasuryLine(line)) continue;
      const posted = toIsoDate(line.postedAtISO || line.posted_at_iso);
      if (ctx.closingAsAt && posted && posted > ctx.closingAsAt) continue;
      const acct = accountOfLine(line);
      if (acct.branchId && acct.branchId !== 'BR-KD') continue;
      const key = String(acct.id || acct.name || 'none');
      const prev = nets.get(key) || { ...acct, net: 0, postedInPeriod: 0 };
      prev.net = roundMoney(prev.net + roundMoney(line.amountNgn ?? line.amount_ngn));
      if (inRange(posted, ctx.startDate, ctx.endDate) && String(line.type || '').toUpperCase() === 'RECEIPT_IN') {
        prev.postedInPeriod = roundMoney(prev.postedInPeriod + roundMoney(line.amountNgn ?? line.amount_ngn));
        postedInPeriod += roundMoney(line.amountNgn ?? line.amount_ngn);
      }
      nets.set(key, prev);
    }
    const positive = [...nets.values()].filter((acct) => acct.net > 0);
    const quoteBranch = ctx.quoteById?.get(row.quotationRef)?.branchId || row.branchId || '';
    if (!positive.length) {
      if (quoteBranch === 'BR-KD' || row.branchId === 'BR-KD') {
        receiptsWithoutTreasuryLine.push({
          receiptId: row.receiptId,
          bankValueDateISO: row.bankValueDateISO,
          customerName: row.customerName,
          quotationRef: row.quotationRef,
          cashNgn: row.cashNgn,
        });
      }
      continue;
    }
    const kd = positive.filter((acct) => !acct.branchId || acct.branchId === 'BR-KD');
    if (!kd.length) continue;
    const netSum = kd.reduce((s, acct) => s + acct.net, 0);
    let left = row.cashNgn;
    kd.forEach((acct, index) => {
      const share = index === kd.length - 1 ? left : netSum > 0 ? roundMoney((row.cashNgn * acct.net) / netSum) : 0;
      left = roundMoney(left - share);
      const { groupRow, accountRow } = bucket(kadunaAccountGroup(acct.name, acct.bankName), acct.name);
      groupRow.receiptsNgn = roundMoney(groupRow.receiptsNgn + share);
      groupRow.receiptCount += index === 0 ? 1 : 0;
      accountRow.receiptsNgn = roundMoney(accountRow.receiptsNgn + share);
      accountRow.receiptCount += 1;
    });
    if (!(postedInPeriod > 0)) {
      confirmedInPeriodTreasuryOutside.push({
        receiptId: row.receiptId,
        bankValueDateISO: row.bankValueDateISO,
        customerName: row.customerName,
        quotationRef: row.quotationRef,
        cashNgn: row.cashNgn,
        accountName: kd.map((acct) => acct.name).filter(Boolean).join(', '),
      });
    }
  }

  const treasuryLinesWithoutReceipt = [];
  const treasuryInPeriodReceiptNotInCash = [];
  for (const line of ctx.tieOutReceiptIns || []) {
    const name = String(line.accountName || line.account_name || '');
    const bankName = String(line.accountBankName || line.account_bank_name || '');
    const amount = roundMoney(line.amountNgn ?? line.amount_ngn);
    const { groupRow, accountRow } = bucket(kadunaAccountGroup(name, bankName), name);
    groupRow.treasuryReceiptInNgn = roundMoney(groupRow.treasuryReceiptInNgn + amount);
    groupRow.treasuryLineCount += 1;
    accountRow.treasuryReceiptInNgn = roundMoney(accountRow.treasuryReceiptInNgn + amount);
    accountRow.treasuryLineCount += 1;
    const sourceId = String(line.sourceId || line.source_id || '');
    const orphan = {
      movementId: String(line.id || ''),
      postedAtISO: toIsoDate(line.postedAtISO || line.posted_at_iso),
      sourceKind: String(line.sourceKind || line.source_kind || ''),
      sourceId,
      accountName: name,
      amountNgn: amount,
    };
    const matched = (ctx.receipts || []).find(
      (receipt) => String(receipt.id || '') === sourceId || String(receipt.ledgerEntryId || receipt.ledger_entry_id || '') === sourceId
    );
    if (!matched) treasuryLinesWithoutReceipt.push(orphan);
    else if (!cashIds.has(String(matched.id || ''))) treasuryInPeriodReceiptNotInCash.push(orphan);
  }
  for (const line of ctx.tieOutReversals || []) {
    const name = String(line.accountName || line.account_name || '');
    const bankName = String(line.accountBankName || line.account_bank_name || '');
    const amount = Math.abs(roundMoney(line.amountNgn ?? line.amount_ngn));
    const { groupRow, accountRow } = bucket(kadunaAccountGroup(name, bankName), name);
    groupRow.reversalOutNgn = roundMoney(groupRow.reversalOutNgn + amount);
    accountRow.reversalOutNgn = roundMoney(accountRow.reversalOutNgn + amount);
  }

  function withDiff(row) {
    return { ...row, differenceNgn: roundMoney(row.receiptsNgn - row.treasuryReceiptInNgn) };
  }
  const groupRows = [...groups.values()].map(withDiff).sort((a, b) => a.group.localeCompare(b.group));
  const accountRows = [...accounts.values()].map(withDiff).sort((a, b) => a.group.localeCompare(b.group) || a.accountName.localeCompare(b.accountName));
  const totals = groupRows.reduce(
    (sum, row) => ({
      receiptsNgn: roundMoney(sum.receiptsNgn + row.receiptsNgn),
      treasuryReceiptInNgn: roundMoney(sum.treasuryReceiptInNgn + row.treasuryReceiptInNgn),
      reversalOutNgn: roundMoney(sum.reversalOutNgn + row.reversalOutNgn),
      differenceNgn: roundMoney(sum.differenceNgn + row.differenceNgn),
    }),
    { receiptsNgn: 0, treasuryReceiptInNgn: 0, reversalOutNgn: 0, differenceNgn: 0 }
  );
  return {
    definition:
      'Kaduna treasury accounts. Receipts are Phase 1 cash: open RECEIPT_IN whose posting (the bank-statement date) is in the period. Treasury is every RECEIPT_IN posted in the period on the same accounts, including lines with no sales receipt and lines later reversed.',
    groups: groupRows,
    accounts: accountRows,
    totals,
    receiptsWithoutTreasuryLine,
    treasuryLinesWithoutReceipt,
    treasuryInPeriodReceiptNotInCash,
    confirmedInPeriodTreasuryOutside,
  };
}

function mapDelta(closeMap, openMap) {
  const keys = new Set([...closeMap.keys(), ...openMap.keys()]);
  const out = new Map();
  for (const key of keys) {
    const delta = roundMoney((closeMap.get(key) || 0) - (openMap.get(key) || 0));
    if (delta !== 0) out.set(key, delta);
  }
  return out;
}

function bridgeCauseQuotes(parts) {
  const paidDelta = mapDelta(parts.closingPaid.byQuote, parts.openingPaid.byQuote);
  const refundDelta = mapDelta(parts.closingRefunds.byQuote, parts.openingRefunds.byQuote);
  const revenueDelta = mapDelta(parts.closingRevenue.byQuote, parts.openingRevenue.byQuote);
  const creditOutDelta = mapDelta(parts.closingCredit.outByQuote, parts.openingCredit.outByQuote);
  const creditInDelta = mapDelta(parts.closingCredit.inByQuote, parts.openingCredit.inByQuote);

  const cashByQuote = new Map();
  for (const row of parts.cashRows) addMap(cashByQuote, row.quotationRef || '(no quote)', row.cashNgn);
  const refundsByQuote = new Map();
  for (const row of parts.refundRows) addMap(refundsByQuote, row.quotationRef || '(no quote)', row.amountNgn);
  const revenueByQuote = new Map();
  for (const event of parts.periodEvents) addMap(revenueByQuote, event.quotationRef || '(no quote)', event.amountNgn);

  const keys = new Set([
    ...paidDelta.keys(),
    ...refundDelta.keys(),
    ...revenueDelta.keys(),
    ...creditOutDelta.keys(),
    ...creditInDelta.keys(),
    ...cashByQuote.keys(),
    ...refundsByQuote.keys(),
    ...revenueByQuote.keys(),
  ]);
  const rows = [];
  for (const quotationRef of keys) {
    const paidGap = roundMoney((paidDelta.get(quotationRef) || 0) - (cashByQuote.get(quotationRef) || 0));
    const refundGap = roundMoney((refundDelta.get(quotationRef) || 0) - (refundsByQuote.get(quotationRef) || 0));
    const revenueGap = roundMoney((revenueDelta.get(quotationRef) || 0) - (revenueByQuote.get(quotationRef) || 0));
    const creditGap = roundMoney((creditInDelta.get(quotationRef) || 0) - (creditOutDelta.get(quotationRef) || 0));
    const differenceNgn = roundMoney(paidGap - refundGap - revenueGap + creditGap);
    if (differenceNgn === 0) continue;
    const reasons = [];
    if (paidGap !== 0) reasons.push('treasury reversal in this period of a receipt bank-confirmed earlier, or the bank-confirmation date and the cash list disagree');
    if (refundGap !== 0) reasons.push('a refund paid outside the period was reversed, or the payout date and the as-at cutoff disagree');
    if (revenueGap !== 0) reasons.push('revenue recognition date disagrees with the period cutoff');
    if (creditGap !== 0) reasons.push('credit moved to or from another customer');
    rows.push({ quotationRef, differenceNgn, paidGapNgn: paidGap, refundGapNgn: refundGap, revenueGapNgn: revenueGap, creditGapNgn: creditGap, reasons });
  }
  rows.sort((a, b) => Math.abs(b.differenceNgn) - Math.abs(a.differenceNgn) || a.quotationRef.localeCompare(b.quotationRef));
  return rows;
}

/**
 * Month-end data pack for the accounts book.
 * Supplies one schedule per book line. It does not prepare a profit and loss,
 * a balance sheet, or a capital figure.
 * Frontend copies via sync into src/shared/lib/monthEndDataPack.js.
 */

import { isStaffLoanExpenseCategory } from '../expenseCategories.js';
import { netKgFromGrossClosing } from './stockRegisterCore.js';

const FACTORY = new Set(['Wages', 'Fuel & lubricant', 'Outside corrugation', 'Maintenance']);
const ADMIN = new Set([
  'Admin expenses',
  'Admin salary',
  'Bank charges',
  'Office expenses',
  'Professional fees',
  'Tax',
  'Pension',
  'Security',
  'Interest',
  'Welfare',
  'Zakat & Sallah',
  'IT & software',
  'Chairman withdrawal',
  'Truck & mining',
]);
const CAPEX = new Set(['Land and buildings', 'Plant and machinery', 'Furniture & fittings', 'Generator']);
const ASSET_EXPENSE_IDS = new Set(['EXP-KD-26-0362', 'EXP-KD-26-0397', 'EXP-KD-26-0326']);

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function isoDate(value) {
  const s = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

export function resolveMonthEndPeriod(query = {}) {
  const month = String(query.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: 'month must be YYYY-MM.' };
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const endDate = `${month}-${String(last).padStart(2, '0')}`;
  const prev = new Date(Date.UTC(y, m - 1, 0));
  const openingDate = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
  return { ok: true, month, startDate: `${month}-01`, endDate, openingDate };
}

/**
 * A schedule's total is the sum of its lines. Nothing else is added at the top.
 * @param {{ id: string, title: string, lines: object[], amountKey?: string, note?: string }} spec
 */
export function makeSchedule(spec) {
  const amountKey = spec.amountKey || 'amountNgn';
  const cents = spec.cents === true;
  const round = cents ? round2 : roundMoney;
  const lines = (spec.lines || []).map((line) => ({
    ...line,
    amountNgn: round(line.amountNgn),
  }));
  const totalNgn = cents
    ? lines.reduce((sum, line) => sum + Math.round(round(line[amountKey] ?? line.amountNgn) * 100), 0) / 100
    : lines.reduce((sum, line) => sum + roundMoney(line[amountKey] ?? line.amountNgn), 0);
  const summed = cents
    ? lines.reduce((sum, line) => sum + Math.round(round(line.amountNgn) * 100), 0) / 100
    : lines.reduce((sum, line) => sum + roundMoney(line.amountNgn), 0);
  return {
    id: spec.id,
    title: spec.title,
    note: spec.note || '',
    totalNgn,
    lineCount: lines.length,
    lines,
    totalEqualsLines: totalNgn === summed,
  };
}

export function coilMaterialFamily(name) {
  const k = String(name || '').toLowerCase();
  if (k.includes('aluzinc')) return 'aluzinc';
  if (k.includes('aluminium') || k.includes('aluminum')) return 'aluminium';
  return '';
}

export function coilValueAtDate(coil, kg, bookPrices = {}) {
  const family = coil.family || coilMaterialFamily(coil.material);
  const form = String(coil.stockForm || 'coil').toLowerCase() === 'roll' ? 'roll' : 'coil';
  const gross = round2(Math.max(0, Number(kg) || 0));
  const netKg = family ? netKgFromGrossClosing(gross, family, form) : round2(gross);
  const poRate = roundMoney(coil.poRateNgn);
  const bookRate = roundMoney(bookPrices[family]);
  return {
    grossKg: gross,
    spoolKg: round2(Math.max(0, gross - netKg)),
    netKg,
    poRateNgn: poRate || null,
    amountNgn: poRate > 0 ? roundMoney(netKg * poRate) : 0,
    bookRateNgn: bookRate || null,
    bookValueNgn: bookRate > 0 ? roundMoney(netKg * bookRate) : null,
    needsPrice: !(poRate > 0),
  };
}

export function suggestCoilPrice(coil, poLines = []) {
  const family = coil.family || coilMaterialFamily(coil.material);
  const gauge = String(coil.gauge || '').replace(/[^0-9.]/g, '');
  const matches = (poLines || [])
    .filter((line) => {
      const lineFamily = line.family || coilMaterialFamily(line.material || line.productName);
      const lineGauge = String(line.gauge || '').replace(/[^0-9.]/g, '');
      return lineFamily && lineFamily === family && lineGauge && lineGauge === gauge && roundMoney(line.rateNgn) > 0;
    })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return matches[0] ? { rateNgn: roundMoney(matches[0].rateNgn), poId: matches[0].poId || '', date: matches[0].date || '' } : null;
}

/**
 * Count on countDate rolled back to targetDate.
 * Kg at the earlier date = count − receipts after that date + usage after that date, up to the count.
 */
export function rollCountBackToDate(countedKg, countDate, targetDate, movements = []) {
  const count = isoDate(countDate);
  const target = isoDate(targetDate);
  let received = 0;
  let used = 0;
  if (count && target && count > target) {
    for (const move of movements || []) {
      const d = isoDate(move.date);
      if (!d || d <= target || d > count) continue;
      received += Number(move.receivedKg) || 0;
      used += Number(move.usedKg) || 0;
    }
  }
  return round2((Number(countedKg) || 0) - received + used);
}

const REFUND_WORD = /\brefunds?\b/i;
const IOU_WORD = /\b(iou|10u)\b/i;
const FORKLIFT = /\bfork\s*-?\s*lifts?\b|\bforklift\b/i;
const TRANSFORMER = /transform/i;

export function classifyBookExpense(line) {
  const category = String(line.category || '').trim();
  const description = String(line.description || line.name || '').trim();
  const ref = String(line.ref || '').trim();
  const text = `${category} ${description} ${ref}`;
  const asset = line.asset === true || CAPEX.has(category) || ASSET_EXPENSE_IDS.has(ref) || TRANSFORMER.test(text);
  const forklift = FORKLIFT.test(text);
  const refund = REFUND_WORD.test(description);
  const iou = IOU_WORD.test(description) || isStaffLoanExpenseCategory(category);
  const washer = /washer/i.test(description);
  const interest = category === 'Interest' || /^\s*interest\b/i.test(description);
  let bucket = 'reclassify';
  let suggested = 'Confirm what this payment was for';
  let bookCategory = category;
  if (asset) {
    bucket = 'asset';
    suggested = 'Fixed asset';
  } else if (refund) {
    bucket = 'reclassify';
    suggested = 'Refund — not an expense';
  } else if (iou) {
    bucket = 'reclassify';
    suggested = 'Staff receivable';
  } else if (forklift || FACTORY.has(category)) {
    bucket = 'factory';
    suggested = forklift ? 'Maintenance — Forklift' : category;
  } else if (category === 'Accessories' || (category === 'Purchases' && washer) || washer) {
    bucket = 'accessories';
    suggested = 'Accessories';
  } else if (category === 'Carriage inward') {
    bucket = 'carriage';
    suggested = 'Carriage inward';
  } else if (interest || ADMIN.has(category)) {
    bucket = 'admin';
    bookCategory = interest ? 'Interest' : category;
    suggested = bookCategory;
  }
  return { bucket, suggested, asset, forklift, refund, iou, category: bookCategory };
}

function lineOf(row) {
  return {
    date: isoDate(row.date) || '',
    ref: String(row.ref || ''),
    name: String(row.name || ''),
    amountNgn: roundMoney(row.amountNgn),
    ...row,
  };
}

function expenseLines(rows, predicate) {
  return (rows || []).filter(predicate).map((row) => {
    const book = row.book || {};
    const { book: _book, ...rest } = row;
    return lineOf({ ...rest, suggested: book.suggested || '' });
  });
}

export function buildMonthEndDataPack(input = {}) {
  const period = input.period || resolveMonthEndPeriod({ month: input.month });
  if (!period.ok) return period;
  const bookPrices = input.bookPrices || {};
  const notReady = [];

  const coilLines = (input.coils || []).map((coil) => {
    const openKg = coil.openingKg;
    const closeKg = coil.closingKg;
    const openVal = coilValueAtDate(coil, openKg, bookPrices);
    const closeVal = coilValueAtDate(coil, closeKg, bookPrices);
    return { coil, openKg, closeKg, openVal, closeVal };
  });

  const stockLine = (kind) =>
    coilLines
      .filter((row) => (kind === 'opening' ? row.openVal.grossKg : row.closeVal.grossKg) > 0)
      .map((row) => {
        const val = kind === 'opening' ? row.openVal : row.closeVal;
        return lineOf({
          date: kind === 'opening' ? period.openingDate : period.endDate,
          ref: row.coil.coilNo,
          name: [row.coil.material, row.coil.gauge, row.coil.colour].filter(Boolean).join(' · '),
          amountNgn: val.amountNgn,
          grossKg: val.grossKg,
          spoolKg: val.spoolKg,
          netKg: val.netKg,
          poRateNgn: val.poRateNgn,
          bookRateNgn: val.bookRateNgn,
          bookValueNgn: val.bookValueNgn,
        });
      });

  const openingStock = makeSchedule({
    id: 'coil-opening',
    title: `Coil stock at ${period.openingDate}`,
    note: 'Kg on that date, spool deducted (60 kg Aluzinc, 35 kg aluminium), value at PO ₦/kg. Book value uses the price you enter.',
    lines: stockLine('opening'),
  });
  const closingStock = makeSchedule({
    id: 'coil-closing',
    title: `Coil stock at ${period.endDate}`,
    note: 'Same basis as the opening schedule.',
    lines: stockLine('closing'),
  });

  const unpriced = coilLines
    .filter((row) => row.closeVal.grossKg > 0 && row.closeVal.needsPrice)
    .map((row) => {
      const suggestion = suggestCoilPrice(row.coil, input.poPrices || []);
      return lineOf({
        date: period.endDate,
        ref: row.coil.coilNo,
        name: [row.coil.material, row.coil.gauge, row.coil.colour].filter(Boolean).join(' · '),
        amountNgn: suggestion ? roundMoney(row.closeVal.netKg * suggestion.rateNgn) : 0,
        grossKg: row.closeVal.grossKg,
        netKg: row.closeVal.netKg,
        suggestedRateNgn: suggestion?.rateNgn || null,
        suggestedFrom: suggestion ? `${suggestion.poId} ${suggestion.date}`.trim() : '',
        flag: 'needs approval',
      });
    });
  const unpricedSchedule = makeSchedule({
    id: 'coil-unpriced',
    title: 'Coils with no cost on record',
    note: 'Suggested price is the latest PO for the same material and gauge. Marked needs approval.',
    lines: unpriced,
  });
  if (unpriced.length) {
    notReady.push(lineOf({
      date: period.endDate,
      ref: 'unpriced-coils',
      name: `${unpriced.length} coil(s) have no PO ₦/kg`,
      amountNgn: unpricedSchedule.totalNgn,
    }));
  }
  if (!roundMoney(bookPrices.aluminium) || !roundMoney(bookPrices.aluzinc)) {
    notReady.push(lineOf({
      date: period.endDate,
      ref: 'book-price',
      name: 'Book price per material was not entered (aluminium and Aluzinc)',
      amountNgn: 0,
    }));
  }

  const counts = input.counts || [];
  const countByCoil = new Map(counts.map((row) => [String(row.coilNo || ''), row]));
  const countLines = coilLines
    .filter((row) => row.closeVal.grossKg > 0 || countByCoil.has(row.coil.coilNo))
    .map((row) => {
      const count = countByCoil.get(row.coil.coilNo);
      if (!count) {
        return lineOf({
          date: period.endDate,
          ref: row.coil.coilNo,
          name: 'No count',
          amountNgn: 0,
          erpKg: row.closeVal.grossKg,
          countKg: null,
          rolledBackKg: null,
          differenceKg: null,
        });
      }
      const rolled = rollCountBackToDate(count.countedKg, count.countDate, period.endDate, count.movements || []);
      return lineOf({
        date: isoDate(count.countDate),
        ref: row.coil.coilNo,
        name: row.coil.material || row.coil.coilNo,
        amountNgn: 0,
        erpKg: row.closeVal.grossKg,
        countKg: round2(count.countedKg),
        rolledBackKg: rolled,
        differenceKg: round2(rolled - row.closeVal.grossKg),
      });
    });
  const countSchedule = makeSchedule({
    id: 'coil-count',
    title: `Physical count rolled back to ${period.endDate}`,
    note: 'A count after month end is rolled back by receipts and usage in between. Amount is not a money figure.',
    lines: countLines,
  });
  if (!counts.length) {
    notReady.push(lineOf({
      date: period.endDate,
      ref: 'stock-count',
      name: 'No physical stock count was entered',
      amountNgn: 0,
    }));
  }

  const stoneLines = (input.stone || []).map((row) => {
    const openingM = round2(row.openingM);
    const purchasedM = round2(row.purchasedM);
    const suppliedM = round2(row.suppliedM);
    const closingM = round2(row.closingM);
    const cost = roundMoney(row.costPerM);
    const expected = round2(openingM + purchasedM - suppliedM);
    return lineOf({
      date: period.endDate,
      ref: row.ref || row.productId || '',
      name: row.name || 'Stone-coated',
      amountNgn: cost > 0 ? roundMoney(closingM * cost) : 0,
      openingM,
      purchasedM,
      suppliedM,
      closingM,
      costPerM: cost || null,
      rollForwardM: expected,
      flag: Math.abs(expected - closingM) > 0.05 ? 'opening + purchased − supplied does not equal closing' : '',
    });
  });
  const stone = makeSchedule({
    id: 'stone',
    title: 'Stone-coated metres',
    note: 'Opening, purchased, supplied, and closing metres. Amount is closing metres × cost per metre.',
    lines: stoneLines,
  });
  const stoneGap = stoneLines.filter((line) => line.flag);
  if (stoneGap.length) {
    notReady.push(lineOf({
      date: period.endDate,
      ref: 'stone-roll-forward',
      name: `${stoneGap.length} stone line(s): opening + purchased − supplied does not equal closing`,
      amountNgn: 0,
    }));
  }

  const accessoryCosts = input.accessoryCosts || {};
  const accessoryLines = (input.accessories || []).map((row) => {
    const qty = row.qty == null ? null : round2(row.qty);
    const unitCost = roundMoney(accessoryCosts[row.ref] ?? accessoryCosts[row.name] ?? row.unitCostNgn);
    return lineOf({
      date: period.endDate,
      ref: row.ref || '',
      name: row.name || '',
      amountNgn: qty == null || !(unitCost > 0) ? roundMoney(row.amountNgn) : roundMoney(qty * unitCost),
      qty,
      qtyLabel: qty == null ? 'manual count' : String(qty),
      unitCostNgn: unitCost || null,
    });
  });
  const accessoryStock = makeSchedule({
    id: 'accessories-stock',
    title: 'Accessories and metro tiles on hand',
    note: 'Quantity at month end. Manual count where the books have no movement.',
    lines: accessoryLines,
  });
  const uncostedAccessories = accessoryLines.filter((line) => line.qty != null && !(line.unitCostNgn > 0));
  if (uncostedAccessories.length) {
    notReady.push(lineOf({
      date: period.endDate,
      ref: 'accessory-cost',
      name: `${uncostedAccessories.length} accessory line(s) have no unit cost, so they have no naira value`,
      amountNgn: 0,
    }));
  }

  const purchaseLines = (input.grns || []).map((row) =>
    lineOf({
      date: row.date,
      ref: row.ref,
      name: row.name,
      amountNgn: roundMoney(row.kg != null ? Number(row.kg) * Number(row.rateNgn || 0) : row.amountNgn),
      kg: row.kg == null ? null : round2(row.kg),
      rateNgn: row.rateNgn || null,
      poId: row.poId || '',
      flag: row.receivedLater ? 'Dated in the month but received later' : '',
    })
  );
  const purchases = makeSchedule({
    id: 'purchases',
    title: 'Purchases — coil and stone GRNs',
    note: 'Received quantity × PO price. A line dated in the month but received later is flagged.',
    lines: purchaseLines,
  });

  const classified = (input.expenses || []).map((row) => ({ ...row, book: classifyBookExpense(row) }));
  const accessoriesPurchased = makeSchedule({
    id: 'accessories-purchased',
    title: 'Accessories purchased',
    lines: expenseLines(classified, (row) => row.book.bucket === 'accessories'),
  });
  const carriage = makeSchedule({
    id: 'carriage',
    title: 'Carriage inward',
    note: 'Each line should name the PO or coil.',
    lines: expenseLines(classified, (row) => row.book.bucket === 'carriage').map((row) => ({
      ...row,
      name: [row.name, row.poRef].filter(Boolean).join(' · '),
    })),
  });
  const factory = makeSchedule({
    id: 'factory-overhead',
    title: 'Factory overhead',
    note: 'Wages, fuel, outside corrugation, and maintenance. Forklift lines are included wherever they were filed. Asset lines are excluded.',
    lines: expenseLines(classified, (row) => row.book.bucket === 'factory'),
  });
  const factoryExcluded = makeSchedule({
    id: 'factory-excluded',
    title: 'Excluded from factory overhead',
    note: 'Asset lines that would otherwise sit in maintenance or a factory category.',
    lines: expenseLines(classified, (row) => row.book.asset && FACTORY.has(row.book.category)),
  });
  const coilUsed = makeSchedule({
    id: 'coil-used',
    title: 'Coil used in the month (cross-check only)',
    note: 'Kg used × that coil’s PO ₦/kg. Not a book posting.',
    lines: (input.coilUsed || []).map((row) =>
      lineOf({
        date: row.date || period.endDate,
        ref: row.coilNo,
        name: row.name || row.coilNo,
        amountNgn: roundMoney(Number(row.kg) * Number(row.rateNgn || 0)),
        kg: round2(row.kg),
        rateNgn: row.rateNgn || null,
      })
    ),
  });

  const salesLines = (input.sales || [])
    .filter((row) => !row.branchId || !input.branchId || row.branchId === input.branchId)
    .map((row) =>
      lineOf({
        date: row.date || period.endDate,
        ref: row.quotationRef || row.ref,
        name: row.customerName || row.name,
        amountNgn: row.amountNgn,
        metres: row.metres,
      })
    );
  if (input.lockedRevenueNgn != null) {
    const live = salesLines.reduce((sum, line) => sum + line.amountNgn, 0);
    const gap = roundMoney(input.lockedRevenueNgn) - live;
    if (gap !== 0) {
      salesLines.push(lineOf({
        date: period.endDate,
        ref: 'locked-close',
        name: 'Locked revenue minus the lines above',
        amountNgn: gap,
      }));
    }
  }
  const sales = makeSchedule({
    id: 'sales',
    title: 'Sales — Phase 1 revenue',
    note: 'Produced metres × price, less credit notes and discount allowed, for this branch. One line per job, plus accessories, services, credit notes, and discount allowed.',
    lines: salesLines,
  });
  const otherBranchSales = makeSchedule({
    id: 'sales-other-branch',
    title: 'Sales excluded — other branch',
    note: 'These were inside an unfiltered recalculation and are not the locked branch revenue.',
    lines: (input.otherBranchSales || []).map((row) => lineOf(row)),
  });
  const lockChanges = makeSchedule({
    id: 'changed-after-lock',
    title: 'Changed after the lock',
    note: 'Jobs, quotations, and receipts dated in this month that were edited after the period was locked. Amount is not a book total.',
    lines: (input.lockChanges || []).map((row) => lineOf(row)),
  });
  if (input.salesHeadlineNgn != null && roundMoney(input.salesHeadlineNgn) !== sales.totalNgn) {
    notReady.push(lineOf({
      date: period.endDate,
      ref: 'sales-headline',
      name: `Phase 1 revenue is ${roundMoney(input.salesHeadlineNgn)} and the lines sum to ${sales.totalNgn}`,
      amountNgn: roundMoney(input.salesHeadlineNgn) - sales.totalNgn,
    }));
  }

  const refundBook = makeSchedule({
    id: 'refund-book',
    title: 'Refund — price reductions and credit notes',
    note: 'This is the book’s Refund line. Advance returns and overpayment refunds are not in this total.',
    lines: (input.priceReductions || []).map((row) => lineOf(row)),
  });
  const advanceReturns = makeSchedule({
    id: 'advance-returns',
    title: 'Advance returns (not the Refund line)',
    lines: (input.advanceReturns || []).map((row) => lineOf(row)),
  });
  const overpayRefunds = makeSchedule({
    id: 'overpayment-refunds',
    title: 'Overpayment refunds (not the Refund line)',
    lines: (input.overpaymentRefunds || []).map((row) => lineOf(row)),
  });
  const passThrough = makeSchedule({
    id: 'pass-through',
    title: 'Pass-through refunds (not a book line)',
    note: 'The receipt and the refund are left out of cash and of the Refund line.',
    lines: (input.passThrough || []).map((row) => lineOf(row)),
  });

  const adminSchedules = [...ADMIN].map((category) =>
    makeSchedule({
      id: `admin-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      title: category,
      lines: expenseLines(classified, (row) => row.book.bucket === 'admin' && row.book.category === category),
    })
  );
  const reclassify = makeSchedule({
    id: 'reclassify',
    title: 'Reclassify',
    note: 'These were filed as expenses and are not the book line they were put on.',
    lines: expenseLines(classified, (row) => row.book.bucket === 'reclassify').map((row) => ({
      ...row,
      name: row.suggested ? `${row.name} → ${row.suggested}` : row.name,
    })),
  });
  if (reclassify.lineCount) {
    notReady.push(lineOf({
      date: period.endDate,
      ref: 'reclassify',
      name: `${reclassify.lineCount} expense line(s) need reclassification`,
      amountNgn: reclassify.totalNgn,
    }));
  }

  const cashAccounts = (input.treasury || []).filter((row) => String(row.type || '').toLowerCase() === 'cash');
  const bankAccounts = (input.treasury || []).filter((row) => String(row.type || '').toLowerCase() !== 'cash');
  const cashCount = input.cashCountNgn == null || input.cashCountNgn === '' ? null : roundMoney(input.cashCountNgn);
  const cashErp = cashAccounts.reduce((sum, row) => sum + roundMoney(row.balanceNgn), 0);
  const cashLines = cashAccounts.map((row) =>
    lineOf({
      date: period.endDate,
      ref: String(row.id),
      name: row.name || 'Cash Office',
      amountNgn: row.balanceNgn,
      kind: 'ERP balance',
    })
  );
  if (cashCount != null) {
    cashLines.push(lineOf({
      date: period.endDate,
      ref: 'cash-count',
      name: 'Latest cash count',
      amountNgn: cashCount,
      kind: 'count',
    }));
    cashLines.push(lineOf({
      date: period.endDate,
      ref: 'cash-difference',
      name: 'Count minus ERP',
      amountNgn: cashCount - cashErp,
      kind: 'difference',
    }));
  }
  const cash = makeSchedule({
    id: 'cash',
    title: 'Cash at hand',
    note: 'ERP Cash Office balance at month end, the latest count, and the difference. The total is the sum of these lines, so enter the count before using the total as the book figure.',
    lines: cashLines,
  });
  if (cashCount == null) {
    notReady.push(lineOf({
      date: period.endDate,
      ref: 'cash-count',
      name: 'No cash count was entered',
      amountNgn: 0,
    }));
  }

  const statements = input.bankStatements || {};
  const periodLocked = input.periodLocked === true;
  const bankLines = bankAccounts.map((row) => {
    const rawStatement = statements[row.id] ?? statements[String(row.id)];
    const statement = rawStatement == null || rawStatement === '' ? null : Math.round(Number(rawStatement) * 100) / 100;
    const erp = roundMoney(row.balanceNgn);
    const difference = statement == null || !Number.isFinite(statement) ? null : Math.round((statement - erp) * 100) / 100;
    const useStatement = periodLocked && statement != null;
    return {
      date: period.endDate,
      ref: String(row.id),
      name: [row.bank, row.name].filter(Boolean).join(' · ') || row.name,
      amountNgn: useStatement ? statement : erp,
      erpBalanceNgn: erp,
      statementNgn: statement,
      differenceNgn: difference,
      flag: row.flag || (difference == null ? 'Statement balance not entered' : difference === 0 ? '' : 'ERP and statement differ'),
    };
  });
  const banks = makeSchedule({
    id: 'banks',
    title: 'Bank balances',
    note: periodLocked
      ? 'This month is locked. Amount is the statement balance. The ERP balance and the difference are beside it.'
      : 'Amount is the ERP balance at month end. Statement balance and the difference are beside it. They should match.',
    cents: true,
    lines: bankLines,
  });
  for (const line of bankLines) {
    if (line.statementNgn == null) {
      notReady.push(lineOf({
        date: period.endDate,
        ref: line.ref,
        name: `No statement balance for ${line.name}`,
        amountNgn: 0,
      }));
    } else if (line.differenceNgn !== 0) {
      notReady.push(lineOf({
        date: period.endDate,
        ref: line.ref,
        name: `${line.name} differs from the statement`,
        amountNgn: line.differenceNgn,
      }));
    }
  }

  const customerDebts = makeSchedule({
    id: 'customer-debts',
    title: 'Customer debts',
    note: 'Unpaid goods, plus amounts recoverable from refund payees.',
    lines: (input.customerDebts || []).map((row) => lineOf(row)),
  });
  const advances = makeSchedule({
    id: 'customer-advances',
    title: 'Customer advances',
    note: 'Paid, not yet supplied.',
    lines: (input.customerAdvances || []).map((row) => lineOf(row)),
  });
  const staff = makeSchedule({
    id: 'staff-receivables',
    title: 'Staff receivables',
    note: 'IOUs, staff purchase credit, and refund excess paid to a staff account.',
    lines: (input.staffReceivables || []).map((row) => lineOf(row)),
  });
  const supplierLines = (input.supplierBalances || []).map((row) => lineOf(row));
  const suppliersOwe = makeSchedule({
    id: 'suppliers-owe',
    title: 'We owe supplier',
    note: 'Received value minus paid, per purchase order, where the balance is still owing.',
    lines: supplierLines.filter((line) => line.amountNgn > 0),
  });
  const advanceLines = supplierLines
    .filter((line) => line.amountNgn < 0)
    .map((line) => ({ ...line, amountNgn: -line.amountNgn }))
    .sort((a, b) => (a.ref === 'PO-KD-26-0085' ? -1 : b.ref === 'PO-KD-26-0085' ? 1 : b.amountNgn - a.amountNgn));
  const suppliersAdvance = makeSchedule({
    id: 'suppliers-advance',
    title: 'Supplier advance (we prepaid)',
    note: 'Paid minus received value, per purchase order. Days outstanding run from the first payment to month end. Delivery date promised is the date on the order. PO-KD-26-0085 (Banbo) is listed first.',
    lines: advanceLines,
  });
  const assets = makeSchedule({
    id: 'asset-additions',
    title: 'Fixed asset additions in the month',
    note: 'Lines flagged as an asset. Transformer is EXP 0362, 0397, and 0326.',
    lines: expenseLines(classified, (row) => row.book.asset),
  });

  for (const row of input.unmatchedReceipts || []) {
    notReady.push(lineOf({
      ...row,
      name: `${row.name || 'Receipt'} · no bank line`,
    }));
  }
  if (input.phase1Error) {
    notReady.push(lineOf({
      date: period.endDate,
      ref: 'phase1',
      name: String(input.phase1Error),
      amountNgn: 0,
    }));
  }
  for (const row of input.deferredReclasses || []) {
    notReady.push(lineOf({
      date: row.date || period.endDate,
      ref: row.ref,
      name: row.name,
      amountNgn: 0,
    }));
  }
  for (const message of input.loaderErrors || []) {
    notReady.push(lineOf({
      date: period.endDate,
      ref: 'loader',
      name: String(message),
      amountNgn: 0,
    }));
  }
  const notReadySchedule = makeSchedule({
    id: 'not-ready',
    title: 'Not ready',
    note: 'Items that block a clean pack. This is a list, not a book total.',
    lines: notReady,
  });

  const schedules = [
    openingStock,
    closingStock,
    unpricedSchedule,
    countSchedule,
    stone,
    accessoryStock,
    purchases,
    accessoriesPurchased,
    carriage,
    factory,
    factoryExcluded,
    coilUsed,
    sales,
    otherBranchSales,
    lockChanges,
    refundBook,
    advanceReturns,
    overpayRefunds,
    passThrough,
    ...adminSchedules,
    reclassify,
    cash,
    banks,
    customerDebts,
    advances,
    staff,
    suppliersOwe,
    suppliersAdvance,
    assets,
    notReadySchedule,
  ];

  return {
    ok: true,
    preparedAccounts: false,
    note: 'This pack does not prepare a profit and loss, a balance sheet, or a capital calculation.',
    branchId: input.branchId || '',
    period,
    schedules,
    allTotalsMatchLines: schedules.every((schedule) => schedule.totalEqualsLines),
  };
}

export function monthEndPackFilename(pack, ext = 'xlsx') {
  const month = pack?.period?.month || 'month';
  const branch = String(pack?.branchId || 'branch').replace(/[^A-Za-z0-9-]/g, '');
  return `month-end-data-pack-${branch}-${month}.${ext}`;
}

/** One sheet per schedule. Row 1 is the total. Row 2 is the column headings. */
export function monthEndPackToSheets(pack) {
  const sheets = [];
  for (const schedule of pack?.schedules || []) {
    const keys = [];
    for (const line of schedule.lines) {
      for (const key of Object.keys(line)) {
        if (!keys.includes(key)) keys.push(key);
      }
    }
    const columns = ['date', 'ref', 'name', 'amountNgn', ...keys.filter((key) => !['date', 'ref', 'name', 'amountNgn'].includes(key))];
    const totalRow = ['TOTAL', '', schedule.title, schedule.totalNgn];
    const header = columns;
    const body = schedule.lines.map((line) => columns.map((key) => (line[key] == null ? '' : line[key])));
    let name = schedule.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || schedule.id.slice(0, 31);
    const used = sheets.map((sheet) => sheet.name);
    if (used.includes(name)) name = `${name.slice(0, 24)} ${schedule.id}`.slice(0, 31);
    sheets.push({ name, rows: [totalRow, header, ...body] });
  }
  return sheets;
}

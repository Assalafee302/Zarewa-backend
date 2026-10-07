/**
 * Read-only loader for the month-end data pack.
 * Does not post, heal, or edit a locked month.
 */

import { hasColumn, tableExists } from '../ap2ReceivedBasisOps.js';
import { buildSalesPhase1ReportFromDb } from '../sales/salesPhase1ReportOps.js';
import { buildMonthEndDataPack, coilMaterialFamily, resolveMonthEndPeriod } from '../../shared/lib/monthEndDataPack.js';
import { daysOutstanding } from '../procurement/supplierAdvanceAge.js';

function nextDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

function optionalAll(db, sql, args) {
  try {
    return db.prepare(sql).all(...(args || []));
  } catch (err) {
    return { error: String(err?.message || err), sql: String(sql).replace(/\s+/g, ' ').slice(0, 90) };
  }
}

let loaderWarnings = [];

function rowsOf(result, label = 'query') {
  if (Array.isArray(result)) return result;
  loaderWarnings.push(`${label}: ${String(result?.error || 'failed').slice(0, 220)} ${result?.sql || ''}`.trim());
  return [];
}

function iso(value) {
  return String(value || '').slice(0, 10);
}

function money(value) {
  return Math.round(Number(value) || 0);
}

function kgAt(liveKg, receivedAt, receivedKg, asOf, usage) {
  const live = Math.max(0, Number(liveKg) || 0);
  const usedAfter = (usage || [])
    .filter((row) => row.date > asOf)
    .reduce((sum, row) => sum + (Number(row.kg) || 0), 0);
  const gotAfter = receivedAt && receivedAt > asOf ? Math.max(0, Number(receivedKg) || 0) : 0;
  return Math.max(0, Math.round((live + usedAfter - gotAfter) * 100) / 100);
}

function loadCoils(db, branchId) {
  const hasBranch = hasColumn(db, 'coil_lots', 'branch_id');
  const hasForm = hasColumn(db, 'coil_lots', 'stock_form');
  const poPrefix = `${branchId.replace(/^BR-/, 'PO-')}%`;
  const sql = `
    SELECT coil_no, material_type_name, gauge_label, colour, current_weight_kg, weight_kg, qty_received,
           unit_cost_ngn_per_kg, received_at_iso, po_id, line_key
           ${hasBranch ? ', branch_id' : ''}
           ${hasForm ? ', stock_form' : ''}
    FROM coil_lots
    WHERE ${hasBranch ? "branch_id = ? OR ((branch_id IS NULL OR TRIM(branch_id) = '') AND po_id LIKE ?)" : 'po_id LIKE ?'}`;
  const args = hasBranch ? [branchId, poPrefix] : [poPrefix];
  return rowsOf(optionalAll(db, sql, args));
}

function loadUsage(db, branchId) {
  if (!tableExists(db, 'production_job_coils') || !tableExists(db, 'production_jobs')) return [];
  const dateExpr = hasColumn(db, 'production_jobs', 'production_date_iso')
    ? `SUBSTR(COALESCE(pj.production_date_iso, pj.completed_at_iso, pj.end_date_iso), 1, 10)`
    : `SUBSTR(COALESCE(pj.completed_at_iso, pj.end_date_iso), 1, 10)`;
  const branchSql = hasColumn(db, 'production_jobs', 'branch_id') ? 'AND pj.branch_id = ?' : '';
  return rowsOf(
    optionalAll(
      db,
      `SELECT pjc.coil_no, ${dateExpr} AS d, SUM(pjc.consumed_weight_kg) AS kg
       FROM production_job_coils pjc
       JOIN production_jobs pj ON pj.job_id = pjc.job_id
       WHERE pj.status = 'Completed' ${branchSql}
       GROUP BY pjc.coil_no, d`,
      branchSql ? [branchId] : []
    )
  ).map((row) => ({ coilNo: row.coil_no, date: iso(row.d), kg: Number(row.kg) || 0 }));
}

function loadPoPrices(db, branchId) {
  if (!tableExists(db, 'purchase_order_lines') || !tableExists(db, 'purchase_orders')) return [];
  const branchSql = hasColumn(db, 'purchase_orders', 'branch_id') ? 'WHERE po.branch_id = ?' : '';
  return rowsOf(
    optionalAll(
      db,
      `SELECT po.po_id, po.order_date_iso, po.expected_delivery_iso, po.supplier_name, l.line_key, l.product_name, l.gauge,
              l.unit_price_per_kg_ngn, l.unit_price_ngn, l.qty_received
       FROM purchase_order_lines l
       JOIN purchase_orders po ON po.po_id = l.po_id
       ${branchSql}`,
      branchSql ? [branchId] : []
    )
  );
}

function loadExpenses(db, branchId, startDate, endDate) {
  if (!tableExists(db, 'treasury_movements') || !tableExists(db, 'payment_requests') || !tableExists(db, 'treasury_accounts')) {
    return [];
  }
  const endExclusive = nextDay(endDate);
  return rowsOf(
    optionalAll(
      db,
      `SELECT tm.posted_at_iso, tm.amount_ngn, tm.id, pr.description, pr.request_reference,
              e.expense_id, e.category, e.reference, e.date AS expense_date
       FROM treasury_movements tm
       JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id AND ta.branch_id = ?
       JOIN payment_requests pr ON pr.request_id = tm.source_id AND tm.source_kind = 'PAYMENT_REQUEST'
       LEFT JOIN expenses e ON e.expense_id = pr.expense_id
       WHERE tm.posted_at_iso >= ? AND tm.posted_at_iso < ?
         AND tm.amount_ngn < 0
         AND (tm.reverses_movement_id IS NULL OR TRIM(COALESCE(tm.reverses_movement_id, '')) = '')
         AND NOT EXISTS (
           SELECT 1 FROM treasury_movements rev
           WHERE rev.reverses_movement_id = tm.id AND rev.posted_at_iso < ?
         )`,
      [branchId, startDate, endExclusive, endExclusive]
    )
  ).map((row) => ({
    date: iso(row.posted_at_iso),
    expenseDate: iso(row.expense_date),
    ref: row.expense_id || row.id,
    name: row.description || row.category || '',
    description: row.description || '',
    category: row.category || '',
    amountNgn: Math.abs(money(row.amount_ngn)),
    poRef: row.request_reference || row.reference || '',
    flag: iso(row.expense_date) && iso(row.expense_date).slice(0, 7) !== iso(row.posted_at_iso).slice(0, 7)
      ? `Expense date ${iso(row.expense_date)}; bank date ${iso(row.posted_at_iso)}. The Expenses report uses the expense date.`
      : '',
  }));
}

function expenseTreasuryById(db, expenseIds) {
  const ids = [...new Set((expenseIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  const found = new Map();
  if (!ids.length || !tableExists(db, 'treasury_movements') || !tableExists(db, 'treasury_accounts')) return found;
  const marks = ids.map(() => '?').join(',');
  for (const row of rowsOf(
    optionalAll(
      db,
      `SELECT tm.source_id, tm.id, tm.posted_at_iso, ta.bank_name, ta.name
       FROM treasury_movements tm
       JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
       WHERE tm.source_kind = 'EXPENSE' AND tm.source_id IN (${marks})
         AND tm.amount_ngn < 0
         AND (tm.reverses_movement_id IS NULL OR TRIM(COALESCE(tm.reverses_movement_id, '')) = '')
         AND NOT EXISTS (
           SELECT 1 FROM treasury_movements rev WHERE rev.reverses_movement_id = tm.id
         )`,
      ids
    )
  )) {
    found.set(String(row.source_id), row);
  }
  return found;
}

function loadRegisterExpenses(db, branchId, startDate, endDate, already) {
  if (!tableExists(db, 'expenses')) return [];
  const rows = rowsOf(
    optionalAll(
      db,
      `SELECT expense_id, category, amount_ngn, date, reference, expense_type
       FROM expenses
       WHERE branch_id = ? AND date >= ? AND date <= ?
         AND category IN ('Bank charges', 'Carriage inward')`,
      [branchId, startDate, endDate]
    )
  ).filter((row) => !already.has(String(row.expense_id || '')));
  const posted = expenseTreasuryById(db, rows.map((row) => row.expense_id));
  return rows.map((row) => {
    const movement = posted.get(String(row.expense_id));
    let flag = 'On the expense register. No treasury line.';
    if (row.category === 'Carriage inward') {
      flag = 'On the expense register. Paid as transport on the purchase order, not as an expense payout.';
    } else if (movement) {
      const bank = movement.bank_name || movement.name || 'treasury';
      flag = `On ${bank} as ${movement.id}, dated ${iso(movement.posted_at_iso)}. Already in that month's bank balance.`;
    }
    return {
      date: iso(row.date),
      expenseDate: iso(row.date),
      ref: row.expense_id,
      name: row.expense_type || row.category,
      description: row.expense_type || row.category,
      category: row.category,
      amountNgn: Math.abs(money(row.amount_ngn)),
      poRef: row.reference || '',
      flag,
    };
  });
}

function reclassRequestId(sourceId) {
  return String(sourceId || '').split(':')[0].trim();
}

function categoryFromReclassMemo(memo) {
  const match = String(memo || '').match(/→\s*([^()]+)/);
  return match ? match[1].trim() : '';
}

function loadReclassJournals(db, branchId) {
  if (!tableExists(db, 'gl_journal_entries')) return [];
  return rowsOf(
    optionalAll(
      db,
      `SELECT entry_date_iso, memo, source_id, branch_id
       FROM gl_journal_entries
       WHERE source_kind = 'EXPENSE_CATEGORY_RECLASS_GL'
         AND (branch_id = ? OR branch_id IS NULL OR TRIM(COALESCE(branch_id, '')) = '')`,
      [branchId]
    )
  );
}

function expenseForReclass(db, sourceId) {
  const requestId = reclassRequestId(sourceId);
  if (!requestId) return null;
  if (tableExists(db, 'payment_requests') && requestId.startsWith('PREQ')) {
    const row = db
      .prepare(`SELECT expense_id, description, paid_amount_ngn FROM payment_requests WHERE request_id = ?`)
      .get(requestId);
    if (!row) return null;
    return {
      expenseId: String(row.expense_id || ''),
      name: row.description || requestId,
      amountNgn: money(row.paid_amount_ngn),
      requestId,
    };
  }
  if (requestId.startsWith('EXP') && tableExists(db, 'expenses')) {
    const row = db.prepare(`SELECT expense_id, expense_type, amount_ngn FROM expenses WHERE expense_id = ?`).get(requestId);
    if (!row) return null;
    return {
      expenseId: String(row.expense_id || ''),
      name: row.expense_type || requestId,
      amountNgn: money(row.amount_ngn),
      requestId,
    };
  }
  return null;
}

function loadMovements(db, branchId) {
  if (!tableExists(db, 'stock_movements')) return [];
  const branchSql = hasColumn(db, 'stock_movements', 'branch_id') ? 'WHERE branch_id = ?' : '';
  return rowsOf(
    optionalAll(
      db,
      `SELECT product_id, type, qty, date_iso, at_iso, value_ngn, unit_price_ngn, ref, detail
       FROM stock_movements ${branchSql}`,
      branchSql ? [branchId] : []
    )
  );
}

function loadProducts(db, branchId) {
  if (!tableExists(db, 'products')) return [];
  return rowsOf(
    optionalAll(
      db,
      `SELECT product_id, name, stock_level, unit FROM products WHERE branch_id = ?`,
      [branchId]
    )
  );
}

function movementDate(row) {
  return iso(row.date_iso || row.at_iso);
}

function onHandAt(stockLevel, moves, asOf) {
  const later = (moves || []).reduce((sum, row) => (movementDate(row) > asOf ? sum + (Number(row.qty) || 0) : sum), 0);
  return Math.round(((Number(stockLevel) || 0) - later) * 100) / 100;
}

function buildStoneAndAccessories(products, movements, openingDate, endDate) {
  const stoneIn = new Set(['STORE_GRN_STONE', 'STORE_STONE_DIRECT']);
  const stoneOut = new Set(['STONE_CONSUMPTION']);
  const flatIn = new Set(['STORE_GRN_STONE_FLATSHEET', 'STORE_STONE_FLATSHEET_DIRECT']);
  const flatOut = new Set(['STONE_FLATSHEET_ISSUE', 'STONE_FLATSHEET_ISSUE_ADJUSTMENT']);
  const accIn = new Set(['STORE_GRN_ACCESSORY', 'STORE_ACCESSORY_DIRECT']);
  const accOut = new Set(['ACCESSORY_ISSUE', 'ACCESSORY_ISSUE_ADJUSTMENT']);
  const byProduct = new Map();
  for (const row of movements) {
    const id = String(row.product_id || '');
    if (!id) continue;
    if (!byProduct.has(id)) byProduct.set(id, []);
    byProduct.get(id).push(row);
  }
  const stone = [];
  const accessories = [];
  for (const product of products) {
    const id = String(product.product_id || '');
    const name = String(product.name || id);
    const moves = byProduct.get(id) || [];
    const stoneMoves = moves.filter((row) => stoneIn.has(row.type) || stoneOut.has(row.type));
    const flatMoves = moves.filter((row) => flatIn.has(row.type) || flatOut.has(row.type));
    const accMoves = moves.filter((row) => accIn.has(row.type) || accOut.has(row.type));
    if (stoneMoves.length && !flatMoves.length) {
      const inWindow = (row) => {
        const d = movementDate(row);
        return d > openingDate && d <= endDate;
      };
      const purchased = stoneMoves
        .filter((row) => stoneIn.has(row.type) && inWindow(row))
        .reduce((sum, row) => sum + Math.abs(Number(row.qty) || 0), 0);
      const supplied = stoneMoves
        .filter((row) => stoneOut.has(row.type) && inWindow(row))
        .reduce((sum, row) => sum + Math.abs(Number(row.qty) || 0), 0);
      let pricedQty = 0;
      let pricedValue = 0;
      for (const row of stoneMoves) {
        if (!stoneIn.has(row.type) || movementDate(row) > endDate) continue;
        const qty = Math.abs(Number(row.qty) || 0);
        const value = money(row.value_ngn) || money(qty * money(row.unit_price_ngn));
        if (qty > 0 && value > 0) {
          pricedQty += qty;
          pricedValue += value;
        }
      }
      stone.push({
        ref: id,
        name,
        openingM: onHandAt(product.stock_level, stoneMoves, openingDate),
        purchasedM: Math.round(purchased * 100) / 100,
        suppliedM: Math.round(supplied * 100) / 100,
        closingM: onHandAt(product.stock_level, stoneMoves, endDate),
        costPerM: pricedQty > 0 ? Math.round(pricedValue / pricedQty) : 0,
      });
      continue;
    }
    const named = /tile|metro|accessor|flat\s*sheet/i.test(name) || /^ACC-/i.test(id);
    const tracked = flatMoves.length ? flatMoves : accMoves;
    if (!tracked.length && !named) continue;
    if (!tracked.length) {
      accessories.push({ ref: id, name, qty: null, amountNgn: 0 });
      continue;
    }
    accessories.push({
      ref: id,
      name,
      qty: onHandAt(product.stock_level, tracked, endDate),
      amountNgn: 0,
    });
  }
  return { stone, accessories };
}

function loadTreasury(db, branchId, endDate) {
  if (!tableExists(db, 'treasury_accounts') || !tableExists(db, 'treasury_movements')) return [];
  const endExclusive = nextDay(endDate);
  return rowsOf(
    optionalAll(
      db,
      `SELECT ta.id, ta.name, ta.bank_name, ta.type,
              COALESCE(ta.opening_balance_ngn, 0) + COALESCE((
                SELECT SUM(tm.amount_ngn) FROM treasury_movements tm
                WHERE tm.treasury_account_id = ta.id AND tm.posted_at_iso < ?
              ), 0) AS balance_ngn
       FROM treasury_accounts ta
       WHERE ta.branch_id = ?`,
      [endExclusive, branchId]
    )
  ).map((row) => ({
    id: row.id,
    name: row.name,
    bank: row.bank_name,
    type: row.type,
    balanceNgn: money(row.balance_ngn),
  }));
}

function addPaid(paidByPo, po, amountNgn) {
  const key = String(po || '');
  if (!key) return;
  paidByPo.set(key, (paidByPo.get(key) || 0) + -money(amountNgn));
}

function loadSuppliers(db, branchId, endDate, poPrices, movements) {
  const endExclusive = nextDay(endDate);
  const paidByPo = new Map();
  if (tableExists(db, 'treasury_movements') && tableExists(db, 'accounts_payable')) {
    const paid = rowsOf(
      optionalAll(
        db,
        `SELECT ap.po_ref, SUM(tm.amount_ngn) AS paid
         FROM treasury_movements tm
         JOIN accounts_payable ap ON ap.ap_id = tm.source_id AND tm.source_kind = 'ACCOUNTS_PAYABLE'
         WHERE tm.posted_at_iso < ? AND tm.type = 'AP_PAYMENT'
         GROUP BY ap.po_ref`,
        [endExclusive]
      )
    );
    for (const row of paid) addPaid(paidByPo, row.po_ref, row.paid);
  }
  if (tableExists(db, 'treasury_movements')) {
    const direct = rowsOf(
      optionalAll(
        db,
        `SELECT source_id, SUM(amount_ngn) AS paid
         FROM treasury_movements
         WHERE posted_at_iso < ?
           AND (
             (type = 'SUPPLIER_PAYMENT' AND source_kind = 'PURCHASE_ORDER')
             OR (type = 'SUPPLIER_OVERPAYMENT' AND source_kind = 'SUPPLIER_OVERPAYMENT')
           )
         GROUP BY source_id`,
        [endExclusive]
      )
    );
    for (const row of direct) addPaid(paidByPo, row.source_id, row.paid);
  }
  const firstPaid = new Map();
  const promised = new Map();
  for (const line of poPrices) {
    if (line.po_id && line.expected_delivery_iso) promised.set(String(line.po_id), iso(line.expected_delivery_iso));
  }
  if (tableExists(db, 'treasury_movements')) {
    const dated = rowsOf(
      optionalAll(
        db,
        `SELECT po, MIN(posted_at_iso) AS first_paid FROM (
           SELECT ap.po_ref AS po, tm.posted_at_iso
           FROM treasury_movements tm
           JOIN accounts_payable ap ON ap.ap_id = tm.source_id AND tm.source_kind = 'ACCOUNTS_PAYABLE'
           WHERE tm.posted_at_iso < ? AND tm.type = 'AP_PAYMENT'
           UNION ALL
           SELECT source_id AS po, posted_at_iso
           FROM treasury_movements
           WHERE posted_at_iso < ?
             AND (
               (type = 'SUPPLIER_PAYMENT' AND source_kind = 'PURCHASE_ORDER')
               OR (type = 'SUPPLIER_OVERPAYMENT' AND source_kind = 'SUPPLIER_OVERPAYMENT')
             )
         ) payments
         WHERE TRIM(COALESCE(po, '')) <> ''
         GROUP BY po`,
        [endExclusive, endExclusive]
      ),
      'supplier-first-paid'
    );
    for (const row of dated) firstPaid.set(String(row.po), iso(row.first_paid));
  }
  const received = new Map();
  for (const line of poPrices) {
    const po = String(line.po_id || '');
    if (!po) continue;
    const prev = received.get(po) || { supplier: line.supplier_name, received: 0 };
    prev.supplier = line.supplier_name || prev.supplier;
    received.set(po, prev);
  }
  if (tableExists(db, 'coil_lots')) {
    const lots = rowsOf(
      optionalAll(
        db,
        `SELECT po_id, line_key, weight_kg, qty_received, unit_cost_ngn_per_kg
         FROM coil_lots WHERE received_at_iso < ?`,
        [endExclusive]
      )
    );
    const priceByLine = new Map(poPrices.map((line) => [`${line.po_id}|${line.line_key}`, money(line.unit_price_per_kg_ngn)]));
    for (const lot of lots) {
      const po = String(lot.po_id || '');
      if (!po || !received.has(po)) continue;
      const rate = priceByLine.get(`${po}|${lot.line_key}`) || money(lot.unit_cost_ngn_per_kg);
      const weight = Number(lot.weight_kg ?? lot.qty_received) || 0;
      received.get(po).received += money(weight * rate);
    }
  }
  for (const row of movements || []) {
    // A posted receipt value (coil lots, stone GRN, or accessory GRN) is goods received.
    // Leaving accessory GRNs out counted a fully received PO such as PO-KD-26-0066 as an advance.
    if (
      row.type !== 'STORE_GRN_STONE' &&
      row.type !== 'STORE_GRN_STONE_FLATSHEET' &&
      row.type !== 'STORE_GRN_ACCESSORY' &&
      row.type !== 'STORE_ACCESSORY_DIRECT'
    ) {
      continue;
    }
    const receivedOn = iso(row.at_iso) || movementDate(row);
    if (!receivedOn || receivedOn >= endExclusive) continue;
    const po = String(row.ref || '');
    if (!received.has(po)) continue;
    const value = money(row.value_ngn) || money(Math.abs(Number(row.qty) || 0) * money(row.unit_price_ngn));
    received.get(po).received += value;
  }
  return [...received.entries()]
    .map(([po, row]) => {
      const paidNgn = paidByPo.get(po) || 0;
      const paidOn = firstPaid.get(po) || '';
      const advance = paidNgn > row.received;
      const days = advance ? daysOutstanding(paidOn, endDate) : null;
      return {
        date: endDate,
        ref: po,
        name: row.supplier || po,
        amountNgn: row.received - paidNgn,
        receivedNgn: row.received,
        paidNgn,
        paidOn,
        promisedDelivery: promised.get(po) || '',
        daysOutstanding: days,
        flag: days != null && days > 30 ? `Advance outstanding ${days} days` : '',
      };
    })
    .filter((row) => row.receivedNgn !== 0 || row.paidNgn !== 0);
}

function loadUnmatchedReceipts(db, branchId, startDate, endDate) {
  if (!tableExists(db, 'sales_receipts')) return [];
  const hasLedger = hasColumn(db, 'sales_receipts', 'ledger_entry_id');
  if (!hasLedger || !tableExists(db, 'treasury_movements')) return [];
  return rowsOf(
    optionalAll(
      db,
      `SELECT r.id, r.date_iso, r.amount_ngn, r.customer_name
       FROM sales_receipts r
       WHERE r.branch_id = ? AND r.date_iso >= ? AND r.date_iso <= ?
         AND COALESCE(r.status, '') NOT IN ('Suspended', 'Reversed', 'Cancelled')
         AND NOT EXISTS (
           SELECT 1 FROM treasury_movements tm
           WHERE tm.source_kind = 'LEDGER_RECEIPT' AND tm.source_id = r.ledger_entry_id
             AND tm.type = 'RECEIPT_IN'
             AND (tm.reverses_movement_id IS NULL OR TRIM(COALESCE(tm.reverses_movement_id, '')) = '')
         )`,
      [branchId, startDate, endDate]
    )
  ).map((row) => ({
    date: iso(row.date_iso),
    ref: row.id,
    name: row.customer_name || '',
    amountNgn: money(row.amount_ngn),
  }));
}

function fromPhase1(pack, endDate) {
  if (!pack?.ok) return { phase1Error: pack?.error || 'Phase 1 sales report did not load.' };
  const sales = [];
  for (const row of pack.revenue?.byQuote || []) {
    const jobs = Array.isArray(row.jobs) ? row.jobs : [];
    const jobSum = jobs.reduce((sum, job) => sum + money(job.revenueNgn), 0);
    if (jobs.length) {
      for (const job of jobs) {
        sales.push({
          date: iso(job.dateISO) || endDate,
          quotationRef: row.quotationRef,
          ref: job.jobId || row.quotationRef,
          customerName: row.customerName,
          branchId: row.branchId || '',
          amountNgn: job.revenueNgn,
          metres: job.metres,
        });
      }
    }
    const goodsLeft = money(row.goodsNgn) - jobSum;
    if (!jobs.length || goodsLeft !== 0) {
      sales.push({
        date: endDate,
        quotationRef: row.quotationRef,
        customerName: row.customerName,
        branchId: row.branchId || '',
        amountNgn: jobs.length ? goodsLeft : row.goodsNgn,
        metres: jobs.length ? null : row.metres,
      });
    }
    if (money(row.accessoryNgn)) {
      sales.push({ date: endDate, quotationRef: row.quotationRef, customerName: `${row.customerName || ''} · accessories`, branchId: row.branchId || '', amountNgn: row.accessoryNgn });
    }
    if (money(row.serviceNgn)) {
      sales.push({ date: endDate, quotationRef: row.quotationRef, customerName: `${row.customerName || ''} · services`, branchId: row.branchId || '', amountNgn: row.serviceNgn });
    }
    if (money(row.creditNoteNgn)) {
      sales.push({ date: endDate, quotationRef: row.quotationRef, customerName: `${row.customerName || ''} · credit note`, branchId: row.branchId || '', amountNgn: row.creditNoteNgn });
    }
    if (money(row.discountAllowedNgn)) {
      sales.push({ date: endDate, quotationRef: row.quotationRef, customerName: `${row.customerName || ''} · discount allowed`, branchId: row.branchId || '', amountNgn: row.discountAllowedNgn });
    }
  }
  const refundRows = pack.refunds?.review?.september?.rows || pack.refunds?.rows || [];
  const priceReductions = [];
  const advanceReturns = [];
  const overpaymentRefunds = [];
  const passThrough = [];
  for (const row of refundRows) {
    const line = {
      date: iso(row.postedAtISO || row.dateISO || row.paidAtISO) || endDate,
      ref: row.refundId || row.ref || '',
      name: row.customerName || '',
      amountNgn: money(row.amountNgn ?? row.paidNgn),
    };
    if (row.refundClass === 'PRICE_REDUCTION') priceReductions.push(line);
    else if (row.refundClass === 'ADVANCE_RETURN') advanceReturns.push(line);
    else if (row.refundClass === 'PASS_THROUGH') passThrough.push(line);
    else if (row.refundClass === 'EXCESS') overpaymentRefunds.push(line);
  }
  const composition = pack.closing?.debtors?.composition || {};
  const recovery = composition.payeeRecovery || {};
  const customerDebts = [
    ...(composition.customerDebtors?.customers || []).map((row) => ({
      date: endDate,
      ref: row.customerId,
      name: `${row.customerName || 'Customer'} · unpaid goods`,
      amountNgn: row.owedNgn,
    })),
    ...(recovery.groups || []).map((row) => ({
      date: endDate,
      ref: row.accountNo || '',
      name: `${row.payeeName || 'Payee'} · recoverable from refund payee`,
      amountNgn: row.amountNgn,
    })),
    ...(recovery.unresolved || []).map((row) => ({
      date: endDate,
      ref: row.refundId || '',
      name: `${row.customerName || row.payeeName || 'Unresolved payee'} · recoverable`,
      amountNgn: row.allocatedNgn || row.owedNgn,
    })),
  ];
  const customerAdvances = (pack.closing?.customers || [])
    .filter((row) => row.kind === 'advance' && row.positionNgn > 0)
    .map((row) => ({
      date: endDate,
      ref: row.customerId,
      name: row.customerName,
      amountNgn: row.positionNgn,
    }));
  const staffReceivables = [
    ...(composition.staffReceivables?.rows || []).map((row) => ({
      date: row.dateISO || endDate,
      ref: row.obligationId || row.quotationRef || row.customerId,
      name: `${row.customerName || 'Staff credit'} · staff purchase credit`,
      amountNgn: row.staffReceivableNgn,
    })),
    ...(recovery.staffRows || []).map((row) => ({
      date: endDate,
      ref: row.accountNo || '',
      name: `${row.staffName || row.payeeName || 'Staff'} · refund excess`,
      amountNgn: row.amountNgn,
    })),
  ];
  return {
    sales,
    salesHeadlineNgn: money(pack.revenue?.totalNgn),
    priceReductions,
    advanceReturns,
    overpaymentRefunds,
    passThrough,
    customerDebts,
    customerAdvances,
    staffReceivables,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string, month?: string, bookPrices?: object, counts?: object[], cashCountNgn?: number, bankStatements?: object }} opts
 */
const LOCKED_REVENUE = { 'BR-KD|2026-09': 175_934_996 };
const ACCEPTED_STATEMENTS = { 'BR-KD|2026-09': { 2: 1_680_669.29, 4: 3_411_799.04, jaiz: 278_000 } };

function lockedRevenueNgn(branchId, month) {
  const value = LOCKED_REVENUE[`${branchId}|${month}`];
  return value == null ? null : value;
}

function acceptedStatements(branchId, month, supplied) {
  return { ...(ACCEPTED_STATEMENTS[`${branchId}|${month}`] || {}), ...(supplied || {}) };
}

function withJaiz(accounts, branchId) {
  if (branchId !== 'BR-KD') return accounts;
  if ((accounts || []).some((row) => /jaiz/i.test(`${row.bank || ''} ${row.name || ''}`))) return accounts;
  return [
    ...(accounts || []),
    { id: 'jaiz', name: 'Jaiz Bank', bank: 'Jaiz Bank', type: 'bank', balanceNgn: 278_000, flag: 'Not an ERP treasury account. No movements.' },
  ];
}

function loadOtherBranchAdjustments(db, branchId, month, startDate, endDate) {
  if (!tableExists(db, 'sales_phase1_adjustments')) return [];
  return rowsOf(
    optionalAll(
      db,
      `SELECT quotation_ref, branch_id, kind, amount_ngn, date_iso
       FROM sales_phase1_adjustments
       WHERE kind IN ('CREDIT_NOTE', 'DISCOUNT_ALLOWED')
         AND (month = ? OR (date_iso >= ? AND date_iso <= ?))
         AND TRIM(COALESCE(branch_id, '')) <> '' AND branch_id <> ?`,
      [month, startDate, endDate, branchId]
    )
  ).map((row) => ({
    date: iso(row.date_iso),
    ref: row.quotation_ref || '',
    name: `${row.branch_id} · ${row.kind}`,
    amountNgn: -Math.abs(money(row.amount_ngn)),
    branchId: row.branch_id,
  }));
}

function loadLockChanges(db, branchId, startDate, endDate) {
  if (!tableExists(db, 'audit_log') || !tableExists(db, 'accounting_period_locks')) return [];
  const lock = db.prepare(`SELECT locked_at_iso FROM accounting_period_locks WHERE period_key = ?`).get(startDate.slice(0, 7));
  if (!lock?.locked_at_iso) return [];
  return rowsOf(
    optionalAll(
      db,
      `SELECT a.occurred_at_iso, a.actor_name, a.action, a.entity_kind, a.entity_id, a.note
       FROM audit_log a
       WHERE a.occurred_at_iso > ?
         AND (
           a.entity_id IN (SELECT id FROM sales_receipts WHERE branch_id = ? AND date_iso >= ? AND date_iso <= ?)
           OR a.entity_id IN (
             SELECT job_id FROM production_jobs
             WHERE branch_id = ?
               AND SUBSTR(COALESCE(completed_at_iso, end_date_iso, start_date_iso), 1, 10) >= ?
               AND SUBSTR(COALESCE(completed_at_iso, end_date_iso, start_date_iso), 1, 10) <= ?
           )
           OR a.entity_id IN (SELECT id FROM quotations WHERE branch_id = ? AND date_iso >= ? AND date_iso <= ?)
         )
       ORDER BY a.occurred_at_iso`,
      [lock.locked_at_iso, branchId, startDate, endDate, branchId, startDate, endDate, branchId, startDate, endDate]
    )
  ).map((row) => ({
    date: iso(row.occurred_at_iso),
    ref: row.entity_id,
    name: `${row.actor_name || ''} · ${row.action} · ${String(row.note || '').slice(0, 160)}`,
    amountNgn: 0,
  }));
}

export function buildMonthEndDataPackFromDb(db, opts = {}) {
  loaderWarnings = [];
  const branchId = String(opts.branchId || 'BR-KD').trim() || 'BR-KD';
  const period = resolveMonthEndPeriod({ month: opts.month });
  if (!period.ok) return period;

  const coils = loadCoils(db, branchId);
  const usage = loadUsage(db, branchId);
  const usageByCoil = new Map();
  for (const row of usage) {
    if (!usageByCoil.has(row.coilNo)) usageByCoil.set(row.coilNo, []);
    usageByCoil.get(row.coilNo).push(row);
  }
  const poPrices = loadPoPrices(db, branchId);
  const rateByLine = new Map(
    poPrices.map((line) => [`${line.po_id}|${line.line_key}`, money(line.unit_price_per_kg_ngn)])
  );
  const coilInput = coils.map((coil) => {
    const receivedAt = iso(coil.received_at_iso);
    const receivedKg = Number(coil.weight_kg ?? coil.qty_received) || 0;
    const live = Number(coil.current_weight_kg) || 0;
    const used = usageByCoil.get(coil.coil_no) || [];
    const poRate = rateByLine.get(`${coil.po_id}|${coil.line_key}`) || money(coil.unit_cost_ngn_per_kg);
    return {
      coilNo: coil.coil_no,
      material: coil.material_type_name,
      family: coilMaterialFamily(coil.material_type_name),
      gauge: coil.gauge_label,
      colour: coil.colour,
      stockForm: coil.stock_form || 'coil',
      poRateNgn: poRate,
      openingKg: kgAt(live, receivedAt, receivedKg, period.openingDate, used),
      closingKg: kgAt(live, receivedAt, receivedKg, period.endDate, used),
    };
  });
  const coilUsed = [];
  for (const row of usage) {
    if (row.date < period.startDate || row.date > period.endDate) continue;
    const coil = coilInput.find((item) => item.coilNo === row.coilNo);
    coilUsed.push({
      date: row.date,
      coilNo: row.coilNo,
      name: coil?.material || row.coilNo,
      kg: row.kg,
      rateNgn: coil?.poRateNgn || 0,
    });
  }

  const movements = loadMovements(db, branchId);
  const products = loadProducts(db, branchId);
  const stock = buildStoneAndAccessories(products, movements, period.openingDate, period.endDate);

  const lateCoil = new Map();
  for (const row of movements) {
    if (row.type !== 'STORE_GRN') continue;
    const coilNo = String(row.detail || '').split('·')[0].trim();
    const documentDate = movementDate(row);
    const receivedDate = iso(row.at_iso);
    if (documentDate >= period.startDate && documentDate <= period.endDate && receivedDate > period.endDate) {
      lateCoil.set(coilNo, row);
    }
  }
  const grnCoils = coils
    .filter((coil) => {
      const d = iso(coil.received_at_iso);
      return (d >= period.startDate && d <= period.endDate) || lateCoil.has(coil.coil_no);
    })
    .map((coil) => {
      const rate = rateByLine.get(`${coil.po_id}|${coil.line_key}`) || money(coil.unit_cost_ngn_per_kg);
      const weight = Number(coil.weight_kg ?? coil.qty_received) || 0;
      const late = lateCoil.has(coil.coil_no);
      return {
        date: late ? iso(lateCoil.get(coil.coil_no).at_iso) : iso(coil.received_at_iso),
        ref: coil.coil_no,
        name: [coil.po_id, coil.material_type_name, coil.gauge_label].filter(Boolean).join(' · '),
        kg: weight,
        rateNgn: rate,
        poId: coil.po_id,
        receivedLater: late,
      };
    });
  const grnStone = movements
    .filter((row) => row.type === 'STORE_GRN_STONE' || row.type === 'STORE_GRN_STONE_FLATSHEET')
    .filter((row) => {
      const d = movementDate(row);
      return d >= period.startDate && d <= period.endDate;
    })
    .map((row) => ({
      date: movementDate(row),
      ref: row.ref || row.product_id,
      name: row.detail || row.product_id || row.type,
      amountNgn: money(row.value_ngn) || money(Math.abs(Number(row.qty) || 0) * money(row.unit_price_ngn)),
      poId: row.ref || '',
      receivedLater: iso(row.at_iso) > period.endDate && movementDate(row) <= period.endDate,
    }));

  let phase1Slice = { phase1Error: '' };
  try {
    const phase1 = buildSalesPhase1ReportFromDb(db, { month: period.month, branchScope: branchId });
    phase1Slice = fromPhase1(phase1, period.endDate);
  } catch (err) {
    phase1Slice = { phase1Error: `Phase 1 sales report did not load. ${String(err?.message || err)}` };
  }

  const paidExpenses = loadExpenses(db, branchId, period.startDate, period.endDate);
  const reclassJournals = loadReclassJournals(db, branchId);
  const deferredReclasses = [];
  const deferredExpenseIds = new Set();
  const reclassInMonth = [];
  for (const journal of reclassJournals) {
    const when = iso(journal.entry_date_iso);
    const expense = expenseForReclass(db, journal.source_id);
    if (!expense?.expenseId || !when) continue;
    const category = categoryFromReclassMemo(journal.memo);
    if (when > period.endDate) {
      deferredExpenseIds.add(expense.expenseId);
      deferredReclasses.push({
        date: when,
        ref: expense.expenseId,
        name: `${expense.expenseId} ₦${expense.amountNgn.toLocaleString('en-NG')} reclassified to ${category || 'the open month'} on ${when}. Not in this locked month.`,
      });
    } else if (when >= period.startDate) {
      reclassInMonth.push({
        date: when,
        ref: expense.expenseId,
        name: expense.name,
        description: expense.name,
        category,
        amountNgn: expense.amountNgn,
        flag: `Category reclass dated ${when}. ${journal.memo || category}`,
      });
    }
  }
  const expenses = paidExpenses
    .concat(loadRegisterExpenses(db, branchId, period.startDate, period.endDate, new Set(paidExpenses.map((row) => row.ref))))
    .filter((row) => !deferredExpenseIds.has(String(row.ref || '')))
    .concat(reclassInMonth);
  const periodLocked = tableExists(db, 'accounting_period_locks')
    && Boolean(db.prepare(`SELECT period_key FROM accounting_period_locks WHERE period_key = ?`).get(period.month));
  const iouLines = expenses.filter((row) =>
    /\b(iou|10u)\b/i.test(row.description) || row.category === 'Staff loan' || row.category === 'IOU / staff loan'
  );
  const staffReceivables = [
    ...(phase1Slice.staffReceivables || []),
    ...iouLines.map((row) => ({
      date: row.date,
      ref: row.ref,
      name: `${row.name} · IOU filed as an expense`,
      amountNgn: row.amountNgn,
    })),
  ];

  return buildMonthEndDataPack({
    branchId,
    period,
    bookPrices: opts.bookPrices || {},
    counts: opts.counts || [],
    coils: coilInput,
    poPrices: poPrices.map((line) => ({
      material: line.product_name,
      gauge: line.gauge,
      rateNgn: line.unit_price_per_kg_ngn,
      poId: line.po_id,
      date: iso(line.order_date_iso),
    })),
    stone: stock.stone,
    accessories: stock.accessories,
    grns: [...grnCoils, ...grnStone],
    expenses,
    coilUsed,
    sales: phase1Slice.sales || [],
    otherBranchSales: loadOtherBranchAdjustments(db, branchId, period.month, period.startDate, period.endDate),
    lockChanges: loadLockChanges(db, branchId, period.startDate, period.endDate),
    lockedRevenueNgn: lockedRevenueNgn(branchId, period.month),
    salesHeadlineNgn: phase1Slice.salesHeadlineNgn,
    priceReductions: phase1Slice.priceReductions || [],
    advanceReturns: phase1Slice.advanceReturns || [],
    overpaymentRefunds: phase1Slice.overpaymentRefunds || [],
    passThrough: phase1Slice.passThrough || [],
    customerDebts: phase1Slice.customerDebts || [],
    customerAdvances: phase1Slice.customerAdvances || [],
    staffReceivables,
    supplierBalances: loadSuppliers(db, branchId, period.endDate, poPrices, movements),
    treasury: withJaiz(loadTreasury(db, branchId, period.endDate), branchId),
    cashCountNgn: opts.cashCountNgn,
    bankStatements: acceptedStatements(branchId, period.month, opts.bankStatements),
    periodLocked,
    deferredReclasses,
    unmatchedReceipts: loadUnmatchedReceipts(db, branchId, period.startDate, period.endDate),
    phase1Error: phase1Slice.phase1Error || '',
    loaderErrors: loaderWarnings,
  });
}

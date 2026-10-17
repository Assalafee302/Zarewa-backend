import { buildTreasuryCashBook } from '../../shared/lib/treasuryCashBookCore.js';
import { getBranch } from '../branches.js';

/** Lagos (UTC+1) start of a calendar day as an ISO instant. */
const lagosDayStartISO = (day) => new Date(`${day}T00:00:00+01:00`).toISOString();
const lagosDayEndISO = (day) => new Date(`${day}T23:59:59.999+01:00`).toISOString();
const inList = (a) => a.map(() => '?').join(',');
const uniq = (a) => [...new Set(a.filter(Boolean).map(String))];

async function tryAll(all, sql, args) {
  try {
    return await all(sql, args);
  } catch {
    return [];
  }
}

/** Staff whose bank accounts carry payouts → remark label ("via OM account", "via BM Suleiman", "via Bakari"). */
export function staffAccountsFromUsers(users) {
  return users
    .filter((u) => String(u.display_name || '').trim().split(/\s+/).length >= 2)
    .map((u) => {
      const name = String(u.display_name).trim();
      const parts = name.split(/\s+/);
      const role = String(u.role_key || '').toLowerCase();
      const label = role === 'admin' ? 'OM account' : /branch_manager|sales_manager/.test(role) ? `BM ${parts[0]}` : parts[parts.length - 1];
      return { name, label };
    });
}

/**
 * Read-only inputs for the cash-book statement of one treasury account. SELECT only.
 * @param {(sql: string, args: unknown[]) => object[] | Promise<object[]>} all
 * @param {{ accountId: number, startDate: string, endDate: string, endAtISO?: string, branchScope?: string }} p
 */
export async function loadTreasuryCashBookSourceWith(all, { accountId, startDate, endDate, endAtISO = '', branchScope = 'ALL', mode = 'confirmed' }) {
  const startISO = lagosDayStartISO(startDate);
  const endISO = endAtISO || lagosDayEndISO(endDate);
  const [account] = await all(
    `SELECT a.id, a.name, a.bank_name, a.acc_no, a.branch_id, a.opening_balance_ngn,
            COALESCE((SELECT SUM(m.amount_ngn) FROM treasury_movements m WHERE m.treasury_account_id = a.id AND m.posted_at_iso < ?), 0) AS before_ngn
     FROM treasury_accounts a WHERE a.id = ?`,
    [startISO, accountId]
  );
  if (!account) return { ok: false, error: 'Treasury account not found.' };
  if (branchScope && branchScope !== 'ALL' && String(account.branch_id) !== String(branchScope)) {
    return { ok: false, error: 'Treasury account is not in this branch.' };
  }
  const movements = await all(
    `SELECT m.id, m.posted_at_iso, m.type, m.treasury_account_id, m.amount_ngn, m.reference, m.counterparty_kind, m.counterparty_id,
            m.counterparty_name, m.source_kind, m.source_id, m.note, m.reverses_movement_id,
            (SELECT o.posted_at_iso FROM treasury_movements o WHERE o.id = m.reverses_movement_id) AS reverses_posted_at_iso
     FROM treasury_movements m WHERE m.treasury_account_id = ? AND m.posted_at_iso >= ? AND m.posted_at_iso <= ? ORDER BY m.posted_at_iso, m.id`,
    [accountId, startISO, endISO]
  );
  const ids = (kinds) => uniq(movements.filter((m) => kinds.includes(m.source_kind)).map((m) => m.source_id));
  const receiptIds = ids(['LEDGER_RECEIPT', 'LEDGER_ADVANCE']);
  const refundIds = ids(['REFUND']);
  const preqIds = ids(['PAYMENT_REQUEST']);
  const expenseIds = ids(['EXPENSE']);
  const apIds = ids(['ACCOUNTS_PAYABLE']);
  const q = async (list, sql) => (list.length ? all(sql.replace('(?)', `(${inList(list)})`), list) : []);

  const ledger = await q(receiptIds, `SELECT id, customer_name, quotation_ref, payment_method, bank_reference FROM ledger_entries WHERE id IN (?)`);
  const salesReceipts = receiptIds.length
    ? await tryAll(all, `SELECT id, paid_by_name, status, bank_confirmed_at_iso FROM sales_receipts WHERE id IN (${inList(receiptIds)})`, receiptIds)
    : [];
  const paidBy = new Map(salesReceipts.map((r) => [String(r.id), String(r.paid_by_name || '').trim()]));
  // Finance-confirmed = bank confirmation recorded or status Cleared. A receipt with no sales_receipts row (advance
  // desk, older data) has no confirmation step and counts as confirmed.
  const receiptState = new Map(
    salesReceipts.map((r) => [
      String(r.id),
      {
        status: String(r.status || '').trim(),
        confirmed: Boolean(String(r.bank_confirmed_at_iso || '').trim()) || /^cleared$/i.test(String(r.status || '').trim()),
        reversed: /reversed/i.test(String(r.status || '')),
      },
    ])
  );
  // Before the period, receipt lines (and their reversals) of receipts still unconfirmed — left out of the confirmed opening.
  const [unconfirmedBefore] = await tryAll(
    all,
    `SELECT COALESCE(SUM(m.amount_ngn), 0) AS s FROM treasury_movements m JOIN sales_receipts r ON r.id = m.source_id
     WHERE m.treasury_account_id = ? AND m.posted_at_iso < ? AND m.source_kind = 'LEDGER_RECEIPT'
       AND COALESCE(r.bank_confirmed_at_iso, '') = '' AND LOWER(TRIM(COALESCE(r.status, ''))) <> 'cleared'`,
    [accountId, startISO]
  );
  const refunds = await q(refundIds, `SELECT refund_id, customer_name, quotation_ref, payee_name, payment_note, split_distributions_json FROM customer_refunds WHERE refund_id IN (?)`);
  const refundLines = await q(refundIds, `SELECT id, source_id, posted_at_iso FROM treasury_movements WHERE source_kind = 'REFUND' AND type = 'REFUND_PAYOUT' AND source_id IN (?) ORDER BY posted_at_iso, id`);
  const preqs = await q(preqIds, `SELECT request_id, payee_name, description FROM payment_requests WHERE request_id IN (?)`);
  const expenses = await q(expenseIds, `SELECT expense_id, expense_type, category FROM expenses WHERE expense_id IN (?)`);
  const payables = await q(apIds, `SELECT ap_id, supplier_name, po_ref FROM accounts_payable WHERE ap_id IN (?)`);
  const accounts = await all(`SELECT id, name, bank_name FROM treasury_accounts`, []);
  const users = await tryAll(all, `SELECT display_name, role_key FROM app_users WHERE COALESCE(display_name, '') <> ''`, []);
  const touched = uniq([...movements.map((m) => m.id), ...movements.map((m) => m.source_id)]);
  const audits = touched.length
    ? await tryAll(all, `SELECT entity_id, note FROM audit_log WHERE action = 'phase2.correction' AND entity_id IN (${inList(touched)}) ORDER BY occurred_at_iso`, touched)
    : [];
  const bankLines = await tryAll(
    all,
    `SELECT description, system_match FROM bank_reconciliation_lines WHERE treasury_account_id = ? AND bank_date_iso >= ? AND bank_date_iso <= ?`,
    [accountId, startDate, endDate]
  );
  const balances = await tryAll(all, `SELECT period_key, closing_kobo FROM bank_statement_balances WHERE treasury_account_id = ?`, [accountId]);

  const staffShare = (json) => {
    try {
      return (JSON.parse(json || '[]') || []).some((s) => Number(s.companyDeductionNgn) > 0);
    } catch {
      return false;
    }
  };
  const corrections = {};
  for (const a of audits) {
    const tag = String(a.note || '').split(/\s+/)[0];
    corrections[a.entity_id] = `ERP corrected (${tag || 'Phase 2'})`;
  }
  const bankNarrations = {};
  for (const b of bankLines) for (const id of String(b.system_match || '').match(/TM-[A-Z]+-\d+-\d+/g) || []) bankNarrations[id] = b.description || '';
  const statementClosings = {};
  for (const b of balances) {
    const m = String(b.period_key || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) continue;
    const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
    statementClosings[last] = Number(b.closing_kobo) / 100;
  }
  const lines = {};
  for (const l of refundLines) (lines[l.source_id] ||= []).push(l.id);

  return {
    ok: true,
    source: {
      account: { id: account.id, name: account.name, bankName: account.bank_name || '', accNo: account.acc_no || '' },
      branchId: account.branch_id,
      startDate,
      endDate,
      endAtISO,
      mode: mode === 'all' ? 'all' : 'confirmed',
      openingNgn: Math.round(Number(account.opening_balance_ngn) || 0) + Math.round(Number(account.before_ngn) || 0),
      openingConfirmedNgn:
        Math.round(Number(account.opening_balance_ngn) || 0) + Math.round(Number(account.before_ngn) || 0) - Math.round(Number(unconfirmedBefore?.s) || 0),
      movements: movements.map((m) => ({
        id: m.id,
        postedAtISO: m.posted_at_iso,
        type: m.type,
        treasuryAccountId: m.treasury_account_id,
        amountNgn: m.amount_ngn,
        counterpartyId: m.counterparty_id || '',
        counterpartyName: m.counterparty_name || '',
        sourceKind: m.source_kind || '',
        sourceId: m.source_id || '',
        note: m.note || '',
        reversesMovementId: m.reverses_movement_id || '',
        reversesPostedAtISO: m.reverses_posted_at_iso || '',
      })),
      receipts: Object.fromEntries(
        ledger.map((l) => [
          l.id,
          {
            customerName: l.customer_name || '',
            paidByName: paidBy.get(String(l.id)) || '',
            quotationRef: l.quotation_ref || '',
            bankReference: l.bank_reference || '',
            pos: /\bpos\b|\bcard\b/i.test(`${l.payment_method || ''} ${l.bank_reference || ''}`),
            ...(receiptState.get(String(l.id)) || {}),
          },
        ])
      ),
      refunds: Object.fromEntries(
        refunds.map((r) => [r.refund_id, { customerName: r.customer_name || '', quotationRef: r.quotation_ref || '', payeeName: r.payee_name || '', paymentNote: r.payment_note || '', staffShare: staffShare(r.split_distributions_json) }])
      ),
      refundPayoutLines: lines,
      paymentRequests: Object.fromEntries(preqs.map((p) => [p.request_id, { payeeName: p.payee_name || '', description: p.description || '' }])),
      expenses: Object.fromEntries(expenses.map((e) => [e.expense_id, { expenseType: e.expense_type || '', category: e.category || '' }])),
      payables: Object.fromEntries(payables.map((p) => [p.ap_id, { supplierName: p.supplier_name || '', poRef: p.po_ref || '' }])),
      accountNames: Object.fromEntries(accounts.map((a) => [String(a.id), `${a.name}${a.bank_name ? ` (${a.bank_name})` : ''}`])),
      staffAccounts: staffAccountsFromUsers(users),
      corrections,
      bankNarrations,
      statementClosings,
    },
  };
}

/** Cash book for one account from loaded source (pure). */
export function treasuryCashBookFromSource(source, branchName = '') {
  return buildTreasuryCashBook({ ...source, branchName: branchName || source.branchId });
}

/** Cash book for one account (SELECT only). */
export async function buildTreasuryCashBookReport(db, p) {
  const loaded = await loadTreasuryCashBookSourceWith((sql, args) => db.prepare(sql).all(...args), p);
  if (!loaded.ok) return loaded;
  const branchRow = getBranch(db, loaded.source.branchId);
  return { ok: true, book: treasuryCashBookFromSource(loaded.source, branchRow?.name || '') };
}

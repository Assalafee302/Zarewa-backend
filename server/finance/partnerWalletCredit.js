/**
 * Partner wallet credits (BM-approved refund accruals). No imports from controlOps/writeOps
 * so approval can call this without circular dependencies.
 */
import { actorId, actorName } from '../auth.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { allocateHumanId } from '../humanId.js';
import { savedCustomerPayoutAccount } from '../sales/customerPayoutAccount.js';
import {
  applyRefundStaffAllocationDeduction,
} from '../../shared/lib/refundStaffAllocationDeduction.js';

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

export function partnerWalletEnabled() {
  const raw = String(process.env.ZAREWA_PARTNER_WALLET_V1 ?? '').trim();
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  return /^(1|true|yes|on)$/i.test(String(process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 || '0'));
}

export function partnerWalletTablesReady(db) {
  try {
    db.prepare(`SELECT 1 FROM partner_wallet_entries LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

export function nextWalletEntryId(db, branchId) {
  return allocateHumanId(db, 'PWL', branchId, {
    table: 'partner_wallet_entries',
    idColumn: 'id',
  });
}

function branchFilter(scope) {
  if (scope === 'ALL' || !scope) return { sql: '', args: [] };
  return { sql: ` AND branch_id = ?`, args: [scope] };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} refundRow
 * @param {number} approvedAmountNgn
 */
function resolveCreditTargets(db, refundRow, approvedAmountNgn) {
  const approved = roundMoney(approvedAmountNgn);
  if (approved <= 0) return [];
  let splits = [];
  try {
    const parsed = JSON.parse(String(refundRow.split_distributions_json || '[]'));
    splits = Array.isArray(parsed) ? parsed : [];
  } catch {
    splits = [];
  }
  const usable = splits
    .map((s) => {
      const kind = String(s?.recipientKind || s?.payoutAccount?.partyKind || 'customer')
        .trim()
        .toLowerCase();
      const staffId = String(s?.recipientAssociatedStaffID || '').trim();
      const customerId = String(s?.recipientCustomerID || '').trim();
      const isStaff = kind === 'associated_staff' || kind === 'staff' || (staffId && !customerId);
      return {
        recipientKind: isStaff ? 'associated_staff' : 'customer',
        recipientAssociatedStaffID: isStaff ? staffId || customerId : '',
        recipientCustomerID: isStaff ? '' : customerId,
        amountNgn: roundMoney(s?.amountNgn),
        payoutAccount: s?.payoutAccount && typeof s.payoutAccount === 'object' ? s.payoutAccount : null,
        note: String(s?.note || '').trim(),
      };
    })
    .filter(
      (s) =>
        s.amountNgn > 0 &&
        (s.recipientCustomerID || s.recipientAssociatedStaffID)
    );

  if (usable.length > 0) {
    const quoteCustomerId = String(refundRow.customer_id || '').trim();
    const splitSum = usable.reduce((s, r) => s + r.amountNgn, 0) || 1;
    let allocated = 0;
    return usable
      .map((s, idx) => {
        const isLast = idx === usable.length - 1;
        const share = isLast
          ? Math.max(0, approved - allocated)
          : roundMoney((approved * s.amountNgn) / splitSum);
        allocated += share;
        const withDeduction = applyRefundStaffAllocationDeduction(
          { ...s, amountNgn: share },
          quoteCustomerId
        );
        const creditAmount = roundMoney(withDeduction.netPayoutNgn ?? share);
        if (s.recipientKind === 'associated_staff') {
          const staff = db
            .prepare(
              `SELECT name, bank_account_name, bank_name, bank_account_no FROM associated_staff WHERE id = ?`
            )
            .get(s.recipientAssociatedStaffID);
          const payeeName =
            String(s.payoutAccount?.payeeName || staff?.bank_account_name || staff?.name || '').trim() ||
            String(refundRow.payee_name || '').trim();
          const payeeBankName =
            String(s.payoutAccount?.payeeBankName || staff?.bank_name || '').trim() ||
            String(refundRow.payee_bank_name || '').trim();
          const payeeAccountNo =
            String(s.payoutAccount?.payeeAccountNo || staff?.bank_account_no || '').trim() ||
            String(refundRow.payee_account_no || '').trim();
          return {
            partyKind: 'associated_staff',
            partyId: s.recipientAssociatedStaffID,
            partyName: String(staff?.name || payeeName || s.recipientAssociatedStaffID).trim(),
            amountNgn: creditAmount,
            grossNgn: share,
            companyDeductionNgn: roundMoney(withDeduction.companyDeductionNgn),
            payeeName,
            payeeBankName,
            payeeAccountNo,
            note:
              s.note ||
              (withDeduction.companyDeductionNgn > 0
                ? `Refund ${refundRow.refund_id} staff split (net after 20% company cut)`
                : `Refund ${refundRow.refund_id} staff split`),
          };
        }
        const resolved = savedCustomerPayoutAccount(db, s.recipientCustomerID);
        const payeeName =
          String(s.payoutAccount?.payeeName || resolved?.payeeName || '').trim() ||
          String(refundRow.payee_name || '').trim();
        const payeeBankName =
          String(s.payoutAccount?.payeeBankName || resolved?.payeeBankName || '').trim() ||
          String(refundRow.payee_bank_name || '').trim();
        const payeeAccountNo =
          String(s.payoutAccount?.payeeAccountNo || resolved?.payeeAccountNo || '').trim() ||
          String(refundRow.payee_account_no || '').trim();
        return {
          partyKind: 'customer',
          partyId: s.recipientCustomerID,
          partyName: String(resolved?.partyName || payeeName || s.recipientCustomerID).trim(),
          amountNgn: creditAmount,
          grossNgn: share,
          companyDeductionNgn: roundMoney(withDeduction.companyDeductionNgn),
          payeeName,
          payeeBankName,
          payeeAccountNo,
          note:
            s.note ||
            (withDeduction.companyDeductionNgn > 0
              ? `Refund ${refundRow.refund_id} split (net after 20% company cut)`
              : `Refund ${refundRow.refund_id} split`),
        };
      })
      .filter((t) => t.amountNgn > 0);
  }

  const customerId = String(refundRow.customer_id || '').trim();
  if (!customerId) return [];
  const resolved = savedCustomerPayoutAccount(db, customerId);
  return [
    {
      partyKind: 'customer',
      partyId: customerId,
      partyName: String(resolved?.partyName || refundRow.customer_name || customerId).trim(),
      amountNgn: approved,
      payeeName: String(refundRow.payee_name || resolved?.payeeName || '').trim(),
      payeeBankName: String(refundRow.payee_bank_name || resolved?.payeeBankName || '').trim(),
      payeeAccountNo: String(refundRow.payee_account_no || resolved?.payeeAccountNo || '').trim(),
      note: `Refund ${refundRow.refund_id} approved`,
    },
  ];
}

/**
 * Credit partner wallets when a refund is BM-approved (call inside the approval transaction).
 */
export function creditRefundToPartnerWalletTx(db, refundRow, { approvedAmountNgn, actor } = {}) {
  if (!partnerWalletEnabled() || !partnerWalletTablesReady(db)) {
    return { ok: true, skipped: true };
  }
  const refundId = String(refundRow?.refund_id || '').trim();
  if (!refundId) return { ok: false, error: 'Refund id required for wallet credit.' };
  const existing = db
    .prepare(
      `SELECT id FROM partner_wallet_entries
       WHERE entry_type = 'credit' AND source_kind = 'REFUND' AND source_id = ? AND amount_ngn > 0`
    )
    .all(refundId);
  if (existing.length) {
    return { ok: true, skipped: true, reason: 'already_credited' };
  }
  const targets = resolveCreditTargets(db, refundRow, approvedAmountNgn);
  if (!targets.length) {
    return { ok: false, error: 'Could not resolve wallet payee for approved refund.' };
  }
  for (const t of targets) {
    if (!t.payeeName || !t.payeeBankName || !t.payeeAccountNo) {
      return {
        ok: false,
        error: `Wallet credit blocked: ${t.partyName || t.partyId} needs complete bank details on profile.`,
      };
    }
  }
  const branchId = String(refundRow.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const at = new Date().toISOString();
  const credits = [];
  const ins = db.prepare(`
    INSERT INTO partner_wallet_entries (
      id, party_kind, party_id, party_name, entry_type, amount_ngn, open_ngn,
      source_kind, source_id, refund_id, withdrawal_id, branch_id,
      payee_name, payee_bank_name, payee_account_no, note,
      created_at_iso, created_by_user_id, created_by_name, treasury_movement_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const t of targets) {
    const id = nextWalletEntryId(db, branchId);
    ins.run(
      id,
      t.partyKind,
      t.partyId,
      t.partyName,
      'credit',
      t.amountNgn,
      t.amountNgn,
      'REFUND',
      refundId,
      refundId,
      null,
      branchId,
      t.payeeName,
      t.payeeBankName,
      t.payeeAccountNo,
      t.note,
      at,
      actorId(actor),
      actorName(actor),
      null
    );
    credits.push({
      id,
      partyId: t.partyId,
      amountNgn: t.amountNgn,
      grossNgn: t.grossNgn != null ? t.grossNgn : t.amountNgn,
      companyDeductionNgn: roundMoney(t.companyDeductionNgn),
    });
  }

  // Company 20% cut is retained at approval — bump paid so wallet nets can finish the refund.
  const companyRetentionNgn = credits.reduce((s, c) => s + roundMoney(c.companyDeductionNgn), 0);
  if (companyRetentionNgn > 0) {
    const paidNow = roundMoney(refundRow.paid_amount_ngn);
    db.prepare(
      `UPDATE customer_refunds
       SET paid_amount_ngn = ?,
           payment_note = CASE
             WHEN TRIM(COALESCE(payment_note, '')) = '' THEN ?
             ELSE payment_note
           END
       WHERE refund_id = ?`
    ).run(
      paidNow + companyRetentionNgn,
      `Company retained ₦${companyRetentionNgn.toLocaleString('en-NG')} (20% staff allocation cut).`,
      refundId
    );
  }

  return { ok: true, credits, companyRetentionNgn };
}

/** Void open credits for a cancelled refund (no withdrawals yet). */
export function voidPartnerWalletCreditsForRefundTx(db, refundId) {
  if (!partnerWalletTablesReady(db)) return { ok: true, skipped: true };
  const rid = String(refundId || '').trim();
  if (!rid) return { ok: true };
  const open = db
    .prepare(
      `SELECT id, amount_ngn, open_ngn FROM partner_wallet_entries
       WHERE entry_type = 'credit' AND refund_id = ?`
    )
    .all(rid);
  for (const row of open) {
    if (roundMoney(row.open_ngn) < roundMoney(row.amount_ngn)) {
      return {
        ok: false,
        error: 'Cannot cancel: part of this refund was already withdrawn from the partner wallet.',
      };
    }
  }
  db.prepare(
    `UPDATE partner_wallet_entries SET open_ngn = 0, note = COALESCE(note,'') || ' [voided on refund cancel]'
     WHERE entry_type = 'credit' AND refund_id = ?`
  ).run(rid);
  return { ok: true };
}

export function refundHasOpenWalletCredit(db, refundId) {
  if (!partnerWalletTablesReady(db)) return false;
  const rid = String(refundId || '').trim();
  if (!rid) return false;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(open_ngn), 0) AS s FROM partner_wallet_entries
       WHERE entry_type = 'credit' AND refund_id = ? AND open_ngn > 0`
    )
    .get(rid);
  return roundMoney(row?.s) > 0;
}

export function openWalletCreditNgnForRefund(db, refundId) {
  if (!partnerWalletTablesReady(db)) return 0;
  const rid = String(refundId || '').trim();
  if (!rid) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(open_ngn), 0) AS s FROM partner_wallet_entries
       WHERE entry_type = 'credit' AND refund_id = ? AND open_ngn > 0`
    )
    .get(rid);
  return roundMoney(row?.s);
}

export function listPartnerWalletBalancesDue(db, branchScope = 'ALL') {
  if (!partnerWalletEnabled() || !partnerWalletTablesReady(db)) return [];
  const bw = branchFilter(branchScope);
  const rows = db
    .prepare(
      `
      SELECT party_kind, party_id,
             MAX(party_name) AS party_name,
             MAX(payee_name) AS payee_name,
             MAX(payee_bank_name) AS payee_bank_name,
             MAX(payee_account_no) AS payee_account_no,
             MAX(branch_id) AS branch_id,
             COALESCE(SUM(CASE WHEN entry_type = 'credit' THEN open_ngn ELSE 0 END), 0) AS balance_ngn,
             COUNT(CASE WHEN entry_type = 'credit' AND open_ngn > 0 THEN 1 END) AS open_credit_count
      FROM partner_wallet_entries
      WHERE 1=1 ${bw.sql}
      GROUP BY party_kind, party_id
      HAVING balance_ngn > 0
      ORDER BY party_name COLLATE NOCASE
    `
    )
    .all(...bw.args);
  return rows.map((r) => ({
    partyKind: r.party_kind,
    partyId: r.party_id,
    partyName: r.party_name || r.party_id,
    payeeName: r.payee_name || '',
    payeeBankName: r.payee_bank_name || '',
    payeeAccountNo: r.payee_account_no || '',
    branchId: r.branch_id || '',
    balanceNgn: roundMoney(r.balance_ngn),
    openCreditCount: Number(r.open_credit_count) || 0,
  }));
}

export function listPartnerWalletOpenCredits(db, partyKind, partyId, branchScope = 'ALL') {
  if (!partnerWalletTablesReady(db)) return [];
  const pk = String(partyKind || '').trim();
  const pid = String(partyId || '').trim();
  if (!pk || !pid) return [];
  const bw = branchFilter(branchScope);
  return db
    .prepare(
      `
      SELECT id, refund_id, amount_ngn, open_ngn, payee_name, payee_bank_name, payee_account_no,
             branch_id, note, created_at_iso, source_id, party_name
      FROM partner_wallet_entries
      WHERE entry_type = 'credit' AND open_ngn > 0
        AND party_kind = ? AND party_id = ? ${bw.sql}
      ORDER BY created_at_iso ASC, id ASC
    `
    )
    .all(pk, pid, ...bw.args)
    .map((r) => ({
      id: r.id,
      refundId: r.refund_id || r.source_id || '',
      amountNgn: roundMoney(r.amount_ngn),
      openNgn: roundMoney(r.open_ngn),
      payeeName: r.payee_name || '',
      payeeBankName: r.payee_bank_name || '',
      payeeAccountNo: r.payee_account_no || '',
      branchId: r.branch_id || '',
      partyName: r.party_name || '',
      note: r.note || '',
      createdAtISO: r.created_at_iso || '',
    }));
}

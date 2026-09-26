/**
 * Normalize refund payout splits at create time.
 * Incomplete payee rows (amount typed, search still empty) must not drop the remainder:
 * when the quote customer has a bank, leftover naira go to that customer.
 */
import { claimingStaffPayeeForUserId, savedCustomerPayoutAccount } from './customerPayoutAccount.js';
import { saveRefundPayoutBank } from './refundPayoutBankOps.js';
import { REFUND_AMOUNT_LINE_TOLERANCE_NGN } from '../../shared/refundConstants.js';

const CLAIMING_KIND = new Set([
  'customer',
  'claiming_staff',
  'quotation_sales_staff',
  'sales_staff',
  'quote_customer',
]);

export function roundRefundSplitMoney(value) {
  return Math.round(Number(value) || 0);
}

function trim(v) {
  return String(v ?? '').trim();
}

function inlinePayoutFromRow(r) {
  const payeeName = trim(r?.payoutAccount?.payeeName ?? r?.payeeName ?? r?.payee_name);
  const payeeBankName = trim(r?.payoutAccount?.payeeBankName ?? r?.payeeBankName ?? r?.payee_bank_name);
  const payeeAccountNo = trim(
    r?.payoutAccount?.payeeAccountNo ?? r?.payeeAccountNo ?? r?.payee_account_no
  ).replace(/\s+/g, '');
  return { payeeName, payeeBankName, payeeAccountNo };
}

function payoutAccountIfComplete(inline) {
  if (!inline?.payeeName || !inline?.payeeBankName || !inline?.payeeAccountNo) return null;
  if (inline.payeeAccountNo.length < 6) return null;
  return inline;
}

/**
 * @param {unknown} input
 * @param {{ quoteCustomerId?: string }} [opts]
 */
export function normalizeRefundSplitRows(input, opts = {}) {
  const quoteCustomerId = trim(opts.quoteCustomerId);
  const rows = Array.isArray(input) ? input : [];
  return rows
    .map((r) => {
      const kindRaw = trim(r?.recipientKind ?? r?.recipient_kind).toLowerCase();
      const staffId = trim(r?.recipientAssociatedStaffID ?? r?.recipient_associated_staff_id);
      const userId = trim(r?.recipientUserId ?? r?.userId ?? r?.handledByUserId ?? r?.handled_by_user_id);
      let customerId = trim(r?.recipientCustomerID ?? r?.recipient_customer_id ?? r?.recipientId);
      const amountNgn = roundRefundSplitMoney(r?.amountNgn ?? r?.amount_ngn);
      const note = trim(r?.note);
      const companyCutWaived = Boolean(
        r?.companyCutWaived === true || r?.company_cut_waived === true || r?.waiveCompanyCut === true
      );
      const companyCutWaiverNote = trim(r?.companyCutWaiverNote ?? r?.company_cut_waiver_note);
      const inline = inlinePayoutFromRow(r);
      const asStaff =
        kindRaw === 'associated_staff' ||
        kindRaw === 'staff' ||
        (Boolean(staffId) && !customerId && !CLAIMING_KIND.has(kindRaw));
      if (asStaff) {
        return {
          recipientKind: 'associated_staff',
          recipientAssociatedStaffID: staffId || customerId,
          recipientCustomerID: '',
          recipientUserId: userId,
          amountNgn,
          note,
          companyCutWaived,
          companyCutWaiverNote,
          ...inline,
        };
      }
      if (!customerId && quoteCustomerId && (CLAIMING_KIND.has(kindRaw) || !kindRaw) && !userId) {
        customerId = quoteCustomerId;
      }
      return {
        recipientKind: 'customer',
        recipientCustomerID: customerId,
        recipientAssociatedStaffID: '',
        recipientUserId: userId,
        amountNgn,
        note,
        companyCutWaived,
        companyCutWaiverNote,
        ...inline,
      };
    })
    .filter(
      (r) =>
        r.amountNgn > 0 &&
        ((r.recipientKind === 'associated_staff' && r.recipientAssociatedStaffID) ||
          (r.recipientKind === 'customer' && (r.recipientCustomerID || r.recipientUserId)))
    );
}

/**
 * Claiming-staff / HR logins sometimes arrive as associated_staff ids.
 * Rewrite to the linked sales customer so the 20% claiming-staff cut applies.
 */
export function coerceRefundSplitRecipient(db, split) {
  const row = split && typeof split === 'object' ? { ...split } : split;
  if (!row) return row;
  const staffId = trim(row.recipientAssociatedStaffID);
  const userId = trim(row.recipientUserId);
  if (trim(row.recipientKind) === 'associated_staff' && staffId) {
    const ast = db.prepare(`SELECT id FROM associated_staff WHERE id = ?`).get(staffId);
    if (ast) return row;
    const claiming = claimingStaffPayeeForUserId(db, staffId);
    if (claiming?.customerID) {
      return {
        ...row,
        recipientKind: 'customer',
        recipientCustomerID: trim(claiming.customerID),
        recipientAssociatedStaffID: '',
      };
    }
    const asCustomer = db.prepare(`SELECT customer_id FROM customers WHERE customer_id = ?`).get(staffId);
    if (asCustomer) {
      return {
        ...row,
        recipientKind: 'customer',
        recipientCustomerID: staffId,
        recipientAssociatedStaffID: '',
      };
    }
  }
  if (trim(row.recipientKind) === 'customer' && !trim(row.recipientCustomerID) && userId) {
    const claiming = claimingStaffPayeeForUserId(db, userId);
    if (claiming?.customerID) {
      return { ...row, recipientCustomerID: trim(claiming.customerID) };
    }
  }
  return row;
}

/**
 * When split lines exist but do not sum to the refund, put leftover naira on the quote customer
 * if that customer has a bank (same as the empty-split default).
 */
export function applyQuoteCustomerSplitRemainder(splits, amountNgn, quoteCustomerId, opts = {}) {
  const quoteId = trim(quoteCustomerId);
  const amount = roundRefundSplitMoney(amountNgn);
  const list = Array.isArray(splits) ? splits.map((s) => ({ ...s })) : [];
  if (!quoteId || opts.customerHasBank !== true) return list;
  const sum = list.reduce((s, r) => s + roundRefundSplitMoney(r.amountNgn), 0);
  const remainder = roundRefundSplitMoney(amount - sum);
  if (remainder <= REFUND_AMOUNT_LINE_TOLERANCE_NGN) return list;
  const idx = list.findIndex(
    (s) => trim(s.recipientKind) === 'customer' && trim(s.recipientCustomerID) === quoteId
  );
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      amountNgn: roundRefundSplitMoney(list[idx].amountNgn) + remainder,
    };
    return list;
  }
  list.push({
    recipientKind: 'customer',
    recipientCustomerID: quoteId,
    recipientAssociatedStaffID: '',
    amountNgn: remainder,
    note: 'Remainder to quote customer',
    companyCutWaived: false,
    companyCutWaiverNote: '',
    payeeName: '',
    payeeBankName: '',
    payeeAccountNo: '',
  });
  return list;
}

function savedAssociatedStaffPayoutAccount(db, staffId) {
  const id = trim(staffId);
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT id, name, staff_type, status, bank_account_name, bank_name, bank_account_no
       FROM associated_staff WHERE id = ?`
    )
    .get(id);
  if (!row) return null;
  if (String(row.status || 'Active').trim().toLowerCase() !== 'active') return null;
  const bankAccountNo = trim(row.bank_account_no);
  const bankName = trim(row.bank_name);
  const bankAccountName = trim(row.bank_account_name);
  if (!bankAccountNo || !bankName) return null;
  return {
    partyKind: 'associated_staff',
    partyId: id,
    partyName: trim(row.name),
    payeeName: bankAccountName || trim(row.name),
    payeeAccountNo: bankAccountNo,
    payeeBankName: bankName,
    staffType: trim(row.staff_type),
  };
}

function accountFromInline(split, partyKind, partyId, partyName) {
  const inline = payoutAccountIfComplete(inlinePayoutFromRow(split));
  if (!inline) return null;
  return {
    partyKind,
    partyId,
    partyName: partyName || inline.payeeName,
    payeeName: inline.payeeName,
    payeeAccountNo: inline.payeeAccountNo,
    payeeBankName: inline.payeeBankName,
  };
}

/**
 * Saved profile bank, else inline account from the refund form (persisted when possible).
 */
export function resolveRefundSplitPayoutAccount(db, split, branchId = '') {
  const inlineAcct = accountFromInline(
    split,
    trim(split?.recipientKind) === 'associated_staff' ? 'associated_staff' : 'customer',
    trim(split?.recipientAssociatedStaffID) || trim(split?.recipientCustomerID),
    ''
  );
  if (trim(split?.recipientKind) === 'associated_staff') {
    const saved = savedAssociatedStaffPayoutAccount(db, split.recipientAssociatedStaffID);
    if (saved) return saved;
    if (inlineAcct) {
      const persisted = saveRefundPayoutBank(db, {
        kind: 'associated_staff',
        id: split.recipientAssociatedStaffID,
        bankAccountName: inlineAcct.payeeName,
        bankName: inlineAcct.payeeBankName,
        bankAccountNo: inlineAcct.payeeAccountNo,
        branchId,
      });
      if (persisted.ok) {
        return {
          ...inlineAcct,
          partyKind: 'associated_staff',
          partyId: trim(split.recipientAssociatedStaffID),
          partyName: persisted.name || inlineAcct.partyName,
        };
      }
      return inlineAcct;
    }
    return null;
  }
  const saved = savedCustomerPayoutAccount(db, split.recipientCustomerID);
  if (saved) return saved;
  if (inlineAcct) {
    const persisted = saveRefundPayoutBank(db, {
      kind: 'customer',
      id: split.recipientCustomerID,
      bankAccountName: inlineAcct.payeeName,
      bankName: inlineAcct.payeeBankName,
      bankAccountNo: inlineAcct.payeeAccountNo,
      branchId,
    });
    if (persisted.ok) {
      return {
        ...inlineAcct,
        partyKind: 'customer',
        partyId: trim(split.recipientCustomerID),
        partyName: persisted.name || inlineAcct.partyName,
      };
    }
    return {
      ...inlineAcct,
      partyKind: 'customer',
      partyId: trim(split.recipientCustomerID),
    };
  }
  return null;
}

/**
 * One till truth: Cash / POS / Bank from live `treasury_accounts.balance`
 * (the same column payouts debit). Do not reconstruct from truncated
 * bootstrap movements — shell mode omits the movement register.
 *
 * Frontend copies via `npm run sync:shared` → src/shared/lib/treasuryTillLane.js
 */
export const TILL_LANE = {
  CASH: 'cash',
  POS: 'pos',
  BANK: 'bank',
};

export function treasuryPayoutAvailableNgn(account) {
  return Math.round(Number(account?.balance) || 0);
}

/**
 * Lane for a treasury account. POS is often stored as type Bank with name "POS".
 * @param {{ type?: string; name?: string; bankName?: string; bank_name?: string } | null | undefined} account
 */
export function treasuryTillLane(account) {
  const type = String(account?.type || '').trim().toLowerCase();
  if (type === 'cash') return TILL_LANE.CASH;
  if (type === 'pos') return TILL_LANE.POS;
  const blob = `${account?.name || ''} ${account?.bankName || account?.bank_name || ''}`.toLowerCase();
  if (/\bpos\b/.test(blob) || blob.includes('point of sale')) return TILL_LANE.POS;
  if (type === 'bank') return TILL_LANE.BANK;
  if (/\btill\b/.test(blob) || /\bcash office\b/.test(blob)) return TILL_LANE.CASH;
  return TILL_LANE.BANK;
}

function emptyLaneLast() {
  return { lastPostedAtISO: null, lastAccountName: '', lastAmountNgn: 0 };
}

/**
 * @param {{
 *   accounts?: object[];
 *   lastByAccountId?: Record<string, { postedAtISO?: string; amountNgn?: number }>;
 *   unclearedCount?: number;
 *   unclearedNgn?: number;
 * }} input
 */
export function composeTreasuryTillTruth(input = {}) {
  const accounts = Array.isArray(input.accounts) ? input.accounts : [];
  const lastByAccountId = input.lastByAccountId && typeof input.lastByAccountId === 'object' ? input.lastByAccountId : {};
  const lanes = {
    [TILL_LANE.CASH]: { ngn: 0, ...emptyLaneLast() },
    [TILL_LANE.POS]: { ngn: 0, ...emptyLaneLast() },
    [TILL_LANE.BANK]: { ngn: 0, ...emptyLaneLast() },
  };
  for (const acc of accounts) {
    const lane = treasuryTillLane(acc);
    const ngn = treasuryPayoutAvailableNgn(acc);
    lanes[lane].ngn += ngn;
    const last = lastByAccountId[acc.id] || lastByAccountId[String(acc.id)];
    const posted = String(last?.postedAtISO || '').trim();
    if (posted && (!lanes[lane].lastPostedAtISO || posted > lanes[lane].lastPostedAtISO)) {
      lanes[lane].lastPostedAtISO = posted;
      lanes[lane].lastAccountName = String(acc.name || acc.bankName || '').trim();
      lanes[lane].lastAmountNgn = Math.round(Number(last.amountNgn) || 0);
    }
  }
  const cashNgn = Math.round(lanes.cash.ngn);
  const posNgn = Math.round(lanes.pos.ngn);
  const bankNgn = Math.round(lanes.bank.ngn);
  return {
    cashNgn,
    posNgn,
    bankNgn,
    totalNgn: cashNgn + posNgn + bankNgn,
    lastMovement: {
      cash: {
        lastPostedAtISO: lanes.cash.lastPostedAtISO,
        lastAccountName: lanes.cash.lastAccountName,
        lastAmountNgn: lanes.cash.lastAmountNgn,
      },
      pos: {
        lastPostedAtISO: lanes.pos.lastPostedAtISO,
        lastAccountName: lanes.pos.lastAccountName,
        lastAmountNgn: lanes.pos.lastAmountNgn,
      },
      bank: {
        lastPostedAtISO: lanes.bank.lastPostedAtISO,
        lastAccountName: lanes.bank.lastAccountName,
        lastAmountNgn: lanes.bank.lastAmountNgn,
      },
    },
    unclearedCount: Math.max(0, Math.round(Number(input.unclearedCount) || 0)),
    unclearedNgn: Math.round(Number(input.unclearedNgn) || 0),
  };
}

/** A payout remainder at or under this amount is closed as rounding, not paid out. */
export const PAYOUT_ROUNDING_CLOSE_MAX_NGN = 200;

export function payoutRemainderOffersRoundingClose(outstandingNgn) {
  const n = Math.round(Number(outstandingNgn) || 0);
  return n > 1 && n <= PAYOUT_ROUNDING_CLOSE_MAX_NGN;
}

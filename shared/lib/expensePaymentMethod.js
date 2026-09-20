/**
 * Map treasury account types onto the expense register payment_method word.
 * Filing packs treat `Pending` as unpaid — payout must replace it.
 *
 * @param {Array<string | null | undefined>} types
 * @returns {'Cash' | 'Bank' | 'Mixed'}
 */
export function expensePaymentMethodFromAccountTypes(types) {
  const buckets = new Set();
  for (const raw of Array.isArray(types) ? types : []) {
    const s = String(raw || '')
      .trim()
      .toLowerCase();
    if (!s) continue;
    if (s === 'cash' || s === 'till' || s === 'pos' || s.includes('cash')) buckets.add('cash');
    else buckets.add('bank');
  }
  if (buckets.size === 0) return 'Mixed';
  if (buckets.size > 1) return 'Mixed';
  return buckets.has('cash') ? 'Cash' : 'Bank';
}

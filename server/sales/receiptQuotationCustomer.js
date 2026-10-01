/**
 * Receipts post to the quotation customer. The sales form takes customer from the quote;
 * leftover customer id from a previous receipt row must not block posting.
 */

/**
 * @param {{ customerID?: string, customer_id?: string } | null | undefined} quotation
 * @param {unknown} [requestedCustomerId]
 */
export function resolveReceiptPostingCustomer(quotation, requestedCustomerId) {
  const quoteCustomerId = String(quotation?.customerID ?? quotation?.customer_id ?? '').trim();
  const requested = String(requestedCustomerId ?? '').trim();
  if (!quoteCustomerId) {
    return { ok: false, error: 'This quotation has no customer on file.' };
  }
  return {
    ok: true,
    customerID: quoteCustomerId,
    requestedCustomerId: requested,
    usedQuoteCustomer: !requested || requested !== quoteCustomerId,
  };
}

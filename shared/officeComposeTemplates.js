/**
 * Versioned-style compose templates for office operations (structured fields + filing hints).
 * @type {Array<{
 *   id: string;
 *   title: string;
 *   summary: string;
 *   filingClass: string;
 *   fields: Array<{ key: string; label: string; type: 'text'|'number'|'date'; required?: boolean }>;
 * }>}
 */
export const OFFICE_OPERATION_TEMPLATES = [
  {
    id: 'production_handover',
    title: 'Production handover / factory issue',
    summary: 'Document a production issue, downtime, or handover between shifts.',
    filingClass: 'operations.production',
    fields: [
      { key: 'lineOrArea', label: 'Line or area', type: 'text', required: true },
      { key: 'issueSummary', label: 'Issue summary', type: 'text', required: true },
      { key: 'downtimeHours', label: 'Downtime (hours)', type: 'number', required: false },
      { key: 'actionTaken', label: 'Action taken', type: 'text', required: false },
    ],
  },
  {
    id: 'maintenance_event',
    title: 'Maintenance request',
    summary: 'Log maintenance work, asset, and safety context.',
    filingClass: 'operations.maintenance',
    fields: [
      { key: 'assetTag', label: 'Asset tag / machine', type: 'text', required: true },
      { key: 'faultDescription', label: 'Fault / work required', type: 'text', required: true },
      { key: 'requestedDate', label: 'Requested date', type: 'date', required: false },
    ],
  },
  {
    id: 'purchase_exception',
    title: 'Purchase / supplier exception',
    summary: 'Explain delivery, quality, or pricing variance for procurement.',
    filingClass: 'procurement.purchase',
    fields: [
      { key: 'supplierName', label: 'Supplier', type: 'text', required: true },
      { key: 'poOrGrnRef', label: 'PO / GRN reference', type: 'text', required: false },
      { key: 'varianceNgn', label: 'Amount impact (NGN)', type: 'number', required: false },
    ],
  },
  {
    id: 'refund_context',
    title: 'Refund — internal context memo',
    summary: 'Attach narrative and evidence before or after a formal refund request.',
    filingClass: 'finance.refund',
    fields: [
      { key: 'customerName', label: 'Customer', type: 'text', required: true },
      { key: 'quotationRef', label: 'Quotation ref', type: 'text', required: false },
      { key: 'amountNgn', label: 'Amount discussed (NGN)', type: 'number', required: false },
    ],
  },
  {
    id: 'md_instruction_record',
    title: 'MD instruction (written record)',
    summary: 'Clerk captures an oral instruction; MD endorses in the thread.',
    filingClass: 'governance.md_instruction',
    fields: [
      { key: 'instructionSummary', label: 'Instruction summary', type: 'text', required: true },
      { key: 'expectedAmountNgn', label: 'Expected amount (NGN)', type: 'number', required: false },
      { key: 'payee', label: 'Payee / beneficiary', type: 'text', required: false },
    ],
  },
];

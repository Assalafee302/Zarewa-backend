/** Material header aligned with LC100 / transactional cutting + production (MAT-002 Longspan). */
export const TEST_QUOTATION_MATERIAL = {
  materialTypeId: 'MAT-002',
  materialGauge: '0.24mm',
  materialColor: 'IV',
  materialDesign: 'Longspan (Indus6)',
};

/** Merge material header onto POST /api/quotations bodies in tests. */
export function withTestQuotationMaterial(body) {
  return { ...TEST_QUOTATION_MATERIAL, ...body };
}

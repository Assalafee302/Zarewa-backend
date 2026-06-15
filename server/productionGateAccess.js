/**
 * Production payment gate — re-export shared policy (server + tests).
 */
export {
  PRODUCTION_GATE_OVERRIDE_NOTE_MIN_LEN,
  productionGateApprovalLevelForActor,
  productionGateOverrideDeniedMessage,
  productionGateOverrideEffective,
  productionGateOverrideNoteValid,
  quotationHasRecordedPayment,
  userMayApproveProductionGate,
} from '../shared/lib/productionGateAccess.js';

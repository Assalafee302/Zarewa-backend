/**
 * Feature flag and configuration for the unified AI orchestration layer.
 *
 * @module server/aiUnificationLayer/config/unifiedAiConfig
 */

import { CONFIDENCE_MEDIUM } from '../../aiIntelligenceRouter/services/confidenceService.js';

/**
 * When unset or false, all AI paths behave exactly as before unified layer existed.
 *
 * @returns {boolean}
 */
export function isUnifiedAiEnabled() {
  const raw = process.env.ZARE_AI_UNIFIED_MODE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

/**
 * @returns {{
 *   enabled: boolean;
 *   routerConfidenceThreshold: number;
 *   kcFallbackEnabled: boolean;
 *   helpFallbackEnabled: boolean;
 * }}
 */
export function readUnifiedAiConfig() {
  return {
    enabled: isUnifiedAiEnabled(),
    routerConfidenceThreshold: CONFIDENCE_MEDIUM,
    kcFallbackEnabled: true,
    helpFallbackEnabled: true,
  };
}

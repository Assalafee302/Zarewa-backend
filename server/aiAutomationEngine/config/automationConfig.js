/**
 * Feature flag for AI automation (Phase 5).
 *
 * @module server/aiAutomationEngine/config/automationConfig
 */

import { CONFIDENCE_MEDIUM } from '../../aiIntelligenceRouter/services/confidenceService.js';

/**
 * @returns {boolean}
 */
export function isAutomationEnabled() {
  const raw = process.env.ZARE_AI_AUTOMATION_MODE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

/**
 * @returns {{
 *   enabled: boolean;
 *   confidenceThreshold: number;
 *   highRiskConfidenceThreshold: number;
 * }}
 */
export function readAutomationConfig() {
  return {
    enabled: isAutomationEnabled(),
    confidenceThreshold: CONFIDENCE_MEDIUM,
    highRiskConfidenceThreshold: 0.75,
  };
}

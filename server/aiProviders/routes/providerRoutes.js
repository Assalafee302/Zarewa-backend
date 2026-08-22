/**
 * AI provider layer HTTP routes (status / health).
 *
 * @module server/aiProviders/routes/providerRoutes
 */

import { requireAuth, requirePermission } from '../../auth.js';
import { healthCheckProviders } from '../healthCheck.js';
import { getUsageSummary } from '../costController.js';
import { readProviderConfig } from '../config/providerConfig.js';

/**
 * @param {import('express').Application} app
 */
export function registerAiProviderRoutes(app) {
  app.get(
    '/api/ai/providers/status',
    requireAuth,
    requirePermission(['settings.manage', 'settings.view']),
    async (_req, res) => {
    try {
      const cfg = readProviderConfig();
      const health = await healthCheckProviders();
      res.json({
        ok: true,
        config: {
          huggingFaceEnabled: cfg.huggingFaceEnabled,
          openAiEnabled: cfg.openAiEnabled,
          ollamaEnabled: cfg.ollamaEnabled,
          providerLayerActive: cfg.providerLayerActive,
        },
        health,
        usage: getUsageSummary(),
      });
    } catch (e) {
      console.error('[ai-provider] status error', e);
      res.status(500).json({ ok: false, error: 'Could not load provider status.' });
    }
  }
  );
}

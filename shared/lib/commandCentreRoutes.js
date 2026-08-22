/**
 * Command Centre navigation — merged exec + business intelligence.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/commandCentreRoutes.js
 */
export const COMMAND_CENTRE_PATH = '/exec';
export const COMMAND_CENTRE_INTELLIGENCE = '/exec?tab=intelligence';
export const COMMAND_CENTRE_FINANCE = '/exec?tab=finance';

/** Legacy route; redirects to intelligence when user has exec access. */
export const LEGACY_BI_PATH = '/analytics';

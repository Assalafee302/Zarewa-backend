import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAutomationEnabled, readAutomationConfig } from './config/automationConfig.js';
import {
  classifyProposalRisk,
  validateProposalForCreation,
  validateProposalApproval,
  FORBIDDEN_AUTO_ACTIONS,
} from './services/aiSafetyGuardService.js';
import { shouldCreateProposal } from './services/aiAutomationRouterService.js';
import { AUTOMATION_TYPES } from '../../shared/lib/aiAutomation/proposalTypes.js';
import { suggestHrLetterAssist } from '../aiUnificationLayer/services/hrLetterUnifiedAssist.js';

describe('automationConfig', () => {
  let saved;

  beforeEach(() => {
    saved = process.env.ZARE_AI_AUTOMATION_MODE;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ZARE_AI_AUTOMATION_MODE;
    else process.env.ZARE_AI_AUTOMATION_MODE = saved;
  });

  it('is disabled by default', () => {
    delete process.env.ZARE_AI_AUTOMATION_MODE;
    expect(isAutomationEnabled()).toBe(false);
  });

  it('enables on true', () => {
    process.env.ZARE_AI_AUTOMATION_MODE = 'true';
    expect(isAutomationEnabled()).toBe(true);
  });

  it('readAutomationConfig exposes thresholds', () => {
    const cfg = readAutomationConfig();
    expect(cfg.confidenceThreshold).toBeGreaterThan(0);
    expect(cfg.highRiskConfidenceThreshold).toBeGreaterThan(cfg.confidenceThreshold);
  });
});

describe('aiSafetyGuardService', () => {
  it('blocks forbidden auto actions in payload', () => {
    const r = validateProposalForCreation({
      type: 'expense',
      payload: { suggestedAction: 'auto_pay expense' },
    });
    expect(r.ok).toBe(false);
  });

  it('blocks auto execution flags', () => {
    const r = validateProposalForCreation({
      type: 'memo',
      payload: { autoPost: true },
    });
    expect(r.ok).toBe(false);
  });

  it('classifies HR dismissal as high risk', () => {
    expect(
      classifyProposalRisk(AUTOMATION_TYPES.HR_LETTER_DRAFT, { letterKind: 'dismissal' })
    ).toBe('high');
  });

  it('validateProposalApproval requires pending status', () => {
    const r = validateProposalApproval({ id: 'u1' }, { status: 'approved' });
    expect(r.ok).toBe(false);
  });

  it('lists forbidden actions', () => {
    expect(FORBIDDEN_AUTO_ACTIONS).toContain('payment');
    expect(FORBIDDEN_AUTO_ACTIONS).toContain('memo_submit');
  });
});

describe('aiAutomationRouterService', () => {
  let saved;

  beforeEach(() => {
    saved = process.env.ZARE_AI_AUTOMATION_MODE;
    process.env.ZARE_AI_AUTOMATION_MODE = 'true';
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ZARE_AI_AUTOMATION_MODE;
    else process.env.ZARE_AI_AUTOMATION_MODE = saved;
  });

  it('shouldCreateProposal respects confidence threshold', () => {
    expect(
      shouldCreateProposal({
        automationType: AUTOMATION_TYPES.MEMO_DRAFT,
        confidence: 0.8,
        riskLevel: 'low',
      })
    ).toBe(true);
    expect(
      shouldCreateProposal({
        automationType: AUTOMATION_TYPES.MEMO_DRAFT,
        confidence: 0.2,
        riskLevel: 'low',
      })
    ).toBe(false);
  });

  it('requires higher confidence for high risk', () => {
    expect(
      shouldCreateProposal({
        automationType: AUTOMATION_TYPES.HR_LETTER_DRAFT,
        confidence: 0.5,
        riskLevel: 'high',
      })
    ).toBe(false);
    expect(
      shouldCreateProposal({
        automationType: AUTOMATION_TYPES.HR_LETTER_DRAFT,
        confidence: 0.8,
        riskLevel: 'high',
      })
    ).toBe(true);
  });
});

describe('hr letter assist baseline', () => {
  it('suggests disciplinary tone', () => {
    const r = suggestHrLetterAssist({ purpose: 'disciplinary warning misconduct' });
    expect(r.suggestedTone).toBe('disciplinary');
  });
});

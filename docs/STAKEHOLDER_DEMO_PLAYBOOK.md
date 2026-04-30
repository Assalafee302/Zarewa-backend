# Stakeholder Demo Playbook

Use this playbook for executive or institutional demo sessions.

## Demo Objective

Show end-to-end operational control across Sales, HR approvals, Finance payout/reconciliation, and Management oversight with auditable traces.

## Pre-Demo Checklist

- CI is green for:
  - `npm run lint`
  - `npm run test:critical-workflows`
  - `npm run verify:complete` (repository root; runs `backend/scripts/verify-complete.mjs`)
- Branch/workspace scope is set correctly.
- Seed data contains:
  - at least one active quotation,
  - at least one approved payment request awaiting payout,
  - at least one reconciliation line in review,
  - at least one manager inbox queue item.
- No placeholder copy appears in the role being demonstrated.

## Demo Flow (Recommended Order)

## 1) Operations Dashboard

- Open dashboard and show:
  - quick actions,
  - office summary,
  - top material performers,
  - inventory health.
- Message: “Operator sees live action priorities and can jump directly into controlled workflows.”

## 2) Sales Workflow

- Open Sales and run:
  - quotation creation/view,
  - receipt capture,
  - cutting list visibility,
  - refund request visibility.
- Message: “Commercial flow is traceable from quote to cash and fulfillment artifacts.”

## 3) HR Request Workflow

- Open HR requests:
  - show request creation,
  - show staged approvals,
  - show loan/leave path toward finance.
- Message: “People operations follow explicit approval gates before money movement.”

## 4) Finance Controls

- Open Finance:
  - payment request review,
  - treasury payout,
  - bank reconciliation action with reasoned status transitions.
- Highlight audit trail chips on payment request rows.
- Message: “Approval decisions, payout actions, and reconciliation outcomes are visible and reviewable.”

## 5) Management Inbox

- Open Manager dashboard:
  - queue filters,
  - transaction intel,
  - approval actions.
- Message: “Managers operate a risk-first queue with focused decision tooling.”

## Acceptance Checklist (Sign-Off)

- One clean end-to-end flow completed for each pillar:
  - Sales
  - HR approvals
  - Finance payout + reconciliation
  - Management queue triage
- No broken/placeholder actions visible.
- Queue counters and list-level records are internally consistent.
- Role guards prevent unauthorized routes and actions.

## Common Questions And Short Answers

- “How is access controlled?”
  - Module-level RBAC policy + route guards + server-side permission checks.
- “How do you prove control actions happened?”
  - Request decision notes, actor/time metadata, and reconciliation status transitions.
- “What gates protect releases?”
  - Lint + critical workflow suite + release verification in CI.


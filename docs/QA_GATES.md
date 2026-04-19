# QA Gates

This project uses layered quality gates in local verification and CI.

## Gate Layers

1. **Lint gate**
   - Command: `npm run lint`
   - Purpose: style and static correctness.

2. **Critical workflow regression gate**
   - Command: `npm run test:critical-workflows`
   - Scope:
     - Module access policy checks
     - Account/manager stock and finance helper logic
     - Core finance and API server regression tests

3. **Release gate**
   - Command: `npm run verify:complete` (repository root; runs `backend/scripts/verify-complete.mjs`)
   - Purpose: integrated release validation including build and e2e checks.

## CI Workflow

Defined in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) at the repository root, in this order:

- Install dependencies
- Lint
- Critical workflow regression suite
- Install Playwright browser
- Release gate

## Local Recommendation Before Merge

Run:

1. `npm run lint`
2. `npm run test:critical-workflows`
3. `npm run verify:ci`

For release candidates, additionally run:

- `npm run test:e2e:ops-finance`
- `npm run test:e2e:hr:full`


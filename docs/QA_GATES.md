# QA Gates

This project uses layered quality gates in local verification and CI.

## Gate Layers

1. **Lint gate**
   - Command: `npm run lint`
   - Purpose: style and static correctness.

2. **Critical workflow regression gate**
   - Command: `npm run test:critical-workflows`
   - Scope:
     - Legacy demo-pack policy
     - Refund security and refund E2E
     - Accounting phase 2
     - Core API server regression (`server/api.test.js`)

3. **Security audit gate** (always on PRs via [`audit-ci.yml`](../.github/workflows/audit-ci.yml))
   - Commands: `npm run test:security-audit` and `npm run test:audit-api-smoke`

4. **Release gate**
   - Command: `npm run verify:complete` (needs a sibling frontend checkout; see [`scripts/verify-complete.mjs`](../scripts/verify-complete.mjs))
   - Purpose: production frontend build, full Vitest, and Playwright.

## CI Workflows

| Workflow | File | What it runs |
|----------|------|----------------|
| Backend CI | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | MySQL 8, migrate, `lint`, `test:critical-workflows` |
| Audit & security | [`.github/workflows/audit-ci.yml`](../.github/workflows/audit-ci.yml) | MySQL 8, migrate, security audit + API smoke |

Release Playwright is **not** on every PR (runtime). Run it locally or on a tagged release candidate.

## Local recommendation before merge

1. `npm run lint`
2. `npm run test:critical-workflows`
3. `npm run test:security-audit`

`npm run verify:ci` is the same as lint + critical workflows.

For release candidates, additionally run:

- `npm run test:refund-live` and `npm run preview:refund-lab` (refund + partner wallet regression)
- `npm run test:e2e:ops-finance`
- `npm run test:e2e:hr`
- `npm run verify:complete` when the sibling frontend is available

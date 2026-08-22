# File structure campaign (backend)

Phased cleanup of the flat `server/` tree (~290 non-test modules). Goal: domain folders, useful comments, less duplicated logic, faster lists/bootstrap.

## Target layout

```
server/
  index.js, app.js, db.js   # process entry
  http/                     # route modules extracted from httpApi.js
  httpApi.js                # composer until routes are fully split
  sales/ finance/ hr/ procurement/ operations/ office/ workspace/ exec/
  migrate.js, schemaSql.js  # schema (split later if needed)
shared/lib/                 # isomorphic math (frontend syncs a subset)
```

## Why this order

`httpApi.js` (~12k lines), `writeOps.js`, `hrOps.js`, `readModel.js` are too large to relocate in one change. Extract **route groups** into `server/http/` first, then `git mv` ops files domain-by-domain.

## Phases

1. **HTTP template** — extract health/liveness and finance diagnostics from `httpApi.js` into `server/http/*Routes.js` (done: `livenessRoutes.js`, `financeDiagnosticRoutes.js`, `workspaceListRoutes.js`). Next: accounting/GL, office, sales.
2. **New work** — all new ops files go in a domain folder (see Cursor rule `file-structure.mdc`).
3. **Ops moves** — `git mv` stable `*Ops.js` into domain folders; update imports; tests travel with the file.
4. **God files** — split `writeOps.js` / `readModel.js` by domain without changing behavior.
5. **Redundancy** — one copy of ledger/refund math in `shared/lib/`; server imports that, frontend syncs. Workspace governance (including production-alignment override) is a single module. SQLite persist for conversion reasons lives in `server/operations/`. Complaint enums/labels live in `shared/customerComplaints.js`; ops keeps SQL.
6. **Speed** — list caps via `listQueryOpts.js`; indexes with new filters; keep bootstrap domain-gated.

## Rules of the road

- Do not move a file that already has unrelated uncommitted edits.
- Keep tests green (`vitest`) after each extract.
- Comment permission gates and stock/money side effects, not SQL narration.

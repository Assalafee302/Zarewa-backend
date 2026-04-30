# Backend-only Git repository

The API imports several modules from **`frontend/src/lib/`** (for example `customerLedgerCore.js`, `moduleAccess.js`). In the **npm workspaces** layout, `frontend/` sits next to `backend/` so those relative imports resolve.

If you clone **only** the backend repository:

1. **Short term:** Add the frontend repo as a sibling directory named `frontend/` (same layout as this monorepo), or set `NODE_PATH` / use a git submodule at `../frontend` from `backend/`.
2. **Long term:** Move the imported files into `shared/` (or a private `@zarewa/shared` package) and change `server/*.js` imports to that module so the backend tree has no dependency on React/Vite code paths.

Current imports (search `frontend/src/lib` under `server/`):

- `customerLedgerCore.js`, `productionTransactionReportCore.js`, `coilSpecVersusProduct.js`
- `moduleAccess.js`, `workspaceNotifications.js`, `quotationLifecycleUi.js`, `salesCuttingListMaterialReadiness.js`, `liveAnalytics.js`, `refundsStore.js`

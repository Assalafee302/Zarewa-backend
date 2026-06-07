# Phase 8 — Operational HR (Live Readiness)

Completed June 2026. Extends Phases 1–7 without rebuilding existing flows.

## A. Files changed

### Backend (new)
- `server/hrLetterWorkflowOps.js` — draft→approval→issue, ref numbers, PDF/DOCX/print lock, audit
- `server/hrStaffBulkImport.js` — Excel template, preview, commit, import runs
- `server/hrStaffNumbering.js` — reserved 1–5, preview/apply renumbering
- `server/hrLetterWorkflowOps.test.js` — lifecycle/sensitivity unit tests

### Backend (modified)
- `server/hrApi.js` — workspace gate middleware, letter workflow routes, bulk import, settings, my-discipline, duplicate PDF route removed
- `server/hrPermissions.js` — team/self API allowlists, bulk import / letter approve helpers
- `server/hrPermissionKeys.js`, `server/hrRoleBundles.js` — `hr.staff.import`
- `server/hrDisciplineCasesOps.js` — discipline letters create drafts via workflow
- `server/migrate.js` — `migrateHrPhase8Operational2026`
- `server/hrModuleHealth.js`, `server/hrTableChecks.js` — Phase 8 diagnostics
- `server/hrPermissions.test.js` — API path access tests

### Frontend (new)
- `src/components/hr/HrAccessDenied.jsx`, `HrMainRouteGuard.jsx`
- `src/components/hr/HrBulkStaffImportModal.jsx`
- `src/components/hr/HrLetterReferencePanel.jsx`, `HrStaffNumberingPanel.jsx`
- `src/pages/hr/MyProfileDiscipline.jsx`

### Frontend (modified)
- `src/App.jsx` — HrMainRouteGuard on `/hr/*`
- `src/lib/hrAccess.js`, `src/lib/hrExtended.js`, `src/lib/moduleAccess.js`
- `src/pages/hr/HrLetters.jsx` — approval UI, PDF/Word/print lock
- `src/pages/hr/HrStaffDirectory.jsx` — Bulk Register Staff
- `src/pages/hr/HrSettingsHub.jsx` — letter refs + staff numbering tabs
- `src/pages/hr/MyProfile.jsx`, `MyProfilePolicies.jsx`
- `src/pages/hr/HrIdCards.jsx` — temporary card design
- `src/components/hr/HrResponsiveTable.jsx`, `HrReportsHub.jsx` — deep-links

## B–L. Feature summary

| Area | Status |
|------|--------|
| Access control | `/hr/*` guarded frontend + backend 403 with team/my-profile messaging |
| Bulk staff import | Template download, preview, commit on `/hr/employees` |
| Letter approval | Draft→submit→HR/GM/MD→issue; discipline letters use drafts |
| PDF/Word/print lock | Backend `assertOfficialLetterExport`; frontend disabled until issued |
| Letter reference reset | Settings tab; `ZAR/HR/{TYPE}/{YEAR}/{SEQ}` on issue |
| Staff ID reset | Settings tab; reserve 1–5, preview, apply with confirmation |
| Temporary ID cards | Watermark, verification code, expiry, signature line |
| Policy acknowledgement | My Profile labels/expiry; HR settings unchanged registry |
| My Profile discipline | `/my-profile/discipline` response + appeal |
| Reports deep-links | `deepLink` / profile fix links in responsive table |
| Notifications | Letter issue, discipline response/appeal, existing summary extended |
| API health | Phase 8 tables in `/api/hr/health` diagnostics |

## M. Migration

Run `npm run db:migrate` for `hr_settings`, `hr_staff_import_runs`, `hr_employee_number_history`, letter workflow columns.

## N. Tests

- Backend: `hrPermissions`, `hrLetterWorkflowOps`, `hrDisciplineCases`, `hrReportsHub` — **16 passed**
- Frontend: `npm run build` — **success**

## O. Remaining limitations

- DOCX export uses HTML-as-Word (no native `docx` package); opens in Word/LibreOffice.
- Letter approval UI is hub-level; full timeline modal per letter is a future polish item.
- Bulk import does not include tax/pension/NHIS columns (by design).
- E2E browser tests not added in this pass; manual UAT recommended for role matrix.
- `resetLetterReferencesForLiveUse` does not require confirm phrase on backend (MD role gate only).

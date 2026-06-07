# PHASE 8 — Operational Readiness: Bulk Onboarding, Letter Governance, and Reference Control

**Status:** Planned — corrections/addendum applied 2026-06-06.

**Builds on:** Phase 7 discipline cases, letter templates, policy gates, profile completeness, and audit trail.

**Note:** The legacy roadmap in [HR-IMPLEMENTATION-PLAN.md](./HR-IMPLEMENTATION-PLAN.md) labels an earlier “Phase 8 — Workspace and Zare” as complete. **This document is the revised Phase 8 scope** for go-live readiness (bulk old-staff registration, letter approval lock, reference numbering, staff ID reservation).

---

## Implementation priority (final order)

| # | Deliverable | Rationale |
|---|-------------|-----------|
| 1 | Access control cleanup | Foundation for all gated actions |
| 2 | Basic old-staff Excel import | Register live staff quickly; complete profiles later |
| 3 | Letter approval workflow | Draft → review → approve before issue |
| 4 | Letter PDF/Word/print lock until approval | Backend + frontend enforcement |
| 5 | Letter reference number system + reset | Official refs only on issue; live sequence control |
| 6 | Staff ID reset / reservation | Separate from letter refs; reserve 1–5 for executives |
| 7 | Improved temporary ID card print | Practical badge output for imported staff |
| 8 | Policy acknowledgement improvements | Onboarding tasks after bulk import |
| 9 | My Profile discipline response/appeal | Employee self-service on open cases |
| 10 | Reports deep-linking and notifications | Operational follow-up from imports and letters |

---

## A. Bulk old-staff Excel upload — BASIC ONLY

### Purpose

Register **existing/live old staff quickly** with **basic records only**. HR completes each profile gradually inside the employee profile tabs. The import is **not** a full HR data migration.

### Excel template — included fields

**Required**

| Column | Notes |
|--------|--------|
| First Name | |
| Surname | |
| Display Name | Shown in UI; may default from first + surname |
| Phone Number | |
| Email | Optional if unavailable |
| Employee Number | Optional if system generates |
| Work Location | `HQ` or `Branch` |
| Branch Code / Branch Name | Map to `branch_id` via master data |
| Department Code / Department Name | Map to `hr_departments` |
| Designation / Job Title | Map to designation or free text |
| Employment Type | permanent, contract, temporary, etc. |
| Employment Status | active, probation, suspended, etc. |
| Date Joined | ISO or Excel date |

**Optional (basic only)**

| Column | Notes |
|--------|--------|
| Basic Salary | Optional depending on payroll readiness |
| Bank Name, Bank Code, Account Number, Account Name | Optional payroll prep |
| Gender | |
| Date of Birth | |
| Residential Address | |
| Next of Kin Name, Next of Kin Phone | |
| Highest Qualification | Single field — not full history |

### Explicitly excluded from bulk template

Do **not** collect in Excel:

- Full tax details (TIN, PAYE history)
- Full pension details (RSA, PIN, employer code)
- Full NHIS details
- Qualification history (multiple rows)
- Document list / uploads
- HR notes / memos
- Policy acknowledgement data
- Payroll remarks / hold flags
- Complex manager/supervisor hierarchy (unless trivial single-column mapping)

### Post-import behaviour

1. Staff record created with `user_id` as immutable system key.
2. Profile completeness score reflects missing sections (`HrProfileCompleteness` / `computeProfileCompleteness`).
3. Incomplete sections visible on staff profile tabs:
   - Personal data
   - Employment details
   - Payroll / bank
   - Tax / pension / NHIS
   - Next of kin
   - Qualifications
   - Documents
   - Policies
   - HR notes
4. **Data-completeness tasks** created for HR (lifecycle/onboarding tasks or notification queue).

### Bulk import workflow (UI)

```
Download basic template → Upload Excel → Validate preview → Import valid rows → Summary report
```

**Summary report must show:**

- Imported count
- Skipped (duplicate / policy)
- Failed (validation errors)
- Duplicate (employee no / email / phone)
- Needs cleanup (partial row, missing branch/dept mapping)

**Safety rules:**

- Dry-run / preview before commit
- Row-level error messages (row number + field)
- No overwrite of existing `user_id` records without explicit “update mode” flag
- Audit: `hr.bulk_staff.import` with actor, file hash, counts

### API (proposed)

```
GET  /api/hr/staff-import/template          → download basic .xlsx
POST /api/hr/staff-import/preview           → validate rows, no writes
POST /api/hr/staff-import/commit            → import valid rows
GET  /api/hr/staff-import/runs/:id          → import run summary
```

### Implementation notes

- Replace or wrap CLI `server/importZarewaStaffFromXlsx.js` (salary-register oriented) with **basic onboarding template** aligned to columns above.
- Frontend: `/hr/staff-directory` or dedicated **Bulk register** panel (modal wizard).
- Map branch/dept/designation via Phase 4 master data (`hr_departments`, `hr_designations`).

---

## B. Letters must NOT be freely printed

### Problem (Phase 7 gap)

Letters currently generate and can be downloaded/printed immediately. Phase 8 **must** enforce approval before official output.

### Letter lifecycle statuses

| Status | Description |
|--------|-------------|
| `draft` | Internal preview only |
| `submitted` | Sent for review |
| `hr_review` | HR reviewing |
| `gm_review` | GM review (when required) |
| `md_review` | MD approval (when required) |
| `approved` | Approved, not yet issued |
| `issued` | Official; ref number assigned |
| `rejected` | Returned with reason |
| `cancelled` | Voided |

### Rules

| Action | Draft | Submitted / in review | Approved / issued |
|--------|-------|------------------------|-------------------|
| Internal preview | Yes — **watermark** | Yes — watermark | Yes — official layout |
| Print official | **No** | **No** | **Yes** |
| Download PDF (official) | **No** | **No** | **Yes** |
| Download Word (official) | **No** | **No** | **Yes** |
| Assign official ref no | **No** | **No** | **Yes** (on issue) |

**Watermark text (draft / in-review preview):**

> DRAFT — NOT VALID FOR OFFICIAL USE

### Sensitive letters — higher approval chain

Require **GM and/or MD** before issue:

- Termination, dismissal, suspension, final warning
- Retrenchment / layoff
- Salary increment, salary confirmation, bonus approval
- Loan-related, payroll-related, promotion
- Discipline outcome letters

**Routine letters** — HR or GM per permission:

- Introduction, confirmation, training approval, leave approval
- Certificate of service, ID card approval

### Frontend (`HrLetters.jsx`, `HrLetterPrintModal.jsx`)

- Show **status pill** and approval timeline in letter detail modal.
- **Disable/hide** Download PDF, Download Word, Print until `approved` or `issued`.
- On blocked action show: *“This letter must be approved before it can be printed or downloaded.”*
- Preview modal: render content with draft watermark overlay.
- Show audit history (approvals, rejections, downloads, prints).

### Backend enforcement (mandatory)

- `GET /api/hr/employment-letters/:id/pdf` → **403** if status ∉ `{approved, issued}`.
- Same for DOCX export and print-optimized endpoint.
- Draft preview endpoint returns HTML/PDF **with watermark** metadata flag.
- Audit every:
  - Approval / rejection / submit / issue
  - PDF download (success + failed attempt where useful)
  - Word download
  - Print request
- Actions: `hr.letter.submitted`, `hr.letter.approved`, `hr.letter.rejected`, `hr.letter.issued`, `hr.letter.pdf_download`, `hr.letter.print_attempt`, etc.

### Schema extensions

```sql
-- hr_employment_letters (extend)
status TEXT NOT NULL DEFAULT 'draft'
reference_number TEXT UNIQUE          -- assigned on issue only
draft_id TEXT                         -- internal draft identifier
submitted_at_iso, submitted_by_user_id
hr_reviewed_at_iso, hr_reviewed_by_user_id
gm_reviewed_at_iso, gm_reviewed_by_user_id
md_approved_at_iso, md_approved_by_user_id
issued_at_iso, issued_by_user_id
rejection_reason TEXT
approval_chain_json TEXT              -- timeline snapshot

-- hr_letter_approval_events (optional normalized timeline)
-- hr_letter_download_log (print/download audit)
```

### API (proposed)

```
POST /api/hr/employment-letters/generate     → creates draft (not issued)
POST /api/hr/employment-letters/:id/submit
PATCH /api/hr/employment-letters/:id/hr-review
PATCH /api/hr/employment-letters/:id/gm-review
PATCH /api/hr/employment-letters/:id/md-approve
POST /api/hr/employment-letters/:id/issue      → assigns ref, status=issued
POST /api/hr/employment-letters/:id/reject
GET  /api/hr/employment-letters/:id/preview    → watermarked preview
GET  /api/hr/employment-letters/:id/pdf        → official only if approved/issued
```

---

## C. Letter reference number — controlled reset

### Requirements

- **Unique** official reference per issued letter.
- Assigned **only** on `approved` → `issued` transition, **not** on draft.
- Drafts may use temporary `draft_id` (e.g. `DRF-HRL-…`) — not official refs.
- Configurable sequence with **no duplicates**.

### Suggested format

```
ZAR/HR/{LETTER_TYPE_CODE}/{YEAR}/{SEQUENCE}
```

Examples:

- `ZAR/HR/APP/2026/0001` — appointment
- `ZAR/HR/DIS/2026/0001` — dismissal
- `ZAR/HR/TRF/2026/0001` — transfer
- `ZAR/HR/PAY/2026/0001` — payroll-related

### Settings (`hr_letter_reference_config` or HR Settings JSON)

| Setting | Description |
|---------|-------------|
| `prefix` | Default `ZAR/HR` |
| `year` | Current year (auto) |
| `letterTypeCode` | Per letter kind map (APP, DIS, TRF, PAY, LVE, …) |
| `startingSequence` | Seed for new year or reset |
| `resetMode` | `yearly` \| `manual` \| `never` |
| `currentSequence` | Per type+year counter |
| `lastIssuedReference` | Last committed ref |

### Reset for live deployment

- **“Reset Letter References for Live Use”** in HR Settings → Letter Settings.
- Requires **HR Admin or MD** + confirmation dialog.
- Shows **preview of next N reference numbers** before apply.
- **Audited:** `hr.letter.reference_reset`.
- Mark pre-live test letters as `test` / `archived` so they do not consume live sequence.
- DB constraint: `UNIQUE(reference_number)` on `hr_employment_letters`.

### Letter reports (extend Phase 7 `letter-issuance-report`)

Include columns:

- Reference number
- Letter type
- Employee
- Status
- Prepared by
- Approved by (GM/MD as applicable)
- Issued date
- Download count / print audit count

---

## D. Staff ID reset — separate from letter references

| Concern | Staff ID / employee number | Letter reference |
|---------|------------------------------|------------------|
| Applies to | `hr_staff_profiles.employee_no` | `hr_employment_letters.reference_number` |
| Purpose | Human-visible staff numbering | Official correspondence numbering |
| Reset action | Reserve 1–5 for CEO, MD, Directors | Reset per letter type sequence |
| System key | **`user_id` unchanged** — all FKs use `user_id` | Letter row id unchanged; ref assigned on issue |
| Settings location | HR Settings → Staff ID | HR Settings → Letter References |

**Staff ID rules:**

- Changing `employee_no` must **not** break payroll, discipline, documents, or audit (all keyed on `user_id`).
- Reservation table or config: `{ reservedNumbers: [1,2,3,4,5], labels: { 1: 'CEO', … } }`.
- Reset/reservation audited: `hr.staff_id.reset`.

---

## E. Additional Phase 8 scope (priority 7–10)

### 7. Temporary ID card print

- Quick card for imported staff with photo placeholder, name, employee no, branch, blood group (optional).
- Mark as **TEMPORARY** on card until full profile + approval.
- Link to existing `hr_id_cards` + `HrIdCards.jsx`.

### 8. Policy acknowledgement improvements

- After bulk import, auto-create onboarding tasks for required policies.
- Dashboard widget: staff missing policy ack post-import.
- Block sensitive HR actions until employee + approver policies complete (extend Phase 7 gates).

### 9. My Profile — discipline response / appeal

- Employee views open cases assigned to them (redacted sensitive mgmt fields).
- Submit written response on `awaiting_employee_response`.
- File appeal when case status allows.
- Notifications on case updates.

### 10. Reports deep-linking and notifications

- Report rows link to staff profile, letter (if issued), case detail.
- Notify HR on: import needs-cleanup, letter pending approval, overdue discipline response.

---

## Module summary table

| Module | Feature | API / UI | Status |
|--------|---------|----------|--------|
| Bulk import | Basic Excel template | `GET template`, `POST preview/commit` | **Planned** |
| Bulk import | Completeness tasks post-import | Lifecycle tasks + notifications | **Planned** |
| Letters | Approval workflow | submit → hr → gm → md → issue | **Planned** |
| Letters | Print/PDF/Word lock | Backend 403 + UI disable | **Planned** |
| Letters | Draft watermark preview | `GET .../preview` | **Planned** |
| Letters | Reference numbering | On issue only | **Planned** |
| Letters | Reference reset | HR Settings action | **Planned** |
| Staff ID | Reservation 1–5 | HR Settings | **Planned** |
| Staff ID | Reset (employee_no only) | Separate from letter refs | **Planned** |
| ID cards | Temporary print | HrIdCards enhancement | **Planned** |
| Policies | Post-import ack tasks | My Profile + HR queue | **Planned** |
| Discipline | My Profile response/appeal | `/my-profile` + case API | **Planned** |
| Reports | Deep links + alerts | Reports hub + notifications | **Planned** |
| Access control | Permission cleanup | hrPermissions + routes | **Planned** |

---

## Relationship to Phase 7 deferred items

| Phase 7 deferred | Phase 8 owner |
|------------------|---------------|
| Letter draft → approve workflow | **B** — full lifecycle |
| Policy PDF / witness / expiry | **8** — partial; PDF archive may remain Phase 8+ |
| Repeat offender analytics | Phase 8+ / BI |

---

## Explicitly out of scope for Phase 8

- Overtime payroll calculation
- Biometric / time-clock integration
- Full tax/pension/NHIS bulk migration via Excel
- Letter template admin CMS (use code templates; admin UI deferred)

---

## Testing checklist (Phase 8 completion)

- [ ] Import 10-row basic Excel → profiles created, completeness < 100%, tasks created
- [ ] Duplicate employee no → skipped with clear message
- [ ] Generate letter → draft only; PDF download returns 403
- [ ] Approve letter → issue → ref assigned → PDF download succeeds
- [ ] Draft preview shows watermark
- [ ] Reset letter refs → next issue starts at configured sequence; audit logged
- [ ] Staff ID change → records intact via `user_id`
- [ ] E2E: import → complete profile → issue letter → print

---

## Document history

| Date | Change |
|------|--------|
| 2026-06-06 | Initial Phase 8 plan with corrections A–E (bulk basic import, letter lock, ref reset, staff ID clarification, priority order) |

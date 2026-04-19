# Zarewa staff salary register → app import

Put your Excel salary file in this folder (for example `Zarewa-Staff-2026.xlsx`). The importer reads the **first worksheet** only.

## Jalingo rows

Any row where **Branch**, **Location**, **Site**, **Office**, or **Region** (matched loosely from your header row) contains **Jalingo** is **skipped** — those staff are not created or updated.

## Required / useful columns

Headers are matched flexibly (case and spacing ignored). Include at least:

| Meaning | Example header names |
|--------|----------------------|
| Full name | Name, Full name, Staff name, Employee name |
| Employee number | Employee no, Staff ID, Emp no (optional but helps avoid duplicates) |
| Branch / site | Branch, Location, Site — use **Kaduna**, **Yola**, **Maiduguri**, or codes like **BR-KAD** (not Jalingo for this import) |
| Department | Department, Unit |
| Job title | Job title, Position, Designation |
| App access role (optional) | Role, App role — mapped to app roles (see below) |
| Monthly basic / gross | Basic salary, Base salary, Monthly gross, Salary |
| Housing (optional) | Housing, Housing allowance |
| Transport (optional) | Transport, Transport allowance |
| Date joined (optional) | Date joined, Start date |
| **Academic qualification** | Academic qualification, Qualification, Education, Degree |
| Minimum job qualification (optional) | Minimum qualification |

If **Username** is empty, one is generated from the name (e.g. `ahmed.salisu`).

## Salary: monthly vs annual

- By default, numeric salary columns are stored as **monthly** base (₦) in the HR file.
- If your sheet uses **annual** figures, run the import with `--annual` (amounts are divided by 12).

## Run the import

From the project root, in PowerShell:

```powershell
$env:ZAREWA_STAFF_IMPORT_PASSWORD = "YourStrongPassw0rd!"
npm run hr:import-staff -- --file "docs/SALARY/your-file.xlsx"
```

Rules for `ZAREWA_STAFF_IMPORT_PASSWORD`: at least 12 characters, lowercase, uppercase, digit, and a symbol (same as HR “Register staff”). **Change passwords after import** or set individual passwords in Settings.

### Dry run (no database changes)

```powershell
npm run hr:import-staff -- --file "docs/SALARY/your-file.xlsx" --dry-run
```

### Optional flags

- `--annual` — salary column is annual; divide by 12 for monthly base.
- `--actor USR-xxxxxxxx` — `app_users.id` to record as `updated_by` (default: first `admin` or `hr_admin`).

### Custom database path

```powershell
$env:ZAREWA_DB_PATH = "C:\path\to\zarewa.sqlite"
```

## Behaviour

- If **employee number** already exists on an HR profile, that user’s file is **updated** (salary, branch, qualifications, etc.).
- If **username** already exists, that user’s HR file is **updated**; no second login is created.
- Otherwise a **new** app user is created with the chosen role and temporary password.

## Role mapping (from “Role” / job text)

Rough mapping: HR → `hr_admin`, finance → `finance_manager`, branch manager → `branch_manager`, sales manager → `sales_manager`, procurement → `procurement_officer`, operations/production → `operations_officer`, default → `sales_staff`. Adjust roles later in Settings if needed.

## Template

See `zarewa-staff-import-template.csv` — you can fill it in Excel and **Save as** `.xlsx`, or align your existing sheet to these column titles.

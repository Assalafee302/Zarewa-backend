# HR Policy: Attendance and Punctuality

## Scope
- Working hours, lateness, absence, attendance upload, and correction controls.

## Required Controls
- Attendance uploads must be branch-consistent (no cross-branch user rows).
- Late/absence records must be attributable to source and uploader.
- Corrections require reviewer accountability (remark on HR review actions where applicable).

## Corrections (operational)

- **Daily roll:** present/absent with optional **in time / out time** (`hr_daily_roll_calls.rows_json`, UI `HrDailyRollPanel`).
- **Uploads / events:** `hr_attendance_uploads`, `hr_attendance_events` with uploader identity.
- Dedicated “attendance correction request” type is **not** used; HR uses `GET /api/hr/attendance/deduction-preview` before payroll lock.

## System Rules
- Uploads persist in `hr_attendance_uploads`.
- Derived events persist in `hr_attendance_events`.
- Payroll deduction calculations must use the latest period attendance snapshot.

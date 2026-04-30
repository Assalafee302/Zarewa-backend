# HR Policy: Attendance and Punctuality

## Scope
- Working hours, lateness, absence, attendance upload, and correction controls.

## Required Controls
- Attendance uploads must be branch-consistent (no cross-branch user rows).
- Late/absence records must be attributable to source and uploader.
- Corrections require request + reviewer remark.

## System Rules
- Uploads persist in `hr_attendance_uploads`.
- Derived events persist in `hr_attendance_events`.
- Payroll deduction calculations must use the latest period attendance snapshot.

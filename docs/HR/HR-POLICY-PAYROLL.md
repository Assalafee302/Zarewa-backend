# HR Policy: Payroll and Statutory Outputs

## Scope
- Payroll run setup, recompute, lock/pay, payslip generation, and statutory summaries.

## Required Controls
- Only draft runs are editable/recomputable.
- Locked/paid runs produce export artifacts without mutating values.
- Payroll action history is auditable.

## System Rules
- Payroll master/detail data uses `hr_payroll_runs`, `hr_payroll_lines`, `hr_payroll_line_loans`.
- Treasury pack, payslip pack, and statutory pack are exported from locked/paid runs.
- Attendance and approved loan deductions feed into payroll line calculations.

# Who does what (staff guide)

Short reference for day-to-day approvals in Zarewa. Technical detail lives in `docs/ACCESS_CONTROL.md`.

| I need to… | Who usually acts |
|------------|------------------|
| **Approve a customer refund** | **Branch manager**, **Managing Director**, or **Administrator** (via `refunds.approve` / `*`). Users with **finance.approve** can also record the approval on the same API. **Finance** still executes the cash/bank payout after approval. |
| **Pay an approved refund** | **Finance** (treasury / cashier with payout permission). |
| **Approve staff leave or loan** | **HR** (queue and final steps per your HR role). |
| **Lock payroll for the month** | **HR** prepares the run; **Managing Director** must **sign off** the draft first; then HR can lock and export. |
| **Set or change list prices** | Users with **pricing** access (typically **MD** / settings). |
| **Sell below list price and still start production** | **MD** must record a **price exception** on that quotation. |
| **Mark goods delivered / production truth** | **Operations** (not sales). |
| **Confirm bank deposit matches a receipt** | **Cashier** / finance with receipt permissions — **bank confirmation** on the receipt row. |
| **Add many bank statement lines at once** | **Finance** — Finance & accounts → Bank reconciliation → **Import CSV** or **Import JSON**. |

**CEO** accounts see **company-wide summaries only**, not full sales/finance line screens.

If something is greyed out or returns “forbidden”, your role is not in that path — escalate to the role in the table above.

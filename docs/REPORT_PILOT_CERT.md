# Report pilot certification (Track C)

**Pilot pack (certify first):** General ledger audit pack (`PACK_GL_AUDIT`) + in-app **GL pilot** (trial balance, comparative window, activity drill-down, cost center filter).

**Golden expectations (fixtures):**

- Empty DB: TB rows may be empty; API returns `ok: true`, no 500s.
- After a manual journal (Debit / Credit balanced, optional `costCenter`): TB net changes; GL pilot drill shows lines with matching `costCenter` when filter set.

**Expand later:** Period costs & inventory, Cash/bank/AR pack — follow same matrix: period × branch × role × export format.

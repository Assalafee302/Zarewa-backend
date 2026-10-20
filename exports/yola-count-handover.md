# Yola (BR-YL) 12 Oct 2026 count – handover

Status as at 14 Oct 2026 17:40 UTC (from the database). The run is **stopped**. Nothing more is posted.

## Posted (2 of 119)
| Coil | What | Records |
|---|---|---|
| 6170 | Weighed 248 = book 248 (no variance). Note "12 Oct 2026 count: tag 6170" and hold "Stained – second grade" | Audit AUD-26-040262; no movement, no journal |
| 7263 | 126 → 117 kg (−9). Note "12 Oct 2026 count: tag 7363" | Movement MV-26-00742 (COIL_COUNT_VARIANCE, dated 12 Oct); audit AUD-26-040419; no journal (no unit cost, ₦0) |

Done earlier as preparation (stays in place):
- 8362: orphan reservation of 5,618 kg released (AUD-26-040211). It is still 6,793 kg on hand, **not counted to 0**.
- 8354: allocation on PRO-YL-26-0101 cleared, 555 kg released (AUD-26-039820). The job is still Planned. It is still 555 kg on hand, **not counted to 0**.

## Not posted (117 coils)
All other coils in `Downloads\Yola_Coil_Update_12Oct2026.xlsx` (86 "Set to weighed" + 31 "Remove") keep their ERP kg. No count variance, journal or note is posted on them.
- Held on purpose: 8414 (343 kg) and 8415 (364 kg) are reserved by PRO-YL-26-0245 (Running).
- Left untouched as instructed:
  - 8287: 135 kg, 135 kg reserved with no open job (an orphan reservation). Waiting for the owner's decision.
  - 8394: see below.

Yola live now: 121 coils, 117,935 kg, 842 kg reserved (8414 343 + 8415 364 + 8287 135). It is lower than 119,611 because of normal production on 13–14 Oct, not count postings.

## Open question: coil 8394
- File (ERP 12 Oct): 2,645 kg. Weighed at the count: 2,327 kg.
- On 13 Oct, 7 jobs were booked on it (PRO-YL-26-0231, 0243, 0267, 0270, 0260, 0289, 0291), using 1,288 kg. Book now: 1,357 kg.
- Per the 8437/8409 rule (count taken before the jobs), the target would be 2,327 − 1,288 = **1,039 kg** (−318 kg). This is **not applied**. The owner has to confirm it, or skip 8394.
- Yola keeps producing. Any other counted coil used since 12 Oct will stop the run the same way. Re-check before the next run, or run it outside working hours.

## Script fix needed before the next run (117 → 119)
`yl-post-run3.mjs` (in the Claude scratchpad) has a wrong check: `if (work.length !== 117)`. The file has 121 coils (88 set + 33 remove). 121 − 2 held (8414, 8415) = **119**, which includes the already-posted 6170 and 7263. The check must be `!== 119`. (The "117" double-counted the two held coils.)

Other behaviour of run 3, which is correct and should be kept:
- One transaction per coil: coil kg, product stock, COIL_COUNT_VARIANCE movement, journal (when the coil has a unit cost), audit, note and stained hold.
- `innodb_lock_wait_timeout = 300`; up to 8 reconnects and 3 lock-wait retries.
- Skips coils already posted.
- Stops before writing if any coil's live kg ≠ file kg or a coil has a movement after 12 Oct.
- Logs to `exports/YL-count-run3.log`.

Run 3 (13 Oct 14:25 UTC) stopped at that pre-check and wrote nothing, because of 8394 and the 117 check.

## Why ADJUSTMENT was not used
The production-book reconcile ignores ADJUSTMENT movements. COIL_COUNT_VARIANCE is the app's own physical-count type, and the reconcile respects it.

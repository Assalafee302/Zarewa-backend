#!/usr/bin/env python3
"""Read-only Phase 11 report from CSV exports."""
import csv
import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path

DOWNLOADS = Path(r"C:\Users\USER\Downloads")
MD_THRESHOLD = 1_000_000
PAYMENT_GATE = 0.70


def read(name):
    with (DOWNLOADS / name).open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def pj(raw, default=None):
    if raw is None or str(raw).strip() in ("", "NULL", "null"):
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


def has(v):
    s = str(v or "").strip()
    return s not in ("", "NULL", "null", "None", "0")


def norm(s):
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def num(v, default=0.0):
    try:
        if v is None or str(v).strip() in ("", "NULL", "null"):
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def categories(raw):
    arr = pj(raw, [])
    if isinstance(arr, list):
        return [str(x).strip() for x in arr if str(x).strip()]
    s = str(raw or "").strip()
    return [s] if s and s != "—" else []


def main():
    refunds = read("customer_refunds.csv")
    treasury = read("treasury_movements.csv")
    quotations = read("quotations.csv")
    lines = read("quotation_lines.csv")
    jobs = read("production_jobs.csv")
    coils = read("production_job_coils.csv")
    conversion = read("production_conversion_checks.csv")
    stone = read("production_job_stone_flatsheet_usage.csv")
    incidents = read("material_incidents.csv")

    q_by_id = {q["id"]: q for q in quotations}
    jobs_by_id = {j["job_id"]: j for j in jobs}
    jobs_by_q = defaultdict(list)
    for j in jobs:
        jobs_by_q[j.get("quotation_ref") or ""].append(j)

    coils_by_job = defaultdict(list)
    for c in coils:
        coils_by_job[c["job_id"]].append(c)

    stone_by_job = defaultdict(set)
    for s in stone:
        stone_by_job[s["job_id"]].add(s["job_id"])

    stone_jobs = {s["job_id"] for s in stone}
    coil_jobs = {c["job_id"] for c in coils}

    treasury_refund = defaultdict(list)
    for tm in treasury:
        if tm.get("source_kind") == "REFUND":
            treasury_refund[tm["source_id"]].append(tm)

    lines_by_q = defaultdict(list)
    for ln in lines:
        lines_by_q[ln["quotation_id"]].append(ln)

    # --- Refunds ---
    type_primary = Counter()
    type_amount = Counter()
    type_any = Counter()
    status_stats = Counter()
    partial_approval = []
    partial_payment = []
    pending_approval = []
    pending_payment = []
    same_req_appr = []
    same_appr_pay = []
    full_chain = []
    above_md = []
    cancel_misapplied = []
    corrugation_refunds = []
    service_only_refunds = []
    multi_cat = []
    multi_refund_q = defaultdict(list)
    paid_no_treasury = []
    refunds_by_q = defaultdict(list)

    for r in refunds:
        rid = r["refund_id"]
        status = (r.get("status") or "").strip()
        status_stats[status] += 1
        cats = categories(r.get("reason_category"))
        if cats:
            type_primary[cats[0]] += 1
            type_amount[cats[0]] += num(r.get("amount_ngn"))
        for c in cats:
            type_any[c] += 1
        if len(cats) > 1:
            multi_cat.append({"refund_id": rid, "quotation_ref": r.get("quotation_ref"), "categories": cats})

        amt = num(r.get("amount_ngn"))
        appr = num(r.get("approved_amount_ngn"))
        paid = num(r.get("paid_amount_ngn"))
        qref = r.get("quotation_ref") or ""
        refunds_by_q[qref].append(rid)
        multi_refund_q[qref].append(rid)

        if status == "Pending":
            pending_approval.append(rid)
        if status == "Approved" and paid < (appr or amt):
            pending_payment.append({"refund_id": rid, "approved": appr or amt, "paid": paid, "quotation_ref": qref})
        if appr and amt and appr < amt and status in ("Approved", "Paid"):
            partial_approval.append({"refund_id": rid, "requested": amt, "approved": appr})
        if paid and appr and paid < appr and status in ("Approved", "Paid"):
            partial_payment.append({"refund_id": rid, "approved": appr, "paid": paid})

        req, appr_by, pay_by = norm(r.get("requested_by")), norm(r.get("approved_by")), norm(r.get("paid_by"))
        if req and appr_by and req == appr_by:
            same_req_appr.append(rid)
        if appr_by and pay_by and appr_by == pay_by:
            same_appr_pay.append(rid)
        if req and appr_by and pay_by and req == appr_by == pay_by:
            full_chain.append({"refund_id": rid, "person": r.get("requested_by"), "amount": amt})

        if amt > MD_THRESHOLD or appr > MD_THRESHOLD:
            above_md.append({
                "refund_id": rid,
                "amount_ngn": int(amt),
                "approved_ngn": int(appr),
                "requested_by": r.get("requested_by"),
                "approved_by": r.get("approved_by"),
                "paid_by": r.get("paid_by"),
                "status": status,
            })

        if status == "Paid" and paid >= (appr or amt) and rid not in treasury_refund:
            paid_no_treasury.append(rid)

        snap = pj(r.get("preview_snapshot_json"), {}) or {}
        qm, am = num(snap.get("quotedMeters")), num(snap.get("actualMeters"))
        job_st = [j.get("status") for j in jobs_by_q.get(qref, [])]

        if "Order cancellation" in cats:
            if "Completed" in job_st and "Cancelled" not in job_st:
                cancel_misapplied.append({
                    "refund_id": rid,
                    "quotation_ref": qref,
                    "status": status,
                    "quoted_m": qm,
                    "actual_m": am,
                    "amount_ngn": int(amt),
                    "partial_production": qm > am > 0,
                })

        q = q_by_id.get(qref)
        if q:
            lj = pj(q.get("lines_json"), {}) or {}
            svcs = [s for s in (lj.get("services") or []) if str(s.get("name") or "").strip()]
            prods = [p for p in (lj.get("products") or []) if str(p.get("name") or "").strip() and num(p.get("qty")) > 0]
            has_corr = any("corrugation" in norm(s.get("name")) or "currugation" in norm(s.get("name")) for s in svcs)
            if has_corr:
                corrugation_refunds.append({"refund_id": rid, "quotation_ref": qref, "categories": cats, "amount_ngn": int(amt), "preview_engine": snap.get("engineVersion")})
            if svcs and not prods:
                service_only_refunds.append({"refund_id": rid, "quotation_ref": qref, "services": [s.get("name") for s in svcs], "categories": cats})

    multi_refund_quotes = {k: v for k, v in refunds_by_q.items() if len(v) > 1}

    # Cross-domain
    cross = []
    for r in refunds:
        rid = r["refund_id"]
        qref = r.get("quotation_ref") or ""
        cats = categories(r.get("reason_category"))
        snap = pj(r.get("preview_snapshot_json"), {}) or {}
        qm, am = num(snap.get("quotedMeters")), num(snap.get("actualMeters"))
        ppm = num(snap.get("pricePerMeterNng") or snap.get("pricePerMeterNgn"))
        job_st = jobs_by_q.get(qref, [])
        statuses = [j.get("status") for j in job_st]
        q = q_by_id.get(qref, {})
        total, paid_q = num(q.get("total_ngn")), num(q.get("paid_ngn"))
        issues = []

        if "Running" in statuses or "Planned" in statuses:
            if r.get("status") in ("Paid", "Approved", "Pending"):
                issues.append("refund_while_job_not_closed")
        if total > 0 and paid_q / total < PAYMENT_GATE and "Overpayment" not in cats and r.get("status") == "Paid":
            issues.append("refund_on_underpaid_quote")
        if "Order cancellation" in cats and "Completed" in statuses and "Cancelled" not in statuses:
            issues.append("cancellation_on_completed_job")
        if qm > am > 0 and "Order cancellation" in cats:
            issues.append("should_be_unproduced_meterage")
        if "Unproduced meterage" in cats and am >= qm and qm > 0:
            issues.append("unproduced_category_but_no_shortfall")
        unproduced_m = max(0, qm - am)
        unproduced_amt = unproduced_m * ppm if ppm else 0
        if "Unproduced meterage" in cats and unproduced_amt and amt > unproduced_amt + 1000:
            issues.append("refund_exceeds_unproduced_estimate")

        if issues:
            cross.append({"refund_id": rid, "quotation_ref": qref, "categories": cats, "issues": issues, "job_statuses": statuses, "paid_pct": round(100 * paid_q / total, 1) if total else None})

    # Production
    job_types = Counter()
    outliers = []
    spec_mismatch_jobs = []
    qc_gaps = []
    payment_gate_exceptions = []
    cancelled_no_refund = []

    for j in jobs:
        jid = j["job_id"]
        qref = j.get("quotation_ref") or ""
        if jid in stone_jobs and jid in coil_jobs:
            job_types["mixed_stone+coil"] += 1
        elif jid in stone_jobs:
            job_types["stone_flatsheet"] += 1
        elif jid in coil_jobs:
            job_types["coil_roofing"] += 1
        elif num(j.get("offcut_inventory_meters")) > 0 or has(j.get("offcut_supply_json")):
            job_types["offcut/custom"] += 1
        else:
            job_types["no_coil_stone"] += 1

        planned, actual = num(j.get("planned_meters")), num(j.get("actual_meters"))
        if j.get("status") == "Completed" and planned > 0 and abs(actual - planned) / planned > 0.05:
            outliers.append({"job_id": jid, "planned_m": planned, "actual_m": actual, "pct_diff": round(100 * (actual - planned) / planned, 2)})

        if boolish(j.get("coil_spec_mismatch_pending")) or any(str(c.get("spec_mismatch")) == "1" for c in coils_by_job[jid]):
            spec_mismatch_jobs.append(jid)

        alert = (j.get("conversion_alert_state") or "").strip()
        if j.get("status") == "Completed":
            if alert in ("High", "Low") and not has(j.get("manager_review_signed_at_iso")):
                qc_gaps.append({"job_id": jid, "issue": "high_low_unsigned"})
            if alert in ("High", "Low") and not has(j.get("conversion_variance_reason_code")):
                qc_gaps.append({"job_id": jid, "issue": "missing_reason_code", "alert": alert})
            if str(j.get("manager_review_required")) == "1" and not has(j.get("manager_review_signed_at_iso")):
                qc_gaps.append({"job_id": jid, "issue": "manager_review_required_unsigned"})

        q = q_by_id.get(qref)
        if j.get("status") == "Completed" and q:
            total, paid_q = num(q.get("total_ngn")), num(q.get("paid_ngn"))
            if total > 0 and paid_q / total < PAYMENT_GATE and not has(q.get("manager_production_approved_at_iso")):
                payment_gate_exceptions.append({"job_id": jid, "quotation_ref": qref, "paid_pct": round(100 * paid_q / total, 1)})

    for j in jobs:
        if j.get("status") != "Cancelled":
            continue
        qref = j.get("quotation_ref") or ""
        if qref and qref not in refunds_by_q:
            cancelled_no_refund.append({"job_id": j["job_id"], "quotation_ref": qref})

    # Historical fields
    hist = {
        "refund_fields": sorted(refunds[0].keys()) if refunds else [],
        "job_fields": sorted(jobs[0].keys()) if jobs else [],
        "quotation_exception_fields_populated": {
            "bm_price_exception": sum(1 for q in quotations if has(q.get("bm_price_exception_approved_at_iso"))),
            "md_price_exception": sum(1 for q in quotations if has(q.get("md_price_exception_approved_at_iso"))),
            "md_confirmed": sum(1 for q in quotations if has(q.get("price_exception_md_confirmed_at_iso"))),
            "manager_production_approved": sum(1 for q in quotations if has(q.get("manager_production_approved_at_iso"))),
        },
        "preview_engine_versions": dict(Counter((pj(r.get("preview_snapshot_json"), {}) or {}).get("engineVersion", "none") for r in refunds)),
        "suggested_lines_empty": sum(1 for r in refunds if not pj(r.get("suggested_lines_json"), [])),
        "material_incidents_rows": len(incidents),
    }

    stone_shortfalls = []
    for s in stone:
        o, sup = num(s.get("ordered_m2")), num(s.get("supplied_m2"))
        if o > sup + 0.01:
            stone_shortfalls.append({"job_id": s["job_id"], "quotation_ref": s.get("quotation_ref"), "shortfall_m2": round(o - sup, 2)})

    report = {
        "summary": {
            "refunds": len(refunds),
            "total_requested_ngn": int(sum(num(r["amount_ngn"]) for r in refunds)),
            "total_paid_ngn": int(sum(num(r["paid_amount_ngn"]) for r in refunds if r.get("status") == "Paid")),
            "jobs": len(jobs),
            "quotations": len(quotations),
            "treasury_refund_payouts": sum(1 for t in treasury if t.get("type") == "REFUND_PAYOUT"),
        },
        "refund_by_type_primary": {k: {"count": type_primary[k], "sum_ngn": int(type_amount[k])} for k in sorted(type_primary)},
        "refund_by_type_any_mention": dict(type_any),
        "refund_by_status": dict(status_stats),
        "partial_approval": partial_approval,
        "partial_payment": partial_payment,
        "pending_approval": pending_approval,
        "pending_payment": pending_payment,
        "same_requester_approver": {"count": len(same_req_appr), "ids": same_req_appr},
        "same_approver_payer": {"count": len(same_appr_pay), "ids": same_appr_pay},
        "full_chain_one_person": {"count": len(full_chain), "rows": full_chain},
        "high_value_refunds": above_md,
        "cancel_misapplied": cancel_misapplied,
        "corrugation_refunds": corrugation_refunds,
        "service_only_refunds": service_only_refunds,
        "multi_category_refunds": {"count": len(multi_cat), "rows": multi_cat[:20]},
        "multi_refund_per_quote": multi_refund_quotes,
        "paid_no_treasury": paid_no_treasury,
        "job_types": dict(job_types),
        "job_status": dict(Counter(j.get("status") for j in jobs)),
        "planned_actual_outliers": sorted(outliers, key=lambda x: abs(x["pct_diff"]), reverse=True)[:25],
        "spec_mismatch_job_count": len(set(spec_mismatch_jobs)),
        "spec_mismatch_sample": list(dict.fromkeys(spec_mismatch_jobs))[:20],
        "qc_gaps": qc_gaps[:30],
        "qc_gap_counts": dict(Counter(g["issue"] for g in qc_gaps)),
        "payment_gate_exceptions": payment_gate_exceptions,
        "cancelled_jobs_no_refund": cancelled_no_refund,
        "stone_shortfalls": stone_shortfalls,
        "cross_domain": cross,
        "historical": hist,
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))


def boolish(v):
    return str(v or "").strip() in ("1", "true", "True")


if __name__ == "__main__":
    main()

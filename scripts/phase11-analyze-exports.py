#!/usr/bin/env python3
"""Read-only Phase 11 analysis of exported CSVs. Writes JSON to stdout."""
import csv
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

DOWNLOADS = Path(r"C:\Users\USER\Downloads")
MD_THRESHOLD = 1_000_000
FILES = {
    "refunds": "customer_refunds.csv",
    "jobs": "production_jobs.csv",
    "coils": "production_job_coils.csv",
    "conversion": "production_conversion_checks.csv",
    "stone": "production_job_stone_flatsheet_usage.csv",
    "treasury": "treasury_movements.csv",
    "quotations": "quotations.csv",
    "lines": "quotation_lines.csv",
}


def read_csv(name):
    path = DOWNLOADS / FILES[name]
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def parse_json_field(raw, default=None):
    if not raw or str(raw).strip() in ("", "NULL", "null"):
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


def norm(s):
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def parse_categories(raw):
    arr = parse_json_field(raw, [])
    if isinstance(arr, list):
        return [str(x).strip() for x in arr if str(x).strip()]
    s = str(raw or "").strip()
    return [s] if s and s != "—" else []


def num(v, default=0):
    try:
        if v is None or str(v).strip() in ("", "NULL", "null"):
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def boolish(v):
    return str(v or "").strip() in ("1", "true", "True", "yes")


def main():
    refunds = read_csv("refunds")
    jobs = read_csv("jobs")
    coils = read_csv("coils")
    conversion = read_csv("conversion")
    stone = read_csv("stone")
    treasury = read_csv("treasury")
    quotations = read_csv("quotations")
    lines = read_csv("lines")

    q_by_id = {r["id"]: r for r in quotations}
    jobs_by_q = defaultdict(list)
    jobs_by_id = {j["job_id"]: j for j in jobs}
    for j in jobs:
        if j.get("quotation_ref"):
            jobs_by_q[j["quotation_ref"]].append(j)

    coils_by_job = defaultdict(list)
    for c in coils:
        coils_by_job[c["job_id"]].append(c)

    conv_by_job = defaultdict(list)
    for c in conversion:
        conv_by_job[c["job_id"]].append(c)

    stone_by_job = defaultdict(list)
    stone_by_q = defaultdict(list)
    for s in stone:
        stone_by_job[s["job_id"]].append(s)
        if s.get("quotation_ref"):
            stone_by_q[s["quotation_ref"]].append(s)

    lines_by_q = defaultdict(list)
    for ln in lines:
        lines_by_q[ln["quotation_id"]].append(ln)

    treasury_refund = defaultdict(list)
    for tm in treasury:
        if tm.get("source_kind") == "REFUND":
            treasury_refund[tm["source_id"]].append(tm)

    # --- Refunds ---
    type_stats = Counter()
    type_amounts = Counter()
    status_stats = Counter()
    branch_stats = Counter()
    pending_approval = []
    pending_payment = []
    partial_approval = []
    partial_payment = []
    same_request_approve = []
    same_approve_pay = []
    admin_self_chain = []
    above_md = []
    duplicate_category_active = []
    paid_no_treasury = []
    cancellation_refunds = []
    overpayment_refunds = []
    service_only_candidates = []
    corrugation_quotes_with_refund = []

    refunds_by_q_cat = defaultdict(list)
    for r in refunds:
        status = (r.get("status") or "").strip()
        status_stats[status] += 1
        branch_stats[r.get("branch_id") or "(none)"] += 1
        cats = parse_categories(r.get("reason_category"))
        primary = cats[0] if cats else "(blank)"
        amt = num(r.get("amount_ngn"))
        appr = num(r.get("approved_amount_ngn"))
        paid = num(r.get("paid_amount_ngn"))
        type_stats[primary] += 1
        type_amounts[primary] += amt

        qref = r.get("quotation_ref") or ""
        for c in cats or ["(blank)"]:
            refunds_by_q_cat[(qref, c)].append(r["refund_id"])

        req = norm(r.get("requested_by"))
        appr_by = norm(r.get("approved_by"))
        paid_by = norm(r.get("paid_by"))
        if req and appr_by and req == appr_by:
            same_request_approve.append(r["refund_id"])
        if appr_by and paid_by and appr_by == paid_by:
            same_approve_pay.append(r["refund_id"])
        if "admin" in req and "admin" in appr_by:
            admin_self_chain.append(r["refund_id"])

        if amt > MD_THRESHOLD or appr > MD_THRESHOLD:
            above_md.append({"refund_id": r["refund_id"], "amount": amt, "approved": appr, "approved_by": r.get("approved_by")})

        if status == "Pending":
            pending_approval.append(r["refund_id"])
        if status == "Approved" and paid < (appr or amt):
            pending_payment.append({"refund_id": r["refund_id"], "approved": appr or amt, "paid": paid})
        if appr and amt and appr < amt and status in ("Approved", "Paid"):
            partial_approval.append({"refund_id": r["refund_id"], "requested": amt, "approved": appr})
        if paid and appr and paid < appr and status in ("Approved", "Paid"):
            partial_payment.append({"refund_id": r["refund_id"], "approved": appr, "paid": paid})

        if status in ("Paid", "Approved") and paid >= (appr or amt) and r["refund_id"] not in treasury_refund:
            paid_no_treasury.append(r["refund_id"])

        if "Order cancellation" in cats or "order cancellation" in norm(r.get("reason")):
            cancellation_refunds.append(r)
        if "Overpayment" in cats:
            overpayment_refunds.append(r)

        # service-only / corrugation
        q = q_by_id.get(qref)
        if q:
            lj = parse_json_field(q.get("lines_json"), {}) or {}
            svcs = lj.get("services") or []
            prods = lj.get("products") or []
            svc_named = [s for s in svcs if str(s.get("name") or "").strip()]
            prod_named = [p for p in prods if str(p.get("name") or "").strip() and num(p.get("qty")) > 0]
            has_corrugation = any("corrugation" in norm(s.get("name")) or "currugation" in norm(s.get("name")) for s in svc_named)
            if has_corrugation:
                corrugation_quotes_with_refund.append({"refund_id": r["refund_id"], "quotation_ref": qref, "categories": cats})
            if svc_named and not prod_named:
                service_only_candidates.append({"refund_id": r["refund_id"], "quotation_ref": qref, "services": [s.get("name") for s in svc_named], "categories": cats})

    dup_active = []
    for (qref, cat), ids in refunds_by_q_cat.items():
        if not qref or cat == "(blank)":
            continue
        active = [i for i in ids if any(r["refund_id"] == i and (r.get("status") or "") in ("Pending", "Approved") for r in refunds)]
        if len(active) > 1:
            dup_active.append({"quotation_ref": qref, "category": cat, "refund_ids": active})

    # --- Production ---
    job_status = Counter(j.get("status") or "(blank)" for j in jobs)
    alert_stats = Counter(j.get("conversion_alert_state") or "(blank)" for j in jobs)
    missing_bm = []
    spec_mismatch_jobs = []
    conversion_outliers = []
    planned_actual_gaps = []
    offcut_jobs = []
    no_coil_completed = []
    payment_gate_underpaid = []
    bm_production_override = []

    for j in jobs:
        jid = j["job_id"]
        qref = j.get("quotation_ref") or ""
        planned = num(j.get("planned_meters"))
        actual = num(j.get("actual_meters"))
        if j.get("status") == "Completed" and boolish(j.get("manager_review_required")) and not (j.get("manager_review_signed_at_iso") or "").strip():
            missing_bm.append(jid)
        if boolish(j.get("coil_spec_mismatch_pending")) or any(boolish(c.get("spec_mismatch")) for c in coils_by_job[jid]):
            spec_mismatch_jobs.append(jid)
        alert = (j.get("conversion_alert_state") or "").strip()
        if alert in ("High", "Low", "Watch"):
            conversion_outliers.append({"job_id": jid, "alert": alert, "planned": planned, "actual": actual})
        if planned > 0 and abs(actual - planned) / planned > 0.05 and j.get("status") == "Completed":
            planned_actual_gaps.append({"job_id": jid, "planned": planned, "actual": actual, "pct_diff": round(100 * (actual - planned) / planned, 2)})
        if num(j.get("offcut_inventory_meters")) > 0 or (j.get("offcut_supply_json") or "").strip() not in ("", "NULL", "null"):
            offcut_jobs.append(jid)
        if j.get("status") in ("Completed", "Running") and not coils_by_job[jid] and planned > 0 and not stone_by_job[jid]:
            no_coil_completed.append(jid)

        q = q_by_id.get(qref)
        if q:
            total = num(q.get("total_ngn"))
            paid = num(q.get("paid_ngn"))
            if total > 0 and paid / total < 0.7 and not (q.get("manager_production_approved_at_iso") or "").strip():
                payment_gate_underpaid.append({"job_id": jid, "quotation_ref": qref, "paid_pct": round(100 * paid / total, 1)})
            if (q.get("manager_production_approved_at_iso") or "").strip():
                bm_production_override.append({"job_id": jid, "quotation_ref": qref, "paid_pct": round(100 * paid / total, 1) if total else None})

    stone_shortfalls = []
    for s in stone:
        ordered = num(s.get("ordered_m2"))
        supplied = num(s.get("supplied_m2"))
        if ordered > supplied + 0.01:
            stone_shortfalls.append({
                "job_id": s["job_id"],
                "quotation_ref": s.get("quotation_ref"),
                "name": s.get("name"),
                "ordered_m2": ordered,
                "supplied_m2": supplied,
                "shortfall_m2": round(ordered - supplied, 2),
            })

    # --- Cross domain ---
    misaligned = []
    for r in refunds:
        qref = r.get("quotation_ref") or ""
        cats = parse_categories(r.get("reason_category"))
        qjobs = jobs_by_q.get(qref, [])
        statuses = [j.get("status") for j in qjobs]
        has_cancelled = any(s == "Cancelled" for s in statuses)
        has_completed = any(s == "Completed" for s in statuses)
        has_running = any(s == "Running" for s in statuses)
        issues = []
        if "Order cancellation" in cats and has_completed and not has_cancelled:
            issues.append("cancellation_refund_but_completed_production")
        if "Order cancellation" in cats and has_running:
            issues.append("cancellation_refund_while_running")
        if not qjobs and qref:
            q = q_by_id.get(qref)
            if q and (q.get("status") or "") != "Void" and num(q.get("paid_ngn")) > 0:
                issues.append("refund_without_production_job_non_void")
        q = q_by_id.get(qref)
        if q and num(q.get("paid_ngn")) < num(r.get("amount_ngn")) and "Overpayment" not in cats:
            issues.append("refund_amount_exceeds_paid_without_overpayment_category")
        preview = parse_json_field(r.get("preview_snapshot_json"), {}) or {}
        if preview.get("actualMeters") is not None and preview.get("quotedMeters") is not None:
            if num(preview.get("actualMeters")) >= num(preview.get("quotedMeters")) and "Unproduced meterage" in cats:
                issues.append("unproduced_category_but_no_shortfall_in_preview")
        if issues:
            misaligned.append({"refund_id": r["refund_id"], "quotation_ref": qref, "categories": cats, "job_statuses": statuses, "issues": issues})

    # Field presence anomalies
    refund_fields = set(refunds[0].keys()) if refunds else set()
    job_fields = set(jobs[0].keys()) if jobs else set()
    null_payee = sum(1 for r in refunds if not (r.get("payee_name") or "").strip())
    null_product_on_jobs = sum(1 for j in jobs if not (j.get("product_id") or "").strip() and not (j.get("product_name") or "").strip())

    out = {
        "counts": {
            "refunds": len(refunds),
            "jobs": len(jobs),
            "coils": len(coils),
            "conversion_checks": len(conversion),
            "stone_usage_rows": len(stone),
            "quotations": len(quotations),
            "treasury_refund_movements": sum(len(v) for v in treasury_refund.values()),
        },
        "refund_by_type": {k: {"count": type_stats[k], "sum_requested_ngn": int(type_amounts[k])} for k in sorted(type_stats.keys())},
        "refund_by_status": dict(status_stats),
        "refund_by_branch": dict(branch_stats),
        "pending_approval_count": len(pending_approval),
        "pending_approval_ids": pending_approval[:20],
        "pending_payment": pending_payment,
        "partial_approval": partial_approval,
        "partial_payment": partial_payment,
        "same_request_approve_count": len(same_request_approve),
        "same_request_approve_ids": same_request_approve[:30],
        "same_approve_pay_count": len(same_approve_pay),
        "same_approve_pay_ids": same_approve_pay[:30],
        "admin_self_chain_count": len(admin_self_chain),
        "above_md_threshold": above_md,
        "duplicate_active_category": dup_active,
        "paid_no_treasury": paid_no_treasury,
        "cancellation_refund_count": len(cancellation_refunds),
        "overpayment_refund_count": len(overpayment_refunds),
        "corrugation_quotes_with_refund": corrugation_quotes_with_refund,
        "service_only_refund_candidates": service_only_candidates,
        "job_status": dict(job_status),
        "conversion_alert_distribution": dict(alert_stats),
        "missing_bm_signoff_count": len(missing_bm),
        "missing_bm_signoff_ids": missing_bm[:40],
        "spec_mismatch_job_count": len(set(spec_mismatch_jobs)),
        "spec_mismatch_job_ids": list(dict.fromkeys(spec_mismatch_jobs))[:40],
        "conversion_outlier_count": len(conversion_outliers),
        "conversion_outliers_sample": conversion_outliers[:25],
        "planned_actual_gaps_count": len(planned_actual_gaps),
        "planned_actual_gaps_sample": sorted(planned_actual_gaps, key=lambda x: abs(x["pct_diff"]), reverse=True)[:20],
        "offcut_job_count": len(offcut_jobs),
        "no_coil_completed_count": len(no_coil_completed),
        "no_coil_completed_ids": no_coil_completed[:20],
        "payment_gate_underpaid_jobs": payment_gate_underpaid[:30],
        "bm_production_override_jobs_count": len(bm_production_override),
        "stone_shortfalls": stone_shortfalls,
        "cross_domain_misaligned_count": len(misaligned),
        "cross_domain_misaligned": misaligned[:40],
        "data_quality": {
            "refunds_missing_payee": null_payee,
            "jobs_missing_product_id_name": null_product_on_jobs,
            "refund_fields": sorted(refund_fields),
            "job_fields": sorted(job_fields),
        },
        "top_requesters": Counter(r.get("requested_by") or "(blank)" for r in refunds).most_common(10),
        "top_approvers": Counter(r.get("approved_by") or "(blank)" for r in refunds).most_common(10),
        "top_payers": Counter(r.get("paid_by") or "(blank)" for r in refunds).most_common(10),
    }
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

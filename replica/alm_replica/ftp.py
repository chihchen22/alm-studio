"""Funds transfer pricing of the existing positions on the base scenario (DEFINITIONS rows F1 to F9).

Three par-matched rates per position: IR against the risk-free curve, all-in against
the risk-free curve plus the term liquidity premium, and LP as their difference. The
par-matched rate prices the position's own principal schedule to par:

    r = (N - sum_i D(t_i) P_i) / (sum_i D(t_i) B_{i-1} dt),   t_i = i / 12, dt = 1 / 12.

The monthly transfer rate is flat at the all-in rate for a rate-locked position; a
floater's refixes at each reset to the benchmark forward over the reset window plus the
premium at that tenor; an interest-bearing deposit blends its rate-locked (1 - beta)
slice at the all-in rate with a beta slice at the one-month forward plus the one-month
premium. The accrual is that rate times the start-of-month balance over 12.
"""
from __future__ import annotations

import math

from .book import HORIZON
from .curve import RatePath, TlpCurve, ZeroCurve, plain_sum
from .book import family_order, family_sides

DT = 1.0 / 12.0


def par_match(rows, df) -> float:
    n0 = rows[0].balance
    num = n0
    den = 0.0
    for i, r in enumerate(rows, start=1):
        d = df(i / 12.0)
        num -= d * r.principal
        den += d * r.balance * DT
    return num / den


def position_ftp(t: dict, rows, curve: ZeroCurve, tlp: TlpCurve, path: RatePath) -> dict:
    df_ir = curve.df
    df_all = lambda s: curve.df(s) * math.exp(-tlp.at(s) * s) if s > 0 else 1.0
    ir = par_match(rows, df_ir)
    allin = locked_all = par_match(rows, df_all)
    n = len(rows)
    typ = t["type"]
    beta = 0.0
    if typ == "nmd-b":
        sc = t["sCurve"]
        r0 = path.rate_at(0) * 100.0
        beta = sc["betaMin"] + (sc["betaMax"] - sc["betaMin"]) / (1.0 + math.exp(-sc["k"] * (r0 - sc["m"])))
        one = curve.simple_forward(0.0, DT)
        ir = (1.0 - beta) * ir + beta * one
        allin = (1.0 - beta) * allin + beta * (one + tlp.at(DT))
    wsum = plain_sum(r.balance for r in rows)
    coupon = plain_sum(r.balance * r.rate for r in rows) / wsum
    if typ == "floating-loan" and t.get("fundingTenorMonths") is not None:
        # The floater's funding tenor (ADR-052; DEFINITIONS row F13): the rate leg is the forward over the reset window on
        # the curve's bond-equivalent quoting basis (C8), the liquidity leg the premium at the funding tenor; the monthly
        # series refixes the forward at each reset and carries that premium throughout; the margin is the balance-weighted
        # average over the loan's months of the coupon less that month's transfer rate.
        R = t.get("resetFrequencyMonths", 1)
        tenor = R / 12.0
        lp = tlp.at(t["fundingTenorMonths"] / 12.0)
        ir = curve.forward_par(0.0, tenor)
        allin = ir + lp
        monthly = []
        f = 0.0
        for m in range(1, n + 1):
            if (m - 1) % R == 0:
                s = (m - 1) / 12.0
                f = curve.forward_par(s, s + tenor) + lp
            monthly.append(f)
        spread = plain_sum(r.balance * (r.rate - monthly[i]) for i, r in enumerate(rows)) / wsum
        return {"ir": ir, "allIn": allin, "lp": lp, "coupon": coupon, "monthly": monthly, "notional": t["notional"], "marginSpread": spread}
    if typ == "floating-loan":
        R = t.get("resetFrequencyMonths", 1)
        tenor = R / 12.0
        monthly = []
        f = 0.0
        for m in range(1, n + 1):
            if (m - 1) % R == 0:
                s = (m - 1) / 12.0
                f = curve.simple_forward(s, s + tenor) + tlp.at(tenor)
            monthly.append(f)
    elif typ == "nmd-b":
        monthly = []
        for m in range(1, n + 1):
            s = (m - 1) / 12.0
            monthly.append((1.0 - beta) * locked_all + beta * (curve.simple_forward(s, s + DT) + tlp.at(DT)))
    else:
        monthly = [allin] * n
    return {"ir": ir, "allIn": allin, "lp": allin - ir, "coupon": coupon, "monthly": monthly, "notional": t["notional"]}


def ftp(bank: dict, positions: list[dict], rows_by_id: dict, curve: ZeroCurve, tlp: TlpCurve, path: RatePath, nii_total12: float, nii_deriv12: float) -> dict:
    sides = family_sides(bank)
    acc = {fid: {"n": 0, "notional": 0.0, "c12": 0.0, "f12": 0.0, "w": {"coupon": 0.0, "ir": 0.0, "allIn": 0.0, "lp": 0.0},
                 "tenored": False, "spreadW": 0.0,
                 "monthly": {"balance": [0.0] * HORIZON, "couponInterest": [0.0] * HORIZON, "ftpAccrual": [0.0] * HORIZON}}
           for fid in family_order(bank)}
    for p in positions:
        t = p["terms"]
        if t["type"] in ("commitment", "non-rate-sensitive", "swap"):
            continue
        rows = rows_by_id[p["id"]]
        r = position_ftp(t, rows, curve, tlp, path)
        a = acc[p["familyId"]]
        a["n"] += 1
        a["notional"] += r["notional"]
        for k in ("coupon", "ir", "allIn", "lp"):
            a["w"][k] += r[k] * r["notional"]
        a["tenored"] = a["tenored"] or "marginSpread" in r
        a["spreadW"] += r.get("marginSpread", r["coupon"] - r["allIn"]) * r["notional"]
        for m, row in enumerate(rows[:HORIZON]):
            accr = r["monthly"][m] * row.balance * DT
            a["monthly"]["balance"][m] += row.balance
            a["monthly"]["couponInterest"][m] += row.interest
            a["monthly"]["ftpAccrual"][m] += accr
            if m < 12:
                a["c12"] += row.interest
                a["f12"] += accr
    out_f = {}
    charges = credits = lending = funding = 0.0
    nim_num = nim_den = 0.0
    for fid in family_order(bank):
        side, _ = sides[fid]
        a = acc[fid]
        if side == "liability":
            margin = a["f12"] - a["c12"]
        else:
            margin = a["c12"] - a["f12"]
        row = {"side": side, "positionCount": a["n"], "notional": a["notional"], "couponInterest12": a["c12"],
               "ftpAccrual12": a["f12"], "margin12": margin, "monthly": a["monthly"]}
        if a["notional"] > 1e-9:
            rates = {k: a["w"][k] / a["notional"] for k in a["w"]}
            margin_rate = (rates["allIn"] - rates["coupon"]) if side == "liability" else (rates["coupon"] - rates["allIn"])
            if a["tenored"]:
                # A family holding a funding-tenor floater: the notional-weighted coupon less transfer rate (F13).
                spread = a["spreadW"] / a["notional"]
                margin_rate = -spread if side == "liability" else spread
            row.update({"couponRate": rates["coupon"], "irFtpRate": rates["ir"], "lpFtpRate": rates["lp"], "allInFtpRate": rates["allIn"],
                        "ftpMarginRate": margin_rate})
        out_f[fid] = row
        if "ftpMarginRate" in row:
            nim_num += row["ftpMarginRate"] * a["notional"]
            nim_den += a["notional"]
        if side == "asset":
            charges += a["f12"]
            lending += margin
        elif side == "liability":
            credits += a["f12"]
            funding += margin
    mismatch = charges - credits
    return {
        "byFamily": out_f,
        # The book NIM rate: the notional-weighted margin rate over every funded family (method note M6).
        "book": {"bookNimRate": nim_num / nim_den if nim_den > 1e-9 else 0.0, "charges12": charges, "credits12": credits, "mismatchCenter12": mismatch},
        "nimBridge": {"lendingMargin12": lending, "fundingMargin12": funding, "mismatchCenter12": mismatch,
                      "bridgeNet12": lending + funding + mismatch + nii_deriv12, "niiNet12": nii_total12, "derivativesNet12": nii_deriv12},
    }

"""The repricing and liquidity gap ladders (DEFINITIONS rows G3 to G9)."""
from __future__ import annotations

import math

from .book import HORIZON, family_order, family_sides
from .curve import plain_sum

BANDS = [("0-1M", 0, 1), ("1-3M", 1, 3), ("3-6M", 3, 6), ("6-12M", 6, 12), ("1-2Y", 12, 24),
         ("2-3Y", 24, 36), ("3-5Y", 36, 60), ("5-10Y", 60, 120), ("10Y+", 120, 360)]


def repricing_series(t: dict, rows, path) -> list[float]:
    """Where each dollar's rate is next free to move, by bucket."""
    rep = [0.0] * HORIZON
    typ = t["type"]
    if typ in ("commitment", "non-rate-sensitive") or t.get("repricingTreatment") == "excluded":
        return rep
    if typ == "swap":
        n, N = t["maturityMonths"], t["notional"]
        sf = -1.0 if t["direction"] == "pay-fixed" else 1.0
        rep[n - 1] += sf * N          # fixed leg reprices at its maturity
        rep[0] += -sf * N             # floating leg at its next reset (month 2, bucket 0)
        return rep
    if typ == "floating-loan" and t.get("resetFrequencyMonths", 1) < t["maturityMonths"]:
        nxt = 1 + t.get("resetFrequencyMonths", 1)
        b = nxt - 2
        ran = 0.0
        for k in range(min(b, len(rows))):
            rep[k] += rows[k].principal
            ran += rows[k].principal
        rep[b] += t["notional"] - ran
        return rep
    if typ == "nmd-b":
        sc = t["sCurve"]
        r0 = path.rate_at(0) * 100.0
        beta = sc["betaMin"] + (sc["betaMax"] - sc["betaMin"]) / (1.0 + math.exp(-sc["k"] * (r0 - sc["m"])))
        for k, r in enumerate(rows[:HORIZON]):
            rep[0] += beta * r.principal
            rep[k] += (1.0 - beta) * r.principal
        return rep
    for k, r in enumerate(rows[:HORIZON]):
        rep[k] += r.principal
    return rep


def liquidity_series(t: dict, rows) -> list[float]:
    liq = [0.0] * HORIZON
    if t["type"] in ("commitment", "non-rate-sensitive", "swap"):
        return liq
    for k, r in enumerate(rows[:HORIZON]):
        liq[k] += r.principal
    return liq


def ladder(bank: dict, fam_series: dict, edges) -> list[dict]:
    """Band the whole book: asset and derivative roots in the assets column, liabilities in the other."""
    sides = family_sides(bank)
    a = [0.0] * HORIZON
    l = [0.0] * HORIZON
    for fid in family_order(bank):
        s = fam_series.get(fid)
        if s is None:
            continue
        side, _ = sides[fid]
        tgt = l if side == "liability" else a
        for k in range(HORIZON):
            tgt[k] += s[k]
    rows = []
    cum = 0.0
    for label, lo, hi in edges:
        av = plain_sum(a[lo:hi])
        lv = plain_sum(l[lo:hi])
        gap = av - lv
        cum += gap
        rows.append({"label": label, "assets": av, "liabilities": lv, "gap": gap, "cumulativeGap": cum})
    return rows


def monthly_edges():
    return [(f"M{k + 1}", k, k + 1) for k in range(HORIZON)]


# The fixed-rate ladder's rule by instrument type (DEFINITIONS row G9): placed, left out, or uncovered.
RATE_LOCKED = ("fixed-loan", "mortgage", "cd")
NOT_RATE_LOCKED = ("floating-loan", "nmd-b", "nmd")
UNCOVERED = ("swap", "commitment", "non-rate-sensitive")


def fixed_rate_ladder(bank: dict, positions: list, base_rows: dict) -> dict:
    """Rate-locked principal by the band of the month it is paid, on the base path; the last band open."""
    sides = family_sides(bank)
    a = [0.0] * len(BANDS)
    l = [0.0] * len(BANDS)
    uncovered = []
    for p in positions:
        t = p["terms"]
        typ = t["type"]
        excluded = t.get("repricingTreatment") == "excluded"
        if typ in UNCOVERED:
            uncovered.append(p["id"])
            continue
        if typ in NOT_RATE_LOCKED and not (typ == "nmd" and excluded):
            continue
        if typ not in RATE_LOCKED and not (typ == "nmd" and excluded):
            raise ValueError(f"{p['id']}: no fixed-rate ladder rule for {typ}")
        side, _ = sides[p["familyId"]]
        tgt = l if side == "liability" else a
        for m, r in enumerate(base_rows[p["id"]], start=1):
            k = m - 1
            band = next(i for i, (_, lo, hi) in enumerate(BANDS) if lo <= k < hi or (i == len(BANDS) - 1 and k >= lo))
            tgt[band] += r.principal
    rows = []
    cum = 0.0
    for i, (label, _, _) in enumerate(BANDS):
        gap = a[i] - l[i]
        cum += gap
        rows.append({"band": label, "assets": a[i], "liabilities": l[i], "gap": gap, "cumulativeGap": cum})
    return {"rows": rows, "uncovered": uncovered}

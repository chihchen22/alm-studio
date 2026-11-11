"""The regulatory deposit convention (DEFINITIONS rows R1 to R7): each non-maturity deposit becomes a frozen core
ladder plus a one-month non-core slice, at run entry, before any projection.
"""
from __future__ import annotations

import math

from .curve import RatePath


def round_half_even(x: float) -> int:
    """Nearest whole number, a tie to the even one (the rung rule's rounding, DEFINITIONS R3)."""
    f = math.floor(x)
    d = x - f
    if d > 0.5:
        return f + 1
    if d < 0.5:
        return f
    return f if f % 2 == 0 else f + 1


def rung_months(life_years: float, rungs: int) -> list[int]:
    return [round_half_even(24.0 * life_years * (k + 0.5) / rungs) for k in range(rungs)]


def beta_at(sc: dict, r_pct: float) -> float:
    return sc["betaMin"] + (sc["betaMax"] - sc["betaMin"]) / (1.0 + math.exp(-sc["k"] * (r_pct - sc["m"])))


def transform(positions: list, base_path: RatePath, params: dict) -> tuple[list, dict]:
    """Replace every nmd and nmd-b position by its children, rung order then the non-core slice; return the child map."""
    r0 = base_path.rate_at(0)
    months = rung_months(params["prescribedAverageLifeYears"], params["rungs"])
    out, parent_of = [], {}
    for p in positions:
        t = p["terms"]
        if t["type"] not in ("nmd", "nmd-b") or "parentPositionId" in p or "slotting" in t:
            out.append(p)
            continue
        if t["type"] == "nmd-b":
            beta = beta_at(t["sCurve"], r0 * 100.0)
            d0 = beta * (r0 * 100.0) / 100.0
        else:
            beta = 0.0
            d0 = t.get("depositRate", 0.0)
        b = min(beta, params["passThroughCap"])
        core = min(1.0 - b, params["coreShareCap"])
        n = t["notional"]
        for k, m in enumerate(months, start=1):
            cid = f"{p['id']}-core-{k}"
            out.append({"id": cid, "familyId": p["familyId"], "parentPositionId": p["id"],
                        "terms": {"id": cid, "type": "nmd", "frozen": True, "notional": n * core / params["rungs"], "maturityMonths": m,
                                  "side": "liability", "depositRate": d0, "repricingTreatment": "excluded"}})
            parent_of[cid] = p["id"]
        cid = f"{p['id']}-noncore"
        if t["type"] == "nmd-b":
            terms = {"id": cid, "type": "floating-loan", "notional": n * (1.0 - core), "maturityMonths": 1, "amortType": "bullet",
                     "side": "liability", "margin": d0 - r0, "resetFrequencyMonths": 1, "indexTenorMonths": 1}
        else:
            terms = {"id": cid, "type": "nmd", "frozen": True, "notional": n * (1.0 - core), "maturityMonths": 1, "side": "liability",
                     "depositRate": d0, "repricingTreatment": "excluded"}
        out.append({"id": cid, "familyId": p["familyId"], "parentPositionId": p["id"], "terms": terms})
        parent_of[cid] = p["id"]
    return out, parent_of

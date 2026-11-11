"""The liquidity stress ladder (DEFINITIONS rows L1 to L6): a monthly net funding ladder under three stress rows and
the survival horizon against a buffer, read from each position's liquidityRole; and, from Studio slice S3d-1
(ADR-064, rows L7 to L15), the term-deposit role with its renewal share, the buffer read from the HQLA tags, the
severe draw set by the commitment dials, the dials themselves, and the survival path past month 12 with a borrowing
line counted in the path only.
"""
from __future__ import annotations

from . import behavior

HORIZON = 12
ROWS = ("bau", "moderate", "severe")
STRESS_ROWS = ("moderate", "severe")
ROLES = ("inflow-asset", "hqla-stock", "hys-pool", "nib-pool", "wholesale", "term-deposit")
# L8: the public LCR haircuts by HQLA level (12 CFR 249.21), stated inputs as ADR-064 gives them.
HQLA_HAIRCUT = {"l1": 0.0, "l2a": 0.15, "l2b": 0.5}


def _role(p: dict):
    r = (p.get("dimensions") or {}).get("liquidityRole")
    if isinstance(r, list):
        return next((x for x in r if x in ROLES), None)
    return r


def _first(rows, n: int) -> list[float]:
    out = [0.0] * n
    for m, r in enumerate(rows[:n]):
        out[m] = r.principal
    return out


def survival(buffer: float, cumulative: list[float]):
    """The first month the buffer plus the cumulative net goes below 0, interpolated from the month before; None if never."""
    prev_m, prev = 0, buffer
    for i, c in enumerate(cumulative, start=1):
        running = buffer + c
        if running < 0:
            return prev_m + prev / (prev - running) * (i - prev_m)
        prev_m, prev = i, running
    return None


def buffer_derivation(bank: dict) -> dict:
    """L8: each hqla-stock position at its face less its level's haircut, in book order; no known level, listed only."""
    positions, not_counted = [], []
    by_level = {k: 0.0 for k in HQLA_HAIRCUT}
    total = 0.0
    for p in bank["positions"]:
        if _role(p) != "hqla-stock":
            continue
        level = (p.get("dimensions") or {}).get("hqla-level")
        if not isinstance(level, str) or level not in HQLA_HAIRCUT:
            # The reason is prose the check does not compare; the positions it names are compared.
            why = "no hqla-level tag" if level is None else f"hqla-level {level!r} is not l1, l2a or l2b"
            not_counted.append({"positionId": p["id"], "familyId": p["familyId"], "notional": p["terms"]["notional"], "reason": why})
            continue
        h = HQLA_HAIRCUT[level]
        counted = p["terms"]["notional"] * (1.0 - h)
        positions.append({"positionId": p["id"], "familyId": p["familyId"], "notional": p["terms"]["notional"], "level": level, "haircut": h, "counted": counted})
        by_level[level] += counted
        total += counted
    return {"positions": positions, "notCounted": not_counted, "byLevel": by_level, "total": total}


def commitment_dials(d: dict, undrawn_now: float) -> dict:
    """L12: the dials (ADR-049) on the amount undrawn now U (ruling 2026-11-05): the face is U / (1 - Ubar), of which
    Ubar and U99 are shares; the LCR reference and the annual charge read U."""
    if "face" in d or "undrawn" in d:
        raise ValueError("the ladder's dials carry no amount of their own; they read the ladder's undrawn face")
    if d.get("delayedDraws"):
        raise ValueError("delayed-draw takedowns on the dials are not in the replica")
    ub, u99 = d["expectedUtilization"], d["tailUtilization"]
    undrawn = undrawn_now
    face = undrawn / (1.0 - ub)
    expected = ub * face
    req = (u99 - ub) * face
    charge_bp = (u99 - ub) / (1.0 - ub) * d["fundingSpreadBp"]
    lcr = d["lcrFactor"] * undrawn
    internal = d["thirtyDayShare"] * req
    return {"face": face, "expectedDrawn": expected, "undrawn": undrawn, "tailDrawn": u99 * face, "bufferRequirement": req,
            "bufferRequirementShareOfFace": u99 - ub, "contingentChargeBp": charge_bp, "contingentChargeAnnual": undrawn * charge_bp / 1e4,
            "lcrReferenceOutflow": lcr, "internalThirtyDayDraw": internal, "internalOverLcr": internal / lcr if lcr != 0 else None,
            "internalShareOfUndrawn": internal / undrawn if undrawn != 0 else None, "delayedDrawTotal": 0.0}


def _row(prm: dict, inflow: list, pools: tuple, maturing: list, cd: tuple, face: float, months: int) -> dict:
    """The ladder's monthly recursion on one row, months 1..months; the renewal share rolls the CD maturities only and
    early withdrawals leave in full (L7); draws in months 1..12 only (L11)."""
    cd_mat, cd_early = cd
    h, n = pools
    out = {k: [] for k in ("hysOut", "nibOut", "wholesaleOut", "cdOut", "draws", "net", "cumulative")}
    run = 0.0
    renew = prm.get("cdRenewal")
    for m in range(months):
        ho = h * prm["hysOutflowMonthly"]
        h -= ho
        no = n * prm["nibOutflowMonthly"]
        n -= no
        wo = maturing[m] * (1 - prm["wholesaleRenewal"])
        co = cd_mat[m] * (1 - renew) + cd_early[m] if renew is not None else 0.0
        dr = face * prm["drawRate"] / HORIZON if m < HORIZON else 0.0
        x = inflow[m] - ho - no - wo - co - dr
        run += x
        for k, v in (("hysOut", ho), ("nibOut", no), ("wholesaleOut", wo), ("cdOut", co), ("draws", dr), ("net", x), ("cumulative", run)):
            out[k].append(v)
    return out


def stress_ladder(bank: dict, positions: list, base_rows: dict, opt: dict, cd_split: dict | None = None) -> dict:
    raw = {p["id"]: p for p in bank["positions"]}
    sp = opt.get("survivalPath")
    H = max(HORIZON, sp["horizonMonths"] if sp else HORIZON)
    inflow_base = [0.0] * H
    inflow_stress = [0.0] * H
    maturing = [0.0] * H
    cd_mat = [0.0] * H
    cd_early = [0.0] * H
    hys = nib = 0.0
    for p in positions:
        role = _role(raw[p["id"]])
        t = p["terms"]
        if role == "inflow-asset":
            base = _first(base_rows[p["id"]], H)
            pre = t.get("prepay")
            if pre is not None and "stressAnnualCpr" in pre:
                stress = _first(behavior.constant_cpr_loan(t["notional"], t["coupon"], t["maturityMonths"], pre["stressAnnualCpr"]), H)
            else:
                stress = base
            for m in range(H):
                inflow_base[m] += base[m]
                inflow_stress[m] += stress[m]
        elif role == "wholesale":
            for m, v in enumerate(_first(base_rows[p["id"]], H)):
                maturing[m] += v
        elif role == "term-deposit":
            # L7: the CD book's principal on the base path, contractual maturities and early withdrawals apart.
            mat, early = (cd_split or {})[p["id"]]
            for m in range(min(H, len(mat))):
                cd_mat[m] += mat[m]
                cd_early[m] += early[m]
        elif role == "hys-pool":
            hys += t["notional"]
        elif role == "nib-pool":
            nib += t["notional"]
    with_cd = any("cdRenewal" in opt["table"][rid] for rid in ROWS)
    derivation = None
    if "buffer" in opt:
        buffer = opt["buffer"]  # L9: a stated buffer overrides the tags
    else:
        derivation = buffer_derivation(bank)
        buffer = derivation["total"]
    dials = opt.get("dials")
    table = {rid: dict(opt["table"][rid]) for rid in ROWS}
    face = opt["undrawnFace"]
    dial_result = None
    if dials is not None:
        # L10: the severe row draws the dials' requirement over 12 months: the rate is the requirement over the undrawn face.
        dial_result = commitment_dials(dials, face)
        table["severe"]["drawRate"] = dial_result["bufferRequirement"] / face
    scenarios = []
    for rid in ROWS:
        prm = table[rid]
        inflow = inflow_stress if rid in STRESS_ROWS else inflow_base
        r = _row(prm, inflow, (hys, nib), maturing, (cd_mat, cd_early), face, HORIZON)
        peak = min(r["cumulative"])
        row = {"id": rid, "params": prm, "inflow": list(inflow[:HORIZON]), "hysOut": r["hysOut"], "nibOut": r["nibOut"], "wholesaleOut": r["wholesaleOut"]}
        if "cdRenewal" in prm:
            row["cdOut"] = r["cdOut"]
        row.update({"draws": r["draws"], "net": r["net"], "cumulative": r["cumulative"], "survivalMonths": survival(buffer, r["cumulative"]),
                    "peakShortfall": peak, "peakMonth": r["cumulative"].index(peak) + 1})
        scenarios.append(row)
    out = {"horizonMonths": HORIZON, "buffer": buffer, "undrawnFace": face, "pools": {"hys": hys, "nib": nib}, "wholesaleMaturities": maturing[:HORIZON]}
    if with_cd:
        out["cdMaturities"] = cd_mat[:HORIZON]
        out["cdEarlyWithdrawals"] = cd_early[:HORIZON]
    out["scenarios"] = scenarios
    if derivation is not None:
        out["bufferDerivation"] = derivation
    if dials is not None:
        out["commitmentDials"] = {"dials": {**dials, "undrawn": face}, "result": dial_result, "statedSevereDrawRate": opt["table"]["severe"]["drawRate"],
                                  "severeDrawRate": table["severe"]["drawRate"]}
    if sp:
        out["survivalPath"] = survival_path(table["severe"], sp, buffer, (hys, nib), inflow_base, inflow_stress, maturing, (cd_mat, cd_early), face)
    return out


def _reading(buffer: float, cumulative: list, peak: float) -> dict:
    s = survival(buffer, cumulative)
    return {"buffer": buffer, "survivalMonths": s, "survivalDays": s * 365.0 / 12.0 if s is not None else None,
            "termFundingNeed": max(0.0, -peak - buffer)}


def survival_path(prm: dict, sp: dict, buffer: float, pools: tuple, inflow_base: list, inflow_stress: list, maturing: list, cd: tuple,
                  face: float) -> dict:
    """L13 to L15: the severe row carried to the setup's horizon on the run's own balances; read against the ladder's
    buffer and, with a facility, against the buffer plus the facility after its haircut (never in the ladder's buffer)."""
    H = sp["horizonMonths"]
    r = _row(prm, inflow_stress, pools, maturing, cd, face, H)
    rows = []
    for m in range(H):
        rows.append({"month": m + 1, "days": (m + 1) * 365.0 / 12.0, "inflow": inflow_stress[m], "hysOut": r["hysOut"][m], "nibOut": r["nibOut"][m],
                     "wholesaleOut": r["wholesaleOut"][m], "cdOut": r["cdOut"][m], "draws": r["draws"][m], "net": r["net"][m], "cumulative": r["cumulative"][m]})
    low = min(r["cumulative"])
    # L14: the peak is the most negative cumulative and its month; 0 and no month when nothing goes negative.
    peak = min(0.0, low)
    peak_month = r["cumulative"].index(low) + 1 if low < 0 else None
    out = {"scenarioId": "severe", "horizonMonths": H, "params": prm,
           "legs": {"horizonMonths": H, "pools": {"hys": pools[0], "nib": pools[1]}, "inflow": inflow_base[:H], "inflowStress": inflow_stress[:H],
                    "wholesaleMaturities": maturing[:H], "cdMaturities": cd[0][:H], "cdEarlyWithdrawals": cd[1][:H], "undrawnFace": face},
           "rows": rows, "peakShortfall": peak, "peakMonth": peak_month, "ladderBuffer": _reading(buffer, r["cumulative"], peak)}
    fac = sp.get("facility")
    if fac is not None:
        counted = fac["capacity"] * (1.0 - fac["haircut"])
        out["facility"] = {"label": fac["label"], "capacity": fac["capacity"], "haircut": fac["haircut"], "counted": counted}
        out["withFacility"] = _reading(buffer + counted, r["cumulative"], peak)
    return out

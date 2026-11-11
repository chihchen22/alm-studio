"""The SEG block on the constant-balance convention (DEFINITIONS rows S1 to S12): sensitivity equivalent gap, the
equivalent balance profile and constant-balance NII, each position walked with its runoff replaced month by month by a
fresh vintage, the shock starting at step 1.
"""
from __future__ import annotations

import copy
import math

from .book import HORIZON, family_order, family_sides, project_position
from .curve import RatePath


class ShockedPath:
    """A parallel shock from step 1 on: step 0 reads the unshocked rate (DEFINITIONS S1)."""

    def __init__(self, base: RatePath, bp: float):
        self.base = base
        self.s = bp / 1e4
        self.n_steps = base.n_steps

    def rate_at(self, k: int) -> float:
        r = self.base.rate_at(k)
        return r if k <= 0 else r + self.s

    def forward_rate_at(self, k: int, tenor: float) -> float:
        f = self.base.forward_rate_at(k, tenor)
        return f if k <= 0 else f + self.s


class ShiftedPath:
    """A path read from step `offset` on: a vintage made in month k reads the run's path from step k (S2)."""

    def __init__(self, inner, offset: int):
        self.inner = inner
        self.offset = offset
        self.n_steps = inner.n_steps - offset

    def rate_at(self, k: int) -> float:
        return self.inner.rate_at(k + self.offset)

    def forward_rate_at(self, k: int, tenor: float) -> float:
        return self.inner.forward_rate_at(k + self.offset, tenor)


def vintage_terms(parent: dict, k: int, notional: float, shocked, base, horizon: int) -> dict:
    """The replacement vintage made at the end of month k (DEFINITIONS S3 to S6)."""
    t = copy.deepcopy(parent)
    t["notional"] = notional
    typ = t["type"]
    if typ == "fixed-loan":
        tenor = parent["maturityMonths"] / 12.0
        t["coupon"] = parent["coupon"] + shocked.forward_rate_at(k, tenor) - base.forward_rate_at(0, tenor)
        t["maturityMonths"] = min(parent["maturityMonths"], horizon - k)
    elif typ == "mortgage":
        p = parent["cprParams"]
        t["noteRate"] = shocked.forward_rate_at(k, 10.0) + (p["secSpread"] + p["primSpread"]) / 1e4
        t["maturityMonths"] = min(parent["originalTermMonths"], horizon - k)
        t["ageMonths"] = 0
        t["originalBalance"] = notional
    elif typ in ("floating-loan", "nmd", "nmd-b"):
        t["maturityMonths"] = min(parent["maturityMonths"], horizon - k)
    else:
        raise ValueError(f"no replacement vintage for {typ}")
    return t


def static_walk(existing: dict, parent: dict, path, base, horizon: int, inp) -> tuple[list[float], list[float]]:
    """Per-month total interest and the existing book's opening balance, months 1..horizon (S7). A deposit vintage
    reads the run's history, unshifted (corrected-v1, DEFINITIONS row K4)."""
    ex = project_position(existing, path, inp)[:horizon]
    interest = [0.0] * horizon
    balance = [0.0] * horizon
    principal = [0.0] * horizon
    for m, r in enumerate(ex):
        interest[m] = r.interest
        balance[m] = r.balance
        principal[m] = r.principal
    vintages = []  # (start month, rows)
    for m in range(1, horizon + 1):
        runoff = principal[m - 1]
        for start, rows in vintages:
            j = m - start
            if 1 <= j <= len(rows):
                runoff += rows[j - 1].principal
        if m > 1:
            for start, rows in vintages:
                j = m - start
                if 1 <= j <= len(rows):
                    interest[m - 1] += rows[j - 1].interest
        if runoff > 0 and m < horizon:
            vt = vintage_terms(parent, m, runoff, path, base, horizon)
            vintages.append((m, project_position(vt, ShiftedPath(path, m), inp)))
    return interest, balance


def flat_cpr_params(params: dict, annual_cpr: float) -> dict:
    """Four-factor parameters that prepay a flat CPR every month: minimum at the target, no incentive reaches the
    midpoint, seasoning ramp 1, no seasonality, no burnout (S9)."""
    p = dict(params)
    p.update({"minCpr": 100.0 * annual_cpr, "maxCpr": 100.0 * annual_cpr + 1.0, "inflection": 1_000_000, "seasoningRamp": 1,
              "seasonalityAmp": 0, "burnoutDecay": 0})
    return p


def compute_seg(inp, positions: list, base_path: RatePath, knobs: dict) -> dict:
    bank = inp.bank
    sides = family_sides(bank)
    s, n, H = knobs["shockBp"], knobs["niiShockBp"], knobs["horizonMonths"]
    overlay = {o["familyId"]: o for o in knobs.get("cprOverlay", [])}
    per = {}
    uncovered = []
    for p in positions:
        t = p["terms"]
        side, typ = sides[p["familyId"]]
        if t["type"] in ("cd", "commitment", "swap", "non-rate-sensitive") or side not in ("asset", "liability"):
            uncovered.append(p["id"])
            continue
        sign = 1.0 if side == "asset" else -1.0
        N = t["notional"]

        def cohort(shock: float):
            o = overlay.get(p["familyId"])
            if o is None or t["type"] != "mortgage":
                return t
            e = copy.deepcopy(t)
            e["cprParams"] = flat_cpr_params(t["cprParams"], o["upAnnualCpr"] if shock > 0 else o["downAnnualCpr"])
            return e

        def walk(shock: float, horizon: int, with_overlay: bool):
            path = ShockedPath(base_path, shock)
            return static_walk(cohort(shock) if with_overlay else t, t, path, base_path, horizon, inp)

        i_up, _ = walk(s, H + 1, True)
        i_dn, _ = walk(-s, H + 1, True)
        out = [sign * N]
        for tt in range(1, H + 1):
            cum = (i_up[tt] - i_dn[tt]) * 12.0 / (2.0 * s / 1e4)
            out.append(sign * (N - cum))
        perd = [0.0] + [out[tt - 1] - out[tt] for tt in range(1, H + 1)]
        b_up, bal_up = walk(s, H, True)
        b_dn, bal_dn = walk(-s, H, True)
        bank_seg = [sign * (b_dn[i] - b_up[i]) * 12.0 / (2.0 * s / 1e4) for i in range(H)]
        ebp = [(bal_up[i] + bal_dn[i]) / 2.0 for i in range(H)]
        nii = {}
        for key, shock in (("base", 0.0), ("up", n), ("down", -n)):
            inter, _ = walk(shock, 12, False)
            nii[key] = [sign * x for x in inter]
        per[p["id"]] = {"family": p["familyId"], "side": side, "out": out, "per": perd, "bank": bank_seg, "ebp": ebp, "nii": nii}
    return {"positions": per, "uncovered": uncovered}


def _sum_into(acc: list, xs: list) -> None:
    for i, x in enumerate(xs):
        acc[i] += x


def _peak(out: list) -> dict:
    best, month = 0.0, 1
    for tt in range(1, len(out)):
        if abs(out[tt]) > abs(best):
            best, month = out[tt], tt
    return {"value": best, "month": month}


def fold(inp, walked: dict, knobs: dict) -> dict:
    """The block: per family and for the book, the signed SEG series, the EBP, the NII trio; the bank print (S10, S11)."""
    H = knobs["horizonMonths"]
    sides = family_sides(inp.bank)

    def empty():
        return {"nii": {k: [0.0] * 12 for k in ("base", "up", "down")}, "out": [0.0] * (H + 1), "per": [0.0] * (H + 1),
                "ebpA": [0.0] * H, "ebpL": [0.0] * H}

    def add(acc, r):
        for k in ("base", "up", "down"):
            _sum_into(acc["nii"][k], r["nii"][k])
        _sum_into(acc["out"], r["out"])
        _sum_into(acc["per"], r["per"])
        _sum_into(acc["ebpA"] if r["side"] == "asset" else acc["ebpL"], r["ebp"])

    def shape(acc):
        b12 = sum(acc["nii"]["base"])
        return {
            "nii": {"base12": _plain(acc["nii"]["base"]), "up12": _plain(acc["nii"]["up"]), "down12": _plain(acc["nii"]["down"]),
                    "baseMonthly": acc["nii"]["base"], "upMonthly": acc["nii"]["up"], "downMonthly": acc["nii"]["down"]},
            "segOutstanding": acc["out"], "segPeriodic": acc["per"], "ebpAssets": acc["ebpA"], "ebpLiabilities": acc["ebpL"],
            "segPeak": _peak(acc["out"]),
        }

    book = empty()
    fams: dict = {}
    bank = [0.0] * H
    for pid, r in walked["positions"].items():
        add(book, r)
        add(fams.setdefault(r["family"], empty()), r)
        _sum_into(bank, r["bank"])
    order = [f for f in family_order(inp.bank) if f in fams]
    asset_notional = 0.0
    for p in inp.bank["positions"]:
        side, typ = sides[p["familyId"]]
        if side == "asset" and p["terms"]["type"] not in ("commitment", "swap"):
            asset_notional += p["terms"]["notional"]
    b = shape(book)
    return {"shockBp": knobs["shockBp"], "niiShockBp": knobs["niiShockBp"], "horizonMonths": H, "niiHorizonMonths": 12,
            "nimPct": 100.0 * b["nii"]["base12"] / asset_notional if asset_notional else 0.0, "totalAssetNotional": asset_notional,
            "book": b, "segBank": bank, "byFamily": {f: shape(fams[f]) for f in order}, "uncovered": walked["uncovered"]}


def _plain(xs) -> float:
    s = 0.0
    for x in xs:
        s += x
    return s

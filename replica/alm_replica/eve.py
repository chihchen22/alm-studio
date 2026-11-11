"""Run-off EVE on the risk-free, the all-in and the spread-consistent discount basis (DEFINITIONS rows E1 to E7)."""
from __future__ import annotations

import math

from .curve import TlpCurve, ZeroCurve, shocked_curve
from .book import HORIZON, family_order, family_sides


def discount_function(curve: ZeroCurve, tlp: TlpCurve | None):
    if tlp is None:
        return curve.df
    return lambda t: curve.df(t) * math.exp(-tlp.at(t) * t) if t > 0 else 1.0


def pv_series(series: dict, df) -> float:
    s = 0.0
    for k in range(HORIZON):
        cf = series["principal"][k] + series["interest"][k]
        if cf != 0.0:
            s += df((k + 1) / 12.0) * cf
    return s


def family_spreads_bp(bank: dict) -> dict:
    """The one discount spread each family carries on the spread-consistent basis; 0 for a deposit (DEFINITIONS E7)."""
    out: dict = {}
    for p in bank["positions"]:
        t = p["terms"]
        s = 0.0 if t["type"] in ("nmd", "nmd-b") or "parentPositionId" in p else float(p.get("discountSpreadBp", 0) or 0)
        if p["familyId"] in out and out[p["familyId"]] != s:
            raise ValueError(f"family {p['familyId']} carries two discount spreads; the engine refuses such a family")
        out[p["familyId"]] = s
    return out


def eve(bank: dict, fams: dict, base: ZeroCurve, tlp: TlpCurve, shocks: dict, basis: str) -> dict:
    sides = family_sides(bank)
    spreads = family_spreads_bp(bank) if basis == "spread-consistent" else {}
    out = {}
    for sid, by_fam in fams.items():
        curve = shocked_curve(base, shocks[sid])
        df_all = discount_function(curve, tlp if basis in ("all-in", "spread-consistent") else None)
        df_rf = curve.df
        pa = pl = pd = 0.0
        byf = {}
        for fid in family_order(bank):
            side, typ = sides[fid]
            ser = by_fam.get(fid)
            if typ == "commitment" or ser is None:
                pv = 0.0
            elif typ == "non-rate-sensitive":
                pv = ser["balance"][0]
            elif side == "derivative":
                pv = pv_series(ser, df_rf)
            else:
                sp = spreads.get(fid, 0.0) / 1e4
                df = df_all if sp == 0.0 else (lambda t, sp=sp: df_all(t) * math.exp(-sp * t))
                pv = pv_series(ser, df)
            byf[fid] = pv
            if typ == "commitment":
                continue
            if side == "asset":
                pa += pv
            elif side == "liability":
                pl += pv
            elif side == "derivative":
                pd += pv
        row = {"pvAssets": pa, "pvLiabilities": pl}
        if any(side == "derivative" for side, _ in sides.values()):
            row["pvDerivatives"] = pd  # a book with no derivative family carries no derivatives line
        row.update({"eve": pa - pl + pd, "byFamily": byf})
        out[sid] = row
    b = out["S0"]["eve"]
    for sid in out:
        out[sid]["deltaEveVsBase"] = out[sid]["eve"] - b
        out[sid]["deltaEvePct"] = (out[sid]["eve"] - b) / b
    return out

"""Net interest income on the run-off basis, by month, family and horizon (DEFINITIONS rows N1 to N4)."""
from __future__ import annotations

from .book import HORIZON, family_order, family_sides


def nii(bank: dict, fams: dict, horizons=(12, 24)) -> dict:
    sides = family_sides(bank)
    out = {}
    for sid, by_fam in fams.items():
        rows = {}
        total = {h: 0.0 for h in horizons}
        deriv = {h: 0.0 for h in horizons}
        monthly = [0.0] * HORIZON
        dmonthly = [0.0] * HORIZON
        for fid in family_order(bank):
            side, _ = sides[fid]
            interest = by_fam.get(fid, {"interest": [0.0] * HORIZON})["interest"]
            sign = 1.0 if side in ("asset", "derivative") else -1.0
            row = {}
            for h in horizons:
                s = 0.0
                for k in range(h):
                    s += interest[k]
                if side == "derivative":
                    row[h] = {"interestIncome": 0.0, "interestExpense": 0.0, "net": s}
                    deriv[h] += s
                elif side == "asset":
                    row[h] = {"interestIncome": s, "interestExpense": 0.0, "net": s}
                    total[h] += s
                else:
                    row[h] = {"interestIncome": 0.0, "interestExpense": s, "net": 0.0 - s}
                    total[h] += 0.0 - s
            nm = [sign * x + 0.0 for x in interest]
            if side == "derivative":
                dmonthly = [a + b for a, b in zip(dmonthly, nm)]
            else:
                monthly = [a + b for a, b in zip(monthly, nm)]
            rows[fid] = {"byHorizon": row, "netMonthly": nm}
        out[sid] = {
            "byFamily": rows,
            "totalNet": {h: total[h] + deriv[h] for h in horizons},
            "derivativesNet": deriv,
            "netMonthly": [a + b for a, b in zip(monthly, dmonthly)],
        }
    return out

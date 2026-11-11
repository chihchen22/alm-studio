"""The deposit forms of Studio slice S3c-1 (DEFINITIONS rows DF1 to DF16), read from ADR-050 to ADR-053, ADR-063,
the deposit desk's data note and the engine's method comments, not from engine code.

- The straight-line runoff (ADR-052): B(t) = B(0) max(0, 1 - t / n), interest at the terms' rate on the opening
  balance, life (n + 1) / 2 months.
- Component decay on a dated rate path (ADR-051): B(t) = B(0) prod_{s<=t} R (1 + mu0 + phi x_s),
  x_s = max(0, r_s + shift - rbar_s), rbar_s the mean of the lookback months before s; past the window the driver holds.
- The full beta form (ADR-050): beta_eff(r) = beta(r) clip(1 - delta v, 0, 2), D*(r) = alpha + beta_eff(r) r, the
  slotted EVE book (frozen or shocked-level) of ten equal bullet rungs and a one-month non-core slice at D(0).
- The replicating-portfolio credit (ADR-052, ADR-053): the rate leg on an overnight tranche and life-target pillars, the
  liquidity leg the bullet par spread at the life.
"""
from __future__ import annotations

import math

from .curve import interp_flat
from .regulatory import beta_at, rung_months
from .schedules import Row

DT = 1.0 / 12.0


# --- Scenario shift at tenor zero ---------------------------------------------------------------------------------

def shift_pct(spec) -> float:
    """The scenario's shift of the short rate at tenor zero, percent (DF1): base 0, a parallel shockBp / 100."""
    if isinstance(spec, (int, float)):
        return spec / 100.0
    kind = spec["kind"]
    if kind == "base":
        return 0.0
    if kind == "parallel":
        return spec["shockBp"] / 100.0
    if kind == "custom":
        knots = spec["shocks"]
        xs = [float(k["tenorYears"]) for k in knots]
        ys = [float(k["shockBp"]) for k in knots]
        return interp_flat(0.0, xs, ys) / 100.0
    raise ValueError(f"no shift at tenor zero for a {kind} scenario")


# --- The straight-line runoff ----------------------------------------------------------------------------------------

def linear_decay_rows(t: dict) -> list[Row]:
    """DF2: one n-th of the book a month for n months, interest at depositRate on the opening balance."""
    n = t["linearDecay"]["horizonMonths"]
    if t["maturityMonths"] != n:
        raise ValueError(f"{t.get('id')}: a straight-line runoff whose maturity is not its n is not in the replica")
    N = t["notional"]
    r = t.get("depositRate", 0.0)
    rows = []
    for m in range(1, n + 1):
        b = N * max(0.0, 1.0 - (m - 1) / n)
        after = N * max(0.0, 1.0 - m / n)
        rows.append(Row(b, b - after if m < n else b, b * r / 12.0, r))
    return rows


# --- Component decay -------------------------------------------------------------------------------------------------

def _month_index(first: str, month: str) -> int:
    y0, m0 = (int(x) for x in first.split("-"))
    y1, m1 = (int(x) for x in month.split("-"))
    return (y1 - y0) * 12 + (m1 - m0)


def component_factors(form: dict, shift: float) -> list[float]:
    """DF3: g_1..g_W of the window, g_s = R (1 + mu0 + phi x_s), the shift on the window months only."""
    if form.get("beyondWindow", "hold-last") != "hold-last" or "staticShare" in form:
        raise ValueError("a component decay form other than hold-last without a static share is not in the replica")
    vals = form["series"]["valuesPct"]
    start = _month_index(form["series"]["firstMonth"], form["window"]["firstMonth"])
    W = _month_index(form["window"]["firstMonth"], form["window"]["lastMonth"]) + 1
    L = form["lookbackMonths"]
    g = []
    for j in range(W):
        s = 0.0
        for k in range(start + j - L, start + j):
            s += vals[k]
        x = max(0.0, vals[start + j] + shift - s / L)
        g.append(form["retention"] * (1.0 + form["drift"] + form["coefficientPerPp"] * x))
    return g


def component_rows(t: dict, shift: float) -> list[Row]:
    """DF4: the opening balance each month, the month's runoff as principal, the remainder at maturity."""
    g = component_factors(t["componentDecay"], shift)
    W = len(g)
    n = t["maturityMonths"]
    r = t.get("depositRate", 0.0)
    b = t["notional"]
    rows = []
    for m in range(1, n + 1):
        nxt = b * g[min(m, W) - 1]
        rows.append(Row(b, b - nxt if m < n else b, b * r / 12.0, r))
        b = nxt
    return rows


def component_life_months(t: dict, shift: float) -> float:
    """DF5: the life of the schedule run off in full: the window months one by one, then the geometric tail at q,
    b (m + q / (1 - q)) from the balance b after the window, m the first month after it."""
    g = component_factors(t["componentDecay"], shift)
    W = len(g)
    s = 1.0
    dm = 0.0
    for m in range(1, W + 1):
        nxt = s * g[m - 1]
        dm += (s - nxt) * m
        s = nxt
    q = g[-1]
    dm += s * ((W + 1) + q / (1.0 - q))
    return dm


# --- The full beta form ----------------------------------------------------------------------------------------------

def _beta(t: dict, form: dict, r: float) -> float:
    if "staticBeta" in form:
        return form["staticBeta"]
    return beta_at(t["sCurve"], r)


def beta_eff(t: dict, form: dict, r: float, rising: bool) -> float:
    """DF6: beta(r) clip(1 - delta v, 0, 2), delta after a rise or after a fall."""
    damp = min(max(1.0 - (form["deltaUp"] if rising else form["deltaDown"]) * form["volRatio"], 0.0), 2.0)
    return _beta(t, form, r) * damp


def full_state(t: dict, form: dict, shift: float) -> dict:
    """DF6: the level (base plus the shift, floored at 0), its direction, beta_eff, D* there, percent; and D(0)."""
    if form.get("balances", "flat") != "flat" or "startPaidRatePct" in form:
        raise ValueError("a full beta form other than flat balances from the base state is not in the replica")
    rb = form["baseShortRatePct"]
    base_rising = form["baseLastMove"] == "rise"
    be0 = beta_eff(t, form, rb, base_rising)
    d0 = form["alphaPct"] + be0 * rb
    r = max(rb + shift, 0.0)
    rising = shift > 0 if shift != 0 else base_rising
    be = beta_eff(t, form, r, rising)
    return {"r": r, "betaEff": be, "dStar": form["alphaPct"] + be * r, "betaEffBase": be0, "d0": d0}


def slotted_rows(t: dict, shift: float, mark: str, caps: dict) -> list[Row]:
    """DF7, DF8: the slotted EVE book, ten equal bullet rungs of the core and a non-core slice leaving at month 1, every
    dollar at D(0); frozen core min(1 - min(beta_eff base, cap), core cap), shocked-level core 1 - beta_eff at the level."""
    form = t["fullBeta"]
    st = full_state(t, form, shift)
    if mark == "frozen":
        b = min(st["betaEffBase"], caps["passThroughCap"])
        core = min(1.0 - b, caps["coreShareCap"])
        life = caps["prescribedAverageLifeYears"]
    elif mark == "shocked-level":
        core = 1.0 - st["betaEff"]
        life = form.get("coreLifeYears", caps["prescribedAverageLifeYears"])
    else:
        raise ValueError(f"no slotting mark {mark}")
    N = t["notional"]
    rungs = caps["rungs"]
    months = rung_months(life, rungs)
    rate = st["d0"] / 100.0
    leaving = {}
    leaving[1] = N * (1.0 - core)
    for m in months:
        leaving[m] = leaving.get(m, 0.0) + N * core / rungs
    last = max(months)
    rows = []
    bal = N
    for m in range(1, last + 1):
        p = leaving.get(m, 0.0)
        rows.append(Row(bal, p, bal * rate / 12.0, rate))
        bal -= p
    return rows


def unslotted_rows(t: dict, shift: float) -> list[Row]:
    """DF6: flat balance, the paid rate closing lambda of the gap to D* each month from D(0), principal at maturity."""
    st = full_state(t, t["fullBeta"], shift)
    lam = t["sCurve"]["lambda"]
    N = t["notional"]
    n = t["maturityMonths"]
    d = st["d0"]
    rows = []
    for m in range(1, n + 1):
        d = d + lam * (st["dStar"] - d)
        rows.append(Row(N, N if m == n else 0.0, N * (d / 100.0) / 12.0, d / 100.0))
    return rows


# --- The replicating-portfolio credit --------------------------------------------------------------------------------

def bullet_par(months: float, df) -> float:
    """DF10: the par-matched rate of a bullet of `months` (monthly accrual on the start-of-month balance); a fractional
    tenor carries a final stub whose accrual weight is the stub."""
    k = math.floor(months)
    stub = months - k
    ann = 0.0
    for i in range(1, k + 1):
        ann += df(i / 12.0)
    if stub > 0:
        ann += stub * df(months / 12.0)
    return (1.0 - df(months / 12.0)) / (ann * DT)


def runoff_par(n: int, df) -> float:
    """The par-matched rate of a unit straight-line runoff of n months."""
    num = 1.0
    den = 0.0
    for i in range(1, n + 1):
        d = df(i / 12.0)
        num -= d / n
        den += d * (1.0 - (i - 1) / n) * DT
    return num / den


def life_target_pillars(life: float, grid: list[int]) -> list[tuple[int, float]]:
    """DF11: the pillar whose life (k + 1) / 2 is the deposit's, or the two that bracket it, w_hi = (L - lo) / (hi - lo)."""
    lives = [((k + 1) / 2.0, k) for k in sorted(grid)]
    for lv, k in lives:
        if lv == life:
            return [(k, 1.0)]
    for (lo, klo), (hi, khi) in zip(lives, lives[1:]):
        if lo < life < hi:
            w = (life - lo) / (hi - lo)
            return [(klo, 1.0 - w), (khi, w)]
    raise ValueError(f"a life of {life} months is outside the pillar grid {grid}")


def credit(beta: float, life: float, grid: list[int], df_rf, df_all) -> dict:
    """DF12: beta overnight, (1 - beta) on the life-target pillars; liquidity: the whole balance at the premium of the life."""
    tranches = []
    if beta > 0:
        tranches.append({"kind": "overnight", "months": 1, "weight": beta, "rate": bullet_par(1, df_rf)})
    for k, w in life_target_pillars(life, grid):
        tranches.append({"kind": "pillar", "months": k, "weight": (1.0 - beta) * w, "rate": bullet_par(k, df_rf)})
    rate = 0.0
    for x in tranches:
        rate += x["weight"] * x["rate"]
    prem = bullet_par(life, df_all) - bullet_par(life, df_rf)
    return {"tranches": tranches, "rateCredit": rate, "liquidityCredit": prem, "totalCredit": rate + prem, "premium": prem}

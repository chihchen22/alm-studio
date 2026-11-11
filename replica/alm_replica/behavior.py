"""Behavior models: mortgages that prepay, deposits that decay and reprice, and the CD
cohort book with early withdrawal. Each is written from its published description
(DEFINITIONS rows P*, D*, B* and CD*).
"""
from __future__ import annotations

import math

from .curve import RatePath, interp_flat, plain_sum
from .schedules import Row, level_payment


# --- Mortgage prepayment ---------------------------------------------------------------

def four_factor_cpr(p: dict, note_rate: float, age0: int, mortgage_rates: list[float]) -> list[float]:
    """Annual CPR (decimal) for months 1..n: refinance S-curve x seasoning x seasonality x burnout."""
    out = []
    cum_itm = 0.0
    for m, mr in enumerate(mortgage_rates, start=1):
        incentive_bp = (note_rate - mr) * 1e4
        x = -p["steepness"] * (incentive_bp - p["inflection"]) / 100.0
        # Past exp's range the S-curve term is exactly 0, its limit (a flat-CPR parameter set puts the midpoint there).
        refi = p["minCpr"] + ((p["maxCpr"] - p["minCpr"]) / (1.0 + math.exp(x)) if x < 700.0 else 0.0)
        age = age0 + m
        seasoning = min(1.0, age / p["seasoningRamp"])
        seasonality = 1.0 - (p["seasonalityAmp"] / 100.0) * math.cos(2 * math.pi * (age - 1) / 12.0)
        cum_itm += max(0.0, note_rate - mr)
        burnout = math.exp(-p["burnoutDecay"] * cum_itm)
        cpr = refi * seasoning * seasonality * burnout
        if not 0.0 <= cpr <= 100.0:
            raise ValueError(f"a CPR of {cpr} percent is outside 0 to 100, which the replica does not model")
        out.append(cpr / 100.0)
    return out


def mortgage(t: dict, path: RatePath) -> list[Row]:
    """A level-pay pool: scheduled principal on the remaining term at the note rate, then prepayment on the rest."""
    p = t["cprParams"]
    n = t["maturityMonths"]
    spread = (p["secSpread"] + p["primSpread"]) / 1e4
    mrates = [path.forward_rate_at(m - 1, 10.0) + spread for m in range(1, n + 1)]
    cprs = four_factor_cpr(p, t["noteRate"], t.get("ageMonths", 0), mrates)
    r = t["noteRate"] / 12.0
    bal = t["notional"]
    rows: list[Row] = []
    for m in range(1, n + 1):
        if bal <= 0:
            break
        interest = bal * r
        sched = level_payment(bal, r, n - m + 1) - interest
        sched = min(sched, bal)
        smm = 1.0 - (1.0 - cprs[m - 1]) ** (1.0 / 12.0)
        prepay = (bal - sched) * smm
        principal = sched + prepay
        rows.append(Row(bal, principal, interest, t["noteRate"]))
        bal -= principal
    return rows


def constant_cpr_loan(notional: float, coupon: float, months: int, annual_cpr: float) -> list[Row]:
    """A level-pay fixed loan prepaying at a constant CPR from month 1 (DEFINITIONS P8): scheduled principal on the
    remaining term, then the monthly mortality on what is left; the payment re-amortises on the surviving balance."""
    c = coupon / 12.0
    smm = 1.0 - (1.0 - annual_cpr) ** (1.0 / 12.0)
    bal = notional
    rows: list[Row] = []
    for m in range(1, months + 1):
        if bal <= 0:
            break
        n = months - m + 1
        interest = bal * c
        sched = bal * c / ((1.0 + c) ** n - 1.0)
        prepaid = smm * (bal - sched)
        principal = sched + prepaid
        rows.append(Row(bal, principal, interest, coupon))
        bal -= principal
    return rows


# --- Non-maturity deposits ------------------------------------------------------------

def _logistic(lo: float, hi: float, k: float, x: float, mid: float) -> float:
    return lo + (hi - lo) / (1.0 + math.exp(-k * (x - mid)))


def _bucket_g(prm: dict) -> list[tuple[float, float]]:
    s = prm["sens"]
    total = plain_sum(b["share"] for b in prm["buckets"])
    out = []
    for b in prm["buckets"]:
        g = s["gMin"] + (s["gMax"] - s["gMin"]) / (1.0 + math.exp(-s["kappaB"] * (math.log(b["repBalance"]) - math.log(s["bStar"]))))
        out.append((b["share"] / total, g))
    return out


def deposit(t: dict, path: RatePath, history_pct: list[float], ib: bool) -> list[Row]:
    """An nmd (static rate) or nmd-b (S-curve beta) deposit decaying by account-size bucket."""
    prm = t["nmdParams"]
    n = t["maturityMonths"]
    buckets = _bucket_g(prm)
    bals = [t["notional"] * sh for sh, _ in buckets]
    path_pct = [path.rate_at(k) * 100.0 for k in range(n)]
    series = list(history_pct) + path_pct
    h0 = len(history_pct)
    P = prm["maPeriod"]
    cum = 0.0
    d_prev = 0.0
    rows: list[Row] = []
    for m in range(1, n + 1):
        k = m - 1
        r = path_pct[k]
        if ib:
            sc = t["sCurve"]
            beta = _logistic(sc["betaMin"], sc["betaMax"], sc["k"], r, sc["m"])
            target = beta * r
            d = target if m == 1 else d_prev + sc["lambda"] * (target - d_prev)
            d_prev = d
            dep_rate = d / 100.0
            driver = r - d
        else:
            dep_rate = t.get("depositRate", 0.0)
            driver = r
        base = _logistic(prm["maxRateGrowth"], prm["maxRateDecay"], prm["logisticK"], driver, prm["logisticMidpoint"])
        window = series[h0 + k - P: h0 + k]
        ma = plain_sum(window) / P
        amp = 1.0 + prm["regimeAlpha"] * max(0.0, r - ma)
        burn = math.exp(-prm["burnoutLambda"] * cum)
        closure = (prm["closureSteady"] + (prm["closureInitial"] - prm["closureSteady"]) * math.exp(-k / prm["closureTauMonths"])) / 100.0
        total_bal = plain_sum(bals)
        principal = 0.0
        for i, (_, g) in enumerate(buckets):
            inc = max(0.0, base * amp * burn * g)
            dec = 1.0 - (1.0 - closure) * (1.0 - inc / 100.0)
            out = bals[i] if m == n else bals[i] * dec
            principal += out
            bals[i] -= out
        rows.append(Row(total_bal, principal, total_bal * dep_rate / 12.0, dep_rate))
        cum += max(0.0, base)
    return rows


# --- The CD cohort book (run-off) --------------------------------------------------------

def _expit(x: float, clip: float) -> float:
    x = max(-clip, min(clip, x))
    return 1.0 / (1.0 + math.exp(-x))


def _term_bucket(term: int, buckets: dict) -> str:
    for name, (lo, hi) in buckets.items():
        if lo <= term <= hi:
            return name
    raise ValueError(f"no term bucket for {term} months")


def cd_book(t: dict, cp: dict, grid: tuple) -> list[Row]:
    """Run-off walk of a cd cohort book: early withdrawal off maturity, the survivor exits at maturity."""
    return cd_walk(t, cp, grid)[0]


def cd_walk(t: dict, cp: dict, grid: tuple) -> tuple[list[Row], list[float], list[float]]:
    """The walk's rows, and each month's principal split into contractual maturities and early withdrawals (L7)."""
    gt, gz, gtlp = grid
    scale = cp["walkScale"]
    hz, st, sv = cp["hazard"], cp["standardization"], cp["severity"]
    clip = cp["logitClip"]
    cohorts = [
        {"term": c["termMonths"], "mtm": c["monthsToMaturity"], "bal": c["balance"] * scale, "rate": c["contractRate"]}
        for c in t["cohorts"]
    ]
    horizon = max(c["mtm"] for c in cohorts)
    rows: list[Row] = []
    maturities: list[float] = []
    earlies: list[float] = []
    for w in range(1, horizon + 1):
        live = [c for c in cohorts if c["bal"] > 0]
        opening = plain_sum(c["bal"] for c in live)
        coupon = plain_sum(c["bal"] * c["rate"] / 12.0 for c in live)
        off = [c for c in live if w < c["mtm"]]
        lnb = [math.log(max(c["bal"], 1.0)) for c in off]
        if len(lnb) > 1:
            mean = plain_sum(lnb) / len(lnb)
            sd = math.sqrt(plain_sum((x - mean) ** 2 for x in lnb) / len(lnb))
            if sd == 0:
                sd = 1.0
        else:
            mean, sd = (lnb[0] if lnb else 0.0), 1.0
        early = 0.0
        for c, x in zip(off, lnb):
            ttm = max(1, c["mtm"] - w + 1)
            tau = ttm / 12.0
            mkt = interp_flat(tau, gt, gz) + interp_flat(tau, gt, gtlp)
            m = mkt - c["rate"]
            h = _expit(hz["const"] + hz["b1Moneyness"] * m
                       + hz["bLogTtmStd"] * (math.log(ttm) - st["lnTtmMean"]) / st["lnTtmStd"]
                       + hz["bLogBalStd"] * (math.log(max(c["bal"], 1.0)) - st["lnBalMean"]) / st["lnBalStd"], clip)
            tb = sv["tbMedium"] if _term_bucket(c["term"], cp["termBuckets"]) == "MEDIUM" else sv["tbShort"]
            pfull = _expit(tb + sv["betaMoneyness"] * m + sv["betaLogBal"] * (x - mean) / sd, clip)
            pi = min(1.0, h * (pfull + (1.0 - pfull) * sv["eSevPartial"]))
            out = c["bal"] * pi
            early += out
            c["bal"] -= out
        mature = 0.0
        for c in live:
            if c["mtm"] == w:
                mature += c["bal"]
                c["bal"] = 0.0
        # A cohort left below the minimum live balance leaves the book with no cash flow (method note M7).
        for c in live:
            if 0 < c["bal"] < cp["minLiveBalance"]:
                c["bal"] = 0.0
        rows.append(Row(opening, early + mature, coupon, coupon * 12.0 / opening if opening else 0.0))
        maturities.append(mature)
        earlies.append(early)
    return rows, maturities, earlies

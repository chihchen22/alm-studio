"""The risk-free zero curve, its parallel shocks, and the rate path read off it.

Written from the curve's published description (replica/DEFINITIONS.md, rows C1 to C12):

- every par quote is a row at a whole-month tenor; the quote type does not matter;
- semi-annual compounding, ACT/365: a node under six months is a pure discount
  bond quoted bond-equivalent, the six-month node a par bond with one coupon, a
  node of a year or more a semi-annual par bond;
- discount factors are interpolated log-linearly between nodes, flat in zero rate
  outside them;
- the built curve is the interpolator read at every whole month, and between
  months a zero rate is linear between its two monthly neighbours;
- zero rates are continuously compounded: DF(t) = exp(-z(t) t);
- a parallel shock adds the shock to every monthly zero rate.
"""
from __future__ import annotations

import bisect
import math
from dataclasses import dataclass
from typing import Callable, Sequence

MONTH = 1.0 / 12.0


def plain_sum(xs) -> float:
    """Left-to-right sum of floats, one addition at a time (Python's own sum() compensates on 3.12)."""
    s = 0.0
    for x in xs:
        s += float(x)
    return s


def _bisect_root(f: Callable[[float], float], lo: float, hi: float) -> float:
    """A root of a monotone f on [lo, hi] by bisection then secant polish, to machine precision."""
    flo, fhi = f(lo), f(hi)
    if flo == 0.0:
        return lo
    if fhi == 0.0:
        return hi
    if (flo > 0) == (fhi > 0):
        raise ValueError("root not bracketed")
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        fm = f(mid)
        if fm == 0.0 or hi - lo < 1e-17:
            return mid
        if (fm > 0) == (flo > 0):
            lo, flo = mid, fm
        else:
            hi, fhi = mid, fm
    return 0.5 * (lo + hi)


class LogLinearDf:
    """Log-linear interpolation of discount factors over nodes (t_i, z_i), flat zero rate outside."""

    def __init__(self, t: Sequence[float], z: Sequence[float]):
        self.t = list(t)
        self.z = list(z)

    def zero(self, s: float) -> float:
        t, z = self.t, self.z
        if s <= t[0]:
            return z[0]
        if s >= t[-1]:
            return z[-1]
        i = bisect.bisect_right(t, s) - 1
        if t[i] == s:
            return z[i]
        w = (s - t[i]) / (t[i + 1] - t[i])
        ln = -(z[i] * t[i]) * (1 - w) - (z[i + 1] * t[i + 1]) * w
        return -ln / s

    def df(self, s: float) -> float:
        if s <= 0:
            return 1.0
        return math.exp(-self.zero(s) * s)


def bootstrap_nodes(quotes: Sequence[tuple[int, float]]) -> tuple[list[float], list[float]]:
    """Solve the quote nodes' continuously compounded zero rates, shortest first.

    quotes: (tenorMonths, par rate) pairs, ascending.
    """
    ts: list[float] = []
    zs: list[float] = []
    for months, r in quotes:
        t = months / 12.0
        if t < 0.5:
            df = (1.0 + r / 2.0) ** (-2.0 * t)
            ts.append(t)
            zs.append(-math.log(df) / t)
            continue
        if t < 1.0:
            df = 1.0 / (1.0 + r / 2.0)
            ts.append(t)
            zs.append(-math.log(df) / t)
            continue
        n = int(round(2 * t))
        coupon_dates = [k / 2.0 for k in range(1, n + 1)]

        def residual(zc: float) -> float:
            interp = LogLinearDf(ts + [t], zs + [zc])
            pv = plain_sum(interp.df(s) for s in coupon_dates)
            return (1.0 - interp.df(t)) - (r / 2.0) * pv

        zc = _bisect_root(residual, -0.20, 1.00)
        ts.append(t)
        zs.append(zc)
    return ts, zs


@dataclass
class ZeroCurve:
    """A zero curve on monthly nodes, linear in zero rate between them, flat outside."""

    t: list[float]
    z: list[float]

    def zero(self, s: float) -> float:
        t, z = self.t, self.z
        if not t:
            return 0.0
        if s <= t[0]:
            return z[0]
        if s >= t[-1]:
            return z[-1]
        k = bisect.bisect_left(t, s)
        i = k - 1
        w = (s - t[i]) / (t[k] - t[i])
        return z[i] * (1 - w) + z[k] * w

    def df(self, s: float) -> float:
        if s <= 0:
            return 1.0
        return math.exp(-self.zero(s) * s)

    def shifted(self, bp: float) -> "ZeroCurve":
        return ZeroCurve(list(self.t), [x + bp / 1e4 for x in self.z])

    # Quoted forwards on the semi-annual bond convention.
    def simple_forward(self, t1: float, t2: float) -> float:
        return (self.df(t1) / self.df(t2) - 1.0) / (t2 - t1)

    def forward_par(self, t1: float, t2: float) -> float:
        return forward_par_from_df(self.df, t1, t2)


def forward_par_from_df(df: Callable[[float], float], t1: float, t2: float) -> float:
    """Forward par Treasury yield over [t1, t2] (semi-annual bond convention), from any discount function."""
    tau = t2 - t1
    p1, p2 = df(t1), df(t2)
    if tau < 0.5 - 1e-9:
        return 2.0 * ((p1 / p2) ** (1.0 / (2.0 * tau)) - 1.0)
    if tau < 1.0 - 1e-9:
        return 2.0 * (p1 / p2 - 1.0)
    n2 = int(round(2 * tau))
    annuity = plain_sum(0.5 * df(t1 + k / 2.0) for k in range(1, n2 + 1))
    return (p1 - p2) / annuity


def build_base_curve(market: dict, horizon_months: int = 360) -> ZeroCurve:
    """The platform default curve of a market snapshot: monthly nodes off the log-linear bootstrap."""
    quotes = []
    for q in market["curve_rfr"]["instruments"]:
        months = int(round(q["t_years"] * 12))
        if months >= 1:
            quotes.append((months, q["rate"]))
    quotes.sort()
    ts, zs = bootstrap_nodes(quotes)
    interp = LogLinearDf(ts, zs)
    last = quotes[-1][0]
    mt = [k / 12.0 for k in range(1, last + 1)]
    mz = [interp.zero(s) for s in mt]
    return ZeroCurve(mt, mz)


class RatePath:
    """The deterministic monthly path of a curve: step k sits at time k / 12."""

    def __init__(self, curve: ZeroCurve, n_steps: int):
        self.curve = curve
        self.n_steps = n_steps

    def rate_at(self, step: int) -> float:
        t = step * MONTH
        return self.curve.simple_forward(t, t + MONTH)

    def forward_rate_at(self, step: int, tenor_years: float) -> float:
        t = step * MONTH
        return self.curve.forward_par(t, t + tenor_years)


class TlpCurve:
    """The term liquidity premium: a continuously compounded zero spread, linear between nodes, flat outside."""

    def __init__(self, nodes: Sequence[dict]):
        pairs = sorted((float(n["t_years"]), float(n["spread"])) for n in nodes)
        self.t = [p[0] for p in pairs]
        self.s = [p[1] for p in pairs]

    def at(self, x: float) -> float:
        t, s = self.t, self.s
        if x <= t[0]:
            return s[0]
        if x >= t[-1]:
            return s[-1]
        k = bisect.bisect_left(t, x)
        if t[k] == x:
            return s[k]
        i = k - 1
        w = (x - t[i]) / (t[k] - t[i])
        return s[i] + w * (s[k] - s[i])


def bootstrap_linear_zero(market: dict) -> ZeroCurve:
    """The curve-default-1 construction: the quote nodes at their own tenors, linear in zero rate between them.

    Same semi-annual treatment as bootstrap_nodes; the coupon-date discount factors read the
    linear-in-zero interpolator over the nodes solved so far plus the candidate.
    """
    ts: list[float] = []
    zs: list[float] = []
    for q in sorted(market["curve_rfr"]["instruments"], key=lambda q: q["t_years"]):
        t, r = float(q["t_years"]), float(q["rate"])
        if t < 0.5:
            ts.append(t)
            zs.append(2.0 * math.log(1.0 + r / 2.0))
            continue
        if t < 1.0:
            ts.append(t)
            zs.append(math.log(1.0 + r / 2.0) / t)
            continue
        n = int(round(2 * t))
        dates = [k / 2.0 for k in range(1, n + 1)]

        def residual(zc: float) -> float:
            c = ZeroCurve(ts + [t], zs + [zc])
            return (1.0 - c.df(t)) - (r / 2.0) * plain_sum(c.df(s) for s in dates)

        zs.append(_bisect_root(residual, -0.20, 1.00))
        ts.append(t)
    return ZeroCurve(ts, zs)


def lab_grid(market: dict, months: int = 240) -> tuple[list[float], list[float], list[float]]:
    """The CD walk's own curve: the default-1 zero curve and the TLP read at every month k / 12, k = 1..months."""
    c = bootstrap_linear_zero(market)
    tlp = TlpCurve(market["tlp_nodes"])
    t = [k / 12.0 for k in range(1, months + 1)]
    return t, [c.zero(x) for x in t], [tlp.at(x) for x in t]


def cd_path_grid(path, months: int, tlp: "TlpCurve") -> tuple[list[float], list[float], list[float]]:
    """The corrected-v1 CD walk's curve (ADR-062; DEFINITIONS row K2): at t_k = k / 12, k = 1..months, the zero rate
    z_k = (1 / t_k) sum over j < k of ln(1 + r_j dt), r_j the path's one-month accrual rate at step j, dt = 1 / 12,
    and the TLP at t_k held static. A path shorter than `months` steps is refused."""
    if path.n_steps < months:
        raise ValueError(f"the corrected CD walk needs a path of at least {months} months; this one has {path.n_steps}")
    t, z, s = [], [], []
    acc = 0.0
    for k in range(1, months + 1):
        acc += math.log(1.0 + path.rate_at(k - 1) * MONTH)
        tk = k / 12.0  # the walk reads tau = months to maturity / 12, so every read lands on a node
        t.append(tk)
        z.append(acc / tk)
        s.append(tlp.at(tk))
    return t, z, s


def interp_flat(x: float, xs: Sequence[float], ys: Sequence[float]) -> float:
    """Linear interpolation with flat ends (numpy interp semantics)."""
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    k = bisect.bisect_right(xs, x)
    i = k - 1
    if xs[i] == x:
        return ys[i]
    return ys[i] + (x - xs[i]) * (ys[k] - ys[i]) / (xs[k] - xs[i])


def custom_shift_bp(t: float, knots: Sequence[dict]) -> float:
    """A custom shock's shift at tenor t, bp: linear between knots, flat outside them."""
    xs = [float(k["tenorYears"]) for k in knots]
    ys = [float(k["shockBp"]) for k in knots]
    return interp_flat(t, xs, ys)


def shocked_curve(base: ZeroCurve, spec) -> ZeroCurve:
    """The scenario's curve: a parallel shift (an int of bp, or a parallel rateSpec), or a custom knot vector added node by node."""
    if isinstance(spec, (int, float)):
        return base.shifted(spec) if spec else base
    kind = spec["kind"]
    if kind == "base":
        return base
    if kind == "parallel":
        return base.shifted(spec["shockBp"])
    if kind == "custom":
        return ZeroCurve(list(base.t), [z + custom_shift_bp(t, spec["shocks"]) / 1e4 for t, z in zip(base.t, base.z)])
    raise ValueError(f"rate spec {kind} is not in the replica")

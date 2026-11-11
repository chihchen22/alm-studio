"""Contractual cash-flow schedules: fixed and floating loans, the swap, the undrawn lines
and the balances held at book.

Every schedule is a list of monthly rows for months 1, 2, ...: the balance at the
start of the month, the principal repaid in it, the interest paid in it and the
rate applied. Month m lands in bucket m - 1 of the 360-month grid (DEFINITIONS
rows G1 and G2). Principal is positive when it is repaid; a draw is negative.
"""
from __future__ import annotations

from dataclasses import dataclass

from .curve import RatePath


@dataclass
class Row:
    balance: float
    principal: float
    interest: float
    rate: float


def level_payment(balance: float, monthly_rate: float, n: int) -> float:
    """The constant payment that retires `balance` in n months at `monthly_rate`."""
    if n <= 0:
        return balance
    if monthly_rate == 0:
        return balance / n
    return balance * monthly_rate / (1.0 - (1.0 + monthly_rate) ** (-n))


def fixed_loan(notional: float, coupon: float, months: int, amort: str) -> list[Row]:
    rows: list[Row] = []
    r = coupon / 12.0
    bal = notional
    if amort == "bullet":
        for m in range(1, months + 1):
            rows.append(Row(bal, notional if m == months else 0.0, bal * r, coupon))
        return rows
    pmt = level_payment(notional, r, months)
    for m in range(1, months + 1):
        interest = bal * r
        principal = pmt - interest
        if m == months or principal > bal:
            principal = bal
        rows.append(Row(bal, principal, interest, coupon))
        bal -= principal
        if bal <= 0:
            break
    return rows


def floating_loan(notional: float, margin: float, months: int, amort: str, reset_months: int, path: RatePath) -> list[Row]:
    """A one-month-index floater: the coupon resets on months 1, 1 + R, ... to the path rate plus the margin."""
    rows: list[Row] = []
    bal = notional
    coupon = 0.0
    pmt = 0.0
    for m in range(1, months + 1):
        if (m - 1) % reset_months == 0:
            coupon = path.rate_at(m - 1) + margin
            if amort != "bullet":
                pmt = level_payment(bal, coupon / 12.0, months - m + 1)
        interest = bal * coupon / 12.0
        if amort == "bullet":
            principal = notional if m == months else 0.0
        else:
            principal = pmt - interest
            if m == months or principal > bal:
                principal = bal
        rows.append(Row(bal, principal, interest, coupon))
        bal -= principal
        if bal <= 0:
            break
    return rows


def non_rate_sensitive(notional: float, horizon: int) -> list[Row]:
    """A balance held at book: constant, no interest, no principal."""
    return [Row(notional, 0.0, 0.0, 0.0) for _ in range(horizon)]


def swap(t: dict, path: RatePath) -> list[Row]:
    """A pay-fixed (or receive-fixed) swap: two bullet legs on one notional, signed receive +, pay -.

    The row is the net of the fixed leg then the floating leg, added in that order.
    """
    n, N = t["maturityMonths"], t["notional"]
    sf = -1.0 if t["direction"] == "pay-fixed" else 1.0
    rows = []
    for m in range(1, n + 1):
        fix_i = sf * (N * t["fixedRate"] / 12.0)
        flo_i = -sf * (N * (path.rate_at(m - 1) + 0.0) / 12.0)
        fix_p = sf * (N if m == n else 0.0)
        flo_p = -sf * (N if m == n else 0.0)
        rows.append(Row(0.0 + sf * N + (-sf * N), 0.0 + fix_p + flo_p, 0.0 + fix_i + flo_i, 0.0))
    return rows


def commitment(t: dict) -> list[Row]:
    """An undrawn line: each month draws a fraction of what is still undrawn; nothing is booked."""
    d = t["draw"]
    undrawn = t["notional"]
    rows = []
    for m in range(1, t["maturityMonths"] + 1):
        rate = d["rampRates"][m - 1] if m <= len(d["rampRates"]) else d["steadyRate"]
        draw = undrawn * rate
        if draw == 0:
            rows.append(Row(0.0, 0.0, 0.0, 0.0))  # a month with no draw moves nothing
            continue
        rows.append(Row(undrawn, -draw, 0.0, 0.0))
        undrawn -= draw
    return rows

"""The six standardized interest rate shocks, computed by the replica from the published formula (method note M11).

The standard (the Basel IRRBB standard, SRP31, as recalibrated in July 2024) states the shocks for one currency
as three magnitudes and a decay function of tenor t in years:

    S(t) = exp(-t / 4)
    parallel   +/- P             P = 200 bp (USD)
    short rate +/- R S(t)        R = 300 bp
    long rate      L (1 - S(t))  L = 225 bp
    steepener  -0.65 |short| + 0.9 |long|
    flattener  +0.8 |short| - 0.6 |long|

The magnitudes and weights are the standard's stated inputs; the replica types them here from the formula as the
standard writes it, never from engine code. The shocks are applied at the market snapshot's curve node tenors
(the eleven `curve_rfr` quote tenors), linear between knots and flat beyond (DEFINITIONS row X3).
"""
from __future__ import annotations

import math

USD_PARALLEL_BP = 200.0
USD_SHORT_BP = 300.0
USD_LONG_BP = 225.0
DECAY_YEARS = 4.0
STEEPENER = (-0.65, 0.9)
FLATTENER = (0.8, -0.6)

# The six shocks in the order the demo lists them; the ids are the setup's names for them.
SHOCK_IDS = ("SRP-PUP", "SRP-PDN", "SRP-SUP", "SRP-SDN", "SRP-STEEP", "SRP-FLAT")


def decay(t: float) -> float:
    return math.exp(-t / DECAY_YEARS)


def shock_bp(shock_id: str, t: float) -> float:
    short = USD_SHORT_BP * decay(t)
    long_ = USD_LONG_BP * (1.0 - decay(t))
    if shock_id == "SRP-PUP":
        return USD_PARALLEL_BP
    if shock_id == "SRP-PDN":
        return -USD_PARALLEL_BP
    if shock_id == "SRP-SUP":
        return short
    if shock_id == "SRP-SDN":
        return -short
    if shock_id == "SRP-STEEP":
        return STEEPENER[0] * short + STEEPENER[1] * long_
    if shock_id == "SRP-FLAT":
        return FLATTENER[0] * short + FLATTENER[1] * long_
    raise ValueError(f"{shock_id} is not one of the six standardized shocks")


def node_tenors(market: dict) -> list[float]:
    return sorted(float(q["t_years"]) for q in market["curve_rfr"]["instruments"])


def six_shocks(market: dict) -> dict:
    """Shock id -> a custom tenor-knot rate spec at the curve node tenors."""
    ts = node_tenors(market)
    return {sid: {"kind": "custom", "shocks": [{"tenorYears": t, "shockBp": shock_bp(sid, t)} for t in ts]} for sid in SHOCK_IDS}


def check_against_setup(own: dict, setup_spec: dict, shock_id: str, tol_bp: float = 1e-12) -> float:
    """Hold the replica's vector against the one the seeded setup carries; return the largest gap in bp, raise past tol."""
    a, b = own["shocks"], setup_spec["shocks"]
    if setup_spec.get("kind") != "custom" or len(a) != len(b):
        raise ValueError(f"{shock_id}: the setup's vector is not {len(a)} custom knots")
    worst = 0.0
    for x, y in zip(a, b):
        if float(x["tenorYears"]) != float(y["tenorYears"]):
            raise ValueError(f"{shock_id}: knot tenor {y['tenorYears']} is not the node tenor {x['tenorYears']}")
        worst = max(worst, abs(float(x["shockBp"]) - float(y["shockBp"])))
    if worst > tol_bp:
        raise ValueError(f"{shock_id}: the setup's vector is {worst} bp from the formula, past {tol_bp} bp")
    return worst

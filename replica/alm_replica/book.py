"""The bank, its scenarios and the run-off projection of every position.

Inputs, shared with the engine as files and never as code: the bank file, the finished
analysis's assumption set, the 2026-03-31 market snapshot, the SOFR history and the CD
illustrative parameters (replica/inputs/).
"""
from __future__ import annotations

import copy
import json
import os
from dataclasses import dataclass, field

import numpy as np

from . import behavior, depositforms, schedules
from .convention import BOOK, CORRECTED_V1, CORRECTED_V1_CD_MIN_LIVE_BALANCE, resolve as resolve_convention
from .curve import RatePath, TlpCurve, ZeroCurve, build_base_curve, cd_path_grid, lab_grid, shocked_curve

HORIZON = 360


@dataclass(frozen=True)
class Subject:
    """One book the replica ties out: its input files, where its bindings sit, and its scenarios (id, parallel bp)."""

    id: str
    label: str
    bank: tuple
    bindings: tuple
    bindings_path: tuple
    scenarios: tuple
    convention: str = BOOK


SHARED_FILES = {
    "market": ("packages", "kernel", "public", "market_public.json"),
    "sofr": ("examples", "sofr-monthly-v1.json"),
    "cdParams": ("replica", "inputs", "cd-illustrative-v3.json"),
}

# Quillfield Bank: the standard deterministic grid its setup runs, base and the parallel shocks.
QUILLFIELD = Subject(
    id="quillfield-v1",
    label="Quillfield Bank, deterministic static run-off, written by the Python replica (replica/)",
    bank=("examples", "mid-size-bank-v1.json"),
    bindings=("examples", "mid-size-bank-v1.analysis.json"),
    bindings_path=("behavior", "bindings"),
    scenarios=(("S0", 0), ("S100", 100), ("S-100", -100), ("S200", 200), ("S-200", -200)),
    convention=CORRECTED_V1,  # the public default the tie-out runs (ADR-062)
)

# The coverage book: the paths Quillfield does not reach, with a deep in-the-money shock for burnout.
COVERAGE = Subject(
    id="coverage-v1",
    label="Coverage book: the behavior paths Quillfield does not reach, written by the Python replica (replica/)",
    bank=("replica", "inputs", "coverage-v1.json"),
    bindings=("replica", "inputs", "coverage-v1.assumptions.json"),
    bindings_path=("bindings",),
    scenarios=(("S0", 0), ("S100", 100), ("S-100", -100), ("S-200", -200), ("S-300", -300)),
    convention=CORRECTED_V1,
)

SUBJECTS = (QUILLFIELD, COVERAGE)


def input_files(subject: Subject) -> dict:
    return {"bank": subject.bank, "bindings": subject.bindings, **SHARED_FILES}


@dataclass
class Inputs:
    bank: dict
    analysis: dict
    market: dict
    sofr: dict
    cd_params: dict
    scenarios: tuple = ()
    regulatory: dict | None = None
    convention: str = BOOK
    nmd_convention: str | None = None
    base: ZeroCurve = field(init=False)
    tlp: TlpCurve = field(init=False)
    cd_grid: tuple = field(init=False)
    history_pct: list = field(init=False)

    def __post_init__(self) -> None:
        self.base = build_base_curve(self.market)
        self.tlp = TlpCurve(self.market["tlp_nodes"])
        self.cd_grid = lab_grid(self.market)
        self.history_pct = warmup_history(self.sofr, self.bank["asOf"])
        self.convention = resolve_convention(self.convention)
        if self.nmd_convention is None and self.regulatory is not None:
            self.nmd_convention = "regulatory"
        if self.nmd_convention in ("regulatory", "shocked-level") and self.regulatory is None:
            raise ValueError("a deposit convention needs the regulatory parameters")


def warmup_history(sofr: dict, as_of: str, cap: int = 600) -> list[float]:
    """The deposit warmup: the monthly history read up to and including the as-of month, the last 600 at most."""
    y0, m0 = (int(x) for x in sofr["firstMonth"].split("-"))
    y1, m1 = (int(x) for x in as_of[:7].split("-"))
    n = (y1 - y0) * 12 + (m1 - m0) + 1
    vals = [float(v) for v in sofr["valuesPct"][:n]]
    if len(vals) < n:
        raise ValueError("the history ends before the as-of month")
    return vals[-cap:]


def load_inputs(root: str, subject: Subject = QUILLFIELD) -> Inputs:
    def rd(parts: tuple) -> dict:
        with open(os.path.join(root, *parts), encoding="utf-8") as f:
            return json.load(f)

    bindings = rd(subject.bindings)
    for key in subject.bindings_path:
        bindings = bindings[key]
    return Inputs(
        bank=rd(subject.bank),
        analysis={"behavior": {"bindings": bindings}},
        market=rd(SHARED_FILES["market"]),
        sofr=rd(SHARED_FILES["sofr"]),
        cd_params=rd(SHARED_FILES["cdParams"]),
        scenarios=subject.scenarios,
        convention=subject.convention,
    )


def effective_terms(inp: Inputs) -> list[dict]:
    """Each position's terms with its family's overlays written over the blocks the terms carry."""
    out = []
    for p in inp.bank["positions"]:
        t = copy.deepcopy(p["terms"])
        for b in inp.analysis["behavior"]["bindings"]:
            if b["familyId"] != p["familyId"]:
                continue
            ov = b["overlay"]
            if ov["kind"] == "prepay" and ov.get("model") == "constant-cpr":
                # A constant CPR on a level-pay fixed loan rides on the terms as the prepay group (DEFINITIONS P8).
                if t["type"] != "fixed-loan" or t.get("amortType") != "level-pay":
                    raise ValueError(f"{p['id']}: a constant CPR applies to a level-pay fixed loan only")
                t["prepay"] = {"annualCpr": ov["annualCpr"], **({"stressAnnualCpr": ov["stressAnnualCpr"]} if "stressAnnualCpr" in ov else {})}
            elif ov["kind"] == "prepay":
                t["cprParams"] = copy.deepcopy(ov["params"])
            elif ov["kind"] == "nmd-decay":
                # The S3c-1 forms ride on the terms beside the decay parameters (DEFINITIONS DF13).
                if "params" in ov:
                    t["nmdParams"] = copy.deepcopy(ov["params"])
                if "componentDecay" in ov:
                    t["componentDecay"] = copy.deepcopy(ov["componentDecay"])
                if "replicatingPortfolio" in ov:
                    t["replicatingPortfolio"] = copy.deepcopy(ov["replicatingPortfolio"])
            elif ov["kind"] == "deposit-beta":
                if "params" in ov:
                    t["sCurve"] = copy.deepcopy(ov["params"])
                if "fullForm" in ov:
                    t["fullBeta"] = copy.deepcopy(ov["fullForm"])
                if "replicatingPortfolio" in ov:
                    t["replicatingPortfolio"] = copy.deepcopy(ov["replicatingPortfolio"])
            else:
                raise ValueError(f"overlay kind {ov['kind']} is not in the replica")
        refuse_unmodelled(t)
        out.append({"id": p["id"], "familyId": p["familyId"], "terms": t})
    return out


def refuse_unmodelled(t: dict) -> None:
    """Refuse a term the replica does not model, rather than project the position without it."""
    pid = t.get("id", "?")
    if t.get("originationOffsetMonths", 0) != 0:
        raise ValueError(f"{pid}: a seasoning offset (originationOffsetMonths) is not in the replica")
    if t["type"] == "swap":
        if t.get("floatMargin", 0) != 0 or t.get("resetFrequencyMonths", 1) != 1:
            raise ValueError(f"{pid}: a swap with a floating margin or a reset other than monthly is not in the replica")
    if t["type"] == "floating-loan" and t.get("rateIndexId") is not None:
        raise ValueError(f"{pid}: a named rate index is not in the replica")
    if "fundingTenorMonths" in t and t["type"] != "floating-loan":
        raise ValueError(f"{pid}: a funding tenor on a {t['type']} is not in the replica")
    if "linearDecay" in t and t["type"] != "nmd":
        raise ValueError(f"{pid}: a straight-line runoff on a {t['type']} is not in the replica")
    if "componentDecay" in t and t["type"] != "nmd":
        raise ValueError(f"{pid}: component decay on a {t['type']} is not in the replica")
    if "fullBeta" in t and t["type"] != "nmd-b":
        raise ValueError(f"{pid}: a full beta form on a {t['type']} is not in the replica")
    for key in ("housing", "depositSlotting"):
        if key in t:
            raise ValueError(f"{pid}: the {key} group is not in the replica")


def project_position(t: dict, path: RatePath, inp: Inputs, shift: float = 0.0) -> list[schedules.Row]:
    """`shift` is the scenario's shift at tenor zero, percent, which the S3c-1 deposit forms read (DEFINITIONS DF1)."""
    typ = t["type"]
    if typ == "fixed-loan" and "prepay" in t:
        return behavior.constant_cpr_loan(t["notional"], t["coupon"], t["maturityMonths"], t["prepay"]["annualCpr"])
    if typ == "fixed-loan":
        return schedules.fixed_loan(t["notional"], t["coupon"], t["maturityMonths"], t["amortType"])
    if typ == "floating-loan":
        return schedules.floating_loan(t["notional"], t["margin"], t["maturityMonths"], t["amortType"], t.get("resetFrequencyMonths", 1), path)
    if typ == "non-rate-sensitive":
        return schedules.non_rate_sensitive(t["notional"], t["maturityMonths"])
    if typ == "swap":
        return schedules.swap(t, path)
    if typ == "commitment":
        return schedules.commitment(t)
    if typ == "mortgage":
        return behavior.mortgage(t, path)
    if typ == "nmd" and t.get("frozen"):
        return schedules.fixed_loan(t["notional"], t["depositRate"], t["maturityMonths"], "bullet")
    if typ == "nmd" and "linearDecay" in t:
        return depositforms.linear_decay_rows(t)
    if typ == "nmd" and "componentDecay" in t:
        return depositforms.component_rows(t, shift)
    if typ == "nmd-b" and "fullBeta" in t:
        if "slotting" not in t:
            return depositforms.unslotted_rows(t, shift)
        return depositforms.slotted_rows(t, shift, t["slotting"], inp.regulatory)
    if typ in ("nmd", "nmd-b"):
        return behavior.deposit(t, path, inp.history_pct, typ == "nmd-b")
    if typ == "cd":
        return cd_walk(t, path, inp)[0]
    raise ValueError(f"instrument type {typ} is not in the replica")


def cd_walk(t: dict, path: RatePath, inp: Inputs):
    """The CD book's walk on the run's convention: rows, maturities and early withdrawals by month."""
    if inp.convention == CORRECTED_V1:
        # ADR-062 points 1 to 3: the walk reads the path's curve plus the static TLP, and the $1 minimum.
        longest = max(c["termMonths"] for c in t["cohorts"])
        params = {**inp.cd_params, "minLiveBalance": CORRECTED_V1_CD_MIN_LIVE_BALANCE}
        return behavior.cd_walk(t, params, cd_path_grid(path, longest, inp.tlp))
    return behavior.cd_walk(t, inp.cd_params, inp.cd_grid)


def bucket(rows: list[schedules.Row]) -> dict:
    """Month m lands in bucket m - 1; the grid holds 360 buckets (float64 arrays)."""
    s = {k: np.zeros(HORIZON) for k in ("balance", "principal", "interest")}
    for m, r in enumerate(rows[:HORIZON]):
        s["balance"][m] += r.balance
        s["principal"][m] += r.principal
        s["interest"][m] += r.interest
    return s


def is_base(spec) -> bool:
    return spec == 0 if isinstance(spec, (int, float)) else spec.get("kind") == "base"


def add_into(acc, x) -> np.ndarray:
    """Element-wise sum of two monthly series, positions added in book order."""
    return np.asarray(acc, dtype=np.float64) + np.asarray(x, dtype=np.float64)


def project_all(inp: Inputs) -> dict:
    """Every position under every scenario: the bucketed series, the family sums and the two gap series."""
    from .gaps import liquidity_series, repricing_series

    positions = effective_terms(inp)
    parent_of = None
    if inp.nmd_convention in ("regulatory", "shocked-level"):
        from .regulatory import transform

        # DF7 to DF9: a full-form deposit is marked and stays whole ("frozen" under regulatory, "shocked-level" under
        # shocked-level); every other deposit takes the regulatory split; shocked-level refuses a book with no form.
        marked = 0
        for p in positions:
            if "fullBeta" in p["terms"]:
                p["terms"]["slotting"] = "frozen" if inp.nmd_convention == "regulatory" else "shocked-level"
                marked += 1
        if inp.nmd_convention == "shocked-level" and marked == 0:
            raise ValueError("shocked-level slotting needs a full-form deposit")
        base_spec = next(spec for _, spec in inp.scenarios if is_base(spec))
        positions, parent_of = transform(positions, RatePath(shocked_curve(inp.base, base_spec), HORIZON), inp.regulatory)
    out = {"positions": {}, "families": {}, "repricing": {}, "liquidity": {}, "baseRows": {}, "effective": positions, "parentOf": parent_of, "cdSplit": {}}
    for sid, bp in inp.scenarios:
        curve = shocked_curve(inp.base, bp)
        path = RatePath(curve, HORIZON)
        per_pos, fams, rep, liq = {}, {}, {}, {}
        sh = depositforms.shift_pct(bp)
        for p in positions:
            rows = project_position(p["terms"], path, inp, sh)
            s = bucket(rows)
            per_pos[p["id"]] = s
            fid = p["familyId"]
            f = fams.setdefault(fid, {k: np.zeros(HORIZON) for k in s})
            for k in s:
                f[k] = add_into(f[k], s[k])
            rep[fid] = add_into(rep.get(fid, np.zeros(HORIZON)), repricing_series(p["terms"], rows, path))
            liq[fid] = add_into(liq.get(fid, np.zeros(HORIZON)), liquidity_series(p["terms"], rows))
            if is_base(bp):
                out["baseRows"][p["id"]] = rows
                if p["terms"]["type"] == "cd":
                    _, mat, early = cd_walk(p["terms"], path, inp)
                    out["cdSplit"][p["id"]] = (mat, early)
        out["positions"][sid] = per_pos
        out["families"][sid] = fams
        out["repricing"][sid] = rep
        out["liquidity"][sid] = liq
    return out


def family_sides(bank: dict) -> dict:
    return {f["id"]: (f["side"], f["instrumentType"]) for f in bank["coa"]["families"]}


def family_order(bank: dict) -> list[str]:
    return [f["id"] for f in bank["coa"]["families"]]

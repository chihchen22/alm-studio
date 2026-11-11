"""The example bank's feature demos (Studio slice S3b-2): each seeded setup's own measures, one targets file per demo.

Inputs, shared with the engine as files: the bank (version 1.1), `replica/inputs/feature-demos-v1.json` (the seven seeded
setups and their two assumption sets, as the seed stores them), the market snapshot, the SOFR history and the CD
parameters. Every demo is the bank's static run-off with the SOFR history warmup (DEFINITIONS row X1).
"""
from __future__ import annotations

import hashlib
import json
import os

from . import eve as eve_mod
from . import gaps as gaps_mod
from . import nii as nii_mod
from . import liquidity as liq_mod
from . import ftp as ftp_mod
from . import seg as seg_mod
from . import srp as srp_mod
import math

from .convention import CORRECTED_V1
from .book import HORIZON, SHARED_FILES, Inputs, family_order, family_sides, is_base, project_all
from .curve import RatePath, shocked_curve

BANK = ("examples", "mid-size-bank-v1.json")
DEMOS = ("replica", "inputs", "feature-demos-v1.json")
REGULATORY = ("replica", "inputs", "regulatory-convention-v1.json")
DEMO_IDS = ("seg", "regulatory", "spread-consistent", "six-shocks", "instruments", "constant-prepay", "fixed-ladder")
SCHEMA = "1.0.0"


def _sha(root: str, parts: tuple) -> str:
    with open(os.path.join(root, *parts), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _rd(root: str, parts: tuple) -> dict:
    with open(os.path.join(root, *parts), encoding="utf-8") as f:
        return json.load(f)


def library_spec(ref: str):
    """A regulatory-grid-v1 reference: S0 is the base, S<n> a parallel shift of n bp (DEFINITIONS row X2)."""
    lib, sid = ref.split("#")
    if lib != "regulatory-grid-v1" or not sid.startswith("S"):
        raise ValueError(f"scenario reference {ref} is not in the replica")
    bp = int(sid[1:])
    return sid, ({"kind": "base"} if bp == 0 else {"kind": "parallel", "shockBp": bp})


def demo_scenarios(setup: dict, market: dict) -> list:
    """The setup's scenarios as (id, rate spec). A tenor-knot shock is one of the six standardized shocks: the replica
    computes its vector from the published formula (srp.py, method note M11), holds it against the setup's at 1e-12 bp,
    and runs its own."""
    sc = setup["scenarios"]
    if sc["kind"] == "library":
        return [library_spec(r) for r in sc["refs"]]
    if sc["kind"] == "plan-scenarios":
        own = srp_mod.six_shocks(market)
        out = []
        for i in sc["items"]:
            if "ref" in i:
                out.append(library_spec(i["ref"]))
            elif i["id"] in own:
                srp_mod.check_against_setup(own[i["id"]], i["rateSpec"], i["id"])
                out.append((i["id"], own[i["id"]]))
            else:
                raise ValueError(f"scenario {i['id']} is not a library reference or a standardized shock")
        return out
    raise ValueError(f"scenario kind {sc['kind']} is not in the replica")


def demo_of(root: str, demo_id: str) -> tuple[dict, dict, dict]:
    doc = _rd(root, DEMOS)
    demo = next(d for d in doc["demos"] if d["id"] == demo_id)
    set_id = demo["setIds"][0]
    aset = next(s for s in doc["sets"] if s["id"] == set_id)
    return doc, demo, aset


def demo_inputs(root: str, demo_id: str, bank: dict | None = None) -> tuple[Inputs, dict]:
    _, demo, aset = demo_of(root, demo_id)
    setup = demo["setup"]
    if setup["nmdWarmup"]["kind"] != "history":
        raise ValueError("the replica's demos read the history warmup only")
    market = _rd(root, SHARED_FILES["market"])
    inp = Inputs(
        bank=bank if bank is not None else _rd(root, BANK),
        analysis={"behavior": {"bindings": aset["bindings"]}},
        market=market,
        sofr={**_rd(root, SHARED_FILES["sofr"]), "firstMonth": setup["nmdWarmup"]["series"]["firstMonth"], "valuesPct": setup["nmdWarmup"]["series"]["valuesPct"]},
        cd_params=_rd(root, SHARED_FILES["cdParams"]),
        scenarios=tuple(demo_scenarios(setup, market)),
        regulatory=_rd(root, REGULATORY) if setup.get("nmdConvention") == "regulatory" else None,
        convention=setup.get("modelConvention"),  # absent is the original convention (ADR-062)
    )
    return inp, setup


def _full(xs) -> list[float]:
    """A series written in full, trailing zeros kept: the check holds its length to the engine's (L1)."""
    return [float(x) + 0.0 for x in xs]


def nii_block(inp: Inputs, res: dict, horizons: tuple) -> dict:
    """Run-off NII by scenario: totals per horizon, the monthly net, per family per horizon (DEFINITIONS N1 to N3)."""
    all_ = nii_mod.nii(inp.bank, res["families"], horizons)
    has_deriv = any(f["side"] == "derivative" for f in inp.bank["coa"]["families"])
    out = {}
    for sid, n in all_.items():
        row = {"totalNet": {str(h): n["totalNet"][h] for h in horizons}, "netMonthly": _full(n["netMonthly"])}
        if has_deriv:
            row["derivativesNet"] = {str(h): n["derivativesNet"][h] for h in horizons}
        row["byFamily"] = {fid: {"byHorizon": {str(h): r["byHorizon"][h] for h in horizons}, "netMonthly": _full(r["netMonthly"])} for fid, r in n["byFamily"].items()}
        out[sid] = row
    return out


def cashflow_block(res: dict, families: list | None = None) -> dict:
    return {sid: {fid: {k: _full(v) for k, v in s.items()} for fid, s in fams.items() if families is None or fid in families}
            for sid, fams in res["families"].items()}


def gap_block(inp: Inputs, res: dict) -> dict:
    return {kind: {sid: {"bands": gaps_mod.ladder(inp.bank, res[kind][sid], gaps_mod.BANDS),
                         "monthly": gaps_mod.ladder(inp.bank, res[kind][sid], gaps_mod.monthly_edges())} for sid in res[kind]}
            for kind in ("repricing", "liquidity")}


def instruments_block(inp: Inputs, res: dict, setup: dict) -> dict:
    """The per-position results file (DEFINITIONS rows I1 to I7): one row per position, one entry per scenario."""
    sides = family_sides(inp.bank)
    basis = setup["eve"]["discountBasis"]
    raw = {p["id"]: p for p in inp.bank["positions"]}
    base_sid = next(s for s, spec in inp.scenarios if is_base(spec))
    base_path = RatePath(shocked_curve(inp.base, dict(inp.scenarios)[base_sid]), HORIZON)
    rows = []
    for p in res["effective"]:
        pid, t = p["id"], p["terms"]
        side, typ = sides[p["familyId"]]
        src = raw[pid]
        sign = 1.0 if side in ("asset", "derivative") else -1.0
        spread = 0.0 if t["type"] in ("nmd", "nmd-b") else float(src.get("discountSpreadBp", 0) or 0) / 1e4
        by = []
        for sid, spec in inp.scenarios:
            ser = res["positions"][sid][pid]
            curve = shocked_curve(inp.base, spec)
            if t["type"] == "commitment":
                pv = 0.0
            elif t["type"] == "non-rate-sensitive":
                # Held at book: valued at par, its balance at the cut-off, in every scenario (DEFINITIONS I7), the
                # value the replica's EVE reads for the family (E4).
                pv = float(ser["balance"][0])
            else:
                df_all = eve_mod.discount_function(curve, inp.tlp if basis in ("all-in", "spread-consistent") else None)
                if t["type"] == "swap":
                    df = curve.df
                elif basis == "spread-consistent" and spread != 0.0:
                    df = lambda x, d=df_all, s_=spread: d(x) * math.exp(-s_ * x)
                else:
                    df = df_all
                pv = eve_mod.pv_series(ser, df)
            nii12 = 0.0
            for k in range(12):
                nii12 += sign * ser["interest"][k]
            p12 = 0.0
            for k in range(12):
                p12 += ser["principal"][k]
            by.append({"scenarioId": sid, "pv": pv, "nii12": nii12, "balance12": float(ser["balance"][11]), "principal12": p12})
        base = res["positions"][base_sid][pid]
        num = den = 0.0
        for k in range(HORIZON):
            pr = float(base["principal"][k])
            if t["type"] not in ("commitment", "swap"):
                num += (k + 1) * pr
                den += pr
        rep = gaps_mod.repricing_series(t, res["baseRows"][pid], base_path)
        first = next((k + 1 for k, v in enumerate(rep) if v != 0.0), None)
        row = {"positionId": pid, "familyId": p["familyId"], "coaNodeId": src["coaNodeId"], "side": side, "type": t["type"],
               "notional": t["notional"], "dimensions": src.get("dimensions", {})}
        if "discountSpreadBp" in src:
            row["discountSpreadBp"] = src["discountSpreadBp"]
        if den > 0:
            row["walMonths"] = num / den
        row["firstRepricingMonth"] = first
        row["byScenario"] = by
        rows.append(row)
    return {"discountBasis": basis, "scenarios": [s for s, _ in inp.scenarios], "positions": rows}


def constant_cpr_bindings(inp: Inputs) -> list:
    return [b for b in inp.analysis["behavior"]["bindings"] if b["overlay"]["kind"] == "prepay" and b["overlay"].get("model") == "constant-cpr"]


# --- The engine's own result shapes, so the accept check walks engine and target side by side --------------

def eve_shape(bank: dict, ev: dict, sids: list) -> dict:
    order = family_order(bank)
    rows = []
    for sid in sids:
        e = ev[sid]
        row = {"scenarioId": sid, "pvAssets": e["pvAssets"], "pvLiabilities": e["pvLiabilities"]}
        if "pvDerivatives" in e:
            row["pvDerivatives"] = e["pvDerivatives"]
        row.update({"eve": e["eve"], "deltaEveVsBase": e["deltaEveVsBase"], "deltaEvePct": e["deltaEvePct"] + 0.0,
                    "byFamily": [{"familyId": f, "pv": e["byFamily"][f]} for f in order]})
        rows.append(row)
    return {"byScenario": rows}


def nii_shape(inp: Inputs, res: dict, horizons: tuple, sids: list) -> dict:
    all_ = nii_mod.nii(inp.bank, res["families"], horizons)
    has_deriv = any(f["side"] == "derivative" for f in inp.bank["coa"]["families"])
    rows = []
    for sid in sids:
        n = all_[sid]
        fams = []
        for fid, r in n["byFamily"].items():
            bh = r["byHorizon"]
            fams.append({"familyId": fid, **{f"{k}{h}": bh[h][k] for h in (12, 24) for k in ("interestIncome", "interestExpense", "net")},
                         "byHorizon": {str(h): bh[h] for h in horizons}, "netMonthly": _full(r["netMonthly"])})
        row = {"scenarioId": sid, "byFamily": fams, "totalNet12": n["totalNet"][12], "totalNet24": n["totalNet"][24],
               "totalNetByHorizon": {str(h): n["totalNet"][h] for h in horizons}, "netMonthly": _full(n["netMonthly"])}
        if has_deriv:
            row.update({"derivativesNet12": n["derivativesNet"][12], "derivativesNet24": n["derivativesNet"][24],
                        "derivativesNetByHorizon": {str(h): n["derivativesNet"][h] for h in horizons}})
        rows.append(row)
    return {"horizonsMonths": list(horizons), "byScenario": rows}


def wal_years(series: dict):
    """Principal-weighted average life of the in-horizon runoff, years; None when that principal is not positive (X5)."""
    num = den = 0.0
    for k in range(HORIZON):
        p = float(series["principal"][k])
        num += p * (k + 1) / 12.0
        den += p
    return num / den if den > 0 else None


def cashflows_shape(bank: dict, res: dict, sids: list) -> dict:
    order = family_order(bank)
    out = []
    for sid in sids:
        rows = []
        for f in order:
            if f not in res["families"][sid]:
                continue
            ser = res["families"][sid][f]
            row = {"familyId": f, "series": {k: _full(v) for k, v in ser.items()}}
            w = wal_years(ser)
            if w is not None:
                row["walYears"] = w
            rows.append(row)
        out.append({"scenarioId": sid, "byFamily": rows})
    return {"byScenario": out}


def gap_shape(inp: Inputs, res: dict, sids: list) -> dict:
    def rows(ladder, edges):
        return [{"band": {"label": r["label"], "startMonth": lo, "endMonth": hi}, "assets": r["assets"], "liabilities": r["liabilities"],
                 "gap": r["gap"], "cumulativeGap": r["cumulativeGap"]} for r, (_, lo, hi) in zip(ladder, edges)]
    out = {}
    for kind in ("repricing", "liquidity"):
        out[kind] = [{"scenarioId": sid, "rows": rows(gaps_mod.ladder(inp.bank, res[kind][sid], gaps_mod.BANDS), gaps_mod.BANDS),
                      "userBuckets": {"kind": "monthly", "rows": rows(gaps_mod.ladder(inp.bank, res[kind][sid], gaps_mod.monthly_edges()), gaps_mod.monthly_edges())}}
                     for sid in sids]
    return out


def ftp_shape(inp: Inputs, res: dict, horizons: tuple, base_sid: str) -> dict:
    base_nii = nii_mod.nii(inp.bank, res["families"], horizons)[base_sid]
    f = ftp_mod.ftp(inp.bank, res["effective"], res["baseRows"], inp.base, inp.tlp, RatePath(inp.base, HORIZON),
                    base_nii["totalNet"][12], base_nii["derivativesNet"][12])
    fams = []
    for fid in family_order(inp.bank):
        row = dict(f["byFamily"][fid])
        row["monthly"] = {k: _full(v) for k, v in row["monthly"].items()}
        fams.append({"familyId": fid, **row})
    bridge = {"horizonMonths": 12, **f["nimBridge"]}
    if not any(fam["side"] == "derivative" for fam in inp.bank["coa"]["families"]):
        # A book with no derivative family reports no derivatives line in the bridge, as NII reports none (N3).
        del bridge["derivativesNet12"]
    return {"scenarioId": base_sid, "byFamily": fams, "book": f["book"], "nimBridge": bridge}


def build_demo(root: str, demo_id: str) -> dict:
    inp, setup = demo_inputs(root, demo_id)
    res = project_all(inp)
    shocks = dict(inp.scenarios)
    horizons = tuple(setup["nii"]["reportHorizons"])
    basis = setup["eve"]["discountBasis"]
    sids = [sid for sid, _ in inp.scenarios]
    base_sid = next(sid for sid, spec in inp.scenarios if is_base(spec))
    ev = lambda: eve_shape(inp.bank, eve_mod.eve(inp.bank, res["families"], inp.base, inp.tlp, shocks, basis), sids)
    measures: dict = {}
    if demo_id == "seg":
        if inp.convention != CORRECTED_V1:
            raise ValueError("the replica's SEG vintages read the run's history (corrected-v1); the original convention's read the kernel's own series")
        knobs = setup["seg"]
        walked = seg_mod.compute_seg(inp, res["effective"], RatePath(shocked_curve(inp.base, shocks[base_sid]), HORIZON + 1), knobs)
        blk = seg_mod.fold(inp, walked, knobs)
        blk["uncovered"] = [{"positionId": u} for u in blk["uncovered"]]
        measures["seg"] = {"scenarioId": base_sid, **blk}
    elif demo_id == "spread-consistent":
        measures["eve"] = ev()
    elif demo_id == "six-shocks":
        measures.update({"eve": ev(), "nii": nii_shape(inp, res, horizons, sids), "cashflows": cashflows_shape(inp.bank, res, sids), "gap": gap_shape(inp, res, sids)})
    elif demo_id == "regulatory":
        measures.update({"parentOf": res["parentOf"], "eve": ev(), "nii": nii_shape(inp, res, horizons, sids),
                         "cashflows": cashflows_shape(inp.bank, res, sids), "gap": gap_shape(inp, res, sids), "ftp": ftp_shape(inp, res, horizons, base_sid)})
    elif demo_id == "constant-prepay":
        measures.update({"liquidityStress": liq_mod.stress_ladder(inp.bank, res["effective"], res["baseRows"], setup["liquidityStress"], res["cdSplit"]),
                         "cashflows": cashflows_shape(inp.bank, res, sids), "eve": ev(), "nii": nii_shape(inp, res, horizons, sids)})
    elif demo_id == "instruments":
        measures["instruments"] = {"horizonMonths": HORIZON, "asOf": inp.bank["asOf"], **instruments_block(inp, res, setup)}
    elif demo_id == "fixed-ladder":
        lad = gaps_mod.fixed_rate_ladder(inp.bank, res["effective"], res["baseRows"])
        measures["gap"] = {"fixedRate": {"scenarioId": base_sid, "bands": [b for b, _, _ in gaps_mod.BANDS], "rows": lad["rows"],
                                         "uncovered": [{"positionId": u} for u in lad["uncovered"]]}}
    else:
        raise ValueError(f"no demo {demo_id}")
    return {
        "schemaVersion": SCHEMA,
        "id": f"demo-{demo_id}-v1",
        "label": f"The {demo_id} feature demo on Quillfield Bank, written by the Python replica (replica/)",
        "demo": demo_id,
        "setupId": setup["id"],
        "inputs": {k: {"path": "/".join(v), "sha256": _sha(root, v)} for k, v in {"bank": BANK, "demos": DEMOS, "regulatory": REGULATORY, **SHARED_FILES}.items()},
        "scenarios": [{"id": s, "rateSpec": spec} for s, spec in inp.scenarios],
        **measures,
    }

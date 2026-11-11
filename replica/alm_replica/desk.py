"""The seven deposit-form demos (six on Quillfield's deposit desk, the funding tenor on Quillfield Bank), one
targets file, `replica/targets/deposit-forms-v1.json`, in the engine's own result shapes (DEFINITIONS DF1 to DF16).

Inputs, shared with the engine as files: the desk (`examples/quillfield-deposit-desk-v1.json`) and the bank,
`replica/inputs/deposit-forms-v1.json` (the seven seeded setups and the desk's five sets, as the seed stores them, plus
Quillfield's illustrative set from the S3b input file), the regulatory parameters, the market, the SOFR history and the
CD parameters.
"""
from __future__ import annotations

import hashlib
import json
import math
import os

from . import depositforms as dfm
from . import eve as eve_mod
from .book import HORIZON, SHARED_FILES, Inputs, family_order, is_base, project_all
from .curve import RatePath, shocked_curve
from .demos import DEMOS, REGULATORY, cashflows_shape, eve_shape, ftp_shape, gap_shape, library_spec, nii_shape

DESK = ("examples", "quillfield-deposit-desk-v1.json")
BANK = ("examples", "mid-size-bank-v1.json")
FORMS = ("replica", "inputs", "deposit-forms-v1.json")
DEMO_IDS = ("desk-linear-decay", "desk-component-decay", "desk-full-beta-frozen", "desk-full-beta-shocked", "desk-credit",
            "desk-scenario-credit", "funding-tenor")
SCHEMA = "1.0.0"


def _rd(root: str, parts: tuple) -> dict:
    with open(os.path.join(root, *parts), encoding="utf-8") as f:
        return json.load(f)


def _sha(root: str, parts: tuple) -> str:
    with open(os.path.join(root, *parts), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def demo_inputs(root: str, demo_id: str) -> tuple[Inputs, dict, dict]:
    doc = _rd(root, FORMS)
    demo = next(d for d in doc["demos"] if d["id"] == demo_id)
    setup = demo["setup"]
    sets = {s["id"]: s for s in doc["sets"]}
    for s in _rd(root, DEMOS)["sets"]:
        sets.setdefault(s["id"], s)
    aset = sets[demo["setIds"][0]]
    if setup["nmdWarmup"]["kind"] != "history" or setup["scenarios"]["kind"] != "library":
        raise ValueError("the replica's deposit-form demos read the history warmup and library scenarios only")
    bank = _rd(root, DESK if demo["bookId"] == "quillfield-deposit-desk-v1" else BANK)
    conv = setup.get("nmdConvention")
    inp = Inputs(
        bank=bank,
        analysis={"behavior": {"bindings": aset["bindings"]}},
        market=_rd(root, SHARED_FILES["market"]),
        sofr={**_rd(root, SHARED_FILES["sofr"]), "firstMonth": setup["nmdWarmup"]["series"]["firstMonth"], "valuesPct": setup["nmdWarmup"]["series"]["valuesPct"]},
        cd_params=_rd(root, SHARED_FILES["cdParams"]),
        scenarios=tuple(library_spec(r) for r in setup["scenarios"]["refs"]),
        regulatory=_rd(root, REGULATORY) if conv in ("regulatory", "shocked-level") else None,
        convention=setup.get("modelConvention"),
        nmd_convention=conv,
    )
    return inp, setup, demo


def component_cashflows(inp: Inputs, res: dict, sids: list) -> dict:
    """The cash flows block; a family holding component decay reads its WAL on the full runoff (DF5)."""
    out = cashflows_shape(inp.bank, res, sids)
    by_fam = {}
    for p in res["effective"]:
        by_fam.setdefault(p["familyId"], []).append(p)
    shocks = dict(inp.scenarios)
    for row in out["byScenario"]:
        sh = dfm.shift_pct(shocks[row["scenarioId"]])
        for f in row["byFamily"]:
            ps = by_fam[f["familyId"]]
            if any("componentDecay" in p["terms"] for p in ps):
                if len(ps) != 1:
                    raise ValueError("a component decay family of more than one position is not in the replica")
                f["walYears"] = dfm.component_life_months(ps[0]["terms"], sh) / 12.0
    return out


def _straight_line_credit(p: dict, inp: Inputs) -> dict:
    """DF14: the straight-line class: life (n + 1) / 2, the deposit's own beta, the stock and the readings."""
    t = p["terms"]
    form = t["replicatingPortfolio"]
    if form.get("construction") != "life-target" or "haircutMonths" in form or "steepener" in form or "life" in form:
        raise ValueError("a straight-line credit other than life-target without haircut or steepener is not in the replica")
    n = t["linearDecay"]["horizonMonths"]
    life = (n + 1) / 2.0
    beta = t.get("beta", 0.0)
    curve = inp.base
    df_rf = curve.df
    df_all = lambda s: curve.df(s) * math.exp(-inp.tlp.at(s) * s) if s > 0 else 1.0
    c = dfm.credit(beta, life, form["pillarGridMonths"], df_rf, df_all)
    N = t["notional"]
    pillars = [x for x in c["tranches"] if x["kind"] == "pillar"]
    M = max([n] + [x["months"] for x in pillars])
    fixed, port, net, liq = [], [], [], []
    for m in range(M + 1):
        run = N * max(0.0, 1.0 - m / n)
        if m == 0:
            fg = pf = N
        else:
            fg = (1.0 - beta) * run
            pf = 0.0
            for x in pillars:
                pf += x["weight"] * N * max(0.0, 1.0 - m / x["months"])
        fixed.append(fg)
        port.append(pf)
        net.append(pf - fg)
        liq.append(run)
    runoff_prem = dfm.runoff_par(n, df_all) - dfm.runoff_par(n, df_rf)
    lo, hi = math.floor(life), math.ceil(life)
    plo = dfm.bullet_par(lo, df_all) - dfm.bullet_par(lo, df_rf)
    if hi == lo:
        bracket = plo
    else:
        phi = dfm.bullet_par(hi, df_all) - dfm.bullet_par(hi, df_rf)
        bracket = plo + (life - lo) * (phi - plo) / (hi - lo)
    return {"positionId": p["id"], "construction": form["construction"], "beta": beta, "runoffMonths": n, "lifeMonths": life,
            "tranches": c["tranches"], "rateCredit": c["rateCredit"], "liquidityCredit": c["liquidityCredit"], "totalCredit": c["totalCredit"],
            "stock": {"liabilityFixedRateGap": fixed, "portfolio": port, "net": net, "liquidityLadder": liq},
            "readings": {"runoffPremium": runoff_prem, "runoffWithinOneBp": abs(runoff_prem - c["liquidityCredit"]) <= 1e-4, "bracketPremium": bracket}}


def _path_credit(p: dict, inp: Inputs) -> dict:
    """DF15, DF16: a credit on the balance path or a capped life, read at every scenario of the run."""
    t = p["terms"]
    form = t["replicatingPortfolio"]
    if form.get("construction") != "life-target" or "beta" in form:
        raise ValueError("a path credit other than life-target on the deposit's own beta is not in the replica")
    life_form = form["life"]
    curve_mode = form.get("scenarioCurve")
    if curve_mode not in (None, "shift"):
        raise ValueError(f"the scenario reading {curve_mode} is not in the replica")
    readings = []
    for sid, spec in inp.scenarios:
        sh = dfm.shift_pct(spec)
        curve = shocked_curve(inp.base, spec) if curve_mode == "shift" else inp.base
        df_rf = curve.df
        df_all = lambda s, c=curve: c.df(s) * math.exp(-inp.tlp.at(s) * s) if s > 0 else 1.0
        if life_form["source"] == "balance-path":
            life = dfm.component_life_months(t, sh)
        elif life_form["source"] == "capped":
            life = float(life_form["months"])
        else:
            raise ValueError(f"life source {life_form['source']} is not in the replica")
        paid = None
        if "fullBeta" in t:
            st = dfm.full_state(t, t["fullBeta"], sh)
            beta = st["betaEff"]
            paid = st["dStar"] / 100.0
        else:
            beta = t.get("beta", 0.0)
        c = dfm.credit(beta, life, form["pillarGridMonths"], df_rf, df_all)
        r = {"scenarioId": sid, "beta": beta, "lifeMonths": life, "tranches": c["tranches"], "rateCredit": c["rateCredit"],
             "liquidityCredit": c["liquidityCredit"], "totalCredit": c["totalCredit"],
             "liquidityLegs": [{"months": life, "weight": 1.0, "premium": c["premium"]}]}
        if paid is not None:
            r["paidRate"] = paid
        readings.append(r)
    base = readings[0]
    top = {"positionId": p["id"], "construction": form["construction"], "lifeSource": life_form["source"]}
    if curve_mode is not None:
        top["scenarioCurve"] = curve_mode
    top.update({k: v for k, v in base.items() if k != "scenarioId"})
    top["byScenario"] = readings
    return top


def credit_shape(inp: Inputs, res: dict) -> dict:
    """The FTP rows of the families that carry a credit: the three rates and the credit object (DF12 to DF16)."""
    rows = []
    for fid in family_order(inp.bank):
        ps = [p for p in res["effective"] if p["familyId"] == fid and "replicatingPortfolio" in p["terms"]]
        if not ps:
            continue
        if len(ps) != 1:
            raise ValueError("a credit family of more than one position is not in the replica")
        p = ps[0]
        if "linearDecay" in p["terms"]:
            key, obj = "replicatingPortfolio", _straight_line_credit(p, inp)
        else:
            key, obj = "scenarioCredit", _path_credit(p, inp)
        rows.append({"familyId": fid, "irFtpRate": obj["rateCredit"], "lpFtpRate": obj["liquidityCredit"], "allInFtpRate": obj["totalCredit"], key: obj})
    return {"byFamily": rows}


def build_desk(root: str) -> dict:
    out = {"schemaVersion": SCHEMA, "id": "deposit-forms-v1",
           "label": "The seven deposit-form demos (Quillfield's deposit desk and the floater's funding tenor), written by the Python replica (replica/)",
           "inputs": {k: {"path": "/".join(v), "sha256": _sha(root, v)} for k, v in
                      {"desk": DESK, "bank": BANK, "forms": FORMS, "demos": DEMOS, "regulatory": REGULATORY, **SHARED_FILES}.items()},
           "demos": []}
    for demo_id in DEMO_IDS:
        inp, setup, demo = demo_inputs(root, demo_id)
        res = project_all(inp)
        sids = [s for s, _ in inp.scenarios]
        shocks = dict(inp.scenarios)
        basis = setup["eve"]["discountBasis"]
        horizons = tuple(setup["nii"]["reportHorizons"])
        base_sid = next(s for s, spec in inp.scenarios if is_base(spec))
        m: dict = {"id": demo_id, "setupId": setup["id"], "bookId": demo["bookId"], "scenarios": [{"id": s, "rateSpec": spec} for s, spec in inp.scenarios]}
        ev = lambda: eve_shape(inp.bank, eve_mod.eve(inp.bank, res["families"], inp.base, inp.tlp, shocks, basis), sids)
        if demo_id == "desk-linear-decay":
            m.update({"eve": ev(), "nii": nii_shape(inp, res, horizons, sids), "cashflows": cashflows_shape(inp.bank, res, sids),
                      "gap": gap_shape(inp, res, sids), "ftp": ftp_shape(inp, res, horizons, base_sid)})
        elif demo_id == "desk-component-decay":
            m["cashflows"] = component_cashflows(inp, res, sids)
        elif demo_id in ("desk-full-beta-frozen", "desk-full-beta-shocked"):
            m.update({"parentOf": res["parentOf"], "eve": ev(), "nii": nii_shape(inp, res, horizons, sids), "cashflows": cashflows_shape(inp.bank, res, sids)})
        elif demo_id in ("desk-credit", "desk-scenario-credit"):
            m["ftp"] = credit_shape(inp, res)
        elif demo_id == "funding-tenor":
            m["ftp"] = ftp_shape(inp, res, horizons, base_sid)
        out["demos"].append(m)
    return out

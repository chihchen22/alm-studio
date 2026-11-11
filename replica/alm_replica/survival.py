"""Studio slice S3d-1's survival-path demo on Quillfield Bank version 1.3 (DEFINITIONS rows L7 to L15): one targets
file, `replica/targets/demo-survival-path-v1.json`, holding the run's liquidity stress block in the engine's own shape.

Inputs, shared with the engine as files: the bank, `replica/inputs/survival-path-v1.json` (the seeded setup as the
seed stores it), Quillfield's illustrative set from `replica/inputs/feature-demos-v1.json`, the market, the SOFR history
and the CD parameters. The stress rates, the dials, the borrowing line and the CD renewal shares are the setup's.
"""
from __future__ import annotations

import hashlib
import json
import os

from . import liquidity as liq_mod
from .book import SHARED_FILES, Inputs, project_all
from .demos import BANK, DEMOS, library_spec

SURVIVAL = ("replica", "inputs", "survival-path-v1.json")
TARGET_ID = "demo-survival-path-v1"
SCHEMA = "1.0.0"


def _rd(root: str, parts: tuple) -> dict:
    with open(os.path.join(root, *parts), encoding="utf-8") as f:
        return json.load(f)


def _sha(root: str, parts: tuple) -> str:
    with open(os.path.join(root, *parts), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def build_survival(root: str) -> dict:
    demo = _rd(root, SURVIVAL)["demos"][0]
    setup = demo["setup"]
    sets = {s["id"]: s for s in _rd(root, DEMOS)["sets"]}
    aset = sets[demo["setIds"][0]]
    if setup["nmdWarmup"]["kind"] != "history" or setup["scenarios"]["kind"] != "library" or setup.get("nmdConvention") is not None:
        raise ValueError("the replica's survival-path demo reads the history warmup, library scenarios and no deposit convention")
    inp = Inputs(
        bank=_rd(root, BANK),
        analysis={"behavior": {"bindings": aset["bindings"]}},
        market=_rd(root, SHARED_FILES["market"]),
        sofr={**_rd(root, SHARED_FILES["sofr"]), "firstMonth": setup["nmdWarmup"]["series"]["firstMonth"], "valuesPct": setup["nmdWarmup"]["series"]["valuesPct"]},
        cd_params=_rd(root, SHARED_FILES["cdParams"]),
        scenarios=tuple(library_spec(r) for r in setup["scenarios"]["refs"]),
        convention=setup.get("modelConvention"),
    )
    res = project_all(inp)
    return {
        "schemaVersion": SCHEMA,
        "id": TARGET_ID,
        "label": "The survival-path demo on Quillfield Bank version 1.3, written by the Python replica (replica/)",
        "demo": demo["id"],
        "setupId": setup["id"],
        "inputs": {k: {"path": "/".join(v), "sha256": _sha(root, v)} for k, v in {"bank": BANK, "survival": SURVIVAL, "demos": DEMOS, **SHARED_FILES}.items()},
        "scenarios": [{"id": s, "rateSpec": spec} for s, spec in inp.scenarios],
        "liquidityStress": liq_mod.stress_ladder(inp.bank, res["effective"], res["baseRows"], setup["liquidityStress"], res["cdSplit"]),
    }

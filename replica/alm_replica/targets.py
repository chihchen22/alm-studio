"""Assemble the committed targets: every measure the tie-out compares, from the replica alone."""
from __future__ import annotations

import hashlib
import json
import os

from . import eve as eve_mod
from . import ftp as ftp_mod
from . import gaps as gaps_mod
from . import nii as nii_mod
from .book import QUILLFIELD, Subject, input_files, load_inputs, project_all
from .curve import RatePath

SCHEMA = "1.0.0"


def _trim(xs: list[float]) -> list[float]:
    n = len(xs)
    while n > 0 and xs[n - 1] == 0.0:
        n -= 1
    return [float(x) + 0.0 for x in xs[:n]]


def _sha(root: str, parts: tuple) -> str:
    with open(os.path.join(root, *parts), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def build(root: str, subject: Subject = QUILLFIELD) -> dict:
    inp = load_inputs(root, subject)
    res = project_all(inp)
    shocks = dict(subject.scenarios)
    sids = [s for s, _ in subject.scenarios]

    positions = {sid: {pid: {k: _trim(v) for k, v in s.items()} for pid, s in res["positions"][sid].items()} for sid in sids}

    nii_all = nii_mod.nii(inp.bank, res["families"])
    has_derivatives = any(f["side"] == "derivative" for f in inp.bank["coa"]["families"])
    nii_out = {}
    for sid in sids:
        n = nii_all[sid]
        row = {"totalNet12": n["totalNet"][12], "totalNet24": n["totalNet"][24]}
        if has_derivatives:  # a book with no derivative family carries no derivatives line
            row.update({"derivativesNet12": n["derivativesNet"][12], "derivativesNet24": n["derivativesNet"][24]})
        nii_out[sid] = {
            **row,
            "netMonthly": _trim(n["netMonthly"]),
            "byFamily": {fid: {"12": r["byHorizon"][12], "24": r["byHorizon"][24], "netMonthly": _trim(r["netMonthly"])} for fid, r in n["byFamily"].items()},
        }

    eve_out = {basis: eve_mod.eve(inp.bank, res["families"], inp.base, inp.tlp, shocks, basis) for basis in ("risk-free", "all-in")}

    gap_out = {}
    for kind in ("repricing", "liquidity"):
        gap_out[kind] = {sid: {"bands": gaps_mod.ladder(inp.bank, res[kind][sid], gaps_mod.BANDS),
                               "monthly": gaps_mod.ladder(inp.bank, res[kind][sid], gaps_mod.monthly_edges())} for sid in sids}

    base_nii = nii_all["S0"]
    f = ftp_mod.ftp(inp.bank, res["effective"], res["baseRows"], inp.base, inp.tlp, RatePath(inp.base, 360),
                    base_nii["totalNet"][12], base_nii["derivativesNet"][12])
    for fid, row in f["byFamily"].items():
        row["monthly"] = {k: _trim(v) for k, v in row["monthly"].items()}

    return {
        "schemaVersion": SCHEMA,
        "id": subject.id,
        "label": subject.label,
        "basis": "static run-off: base and parallel shocks (scenarios below), SOFR history warmup, no new volume",
        "tolerance": {"relative": 1e-9, "absoluteFloorDollars": 1e-6, "absoluteFloorRates": 1e-12},
        "inputs": {k: {"path": "/".join(v), "sha256": _sha(root, v)} for k, v in input_files(subject).items()},
        "scenarios": [{"id": s, "shockBp": b} for s, b in subject.scenarios],
        "positions": positions,
        "nii": nii_out,
        "eve": eve_out,
        "gap": gap_out,
        "ftp": f,
    }


def dumps(t: dict) -> str:
    return json.dumps(t, indent=None, separators=(",", ":"), sort_keys=False, allow_nan=False) + "\n"

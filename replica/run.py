"""Write or check the replica's targets, one file per book.

    python replica/run.py --write    regenerate replica/targets/<book>.json for every book
    python replica/run.py --check    regenerate in memory and fail on any drift from the committed files
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import numpy  # noqa: E402

from alm_replica.book import SUBJECTS  # noqa: E402
from alm_replica.demos import DEMO_IDS, build_demo  # noqa: E402
from alm_replica.desk import build_desk  # noqa: E402
from alm_replica.survival import TARGET_ID as SURVIVAL_ID, build_survival  # noqa: E402
from alm_replica.targets import build, dumps  # noqa: E402

# The interpreter and numpy the committed targets were written with (requirements.txt): a byte compare is only
# meaningful on the same pair, so another pair is refused in words rather than reported as drift.
PYTHON = (3, 12)
NUMPY = "2.5.2"


def target_path(subject_id: str) -> str:
    return os.path.join(HERE, "targets", f"{subject_id}.json")


def main(argv: list[str]) -> int:
    if argv[1:] not in (["--write"], ["--check"]):
        print(__doc__)
        return 2
    print(f"replica: Python {sys.version.split()[0]}, numpy {numpy.__version__}")
    if sys.version_info[:2] != PYTHON or numpy.__version__ != NUMPY:
        print(f"replica: FAIL: the targets are written with Python {PYTHON[0]}.{PYTHON[1]} and numpy {NUMPY}; use that pair (replica/requirements.txt)")
        return 1
    failed = 0
    jobs = [(subject.id, lambda subject=subject: build(ROOT, subject)) for subject in SUBJECTS]
    jobs += [(f"demo-{d}-v1", lambda d=d: build_demo(ROOT, d)) for d in DEMO_IDS]
    jobs += [("deposit-forms-v1", lambda: build_desk(ROOT))]
    jobs += [(SURVIVAL_ID, lambda: build_survival(ROOT))]
    for target_id, make in jobs:
        fresh = dumps(make())
        path = target_path(target_id)
        rel = os.path.relpath(path, ROOT)
        if argv[1] == "--write":
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(fresh)
            print(f"replica: wrote {rel} ({len(fresh):,} bytes)")
            continue
        try:
            with open(path, encoding="utf-8") as f:
                committed = f.read()
        except FileNotFoundError:
            print(f"replica:check FAIL: {rel} is missing")
            failed += 1
            continue
        if committed == fresh:
            print(f"replica:check PASS: a fresh replica run reproduces {rel} byte for byte ({len(fresh):,} bytes)")
            continue
        failed += 1
        n = next((i for i, (a, b) in enumerate(zip(committed, fresh)) if a != b), min(len(committed), len(fresh)))
        print(f"replica:check FAIL: the fresh run differs from {rel} at character {n:,}")
        print(f"  committed: ...{committed[max(0, n - 60):n + 60]}...")
        print(f"  fresh:     ...{fresh[max(0, n - 60):n + 60]}...")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

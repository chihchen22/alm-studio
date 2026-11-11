"""The model convention a run names (ADR-062; DEFINITIONS rows K1 to K4).

"book" is the original convention, the behavior before the corrections; "corrected-v1" is the public default since slice
K1. The replica models both for the CD book. The two conventions differ in three ways, and the replica reads each from
ADR-062's text, not from engine code:

- the CD walk's curve: on "book" the walk reads its own grid, the default-1 zero curve of the market snapshot plus the
  TLP, the same in every scenario (DEFINITIONS row C11); on "corrected-v1" it reads the zero curve of the path it is
  projected on, z_k = (1 / t_k) sum over j < k of ln(1 + r_j dt), t_k = k / 12, r_j the path's one-month accrual rate,
  plus the run's TLP held static, at k = 1 to the book's longest term (row K2);
- the CD minimum live balance: $1,000 of walk balance on "book" (the CD parameter file), $1 on "corrected-v1", the
  figure the kernel's CD header documents; a stated input (row K3);
- SEG replacement deposit vintages: on "corrected-v1" they read the run's history, unshifted (row K4), which is what
  the replica always built. The "book" convention's vintages read the kernel's own series, which the replica cannot
  hold without copying a kernel constant, so the replica refuses a SEG block on "book".
"""
from __future__ import annotations

BOOK = "book"
CORRECTED_V1 = "corrected-v1"
CONVENTIONS = (BOOK, CORRECTED_V1)

# ADR-062 point 3: the kernel header's documented minimum, in walk dollars (a stated input, DEFINITIONS row K3).
CORRECTED_V1_CD_MIN_LIVE_BALANCE = 1.0


def resolve(value: str | None) -> str:
    """An absent convention is the original convention (ADR-062)."""
    v = BOOK if value is None else value
    if v not in CONVENTIONS:
        raise ValueError(f"model convention {v} is not in the replica")
    return v

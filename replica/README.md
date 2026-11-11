# replica

A second, independent implementation of the engine's deterministic core in Python 3.12 and numpy, for Quillfield Bank, a small coverage book (inputs/coverage-v1.json) and the bank's seven feature demos.
It shares only input files with the engine: no code and no constants.

- `python replica/run.py --write` regenerates `targets/<book>.json` for both books; `--check` fails on any drift.
- `ALM_PYTHON=<python> npm run replica:check` runs the check; `npm run accept` compares the engine with the targets.
- `DEFINITIONS.md` lists every model definition and its source; `DISAGREEMENTS.md` records each disagreement and its cause.
- Package `alm_replica/`: curve, schedules, behavior, nii, eve, gaps, ftp; `book.py` reads the inputs and projects the bank.

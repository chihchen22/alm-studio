# Contributing

Thank you for reading this far. ALM Studio is a teaching tool, and the most useful thing a reader can send is a place where a number, a method or a sentence does not hold up.

## Bugs and questions

Open an issue. Say what you did, what you saw and what you expected, and name the screen or the guide page. For a number, give the run (its setup name and launch number, which the Studio shows; run ids differ on every machine) and the figure you read. A question about a method is an issue too; if the answer belongs in the guide, the issue is where it starts.

## Changes

Open an issue before a pull request, so the change can be talked through before the work is done. Small fixes to wording or a doc need no more than a sentence.

A change must pass, from the repository root:

- `npm run typecheck` and `npm test`;
- `npm run accept`, the acceptance battery, which compares the engine with the Python replica's committed targets cell by cell. A change that moves a tied-out number is a model change: say so in the issue, and regenerate the targets with the replica (`$ALM_PYTHON replica/run.py --write`, then `ALM_PYTHON=/path/to/python3.12 npm run replica:check`), never by editing a target to match the engine;
- `npm run docs:check` when a public doc changes. Every Quillfield number a doc quotes carries a marker naming the replica target and cell it is read from; the check formats the target's value and fails on any difference. The marker's form is described at the top of [`scripts/docs-check.mjs`](https://github.com/chihchen22/alm-studio/blob/main/scripts/docs-check.mjs). A result with no target is described in words, not quoted.

A change to a method is described in its pull request, and a limit it introduces is added to [`docs/guide/limitations.md`](https://github.com/chihchen22/alm-studio/blob/main/docs/guide/limitations.md) in plain words. The kernel ([`packages/kernel`](https://github.com/chihchen22/alm-studio/tree/main/packages/kernel)) is frozen and hash-verified; a change in behavior goes in the engine beside it.

Prose in the public docs follows the voice of the existing pages: plain words, the method before the formula, every quoted number marked.

## License

By contributing you agree that your contribution is licensed under the Apache License, Version 2.0, the license of the project.

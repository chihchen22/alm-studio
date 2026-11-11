# Changelog

All notable changes to ALM Studio are recorded here, newest first.

## 0.1.0 (2026-11-06)

The first public release, an early one: the interfaces and the stored formats may still change between minor versions.

What it holds:

- The Studio, a local web app over a TypeScript ALM engine: net interest income, economic value of equity on three discount bases, the sensitivity equivalent gap, the repricing, liquidity and fixed-rate gap ladders, funds transfer pricing, the deposit models and conventions, and a liquidity stress with a survival path, each on a Results screen with a CSV export.
- Quillfield Bank, a synthetic bank, and its deposit desk. `npm run learn` sets up the finished analysis and runs every demo once on a store of its own; Home opens on a Start here path of eight steps and eight more demos.
- The method guide under [`docs/guide/`](https://github.com/chihchen22/alm-studio/tree/main/docs/guide) (seven topic pages and a limitations page), with every Quillfield number in it checked against the replica's targets by `npm run docs:check`.
- An independent Python replica under [`replica/`](https://github.com/chihchen22/alm-studio/tree/main/replica) and its committed targets: `npm run accept` ties the run-off earnings, value, gap, FTP and liquidity figures of every demo to them cell by cell.
- The guided Analysis path from import to report, JSON and CSV position import, and under Advanced the run setups, assumption sets, scenarios, compare runs and the stochastic rate models (Hull-White and BGM).
- The vendored rate and instrument math in [`packages/kernel`](https://github.com/chihchen22/alm-studio/tree/main/packages/kernel), hash-verified, and the typed tool surface and MCP server in [`packages/ai`](https://github.com/chihchen22/alm-studio/tree/main/packages/ai).

Released under the Apache License, Version 2.0.

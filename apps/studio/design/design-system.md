# Studio design system

The standards file for Studio pages. Every rule below is meant to be checked against a page, by eye or by `check.mjs`. Token values live in `tokens.css`; this file names them and says what each one is for. When this file and `tokens.css` disagree on a value, `tokens.css` wins and this file is corrected.

## 1. What Studio is

Studio is the product surface of an ALM aggregator for a bank treasury desk: the screens where a treasury practitioner reads NII, EVE, gaps and model status from the ALM Studio engine. It should read as calm, exact and fast. A reader finds the number, its unit and its basis without hunting.

What it is not: a trading terminal (no dense multi-pane blotters, no black-and-amber), a BI tool (no drag-and-drop widget grids, no chart for its own sake), a marketing site (no hero imagery, no slogans).

## 2. Reference

The reference is the product pages of mercury.com. What we take from it: quiet surfaces, one accent color, tabular figures, and whitespace that separates groups instead of rules and boxes. Where a page needs a divider, spacing comes first and a `--line` rule second.

The reference for the bar is mercury.com.

## 3. Palette

All colors come from `tokens.css`. Pages never write a hex, `rgb()`, `rgba()` or `hsl()` value. Light values sit in `:root`; dark values sit in the `prefers-color-scheme: dark` block guarded by `:root:not([data-theme="light"])`, and again in `:root[data-theme="dark"]`.

| Token | Role |
|---|---|
| `--bg` | Page background. |
| `--surface` | Cards, sheets, table bodies. |
| `--surface-2` | Secondary surface: table header rows, input fields, hover rows. |
| `--ink` | Primary text and headline numbers. |
| `--ink-2` | Secondary text: descriptions, table cells that are not the key figure. |
| `--muted` | Labels, axis text, captions, disabled text. |
| `--line` | Hairline dividers and chart gridlines. |
| `--line-2` | Stronger borders: input outlines, card edges where spacing alone is not enough. |
| `--accent` | The one interactive color: primary button, selected tab, focus ring, active link. |
| `--accent-ink` | Text on an `--accent` fill. |
| `--accent-wash` | Selected-row and selected-tab background. |
| `--pos` | Favorable delta; pass status. |
| `--neg` | Adverse delta; breach status. |
| `--warn` | Near a limit, not over it. |
| `--unobs` | Unobservable status: the engine cannot compute the value from its inputs. |
| `--stale` | Stale status: the value is from an input older than its freshness window. |
| `--pos-wash`, `--neg-wash`, `--warn-wash`, `--unobs-wash`, `--stale-wash` | Chip and cell backgrounds, the matching status hue at .12 alpha. |
| `--series-1` to `--series-6` | Categorical chart series, in order. `--series-1` is `var(--accent)` in every block: it is the one coloured series. |
| `--series-1-wash` | The soft fill under a single `--series-1` line: `var(--accent-wash)`. |
| `--seq-1` to `--seq-7` | Sequential ramp for heatmaps and ordered bins. Light runs pale to dark; dark mode reverses it so `--seq-7` is always the highest-contrast end against the background. |

Rules:

- One accent per screen. At most two accent-filled surfaces above the fold: the page's one action chip and, if present, one chart series in `--series-1`. Everything else clickable is a neutral wash (`--surface-2`) on a hairline. A single-series chart is neutral (`--muted` marks, the base scenario in `--ink-2`).
- `--pos` and `--neg` color deltas only (change in NII, change in EVE, limit headroom used). A level (EVE of 412 mm) is printed in `--ink`, whatever its sign.
- Status colors appear only with the status word next to them (Section 6).
- Contrast floors (light theme, on `--bg` #F6F6F4): `--muted` #636D78 4.86:1, `--neg` #B03A28 5.57:1, `--unobs` #5F6975 5.16:1; each text-bearing token holds at least 4.5:1.

## 4. Type

Font stacks: `--font` for text, `--mono` for identifiers and code (run IDs, file hashes), never for numbers in tables.

Sizes come from the seven-step `--fs` scale: `--fs-1` 12px, `--fs-2` 13px, `--fs-3` 14px, `--fs-4` 16px, `--fs-5` 20px, `--fs-6` 26px, `--fs-7` 34px. A screen uses three sizes at most.

- Page title: `--fs-6`, weight 400. It is the only text at `--fs-6` on a page that is not a number.
- Headline numbers: `--fs-6` or `--fs-7`, weight 400, tabular figures. Size carries the hierarchy, not weight. Units beside a figure are `--fs-3` in `--muted`.
- A product page uses three working sizes: `--fs-6` (title and headline figures), `--fs-3` (body, controls, card and node titles), `--fs-1` (labels, captions, chips, axis text). Nothing renders under 12px.
- Labels: `--fs-1`, uppercase, letter-spacing .04em, color `--muted`.
- All numbers use tabular figures (`font-variant-numeric: tabular-nums`, set on `html` and on `.num`), so columns of figures align on the digit.

## 5. Spacing and radius

Spacing uses the `--sp` scale only: 4, 8, 12, 16, 24, 32, 48px. No other margin or padding values.

Radius: cards `--r-2` (10px), chips 999px, sheets and dialogs `--r-3` (14px), inputs and small buttons `--r-1` (6px).

Page gutters: `--sp-5` (24px) at 1024px wide, `--sp-6` (32px) at 1440px wide.

Cards and tiles sit on a one-pixel `--line` hairline with no shadow. `--shadow-1` is kept for small overlays (a menu); `--shadow-2` for sheets.

The shell: a 232px rail on the left, main in the middle, a 280px assistant rail on the right (it drops under main below 1280px). A canvas page may collapse the assistant rail to a 48px strip (below).

- Rail groups, separated by a `--line` hairline: [Home] | [Balance Sheet, Market, Assumptions, Scenarios] | [Plan, Run] | [Results, Compare]. Each group after the first carries an `--fs-1` uppercase `--muted` group label: Inputs, Compose, Read. One word or two per item, no icons.
- The active rail item is a neutral wash: `--surface-2` background, `--ink` text, weight 500. The accent is never the active-item color.
- Assistant rail: the title, the two-line text, the drop zone directly under it, then an `--fs-1` list titled "What the assistant will do here" with three noun phrases specific to the page.
- Collapsed assistant rail, the default on every read page (Home, Balance Sheet, Market) and on canvas pages (Plan): a 48px strip at the right with a `--surface` fill and a `--line` hairline on its left, a vertical `--fs-1` uppercase `--muted` "Assistant" label reading bottom to top, and the drop target reduced to a small "Drop file" chip (`--surface-2` wash, `--line-2` hairline, the accent only on hover or focus). The strip stays at the right at every width, so the canvas keeps the room; the three page-specific noun phrases move into the page source until the rail is expanded.
- Removed from the Studio shell on 2026-10-26: the strip had no provider and a disabled file drop, and read as broken. The two rail entries above describe the mock only; the CSS rules remain unused until a follow-up drops them.

## 6. Status semantics

Four statuses, each with a color and a border style from `tokens.css`. The border style is the cue that does not depend on color; the word in the chip is the other.

| Status | Class | Color | Border | Chip text |
|---|---|---|---|---|
| Pass | `.status-pass` | `--pos` | solid | pass |
| Breach | `.status-breach` | `--neg` | dashed | breach |
| Unobservable | `.status-unobs` | `--unobs` | dotted | unobservable |
| Stale | `.status-stale` | `--stale` | 3px double (two 1px rules), zero vertical padding so the chip matches the others' height | stale |

A chip always carries the word. A colored dot or border alone is not a status. The chip text is the engine's status word as the route returns it, lower case (`pass`, `breach`, `unobservable`, `stale`); Studio does not recase it.

## 7. Charts

Charts follow the chart rules of this design system.

- Categorical series use `--series-1` onward, in order. Sequential encodings use `--seq-1` to `--seq-7`.
- No gridlines. The one exception is a single zero line (`--line-2`) where negative values exist. No y-axis tick column.
- The SVG carries marks only: `preserveAspectRatio="none"`, full card content width, fixed height (bar and line plots 180px, the gap ladder 220px). Strokes and dot marks use `vector-effect: non-scaling-stroke` so they keep their weight when the plot stretches.
- Axis category labels and the unit label are HTML text, below and above the SVG in a flex row aligned to the bands, never SVG `<text>`, so they never scale. Axis text is `--muted` at `--fs-1`.
- Headline values leave the plot. When a tile on the same page already carries the movement, the card states it once in one `--fs-1` `--muted` supporting line under the title, uncoloured. Otherwise one chip beside the title may carry it (a delta chip in `--pos`/`--neg`, or a neutral chip for a level). A chart card carries either one chip beside the title or one muted supporting line under it, never two chips; two values go in one supporting line. Bars carry no painted values; the Show table keeps every value, and each mark keeps its hover title.
- A single line takes `--series-1`; the base scenario is a hollow dot. It carries the soft `--series-1-wash` fill under it only when its baseline is zero. A line chart floored above zero carries no fill and states "axis from N" in its unit line, so the floor is never mistaken for zero.
- The attribution waterfall is a table-chart: labels and values are HTML columns either side of the SVG of bars, a deliberate exception to selective direct labels. It keeps the zero line and no other gridline.
- No 3D, no gradients, no shadows on marks.
- Every chart carries a one-line caption naming the envelope field it plots, in the form "Source: <envelope field>, run <run id>". This is ours, not the reference's, and it stays.
- Allowed exception to the radius scale: chart marks and legend keys use a 1px or 2px radius (heatmap cells, legend line and box keys, spacing bars), because `--r-1` would round a small mark into a blob. Bar data-ends keep the 4px round from the chart mark spec.

## 8. Voice

- Labels are nouns ("Base NII", "Limit headroom"). Buttons are verbs ("Run", "Export").
- No exclamation marks.
- Numbers carry units and basis: "412 mm USD", "-38 bp vs base", "12m horizon".
- "Unobservable" is a word we print. A missing value is never shown as a dash or a blank.
- A stat tile is: label (`--fs-1` uppercase `--muted`), figure (`--fs-6`, weight 400, tabular, always `--ink`) with its unit, one delta chip on delta tiles (the only colour on the tile), then an `--fs-1` `--muted` mono source line naming the envelope field (for example `eve.byScenario[S0].eve`). The exact figure sits in the tile's `title` attribute; the tile does not repeat the figure in raw units.

## 9. Motion

- `--t-fast` (120ms) for hover and focus changes.
- `--t-base` (200ms) for panels, sheets and drawers opening and closing.
- Nothing that carries a number animates: no counting-up figures, no bars growing in on load.

## 10. Forbidden

- Raw color literals in pages: hex values, color functions (`rgb()`, `rgba()`, `hsl()`, `hsla()`, `oklch()`, `oklab()`, `lab()`, `lch()`, `color-mix()`) and named colors. `check.mjs page <file>` fails on these inside `style="..."` attributes, the SVG color attributes `fill`, `stroke`, `stop-color`, `flood-color`, `lighting-color` and `color`, and `<style>` bodies. The named colors it knows are red, blue, green, white, black, gray, grey, orange, purple and yellow. In those places `var(--...)`, `none`, `currentColor`, `transparent`, `inherit` and `url(#id)` pass. A `#id` counts as a selector only in a `<style>` body, before the `{` of its rule; a hex in a value list such as a `box-shadow` is a color. Colors set in script are not scanned and are checked by eye.
- Em-dashes (U+2014) and section signs (U+00A7), in copy and in code. `check.mjs page <file>` fails on either character, or its entity (`&mdash;`, `&#8212;`, `&#x2014;`, `&sect;`, `&#167;`, `&#xa7;`), anywhere in a page file. It does not scan `tokens.css` or other non-page files for them.
- Decorative icons. An icon appears only where it is the control (close, expand, sort).
- Gradients, anywhere.
- Drop shadows heavier than `--shadow-2`.
- Placeholder numbers. A mock shows a real engine output or the word "Unobservable", never 123 or 0.00 filler.

## 11. Header band

Every product page opens with the same band, top to bottom:

1. The page title at `--fs-6`, weight 400 (Section 4).
2. One row of pill chips (`.pill`, 32px, `--surface-2` wash on a `--line` hairline, `--fs-3`). A selector pill carries its key in `--muted` and its value in `--ink` ("Book synthetic-2500-v1", "Run run-20260923-163546-001557f", "Plan PLAN-EXAMPLE-IRRBB-1") and ends in a small chevron drawn in CSS from two borders of a rotated box, no icon font. A fixed context value ("As of 2026-03-31", "Horizon 360 months") is the same pill without the chevron. No native `<select>` in the band.
3. After the selectors, the page's action. At most one pill is accent-filled (`.pill-primary`): Run on Home, Save plan on Plan. A secondary action is a quiet pill (`.pill-quiet`, transparent on the hairline): Validate on Plan, Export on Results, which has no accent-filled pill.
4. The metadata line at `--fs-1` in `--muted`, for example "2,351 positions, assets 5,358.7 mm USD, intake statistics", with each figure's source comment.

The band scrolls with the page; it is not sticky and has no rule under it.

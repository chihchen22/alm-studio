// apps/studio/src/guided/startHereCards.ts
/**
 * The demo card copy the Start here card shows behind each item's "More about this demo" (moved here
 * from the feature demo sections, whose Home component the author removed in the S3f cleanup). The text is the S3b-1,
 * S3c-1 and S3d-1 cards, unchanged: each number is the engine's on the seeded setup, rounded, and the card says "about".
 * The disclosure reads it through `aboutText` (./startHere.ts), which leaves out the card's own change advice.
 * ./featureDemos.ts re-exports every name here, so older imports keep working.
 */
/**
 * One card: what it shows, where to look and one change with what happens (`text`), and the plain lines its Details
 * add (`notes`): what the demo leaves out, which base a figure is on, and the caveats a reader needs (S3b fix round).
 */
export interface DemoCard {
  id: string;
  title: string;
  text: string;
  look: string;
  notes: readonly string[];
}

/** The card copy, in card order. Plain words; developer detail lives in Details (the row's ids). */
export const DEMO_CARDS: readonly DemoCard[] = [
  {
    id: "seg",
    title: "SEG and its knobs",
    look: "Results, SEG / EBP",
    text:
      "SEG, the sensitivity equivalent gap, shows how much of the bank acts like a fixed-rate balance when rates move a little. " +
      "It covers every earning asset and every liability but the CDs. The CDs and the swap are outside it, so its earnings and its NIM are for that part of the bank. " +
      "Launch it, then open Results, SEG / EBP. " +
      "Change the NII shock from 100 to 200 bp: the 12-month earnings change under the rise roughly doubles, from about minus $2 million to minus $4 million.",
    notes: [
      "Outside the SEG block: the certificates of deposit ($1,050 million), the swap, the undrawn lines and the non-earning balances.",
      "Its NIM is its 12-month earnings over total assets ($5,000 million, the non-earning balances included). The peer margin in the data note, 3.84 percent, is on earning assets, so the two are on different bases.",
      "This setup nudges rates by 25 bp and reads ten years ahead. The mortgages already on the books prepay at 6 percent a year under the rise and 20 percent under the fall (the cohort-0 overlay).",
    ],
  },
  {
    id: "regulatory",
    title: "The regulatory deposit convention",
    look: "Results, Value (EVE)",
    text:
      "This is the standardized deposit convention of the international (Basel) standard, shown as a reference. The US has not adopted it. " +
      "Each deposit is split into a stable core, laid out evenly with an average life of five years, and a non-core slice that leaves in one month: about 31 percent of the deposits, from 10 to 50 percent by deposit. " +
      "The core keeps today's paid rate. " +
      "Launch it, then open Results, Value (EVE). " +
      "Change the NMD convention to behavioral: base value rises by about $205 million.",
    notes: [
      "Non-core share by deposit: non-interest checking 10 percent, interest checking 25 percent, savings 39 percent, money market 50 percent ($990 million of $3,150 million).",
      "The interest-bearing non-core slice floats: it reprices one for one with the one-month rate. The core rungs and the non-interest slice stay at today's paid rate.",
      "The engine applies one core cap (90 percent) and one five-year life to every deposit. The standard sets different caps and lives for retail transactional, retail non-transactional and wholesale deposits.",
      "Base value moves from about $1,114 million to about $1,319 million. The CDs are not split.",
    ],
  },
  {
    id: "spread-consistent",
    title: "Spread-consistent discounting",
    look: "Results, Value (EVE), by family",
    text:
      "Spread-consistent discounting values each loan on the funding curve plus the loan's own credit spread. All-in uses the funding curve alone, so the only difference is that loans are worth less here. " +
      "This bank's loans carry round spreads, from 75 bp on mortgages to 300 bp on consumer loans. " +
      "Launch it, then open Results, Value (EVE). " +
      "Change the EVE discount basis to all-in: base value rises by about $154 million, from about $1,144 million to $1,298 million.",
    notes: [
      "The spreads are in the bank file's version 1.1. A store that imported version 1.0 keeps it under the same id, and there this demo reads the all-in values. A fresh store reads version 1.1.",
    ],
  },
  {
    id: "six-shocks",
    title: "The six standardized shocks",
    look: "Results, Value (EVE) and Earnings (NII)",
    text:
      "The six standardized shocks are the rate moves an international standard asks banks to test: parallel up and down 200 bp, short rates up and down, a steepener and a flattener. " +
      "Launch it, then open Results, Value (EVE), one row per shock. Parallel up hurts this bank most. " +
      "Change the NMD convention to regulatory: parallel up is still the worst, but its loss roughly halves, from about $196 million to about $98 million.",
    notes: [
      "The shock sizes are the standard's USD ones as recalibrated in July 2024: parallel 200 bp, short rate 300 bp, long rate 225 bp (150 bp before the recalibration).",
      "The standard is an international reference. The US has not adopted it.",
    ],
  },
  {
    id: "instruments",
    title: "Instrument-level results",
    look: "Results, Instruments",
    text:
      "Instrument-level results keep one row for each of the bank's 29 positions in every scenario: its value, its 12-month earnings, its balance and the principal it pays back in the first year. " +
      "Launch it, then open Results, Instruments, and sort or filter the grid. " +
      "Change the chart nodes to Total Liabilities and Equity only: the grid keeps just the 7 deposit and borrowing positions, and the saved file gets smaller.",
    notes: [
      "The three non-earning balances ($250 million) are valued at par in every scenario, as Value (EVE) values them, so the rows sum to Value (EVE) family by family. A results file made before this change reads 0 for them and says so.",
    ],
  },
  {
    id: "constant-prepay",
    title: "Constant prepayment and the stress inflow line",
    look: "Results, Liquidity",
    text:
      "A constant prepayment lets fixed-rate loans pay back early at a steady speed: consumer loans at 10 percent a year and multifamily loans at 6 percent. " +
      "In a liquidity stress borrowers pay back more slowly, so the two stress ladders read half those speeds. " +
      "Launch it, then open Results, Liquidity, and compare the ladders. " +
      "Change the assumption set to the illustrative set, which has no constant prepayment: business-as-usual inflows over the first year fall from about $304 million to about $272 million.",
    notes: [
      "The stress ladder leaves out the certificates of deposit ($1,050 million): this setup states no renewal share for them, so they enter nothing. The survival-path demo puts them in.",
      "No borrowing matures within the ladder's 12 months, so the wholesale renewal setting changes nothing here.",
      "So the buffer outlasting the severe row by about $19 million is not a full survival reading.",
    ],
  },
  {
    id: "fixed-ladder",
    title: "The fixed-rate gap ladder",
    look: "Results, Gap and liquidity",
    text:
      "The fixed-rate gap ladder shows when the money on fixed-rate positions comes back: each dollar of principal on a fixed loan, mortgage or CD sits in the band of the month it is paid. " +
      "Launch it, then open Results, Gap and liquidity, and read the Fixed-rate gap card. " +
      "Change the NMD convention to regulatory: the deposits become fixed-rate core slices, so liabilities in the 5-10Y band grow from nothing to about $1,080 million.",
    notes: [],
  },
];


/**
 * The cards of the seven deposit-form demos, the funding tenor on Quillfield Bank and six on
 * Quillfield's deposit desk, in the server's order. Kept apart from DEMO_CARDS, the seven of S3b, so neither list moves
 * the other. The same rules: one plain paragraph that says where to look and one change with what happens, and Details
 * that say what the demo leaves out. Each number is the engine's on the seeded setup, rounded, and the card says "about".
 */
export const DEPOSIT_FORM_CARDS: readonly DemoCard[] = [
  {
    id: "funding-tenor",
    title: "The floater's funding tenor",
    look: "Results, FTP",
    text:
      "A floating loan resets its rate every month, but the bank funds it for longer. Its funding tenor says how long. " +
      "With one, FTP charges the rate leg at the one-month reset and the liquidity leg at the funding tenor. " +
      "This bank's C&I, construction and home equity lines and its floating advance carry one. " +
      "Launch it, then open Results, FTP. " +
      "Change from version 1.1, which carried none: the four families' 12-month FTP margin falls from about $16.3 million to about $15.1 million.",
    notes: [
      "Funding tenors: C&I lines 36 months, C&I term loans 24, construction 24, home equity lines 60, the floating advance 24. Only the FTP rows of those four families move, and the book roll-up with them.",
      "Home equity lines: the rate leg moves from about 4.06 to 3.74 percent (the one-month forward at the reset) and the liquidity leg from about 0.51 to 0.45 percent (the premium at 60 months).",
      "A store that imported version 1.1 keeps it under the same id, and there this demo reads the old FTP. A fresh store reads version 1.2.",
    ],
  },
  {
    id: "desk-linear-decay",
    title: "A straight-line deposit runoff",
    look: "Results, Gap and liquidity",
    text:
      "Quillfield's deposit desk holds only deposits: $1.2 billion in three families. " +
      "Its operating deposits run off in a straight line, $300 million over 48 months, so $6.25 million leaves every month and their life is 24.5 months. " +
      "Launch it, then open Results, Gap and liquidity, and read the liquidity ladder and the Life by family card. " +
      "Change the NMD convention to regulatory: the straight line becomes a capped core ladder, and the desk's base value rises by about $25 million.",
    notes: [
      "The desk holds no assets, so its value (EVE) is negative: what the bank owes on its deposits, about minus $1,099 million at base.",
      "Each deposit is a family of its own: operating deposits $300 million, savings $400 million, money market accounts $500 million.",
      "On this setup the savings and money market books run on their own terms, so earnings, value, gap and FTP all show.",
      "The regulatory convention follows an international standard, shown as a reference. The US has not adopted it.",
    ],
  },
  {
    id: "desk-component-decay",
    title: "Component decay on a dated rate path",
    look: "Results, Gap and liquidity, Life by family",
    text:
      "Component decay projects a savings book's balance on a dated rate path. " +
      "Each month 2 percent of balances leave and the rest grow 0.25 percent, and each point SOFR sits above its average of the year before takes another 0.5 percent off. " +
      "This demo replays SOFR from April 2022 to March 2026. " +
      "Launch it, then open Results, Gap and liquidity: the savings life is about 4.1 years. " +
      "Change the monthly retention to 0.99 in the set editor: the life rises to about 9.5 years.",
    notes: [
      "Earnings (NII), value (EVE) and FTP stand aside on this run, each with a note: the form prices volume on a dated path, not a paid rate on a curve path.",
      "A shocked scenario adds its shift to the window months only, so the year-before average stays on SOFR as it happened. Under +100 bp the life falls to about 3.4 years.",
      "Past March 2026 the driver holds its last value, and the life counts the whole runoff, past the 30-year grid too.",
      "The SOFR values are the shipped public series (Federal Reserve Bank of New York, via FRED).",
    ],
  },
  {
    id: "desk-full-beta-frozen",
    title: "The full beta form, frozen slotting",
    look: "Results, Value (EVE)",
    text:
      "The full beta form sets a deposit's paid rate from the short rate: an intercept, a beta that rises with rates, and a damper after each move, the paid rate closing part of the gap each month. " +
      "The money market book carries it. Frozen slotting holds its core share at the base date: half the book over five years, half in one month. " +
      "Launch it, then open Results, Value (EVE). Under +100 bp its value moves by about $10.1 million. " +
      "Change the NMD convention to shocked-level: about $13.2 million.",
    notes: [
      "The form, round values: intercept 0.10 percent, damper 0.3 after a rise and 0.1 after a fall, base short rate 3.65 percent after a fall, balances flat.",
      "FTP stands aside on this run: the FTP module does not read the form. SEG, key-rate durations and the EVE channels are refused beside it.",
      "The operating and savings deposits take the standard regulatory split in both full beta demos, so the two runs differ in the money market book only.",
      "The regulatory convention follows an international standard, shown as a reference. The US has not adopted it.",
    ],
  },
  {
    id: "desk-full-beta-shocked",
    title: "The full beta form, shocked-level slotting",
    look: "Results, Value (EVE)",
    text:
      "Shocked-level slotting reads the money market book's core share at each scenario's own short rate: one minus the beta there, over five years. " +
      "After a rise the damper is stronger, so at +100 bp the beta falls from about 0.51 to 0.46 and the core grows from 49 to 54 percent. " +
      "Launch it, then open Results, Value (EVE): under +100 bp the value moves by about $13.2 million, against $10.1 million frozen. " +
      "Change the core life to 7 years in the set editor: about $17.0 million.",
    notes: [
      "At base the core share is about 49 percent: one minus a beta of about 0.51 at 3.65 percent, after a fall.",
      "The damper is 0.3 after a rise and 0.1 after a fall. At +100 bp the S-curve beta rises from about 0.56 to 0.65, but the stronger damper takes it to about 0.46. After a fall the core grows too: about 58 percent at -100 bp.",
      "The operating and savings deposits take the standard regulatory split here too, as in the frozen demo.",
      "FTP stands aside on this run: the FTP module does not read the form. SEG, key-rate durations and the EVE channels are refused beside it.",
    ],
  },
  {
    id: "desk-credit",
    title: "The replicating-portfolio credit",
    look: "Results, FTP, Deposit credits",
    text:
      "A deposit's credit is what its funding is worth: fixed-rate bullets whose life matches the deposit's, plus the liquidity premium at that life, with the repricing share rolled overnight. " +
      "The desk prices all three deposits: the operating runoff's life of 24.5 months, the savings path's 49.5 months, and a 60-month cap on the flat money market book. " +
      "Launch it, then open Results, FTP. The operating deposits earn about 4.14 percent. " +
      "Change their construction to strip: about 4.08 percent.",
    notes: [
      "Base scenario only: a straight-line runoff's credit is read on the base curve.",
      "Earnings (NII) and value (EVE) stand aside on a credit run, each with a note: the run prices transfer rates.",
      "Pillars: 1, 12, 36, 60 and 120 months. The operating credit blends the 36 and 60-month pillars half and half.",
      "The money market book's beta, about 0.51, rolls overnight. The rest sits almost all on the 120-month pillar, whose life of 60.5 months is closest to the cap.",
    ],
  },
  {
    id: "desk-scenario-credit",
    title: "The credit at every scenario",
    look: "Results, FTP, Deposit credits",
    text:
      "The credit can be read at every scenario. " +
      "Here each scenario re-prices the savings and money market credits on its own shifted curve, and the savings life comes from the balance path that scenario projects. " +
      "Launch it, then open Results, FTP, and read the tables by scenario. " +
      "Under +100 bp the savings credit rises from about 4.53 to 5.39 percent, as its life falls from 49.5 to 41.3 months. " +
      "Change the shocked-scenario reading to hold-base: about 4.39 percent.",
    notes: [
      "The FTP series itself stays on the base scenario; only the credit is read at each scenario.",
      "The money market life stays at its 60-month cap in every scenario; its beta moves with the shocked rate.",
      "The operating deposits carry no credit on this setup: a straight-line runoff's credit is read on the base curve only.",
      "Earnings (NII) and value (EVE) stand aside on this run, each with a note: the run prices transfer rates.",
    ],
  },
];

/**
 * The survival path's card on Quillfield Bank version 1.3, after the cards. Kept
 * apart from the other lists, so neither moves. The same rules; each number is the engine's on the seeded setup,
 * rounded, and the card says "about".
 */
export const SURVIVAL_PATH_CARDS: readonly DemoCard[] = [
  {
    id: "survival-path",
    title: "The survival path and the commitment dials",
    look: "Results, Liquidity, Survival path",
    text:
      "The survival path asks how long liquid assets last in a severe stress. " +
      "The buffer is the cash and securities less their HQLA haircuts, about $1,168 million. Maturing CDs leave less the share that renews, and the dials set the draws on the undrawn lines. " +
      "Launch it, then open Results, Liquidity, Survival path: the buffer lasts about 6.7 months, 203 days. " +
      "With the FHLB borrowing line, $400 million after its haircut: about 10.6 months, 322 days. " +
      "Change the borrowing line to Off on the page: back to about 203 days.",
    notes: [
      "The stress rates are round illustrative values, not fitted. Severe: the savings pool (savings and money market) leaves at 8 percent a month, the checking pool (both checking accounts) at 1.5 percent; 30 percent of maturing CDs renew, and early withdrawals leave in full.",
      "The buffer counts each security at its face, not its market value, and does not apply the regulatory caps on Level 2 assets. The agency notes and agency MBS are Level 2A, at a 15 percent haircut.",
      "The draws: the lines' $1,000 million is undrawn now, a commitment of about $1,176 million at an expected use (Ubar) of 15 percent. The severe draw is U99 less Ubar (35 less 15 percent) of that commitment, about $235 million, spread evenly over the first 12 months, and nothing after.",
      "The LCR reference beside it is the regulatory 30-day outflow on the undrawn lines only: 10 percent of the $1,000 million undrawn now, $100 million. It is not a full LCR.",
      "These figures hold on a fresh store, which imports Quillfield Bank version 1.3. A store that imported an older version has no HQLA levels on the bank, so its buffer counts nothing; the page says so.",
      "The page cannot show a stress on loan repayments beyond the stress speeds, new lending, or intraday flows. Compare does not show the liquidity tables yet; export each run's CSV.",
    ],
  },
];

/** The card for a demo id, or undefined for an id the Studio has no copy for (a newer server). */
export function cardFor(id: string): DemoCard | undefined {
  return DEMO_CARDS.find((c) => c.id === id) ?? DEPOSIT_FORM_CARDS.find((c) => c.id === id) ?? SURVIVAL_PATH_CARDS.find((c) => c.id === id);
}

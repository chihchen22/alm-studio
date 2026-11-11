/**
 * Chart of accounts and product-family catalogue for the synthetic book.
 *
 * Eleven families across assets and liabilities plus an equity plug node,
 * inside the 8-to-12 band the spec asks for. Each family declares which
 * instrument type its positions instantiate: one of the five frozen kernel
 * types, or the engine-side "cd" cohort-book arm for the cds family
 * (the cds family runs the kernel competing-risk
 * early-withdrawal walk; FHLB advances and borrowings stay contractual
 * bullets). The equity node is summation-only: it carries no positions and its
 * balance is derived as assets minus liabilities at t=0.
 */
import type { CoaNode, ChartOfAccounts, ProductFamilyDef } from "@alm/engine";

const COA_SCHEMA_VERSION = "1.0.0";

// Root nodes.
const N_ASSETS = "coa-assets";
const N_LIAB_EQ = "coa-liab-equity";

// Leaf and plug node ids.
const N_CASH = "coa-cash";
const N_INV = "coa-investments";
const N_FIXED = "coa-fixed-loans";
const N_FLOAT = "coa-floating-loans";
const N_MTG = "coa-mortgages";
const N_MBS = "coa-mbs";
const N_DDA = "coa-dda";
const N_MMA = "coa-mma";
const N_CD = "coa-cds";
const N_FHLB = "coa-fhlb";
const N_BORR = "coa-borrowings";
const N_EQUITY = "coa-equity";

/** The single equity plug node id, exported for the conservation check. */
export const EQUITY_NODE_ID = N_EQUITY;

const NODES: CoaNode[] = [
  { id: N_ASSETS, label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
  { id: N_CASH, label: "Cash & Equivalents", parentId: N_ASSETS, side: "asset", isLeaf: true, familyId: "cash", order: 0 },
  { id: N_INV, label: "Investments / Treasuries", parentId: N_ASSETS, side: "asset", isLeaf: true, familyId: "investments", order: 1 },
  { id: N_FIXED, label: "Fixed-Rate Loans", parentId: N_ASSETS, side: "asset", isLeaf: true, familyId: "fixed-loans", order: 2 },
  { id: N_FLOAT, label: "Floating / C&I Loans", parentId: N_ASSETS, side: "asset", isLeaf: true, familyId: "floating-loans", order: 3 },
  { id: N_MTG, label: "Residential Mortgages", parentId: N_ASSETS, side: "asset", isLeaf: true, familyId: "mortgages", order: 4 },
  { id: N_MBS, label: "MBS", parentId: N_ASSETS, side: "asset", isLeaf: true, familyId: "mbs", order: 5 },
  { id: N_LIAB_EQ, label: "Total Liabilities & Equity", parentId: null, side: "liability", isLeaf: false, order: 1 },
  { id: N_DDA, label: "DDA (Non-Interest)", parentId: N_LIAB_EQ, side: "liability", isLeaf: true, familyId: "dda", order: 0 },
  { id: N_MMA, label: "MMA / Savings", parentId: N_LIAB_EQ, side: "liability", isLeaf: true, familyId: "mma", order: 1 },
  { id: N_CD, label: "CDs", parentId: N_LIAB_EQ, side: "liability", isLeaf: true, familyId: "cds", order: 2 },
  { id: N_FHLB, label: "FHLB Advances", parentId: N_LIAB_EQ, side: "liability", isLeaf: true, familyId: "fhlb", order: 3 },
  { id: N_BORR, label: "Borrowings", parentId: N_LIAB_EQ, side: "liability", isLeaf: true, familyId: "borrowings", order: 4 },
  { id: N_EQUITY, label: "Equity (plug)", parentId: N_LIAB_EQ, side: "equity", isLeaf: false, order: 5 },
];

const FAMILIES: ProductFamilyDef[] = [
  { id: "cash", label: "Cash & Equivalents", side: "asset", instrumentType: "fixed-loan", coaNodeId: N_CASH },
  { id: "investments", label: "Investments / Treasuries", side: "asset", instrumentType: "fixed-loan", coaNodeId: N_INV },
  { id: "fixed-loans", label: "Fixed-Rate Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: N_FIXED },
  { id: "floating-loans", label: "Floating / C&I Loans", side: "asset", instrumentType: "floating-loan", coaNodeId: N_FLOAT },
  { id: "mortgages", label: "Residential Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: N_MTG },
  { id: "mbs", label: "MBS", side: "asset", instrumentType: "mortgage", coaNodeId: N_MBS },
  { id: "dda", label: "DDA (Non-Interest)", side: "liability", instrumentType: "nmd", coaNodeId: N_DDA },
  { id: "mma", label: "MMA / Savings", side: "liability", instrumentType: "nmd-b", coaNodeId: N_MMA },
  { id: "cds", label: "CDs", side: "liability", instrumentType: "cd", coaNodeId: N_CD },
  { id: "fhlb", label: "FHLB Advances", side: "liability", instrumentType: "fixed-loan", coaNodeId: N_FHLB },
  { id: "borrowings", label: "Borrowings", side: "liability", instrumentType: "fixed-loan", coaNodeId: N_BORR },
];

/** Build the frozen chart of accounts (deep-cloned so callers cannot mutate it). */
export function buildChartOfAccounts(): ChartOfAccounts {
  return {
    schemaVersion: COA_SCHEMA_VERSION,
    nodes: NODES.map((n) => ({ ...n })),
    families: FAMILIES.map((f) => ({ ...f })),
  };
}

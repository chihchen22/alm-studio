/**
 * CSV column contract, GENERATED from the kernel's instrument term interfaces.
 *
 * The contract is not hand-copied: this module parses the kernel source files
 * (`packages/kernel/src/math/instruments/types.ts` for `InstrumentTermsBase`
 * and the shared type aliases, plus the five concrete instrument files for the
 * per-type terms interfaces) with the TypeScript compiler API and derives the
 * per-type CSV column set from the interface members themselves. If the kernel
 * gains, renames, or retypes a term field, the contract moves with it and the
 * doc-sync test (`__tests__/importFormatsDoc.test.ts`) fails until
 * `docs/import-formats.md` is regenerated. A hand-copied column
 * list would drift silently; this one cannot.
 *
 * Classification rules per interface member:
 *   - `number` / `string`            -> a typed CSV column
 *   - union of string literals, or a type alias resolving to one (AmortType)
 *                                    -> an enum CSV column with the literal set
 *   - any other type reference (MBSParams, NMDParams, BetaSCurveParams)
 *                                    -> a parameter block, NOT a CSV column;
 *                                       the CSV path fills it from a registered
 *                                       kernel default or refuses loudly
 *   - `id` and `type` are excluded: they are derived from the `position_id`
 *     and `terms_type` meta columns.
 *
 * The `typescript` package is a root devDependency of this repo; the platform
 * is a repo-local tool run via tsx, so parsing kernel sources at load time is
 * always possible. The parsed contract is cached after the first call.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo-root-relative location of the kernel instrument sources. */
export const KERNEL_INSTRUMENTS_DIR = path.resolve(
  HERE,
  "../../../../packages/kernel/src/math/instruments",
);

/** The kernel source files the contract is generated from. */
export const CONTRACT_SOURCE_FILES = [
  "types.ts",
  "fixedLoan.ts",
  "floatingLoan.ts",
  "mortgage.ts",
  "nmd.ts",
  "nmdBeta.ts",
] as const;

/** Platform meta columns; fixed by the platform design, not by kernel types. */
export const META_COLUMNS = [
  "position_id",
  "family_id",
  "coa_node_id",
  "terms_type",
] as const;

/** Term fields never expressed as CSV columns (derived from meta columns). */
const EXCLUDED_FIELDS = new Set(["id", "type"]);

/**
 * Engine-side corrections to a kernel field comment the table would otherwise print, keyed
 * `<terms type>.<field>`. The kernel stays byte-identical, so where its comment says what the engine does
 * not do, the table says what the engine does. Each key must name a column the kernel declares, or the build throws,
 * so an override cannot outlive its field.
 */
export const COLUMN_DOC_OVERRIDES: Readonly<Record<string, string>> = {
  // The kernel comment says beta drives a repricing-gap split. The engine never reads a plain deposit's beta in
  // either gap ladder (packages/engine/src/gap/gapEngine.ts: non-interest-bearing NMD stays pure runoff); only the
  // replicating-portfolio funding credit reads it.
  "nmd.beta":
    "Deposit-rate beta of a plain deposit, a decimal from 0 to 1. No gap ladder reads it: a plain deposit runs off as its decay model says. Only the replicating-portfolio funding credit reads it, as the share of the balance that reprices at once.",
};

export interface ColumnSpec {
  /** CSV header name; exactly the kernel interface property name. */
  name: string;
  kind: "number" | "string" | "enum";
  /** Populated when kind is "enum": the closed literal set, in source order. */
  enumValues?: readonly string[];
  required: boolean;
  /** First line of the kernel JSDoc for the field, when present. */
  doc?: string;
}

export interface ParamBlockSpec {
  /** Terms field name, e.g. "cprParams". */
  field: string;
  /** Referenced kernel type name, e.g. "MBSParams". */
  typeName: string;
  doc?: string;
}

export interface TermsContract {
  /** The `terms.type` discriminant, e.g. "fixed-loan". */
  termsType: string;
  /** The kernel interface name, e.g. "FixedLoanTerms". */
  interfaceName: string;
  /** Type-specific scalar columns (base columns are shared, listed separately). */
  columns: ColumnSpec[];
  /** Object-typed fields the CSV path fills from kernel defaults. */
  paramBlocks: ParamBlockSpec[];
}

export interface CsvColumnContract {
  metaColumns: readonly string[];
  /** Shared columns from InstrumentTermsBase, in source order. */
  baseColumns: ColumnSpec[];
  /** One contract per concrete terms type, in source-file order. */
  contracts: TermsContract[];
  /** Every legal term column name (base plus all per-type), unique. */
  termColumnNames: string[];
}

type Classified =
  | { kind: "number" | "string" }
  | { kind: "enum"; values: string[] }
  | { kind: "block"; typeName: string };

function firstJsDocLine(node: ts.Node): string | undefined {
  const docs = ts.getJSDocCommentsAndTags(node);
  for (const d of docs) {
    if (!ts.isJSDoc(d)) continue;
    const c = d.comment;
    const text = typeof c === "string" ? c : c ? (ts.getTextOfJSDocComment(c) ?? "") : "";
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length > 0) return flat;
  }
  return undefined;
}

function classifyType(
  t: ts.TypeNode,
  aliases: Map<string, ts.TypeNode>,
  sf: ts.SourceFile,
): Classified {
  if (t.kind === ts.SyntaxKind.NumberKeyword) return { kind: "number" };
  if (t.kind === ts.SyntaxKind.StringKeyword) return { kind: "string" };
  if (ts.isUnionTypeNode(t)) {
    const values: string[] = [];
    for (const m of t.types) {
      if (ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal)) {
        values.push(m.literal.text);
      } else {
        return { kind: "block", typeName: t.getText(sf) };
      }
    }
    return { kind: "enum", values };
  }
  if (ts.isTypeReferenceNode(t)) {
    const name = t.typeName.getText(sf);
    const alias = aliases.get(name);
    if (alias) return classifyType(alias, aliases, sf);
    return { kind: "block", typeName: name };
  }
  // Anything else (boolean, tuples, ...) is not representable as a CSV cell
  // today; classify as a block so the CSV path refuses loudly instead of
  // guessing a cell format.
  return { kind: "block", typeName: t.getText(sf) };
}

interface ParsedInterface {
  name: string;
  extendsBase: boolean;
  members: ts.PropertySignature[];
  sf: ts.SourceFile;
}

function collectDeclarations(files: readonly string[]): {
  interfaces: ParsedInterface[];
  aliases: Map<string, ts.TypeNode>;
  aliasSf: Map<string, ts.SourceFile>;
} {
  const interfaces: ParsedInterface[] = [];
  const aliases = new Map<string, ts.TypeNode>();
  const aliasSf = new Map<string, ts.SourceFile>();
  for (const file of files) {
    const full = path.join(KERNEL_INSTRUMENTS_DIR, file);
    const text = readFileSync(full, "utf-8");
    const sf = ts.createSourceFile(full, text, ts.ScriptTarget.ES2022, true);
    sf.forEachChild((node) => {
      if (ts.isTypeAliasDeclaration(node)) {
        aliases.set(node.name.text, node.type);
        aliasSf.set(node.name.text, sf);
      } else if (ts.isInterfaceDeclaration(node)) {
        const extendsBase = (node.heritageClauses ?? []).some((h) =>
          h.types.some((t) => t.expression.getText(sf) === "InstrumentTermsBase"),
        );
        interfaces.push({
          name: node.name.text,
          extendsBase,
          members: node.members.filter(ts.isPropertySignature),
          sf,
        });
      }
    });
  }
  return { interfaces, aliases, aliasSf };
}

function buildColumns(
  iface: ParsedInterface,
  aliases: Map<string, ts.TypeNode>,
): { columns: ColumnSpec[]; paramBlocks: ParamBlockSpec[]; termsType?: string } {
  const columns: ColumnSpec[] = [];
  const paramBlocks: ParamBlockSpec[] = [];
  let termsType: string | undefined;
  for (const m of iface.members) {
    if (!ts.isIdentifier(m.name)) continue;
    const field = m.name.text;
    if (!m.type) continue;
    if (field === "type") {
      if (ts.isLiteralTypeNode(m.type) && ts.isStringLiteral(m.type.literal)) {
        termsType = m.type.literal.text;
      }
      continue;
    }
    if (EXCLUDED_FIELDS.has(field)) continue;
    const doc = firstJsDocLine(m);
    const cls = classifyType(m.type, aliases, iface.sf);
    if (cls.kind === "block") {
      paramBlocks.push({ field, typeName: cls.typeName, doc });
    } else if (cls.kind === "enum") {
      columns.push({
        name: field,
        kind: "enum",
        enumValues: cls.values,
        required: m.questionToken === undefined,
        doc,
      });
    } else {
      columns.push({ name: field, kind: cls.kind, required: m.questionToken === undefined, doc });
    }
  }
  return { columns, paramBlocks, termsType };
}

let cached: CsvColumnContract | undefined;

/** Generate (or return the cached) CSV column contract from kernel sources. */
export function getCsvColumnContract(): CsvColumnContract {
  if (cached) return cached;
  const { interfaces, aliases } = collectDeclarations(CONTRACT_SOURCE_FILES);

  const base = interfaces.find((i) => i.name === "InstrumentTermsBase");
  if (!base) {
    throw new Error(
      `columnContract: InstrumentTermsBase not found in ${KERNEL_INSTRUMENTS_DIR}/types.ts`,
    );
  }
  const baseBuilt = buildColumns(base, aliases);
  if (baseBuilt.paramBlocks.length > 0) {
    const names = baseBuilt.paramBlocks.map((p) => `${p.field}: ${p.typeName}`).join(", ");
    throw new Error(
      `columnContract: InstrumentTermsBase carries non-scalar fields the CSV path cannot express: ${names}`,
    );
  }

  const contracts: TermsContract[] = [];
  for (const iface of interfaces) {
    if (!iface.extendsBase) continue;
    const built = buildColumns(iface, aliases);
    if (!built.termsType) {
      throw new Error(
        `columnContract: interface ${iface.name} extends InstrumentTermsBase but has no literal "type" discriminant`,
      );
    }
    const columns = built.columns.map((c) => {
      const override = COLUMN_DOC_OVERRIDES[`${built.termsType}.${c.name}`];
      return override === undefined ? c : { ...c, doc: override };
    });
    contracts.push({
      termsType: built.termsType,
      interfaceName: iface.name,
      columns,
      paramBlocks: built.paramBlocks,
    });
  }
  if (contracts.length === 0) {
    throw new Error("columnContract: no terms interfaces found in the kernel instrument sources");
  }
  for (const key of Object.keys(COLUMN_DOC_OVERRIDES)) {
    const [type, field] = key.split(".");
    if (!contracts.some((t) => t.termsType === type && t.columns.some((c) => c.name === field))) {
      throw new Error(`columnContract: the doc override "${key}" names no column the kernel declares`);
    }
  }

  const seen = new Set<string>();
  const termColumnNames: string[] = [];
  for (const c of [...baseBuilt.columns, ...contracts.flatMap((t) => t.columns)]) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      termColumnNames.push(c.name);
    }
  }
  for (const meta of META_COLUMNS) {
    if (seen.has(meta)) {
      throw new Error(`columnContract: meta column "${meta}" collides with a kernel term field`);
    }
  }

  cached = {
    metaColumns: META_COLUMNS,
    baseColumns: baseBuilt.columns,
    contracts,
    termColumnNames,
  };
  return cached;
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function columnTable(columns: readonly ColumnSpec[]): string {
  const lines = ["| column | type | required | description |", "|---|---|---|---|"];
  for (const c of columns) {
    const type = c.kind === "enum" ? c.enumValues!.map((v) => `\`${v}\``).join(" \\| ") : c.kind;
    lines.push(
      `| \`${c.name}\` | ${type} | ${c.required ? "yes" : "no"} | ${mdEscape(c.doc ?? "")} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Render the generated contract as the markdown section embedded in
 * `docs/import-formats.md`. The doc-sync test compares the doc's
 * generated region against this output byte for byte (after trimming), so the
 * doc cannot drift from the kernel source.
 */
export function renderColumnContractMarkdown(): string {
  const contract = getCsvColumnContract();
  const parts: string[] = [];
  parts.push(
    `Meta columns (every row): ${contract.metaColumns.map((m) => `\`${m}\``).join(", ")}.`,
  );
  parts.push("");
  parts.push("#### Shared term columns (from `InstrumentTermsBase`)");
  parts.push("");
  parts.push(columnTable(contract.baseColumns));
  for (const t of contract.contracts) {
    parts.push("");
    parts.push(`#### \`${t.termsType}\` (\`${t.interfaceName}\`)`);
    parts.push("");
    if (t.columns.length > 0) {
      parts.push(columnTable(t.columns));
    } else {
      parts.push("No type-specific scalar columns.");
    }
    if (t.paramBlocks.length > 0) {
      parts.push("");
      parts.push(
        `Parameter blocks (not CSV columns; filled from kernel defaults by the CSV path, ` +
          `authored via the JSON path or the run's assumption set): ` +
          t.paramBlocks.map((p) => `\`${p.field}\` (\`${p.typeName}\`)`).join(", ") +
          ".",
      );
    }
  }
  return parts.join("\n");
}

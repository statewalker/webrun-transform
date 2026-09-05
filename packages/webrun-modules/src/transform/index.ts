import type {
  PackageManifest,
  SourceFile,
  SourceFormat,
  Transform,
  TransformResult,
} from "../types.js";
import { parseEsmModule } from "./analyze.js";
import { newCjsTransform } from "./transform-cjs.js";
import { newEsmTransform } from "./transform-esm.js";

export { analyze } from "./analyze.js";

/** The default per-file transform: dispatch ESM/TS/JSX vs CJS by `file.format`.
 *  `production` selects the JSX runtime (must match the globals' NODE_ENV). */
export function newDefaultTransform(production = false): Transform {
  const esm = newEsmTransform(production);
  const cjs = newCjsTransform(production);
  return {
    transform(file: SourceFile, rewrite: (specifier: string) => string): Promise<TransformResult> {
      return file.format === "cjs" ? cjs.transform(file, rewrite) : esm.transform(file, rewrite);
    },
  };
}

// `module.exports` / `exports.x` / `exports[…]` are impossible in real ESM — a
// *definitive* CJS signal (unlike the word "export", which appears in CJS files'
// strings/comments, e.g. React's dev warnings).
const CJS_EXPORTS = /\bmodule\.exports\b|\bexports\s*[.[]/;
// A real ESM statement: `import`/`export` as syntax, not a word in prose.
const ESM_STMT = /(^|[\s;])(import|export)[\s{*'"]/;
const REQUIRE_CALL = /(^|[^.\w])require\s*\(/;

/**
 * Decide a file's `SourceFormat` from its extension, the package `type`, and
 * (for ambiguous `.js`) a content sniff. Mirrors Node: `.mjs`=ESM, `.cjs`=CJS,
 * `.js` follows `package.json#type`; with no `type`, a package `.js` is CJS
 * (Node's default) unless real ESM syntax is present. Definitive CJS markers
 * (`module.exports`/`exports.x`) win over a loose `import`/`export` word-match,
 * so a CJS file with "export" in a string is not mis-read as ESM — unless BOTH
 * markers appear, in which case one of them is inside a string and only the AST
 * can say which (see `hasEsmSyntax`).
 */
export function detectFormat(
  path: string,
  source: string,
  manifest?: PackageManifest,
): SourceFormat {
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return "tsx";
  if (path.endsWith(".mjs")) return "esm";
  if (path.endsWith(".cjs")) return "cjs";
  if (manifest?.type === "module") return "esm";
  if (manifest?.type === "commonjs") return "cjs";
  const cjsMarker = CJS_EXPORTS.test(source);
  const esmMarker = ESM_STMT.test(source);
  // Both markers present ⇒ at least one is text inside a string, a template
  // literal or a comment. Only a parse can tell which, so pay for one here; the
  // unambiguous cases below stay on the cheap regexes.
  if (cjsMarker && esmMarker) return hasEsmSyntax(source) ? "esm" : "cjs";
  if (cjsMarker) return "cjs"; // definitive CJS
  if (esmMarker) return "esm"; // real import/export syntax
  if (REQUIRE_CALL.test(source)) return "cjs"; // weaker CJS hint
  // Node default: a package `.js` with no `type:module` is CJS; authored source
  // (no manifest) defaults to ESM.
  return manifest ? "cjs" : "esm";
}

/**
 * True when the source has a real top-level `import`/`export` STATEMENT.
 *
 * Sucrase's ESM transformers emit `module.exports` and `exports.` as their
 * OUTPUT, so those tokens sit inside their string and template literals; a text
 * scan called such a file CJS and wrapped a genuine ESM module in the CJS
 * function wrapper, which the browser rejects with "'import' and 'export' may
 * only appear at the top level". ESM statements and CJS `exports` are mutually
 * exclusive, so finding one on the AST is definitive.
 *
 * Unparseable as a module ⇒ false, leaving the text heuristics to decide.
 */
function hasEsmSyntax(source: string): boolean {
  let ast: ReturnType<typeof parseEsmModule>;
  try {
    ast = parseEsmModule(source);
  } catch {
    return false;
  }
  return ast.body.some(
    (n) =>
      n.type === "ImportDeclaration" ||
      n.type === "ExportNamedDeclaration" ||
      n.type === "ExportDefaultDeclaration" ||
      n.type === "ExportAllDeclaration",
  );
}

export { newCjsTransform } from "./transform-cjs.js";
export { newEsmTransform } from "./transform-esm.js";

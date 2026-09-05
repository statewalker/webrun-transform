import { parse as acornParse } from "acorn";
import attachGlobals from "acorn-globals";
import { init as initCjs, parse as parseCjs } from "cjs-module-lexer";
import type { ModuleDescriptor, ModuleImport, SourceFormat } from "../types.js";
import { toJs } from "./to-js.js";

let cjsReady: Promise<unknown> | undefined;
const REQUIRE_RE = /require\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1\s*\)/g;

/** The parser seam. acorn baseline (pure-JS, isomorphic); oxc-wasm may replace
 *  this behind the same signature once the spike validates it. Exported so the
 *  ESM transform reuses the SAME parser config for its specifier-rewrite spans.
 *  acorn sets `start`/`end` on every node natively, which the splice needs. */
export function parseEsmModule(js: string) {
  return acornParse(js, { ecmaVersion: "latest", sourceType: "module" }) as unknown as {
    body: any[];
  };
}

function emptyImport(): ModuleImport {
  return { names: [], hasNamespace: false, hasDefault: false };
}

/**
 * Analyze one module into its import/export descriptor. TS/JSX is stripped via
 * `toJs` first (acorn can't parse types/JSX, and stripping surfaces the
 * sucrase-injected `react/jsx-runtime` import). Free globals are detected with
 * `acorn-globals` (scope-aware) and recorded under the reserved `""` key.
 */
export async function analyze(
  source: string,
  format: SourceFormat,
  production = false,
): Promise<ModuleDescriptor> {
  if (format === "cjs") return analyzeCjs(source);

  // Must match the transform's `production` so the scanner sees the SAME injected
  // `react/jsx*-runtime` import the transform emits (else the resolved dep and the
  // emitted specifier diverge and the JSX runtime import 404s).
  const js = toJs(source, format, undefined, production);
  const ast = parseEsmModule(js);
  const imports: Record<string, ModuleImport> = {};
  const exports = new Set<string>();

  const importFor = (spec: string) => {
    imports[spec] ??= emptyImport();
    return imports[spec];
  };

  for (const node of ast.body) {
    switch (node.type) {
      case "ImportDeclaration": {
        const imp = importFor(node.source.value);
        for (const s of node.specifiers) {
          if (s.type === "ImportDefaultSpecifier") imp.hasDefault = true;
          else if (s.type === "ImportNamespaceSpecifier") imp.hasNamespace = true;
          else imp.names.push(s.imported.name ?? s.imported.value); // ImportSpecifier
        }
        break;
      }
      case "ExportNamedDeclaration": {
        if (node.source) importFor(node.source.value); // re-export → also an import edge
        for (const s of node.specifiers ?? []) exports.add(s.exported.name ?? s.exported.value);
        if (node.declaration) collectDeclNames(node.declaration, exports);
        break;
      }
      case "ExportDefaultDeclaration":
        exports.add("default");
        break;
      case "ExportAllDeclaration": {
        importFor(node.source.value);
        if (node.exported) exports.add(node.exported.name ?? node.exported.value);
        break;
      }
    }
  }

  // Dynamic `import("literal")` — an ImportExpression nested anywhere in the
  // tree (not just at statement level), so a generic walk is needed. Only
  // static string sources are captured; a computed source like
  // `import("./" + n)` is left out.
  collectDynamicImports(ast.body, importFor);

  // Free (unbound) identifiers — scope-aware, so locally-declared names are
  // excluded. MUST pass sourceType:"module" or acorn-globals throws on the
  // import/export statements the stripped `js` still contains.
  const free = (
    attachGlobals as unknown as (
      src: string,
      opts: { ecmaVersion: string; sourceType: string },
    ) => { name: string }[]
  )(js, { ecmaVersion: "latest", sourceType: "module" });
  if (free.length)
    imports[""] = {
      names: [...new Set(free.map((g) => g.name))],
      hasNamespace: false,
      hasDefault: false,
    };

  return { imports, exports: [...exports] };
}

/**
 * Analyze a CommonJS module: `require(...)` specifiers via regex, exports via
 * `cjs-module-lexer` (best-effort static analysis of `exports.x`/`module.exports.x`),
 * and free globals via `acorn-globals` (CJS parses as a script; `require`/`module`/
 * `exports` surface as globals too, which is harmless — they aren't in the
 * injectable allowlist).
 */
async function analyzeCjs(source: string): Promise<ModuleDescriptor> {
  cjsReady ??= initCjs();
  await cjsReady;
  const imports: Record<string, ModuleImport> = {};
  for (const spec of findRequireSpecifiers(source)) imports[spec] ??= emptyImport();
  let exports: string[] = [];
  try {
    const parsed = parseCjs(source);
    exports = [...new Set([...parsed.exports, ...parsed.reexports])];
    for (const spec of parsed.reexports) imports[spec] ??= emptyImport();
  } catch {
    exports = [];
  }
  try {
    const free = (attachGlobals as unknown as (src: string) => { name: string }[])(source);
    if (free.length)
      imports[""] = {
        names: [...new Set(free.map((g) => g.name))],
        hasNamespace: false,
        hasDefault: false,
      };
  } catch {
    // unparseable as-is → no global injection (conservative)
  }
  return { imports, exports };
}

/**
 * Minimal recursive AST walk (no acorn-walk dependency) that finds every
 * `ImportExpression` node with a string-literal `.source` and registers its
 * specifier via `importFor`. Computed sources (non-`Literal`) are skipped.
 */
function collectDynamicImports(node: any, importFor: (spec: string) => unknown): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectDynamicImports(item, importFor);
    return;
  }
  if (typeof node.type !== "string") return;
  if (node.type === "ImportExpression" && node.source?.type === "Literal") {
    if (typeof node.source.value === "string") importFor(node.source.value);
  }
  for (const key in node) {
    if (key === "type") continue;
    collectDynamicImports(node[key], importFor);
  }
}

/**
 * Minimal recursive AST walk finding every `require("…")` CALL with a single
 * string-literal argument. Mirrors `collectDynamicImports`; computed arguments
 * are skipped.
 */
function collectRequireCalls(node: any, add: (spec: string) => void): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectRequireCalls(item, add);
    return;
  }
  if (typeof node.type !== "string") return;
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "require" &&
    node.arguments?.length === 1 &&
    node.arguments[0]?.type === "Literal" &&
    typeof node.arguments[0].value === "string"
  ) {
    add(node.arguments[0].value);
  }
  for (const key in node) {
    if (key === "type") continue;
    collectRequireCalls(node[key], add);
  }
}

/**
 * Static `require(...)` specifiers, found on the AST rather than in raw text.
 * A text scan also matches `require(...)` that merely APPEARS inside a string or
 * template literal — sucrase's `CJSImportProcessor` builds the text
 * `` `require('${path}');` `` — and would then resolve `${path}` as a package
 * name. Falls back to the text scan only when the source will not parse at all,
 * preserving the previous tolerance.
 */
export function findRequireSpecifiers(source: string): string[] {
  const out = new Set<string>();
  for (const sourceType of ["script", "module"] as const) {
    try {
      const ast = acornParse(source, {
        ecmaVersion: "latest",
        sourceType,
        allowReturnOutsideFunction: true,
      });
      collectRequireCalls(ast, (spec) => out.add(spec));
      return [...out];
    } catch {
      // try the next parse mode
    }
  }
  for (const m of source.matchAll(REQUIRE_RE)) out.add(m[2]);
  return [...out];
}

/** Pull exported binding names out of an `export const/let/var/function/class` decl. */
function collectDeclNames(decl: any, out: Set<string>): void {
  if (decl.type === "VariableDeclaration") {
    for (const d of decl.declarations) if (d.id.type === "Identifier") out.add(d.id.name);
  } else if (decl.id?.name) {
    out.add(decl.id.name); // FunctionDeclaration / ClassDeclaration
  }
}

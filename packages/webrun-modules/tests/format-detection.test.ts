import { describe, expect, it } from "vitest";
import { detectFormat } from "../src/transform/index.js";

/** A package with no `"type"` field — sucrase's shape, so detection must fall
 *  through to the source heuristics rather than being settled by the manifest. */
const untypedManifest = { name: "sucrase", version: "3.35.1" };

describe("format detection", () => {
  // sucrase's ESM transformers EMIT `module.exports` / `exports.` as their output,
  // so those tokens appear inside their string and template literals. A raw-text
  // scan called the file CJS and wrapped a genuine ESM module in the CJS function
  // wrapper, and the browser rejected it: "'import' and 'export' may only appear
  // at the top level".
  it("keeps a module ESM when `exports.` appears only inside a string", () => {
    const source = [
      'import { TokenType as tt } from "../parser/tokenizer/types";',
      "export function emit() {",
      '  return "\\nmodule.exports = exports.default;\\n";',
      "}",
    ].join("\n");
    expect(detectFormat("CJSImportTransformer.js", source, untypedManifest)).toBe("esm");
  });

  // The ordering this fix touches exists to protect this case: React's dev build
  // is CJS and carries the WORD "export" in its warning strings, which trips
  // `ESM_STMT`. Routing the both-markers case through the AST must not lose it.
  it("keeps a CJS module CJS when only the word `export` appears in a string", () => {
    const source = [
      'var warn = "You may have forgotten to export your component";',
      "function jsx() {}",
      "module.exports = { jsx: jsx };",
    ].join("\n");
    expect(detectFormat("react-jsx-dev-runtime.js", source, untypedManifest)).toBe("cjs");
  });

  it("keeps a CJS module CJS when no ESM marker is present at all", () => {
    const source = 'var fs = require("fs");\nexports.read = fs.readFileSync;';
    expect(detectFormat("index.js", source, untypedManifest)).toBe("cjs");
  });

  // A CJS file that will not parse as a module (top-level `return`, as UMD
  // wrappers emit) must fall back to the text heuristics rather than be called ESM.
  it("falls back to the text heuristics when the source will not parse", () => {
    const source = [
      'if (typeof exports !== "object") return;',
      'var warn = "export";',
      "module.exports = 1;",
    ].join("\n");
    expect(detectFormat("umd.js", source, untypedManifest)).toBe("cjs");
  });
});

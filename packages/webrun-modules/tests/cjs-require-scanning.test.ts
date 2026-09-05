import { describe, expect, it } from "vitest";
import { analyze } from "../src/transform/analyze.js";

describe("CJS require scanning", () => {
  it("collects a real require() call", async () => {
    const d = await analyze(`const fs = require("node:fs");\nmodule.exports = fs;`, "cjs");
    expect(Object.keys(d.imports)).toContain("node:fs");
  });

  // sucrase's CJSImportProcessor builds `require('…')` TEXT inside a template
  // literal. A raw-text scan reads `${path}` as a package name and asks the
  // registry for it, which 404s and fails the whole module.
  it("ignores require(...) text inside a template literal", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text sucrase emits, not an interpolation.
    const source = "const code = `require('${path}');`;\nmodule.exports = code;";
    const d = await analyze(source, "cjs");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text sucrase emits, not an interpolation.
    expect(Object.keys(d.imports)).not.toContain("${path}");
  });

  it("ignores require(...) text inside a plain string literal", async () => {
    const d = await analyze(`const code = "require('some-pkg')";\nmodule.exports = code;`, "cjs");
    expect(Object.keys(d.imports)).not.toContain("some-pkg");
  });
});

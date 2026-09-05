import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { newCjsTransform } from "../src/transform/transform-cjs.js";
import type { SourceFile } from "../src/types.js";

const t = newCjsTransform();
// Rewrite maps relative specifiers to sibling .mjs files so the output is importable.
const rw = (s: string) => (s.startsWith(".") ? `${s}.mjs` : s);

const dirs: string[] = [];
afterAll(() => {}); // temp dirs auto-cleaned by the OS; kept for symmetry

async function build(files: Record<string, SourceFile>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cjs-spike-"));
  dirs.push(dir);
  for (const [name, file] of Object.entries(files)) {
    const { code } = await t.transform(file, rw);
    await writeFile(join(dir, name), code);
  }
  return dir;
}

describe("newCjsTransform (executed)", () => {
  it("runs module.exports=fn, transitive require, and named exports", async () => {
    const dir = await build({
      "leaf.mjs": {
        path: "leaf.js",
        format: "cjs",
        source: `exports.double = (x) => x * 2;\nmodule.exports.tag = "leaf";`,
      },
      "main.mjs": {
        path: "main.js",
        format: "cjs",
        source: `const leaf = require("./leaf");\nmodule.exports = function (x) { return leaf.double(x); };\nmodule.exports.leafTag = leaf.tag;`,
      },
    });
    const mod = await import(pathToFileURL(join(dir, "main.mjs")).href);
    expect(typeof mod.default).toBe("function");
    expect(mod.default(21)).toBe(42); // transitive require("./leaf").double worked
    expect(mod.default.leafTag).toBe("leaf");

    const leaf = await import(pathToFileURL(join(dir, "leaf.mjs")).href);
    expect(leaf.double(5)).toBe(10); // named export snapshot importable
    expect(leaf.tag).toBe("leaf");
  });

  // semver's classes/range.js <-> classes/comparator.js: each assigns
  // `module.exports` BEFORE requiring its partner, the standard CJS idiom for
  // breaking a cycle. Node honours it because `require` is lazy — the partner's
  // body starts at the require site, by which time the requirer has published.
  // Hoisting requires to top-level `import`s inverts that order, so the
  // translation has to defer execution the same way Node does.
  //
  // Run in a CHILD NODE PROCESS, not through `await import` here: vitest's module
  // runner does not reproduce ESM temporal-dead-zone semantics, and this bug is a
  // TDZ read of a cyclic partner's `default`. Under vitest the broken output
  // merely yields `undefined`; under a real ESM loader it throws.
  it("survives a require cycle where each module publishes before requiring", async () => {
    const dir = await build({
      "range.mjs": {
        path: "range.js",
        format: "cjs",
        source: [
          "class Range {}",
          "module.exports = Range",
          'const Comparator = require("./comparator")',
          "module.exports.partner = Comparator.name",
        ].join("\n"),
      },
      "comparator.mjs": {
        path: "comparator.js",
        format: "cjs",
        source: [
          "class Comparator {}",
          "module.exports = Comparator",
          'const Range = require("./range")',
          "module.exports.partner = Range.name",
        ].join("\n"),
      },
    });
    // Entering through either side must work, and each must see its partner.
    await writeFile(
      join(dir, "main.mjs"),
      [
        'const r = await import("./range.mjs");',
        'const c = await import("./comparator.mjs");',
        "console.log(JSON.stringify({",
        "  range: r.default?.name, rangePartner: r.default?.partner,",
        "  comparator: c.default?.name, comparatorPartner: c.default?.partner,",
        "}));",
      ].join("\n"),
    );
    const { stdout, stderr, status } = spawnSync(process.execPath, [join(dir, "main.mjs")], {
      encoding: "utf8",
    });
    expect(stderr, "child process must not throw").not.toContain("ReferenceError");
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      range: "Range",
      rangePartner: "Comparator",
      comparator: "Comparator",
      comparatorPartner: "Range",
    });
  });

  it("surfaces named exports through a `module.exports = require(...)` reexport", async () => {
    // React's entry (`module.exports = require('./cjs/react.development.js')`) is
    // this shape: the entry has no own exports, only a reexport. The interop must
    // follow it so `import { StrictMode } from "react"` resolves.
    const dir = await build({
      "impl.mjs": {
        path: "impl.js",
        format: "cjs",
        source: `exports.alpha = 1;\nexports.beta = 2;`,
      },
      "reexporter.mjs": {
        path: "reexporter.js",
        format: "cjs",
        source: `module.exports = require("./impl");`,
      },
    });
    const mod = await import(pathToFileURL(join(dir, "reexporter.mjs")).href);
    expect(mod.alpha).toBe(1); // named export surfaced via the reexport
    expect(mod.beta).toBe(2);
    expect(mod.default).toEqual({ alpha: 1, beta: 2 }); // default still the object
  });

  it("throws on a computed require at execution time", async () => {
    const dir = await build({
      "bad.mjs": {
        path: "bad.js",
        format: "cjs",
        source: `const n = "x";\nmodule.exports = require("./" + n);`,
      },
    });
    await expect(import(pathToFileURL(join(dir, "bad.mjs")).href)).rejects.toThrow(
      /Cannot require \(computed\/unresolved\)/,
    );
  });
});

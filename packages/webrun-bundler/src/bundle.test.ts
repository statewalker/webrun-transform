import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { Source } from "@statewalker/webrun-modules";
import * as esbuild from "esbuild-wasm";
import { describe, expect, it } from "vitest";
import { bundle, chainPackages, nodeModulesPackages, npmPackages, transpile } from "./index.js";
import type { SourceMap } from "./types.js";

// esbuild-wasm itself (its Node build runs the same WebAssembly as in browsers); every
// file comes from a MemFilesApi, nothing from a disk.

const enc = new TextEncoder();
async function filesOf(tree: Record<string, string>): Promise<FilesApi> {
  const files = new MemFilesApi();
  for (const [path, text] of Object.entries(tree)) await files.write(path, [enc.encode(text)]);
  return files;
}

/** 1-based line of the first line of `text` containing `marker`. */
const lineOf = (text: string, marker: string) =>
  text.split("\n").findIndex((l) => l.includes(marker)) + 1;

/** Where the bundled line holding `marker` comes from. */
function trace(code: string, map: SourceMap, marker: string) {
  const lines = code.split("\n");
  const line = lines.findIndex((l) => l.includes(marker));
  expect(line, `${marker} in the bundle`).toBeGreaterThanOrEqual(0);
  const tm = new TraceMap(map as never);
  const text = lines[line] as string;
  // the first mapped column of the line
  for (let column = 0; column < text.length; column++) {
    const pos = originalPositionFor(tm, { line: line + 1, column });
    if (pos.source) return { source: pos.source, line: pos.line };
  }
  return { source: null, line: null };
}

// The original TypeScript of a published package: types and comments make its lines differ
// from the compiled JavaScript's, so a trace that ends at the .js would be off.
const ESM_PKG_SRC = `/** Greeting helpers. */
export interface Options {
  punctuation?: string;
}

export type Name = string;

export async function greet(name: Name, opts: Options = {}): Promise<string> {
  await Promise.resolve();
  return "hello " + name + (opts.punctuation ?? "!") + "MARK_ESM_PKG".slice(99);
}
`;

/** `esm-pkg` as npm ships it: compiled dist/, a linked map without sourcesContent, src/. */
async function esmPackage(): Promise<Record<string, string>> {
  const out = await esbuild.transform(ESM_PKG_SRC, {
    loader: "ts",
    sourcefile: "../src/index.ts",
    sourcemap: "external",
    format: "esm",
    target: "es2022",
  });
  const map = JSON.parse(out.map);
  delete map.sourcesContent; // many packages ship maps without it: the bundler reads src/
  return {
    "/package.json": JSON.stringify({
      name: "esm-pkg",
      version: "1.2.3",
      type: "module",
      exports: { ".": { browser: "./dist/browser.js", default: "./dist/index.js" } },
    }),
    "/dist/browser.js": `${out.code}//# sourceMappingURL=browser.js.map\n`,
    "/dist/browser.js.map": JSON.stringify(map),
    "/dist/index.js": 'export const greet = () => "not the browser build";\n',
    "/src/index.ts": ESM_PKG_SRC,
  };
}

const CJS_PKG = {
  "/package.json": JSON.stringify({ name: "cjs-pkg", version: "2.0.0", main: "lib/index.js" }),
  "/lib/index.js": `"use strict";
exports.shout = function (s) {
  return s.toUpperCase() + "!" + "MARK_CJS".slice(99);
};
`,
};

const APP = `import cjs from "cjs-pkg";
import { greet } from "esm-pkg";
import data from "./data.json";

export async function main(name: string): Promise<string> {
  const g = (await greet(name)) + "MARK_APP_AWAIT".slice(99);
  return \`\${g} \${cjs.shout(name)} \${data.v}\${"MARK_APP_RETURN".slice(99)}\`;
}
`;

/** A registry `Source` over in-memory packages; counts loads. */
function fakeRegistry(packages: Record<string, Record<string, string>>) {
  const loads: string[] = [];
  const source: Source = {
    matches: (ref) => "pkg" in ref,
    async load(ref) {
      if (!("pkg" in ref)) throw new Error("not a package");
      loads.push(`${ref.pkg}@${ref.version ?? "latest"}`);
      const tree = packages[ref.pkg];
      if (!tree) throw new Error(`no package ${ref.pkg}`);
      const files = await filesOf(tree);
      const manifest = JSON.parse(tree["/package.json"] as string);
      return { name: ref.pkg, version: manifest.version, files, manifest };
    },
  };
  return { source, loads };
}

async function run(code: string) {
  const bytes = enc.encode(code);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const url = `data:text/javascript;base64,${btoa(bin)}`;
  return import(/* @vite-ignore */ url);
}

describe("bundle", () => {
  it("bundles from a FilesApi with packages fetched on demand; every line traces to its source", async () => {
    const files = await filesOf({
      "/package.json": JSON.stringify({
        dependencies: { "esm-pkg": "^1.0.0", "cjs-pkg": "^2.0.0" },
      }),
      "/src/app.ts": APP,
      "/src/data.json": '{ "v": 42 }',
    });
    const { source, loads } = fakeRegistry({ "esm-pkg": await esmPackage(), "cjs-pkg": CJS_PKG });
    const r = await bundle({
      esbuild,
      files,
      entry: "/src/app.ts",
      packages: npmPackages({ source }),
    });

    expect(loads.sort()).toEqual(["cjs-pkg@^2.0.0", "esm-pkg@^1.0.0"]);
    expect((await run(r.code)).main).toBeTypeOf("function");
    expect(await (await run(r.code)).main("bob")).toBe("hello bob! BOB! 42");
    expect(r.code).toMatch(/\/\/# sourceMappingURL=bundle\.js\.map\n$/);

    // The user's TypeScript, line for line.
    expect(trace(r.code, r.map, "MARK_APP_AWAIT")).toEqual({
      source: "~/src/app.ts",
      line: lineOf(APP, "MARK_APP_AWAIT"),
    });
    expect(trace(r.code, r.map, "MARK_APP_RETURN")).toEqual({
      source: "~/src/app.ts",
      line: lineOf(APP, "MARK_APP_RETURN"),
    });
    // Through the package's own map, to its original TypeScript (not dist/browser.js).
    expect(trace(r.code, r.map, "MARK_ESM_PKG")).toEqual({
      source: "npm:esm-pkg@1.2.3/src/index.ts",
      line: lineOf(ESM_PKG_SRC, "MARK_ESM_PKG"),
    });
    // CommonJS, converted by esbuild, still maps to the package's file.
    expect(trace(r.code, r.map, "MARK_CJS")).toEqual({
      source: "npm:cjs-pkg@2.0.0/lib/index.js",
      line: 3,
    });
    // The map carries every source's text, the package's TypeScript included.
    const i = r.map.sources.indexOf("npm:esm-pkg@1.2.3/src/index.ts");
    expect(r.map.sourcesContent?.[i]).toBe(ESM_PKG_SRC);
    expect(r.map.sources).not.toContain("npm:esm-pkg@1.2.3/dist/browser.js");
  });

  it("sourcemap: false builds no map (the same code, no sourceMappingURL), warnings kept", async () => {
    const files = await filesOf({
      "/package.json": JSON.stringify({
        dependencies: { "esm-pkg": "^1.0.0", "cjs-pkg": "^2.0.0" },
      }),
      "/src/app.ts": APP,
      "/src/data.json": '{ "v": 42 }',
      // esbuild warns about a comparison with -0.
      "/src/warn.ts": "export const odd = (x: number) => x === -0;\n",
    });
    const { source } = fakeRegistry({ "esm-pkg": await esmPackage(), "cjs-pkg": CJS_PKG });
    await files.write("/src/entry.ts", [
      new TextEncoder().encode('export * from "./app.ts";\nexport * from "./warn.ts";\n'),
    ]);
    const r = await bundle({
      esbuild,
      files,
      entry: "/src/entry.ts",
      packages: npmPackages({ source }),
      sourcemap: false,
    });
    expect(await (await run(r.code)).main("bob")).toBe("hello bob! BOB! 42");
    expect(r.code).not.toMatch(/sourceMappingURL/);
    expect(r.map.mappings).toBe("");
    expect(r.map.sources).toEqual([]);
    expect(r.warnings?.map((w) => w.text).join(" ")).toMatch(/-0/);
  });

  it("maps every line that comes from an input; only esbuild's own helpers have no source", async () => {
    const files = await filesOf({
      "/package.json": JSON.stringify({
        dependencies: { "esm-pkg": "^1.0.0", "cjs-pkg": "^2.0.0" },
      }),
      "/src/app.ts": APP,
      "/src/data.json": '{ "v": 42 }',
    });
    const { source } = fakeRegistry({ "esm-pkg": await esmPackage(), "cjs-pkg": CJS_PKG });
    for (const lowerAwait of [false, true]) {
      const r = await bundle({
        esbuild,
        files,
        entry: "/src/app.ts",
        packages: npmPackages({ source }),
        lowerAwait,
      });
      const tm = new TraceMap(r.map as never);
      const lines = r.code.split("\n");
      // esbuild's runtime (`__commonJS`, `__toESM`, with lowering `__async`) comes first, up
      // to the first module's comment; it is the only code no input wrote.
      const firstModule = lines.findIndex((l) => l.startsWith("// webrun:"));
      expect(firstModule).toBeGreaterThan(0);
      // …and its closing `export { … };` clause, which lists the entry's exports.
      const exportClause = lines.lastIndexOf("export {");
      const unmapped: string[] = [];
      lines.slice(firstModule, exportClause < 0 ? undefined : exportClause).forEach((text, i) => {
        const code = text.trim();
        if (!code || code.startsWith("//") || /^[\]{}()[;,]+$/.test(code)) return;
        let mapped = false;
        for (let column = 0; column < text.length && !mapped; column++)
          mapped = !!originalPositionFor(tm, { line: firstModule + i + 1, column }).source;
        if (!mapped) unmapped.push(code);
      });
      // Besides them, only esbuild's CommonJS wrapper lines: `var require_x = __commonJS({`
      // and the module's function head.
      expect(
        unmapped.filter(
          (l) => !/^var require_\w+ = __commonJS\(\{$|^"webrun:[^"]+"\(.*\) \{$/.test(l),
        ),
      ).toEqual([]);
      if (lowerAwait) {
        expect(r.code).not.toMatch(/\bawait\b/);
        expect(trace(r.code, r.map, "MARK_APP_AWAIT").source).toBe("~/src/app.ts");
        expect(trace(r.code, r.map, "MARK_ESM_PKG").source).toBe("npm:esm-pkg@1.2.3/src/index.ts");
        expect(await (await run(r.code)).main("amy")).toBe("hello amy! AMY! 42");
      }
    }
  });

  it("reads packages from node_modules folders of the FilesApi, nested ones first", async () => {
    const files = await filesOf({
      "/src/main.js":
        'import { a } from "a";\nimport { v } from "b";\nexport const out = a + "/" + v;\n',
      "/node_modules/a/package.json": JSON.stringify({
        name: "a",
        version: "1.0.0",
        main: "index.js",
      }),
      "/node_modules/a/index.js": 'export { v as a } from "b";\n',
      "/node_modules/a/node_modules/b/package.json": JSON.stringify({
        name: "b",
        version: "2.0.0",
        module: "m.js",
      }),
      "/node_modules/a/node_modules/b/m.js": 'export const v = "b2" + "MARK_B2".slice(99);\n',
      "/node_modules/b/package.json": JSON.stringify({ name: "b", version: "1.0.0" }),
      "/node_modules/b/index.js": 'export const v = "b1";\n',
    });
    const r = await bundle({ esbuild, files, entry: "/src/main.js" });
    expect((await run(r.code)).out).toBe("b2/b1");
    expect(trace(r.code, r.map, "MARK_B2").source).toBe("npm:b@2.0.0/m.js");
    // a/index.js only re-exports: no code of its own, so esbuild maps nothing to it.
    expect(r.map.sources).toEqual(
      expect.arrayContaining(["~/src/main.js", "npm:b@2.0.0/m.js", "npm:b@1.0.0/index.js"]),
    );
  });

  it('gives files in a "type": "module" scope Node\'s CommonJS interop (tslib\'s modules/)', async () => {
    // tslib 2.3: exports "import" -> modules/index.js (modules/package.json: type module), which
    // does `import tslib from "../tslib.js"` of a CommonJS file that sets __esModule. In Node
    // (and Vite, which pre-bundles from disk) the default import is module.exports.
    const files = await filesOf({
      "/src/main.js": 'import { __extends } from "tslib";\nexport const out = typeof __extends;\n',
      "/node_modules/tslib/package.json": JSON.stringify({
        name: "tslib",
        version: "2.3.0",
        main: "tslib.js",
        exports: {
          ".": { import: "./modules/index.js", module: "./tslib.es6.js", default: "./tslib.js" },
        },
      }),
      "/node_modules/tslib/modules/package.json": JSON.stringify({ type: "module" }),
      "/node_modules/tslib/modules/index.js":
        'import tslib from "../tslib.js";\nconst { __extends } = tslib;\nexport { __extends };\n',
      "/node_modules/tslib/tslib.js":
        'Object.defineProperty(exports, "__esModule", { value: true });\nexports.__extends = function () {};\n',
      "/node_modules/tslib/tslib.es6.js": "export function __extends() {}\n",
    });
    const r = await bundle({
      esbuild,
      files,
      entry: "/src/main.js",
      conditions: ["browser", "import"],
    });
    expect((await run(r.code)).out).toBe("function");
    expect(r.map.sources).toContain("npm:tslib@2.3.0/modules/index.js");
  });

  it("keeps externals as imports, picks exports conditions, resolves .js to .ts and #imports", async () => {
    const files = await filesOf({
      "/package.json": JSON.stringify({ imports: { "#util": "./src/util.ts" } }),
      "/src/worker.ts":
        'import { DurableObject } from "cloudflare:workers";\nimport { readFileSync } from "node:fs";\nimport { which } from "dual";\nimport { util } from "#util";\nimport { helper } from "./helper.js";\nexport const all = [DurableObject, readFileSync, which, util, helper];\n',
      "/src/util.ts": 'export const util: string = "util";\n',
      "/src/helper.ts": 'export const helper: string = "helper";\n',
      "/node_modules/dual/package.json": JSON.stringify({
        name: "dual",
        version: "1.0.0",
        exports: { workerd: "./w.js", browser: "./b.js", default: "./d.js" },
      }),
      "/node_modules/dual/w.js": 'export const which = "workerd";\n',
      "/node_modules/dual/b.js": 'export const which = "browser";\n',
      "/node_modules/dual/d.js": 'export const which = "default";\n',
    });
    const r = await bundle({
      esbuild,
      files,
      entry: "/src/worker.ts",
      external: ["cloudflare:*", "node:*"],
      conditions: ["workerd", "worker", "browser"],
      platform: "neutral",
    });
    expect(r.code).toMatch(/from "cloudflare:workers"/);
    expect(r.code).toMatch(/from "node:fs"/);
    expect(r.code).toContain('"workerd"');
    expect(r.code).not.toContain('"browser"');
    expect(r.map.sources).toEqual(
      expect.arrayContaining([
        "~/src/worker.ts",
        "~/src/util.ts",
        "~/src/helper.ts",
        "npm:dual@1.0.0/w.js",
      ]),
    );
  });

  it("node_modules first, then the registry; unresolvable imports are esbuild errors", async () => {
    const files = await filesOf({
      "/package.json": JSON.stringify({ dependencies: { "cjs-pkg": "2" } }),
      "/src/main.js":
        'import local from "local";\nimport cjs from "cjs-pkg";\nexport const out = local + cjs.shout("a");\n',
      "/node_modules/local/package.json": JSON.stringify({ name: "local", version: "0.1.0" }),
      "/node_modules/local/index.js": 'export default "local:";\n',
    });
    const { source, loads } = fakeRegistry({ "cjs-pkg": CJS_PKG });
    const packages = chainPackages(nodeModulesPackages(), npmPackages({ source }));
    const r = await bundle({ esbuild, files, entry: "/src/main.js", packages });
    expect((await run(r.code)).out).toBe("local:A!");
    expect(loads).toEqual(["cjs-pkg@2"]);

    await files.write("/src/bad.js", [enc.encode('import "nowhere";\n')]);
    await expect(bundle({ esbuild, files, entry: "/src/bad.js", packages })).rejects.toThrow(
      /Could not resolve "nowhere"/,
    );
  });

  it("host modules (by name or function) and inject; their lines map to virtual:<specifier>", async () => {
    const files = await filesOf({
      "/src/main.ts":
        'import { env } from "cloudflare:workers";\nimport { join } from "node:path";\nimport { tag } from "./tag.ts";\nexport const out = [env.NAME, join("a", "b"), tag, new Response("r").kind];\n',
      "/src/tag.ts": 'export const tag: string = "tag";\n',
      "/src/shim.ts":
        'export class Response { kind = "shimmed"; constructor(public body: string) {} }\n',
    });
    const r = await bundle({
      esbuild,
      files,
      entry: "/src/main.ts",
      modules: (spec) =>
        spec === "cloudflare:workers"
          ? 'export const env = { NAME: "host-env" };\n'
          : spec.startsWith("node:")
            ? `export const join = (...p) => p.join("/") + ${JSON.stringify(`<${spec}>`)};\n`
            : undefined,
      inject: ["/src/shim.ts"],
    });
    expect((await run(r.code)).out).toEqual(["host-env", "a/b<node:path>", "tag", "shimmed"]);
    expect(r.map.sources).toEqual(
      expect.arrayContaining([
        "virtual:cloudflare:workers",
        "virtual:node:path",
        "~/src/main.ts",
        "~/src/shim.ts",
      ]),
    );
    // a record works too, and an unknown specifier still resolves as usual
    const r2 = await bundle({
      esbuild,
      files,
      entry: "/src/main.ts",
      modules: {
        "cloudflare:workers": "export const env = { NAME: 1 };\n",
        "node:path": "export const join = () => 2;\n",
      },
    });
    expect((await run(r2.code)).out.slice(0, 3)).toEqual([1, 2, "tag"]);
  });

  it("pnpm layouts: a package's own dependencies come from node_modules/.pnpm/node_modules", async () => {
    const files = await filesOf({
      "/app/main.js": 'import { a } from "a";\nexport const out = a;\n',
      // node_modules/a is a symlink into .pnpm in a real install; its dependency b is only
      // next to a's real directory, reachable through pnpm's hoisted links.
      "/app/node_modules/a/package.json": JSON.stringify({ name: "a", version: "1.0.0" }),
      "/app/node_modules/a/index.js": 'import { b } from "b";\nexport const a = "a+" + b;\n',
      "/app/node_modules/.pnpm/node_modules/b/package.json": JSON.stringify({
        name: "b",
        version: "4.0.0",
      }),
      "/app/node_modules/.pnpm/node_modules/b/index.js": 'export const b = "b";\n',
    });
    const r = await bundle({ esbuild, files, root: "/app", entry: "/main.js" });
    expect((await run(r.code)).out).toBe("a+b");
    expect(r.map.sources).toContain("npm:b@4.0.0/index.js");
  });

  it("inline maps: the bundle carries its own map", async () => {
    const files = await filesOf({ "/a.ts": "export const a: number = 1; // MARK_A\n" });
    const r = await bundle({ esbuild, files, entry: "/a.ts", sourcemap: "inline" });
    const b64 = /sourceMappingURL=data:application\/json;base64,(\S+)/.exec(r.code)?.[1];
    expect(
      JSON.parse(
        new TextDecoder().decode(Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0))),
      ),
    ).toEqual(r.map);
  });
});

describe("transpile", () => {
  it("one file, its map back to it; await lowered when asked", async () => {
    const src =
      "type T = number;\n\nexport async function f(x: T) {\n  return (await x) + 1 + 'MARK_F'.length * 0;\n}\n";
    const r = await transpile(src, { esbuild, path: "~/src/f.ts", lowerAwait: true });
    expect(r.code).not.toMatch(/\bawait\b/);
    expect(trace(r.code, r.map, "MARK_F")).toEqual({ source: "~/src/f.ts", line: 4 });
    expect(r.code).toMatch(/\/\/# sourceMappingURL=f\.js\.map\n$/);
  });
});

import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { PackageManifest, Source } from "../src/types.js";

type Pkg = { version: string; manifest: Partial<PackageManifest>; files: Record<string, string> };

/** In-memory Source: serves fixed packages from a map (no network). */
function memSource(pkgs: Record<string, Pkg>): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg in pkgs,
    async load(ref) {
      if (!("pkg" in ref)) throw new Error("bad ref");
      const p = pkgs[ref.pkg];
      const files = new MemFilesApi();
      for (const [path, content] of Object.entries(p.files))
        await writeText(files, `/${path}`, content);
      return {
        name: ref.pkg,
        version: p.version,
        files,
        manifest: { name: ref.pkg, version: p.version, ...p.manifest } as PackageManifest,
      };
    },
  };
}

// jszip@3.10.2's shape, reduced: an EXTENSIONLESS `main`, no `exports`, and a
// `browser` field that is an object — browserify's substitution MAP, in which the
// node entry is remapped to the pre-bundled browser build. The browser build is a
// UMD wrapper that publishes its value with `module.exports = <ctor>` (not
// `exports.x = …`), which is what the CJS interop has to carry through to `default`.
// It deliberately touches no allowlisted free global (`globalThis`, `process`, …),
// so the emitted artifact carries no `~deps/~globals.js` prelude and can be
// evaluated straight from a `data:` URL, which has no base to resolve against.
const UMD_CTOR = `(function (f) {
  if (typeof exports === "object" && typeof module !== "undefined") { module.exports = f(); }
  else if (typeof define === "function" && define.amd) { define([], f); }
  else { (typeof window !== "undefined" ? window : this).FakeZip = f(); }
})(function () {
  function FakeZip() { this.ok = true; }
  FakeZip.version = "9.9.9";
  return FakeZip;
});`;

const PKGS: Record<string, Pkg> = {
  fakezip: {
    version: "3.10.2",
    manifest: {
      main: "./lib/index",
      browser: {
        "./lib/index": "./dist/fakezip.min.js",
        "readable-stream": "./lib/readable-stream-browser.js",
      },
    },
    files: {
      "lib/index.js": `module.exports = function NodeOnly() {};`,
      "dist/fakezip.min.js": UMD_CTOR,
    },
  },
  // Same object-`browser` form, but nothing in the map remaps the entry: the
  // module/main entry must survive untouched.
  mapped: {
    version: "1.0.0",
    manifest: {
      main: "./lib/main.js",
      module: "./lib/esm.js",
      browser: { fs: false },
    },
    files: {
      "lib/main.js": `module.exports = 1;`,
      "lib/esm.js": `export const x = 1;`,
    },
  },
};

function server() {
  return newModuleServer({ cache: new MemFilesApi(), sources: [memSource(PKGS)] });
}

describe("legacy `browser` field as a substitution map", () => {
  it("resolves the entry through the map instead of fabricating index.js", async () => {
    const s = server();
    const { url } = await s.resolve({ pkg: "fakezip" });
    expect(url).toBe("/fakezip@3.10.2/dist/fakezip.min.js");
  });

  it("serves that entry (a fabricated index.js is not in the package)", async () => {
    const s = server();
    const { url } = await s.resolve({ pkg: "fakezip" });
    const res = await s.fetch(new Request(`http://h${url}`));
    expect(res.status).toBe(200);
  });

  it("keeps module/main when the map does not remap the entry", async () => {
    const s = server();
    const { url } = await s.resolve({ pkg: "mapped" });
    expect(url).toBe("/mapped@1.0.0/lib/esm.js");
  });

  it("binds `module.exports = <ctor>` to the served module's default", async () => {
    const s = server();
    const { url } = await s.resolve({ pkg: "fakezip" });
    const code = await (await s.fetch(new Request(`http://h${url}`))).text();
    // The served artifact is self-contained (no imports), so it can be evaluated
    // directly — a compile-only assertion would not have caught an empty default.
    const m = (await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    )) as { default: unknown };
    expect(typeof m.default).toBe("function");
    expect((m.default as { version: string }).version).toBe("9.9.9");
    expect(new (m.default as new () => { ok: boolean })().ok).toBe(true);
  });
});

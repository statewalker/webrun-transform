import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { PackageManifest, Source } from "../src/types.js";

// Offline fixture mirroring tests/server.test.ts's `memSource` pattern: the
// neighbouring tests in this directory never hit the network (see
// tests/_fixtures.ts and the in-memory `Source`s in tests/server.test.ts and
// tests/css-server.test.ts), so this test seeds its own fake "katex"/"wasm-pkg"
// packages instead of resolving the real `katex` / `@duckdb/duckdb-wasm` from
// the npm registry.
type Pkg = { version: string; manifest: Partial<PackageManifest>; files: Record<string, string> };

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

const PKGS: Record<string, Pkg> = {
  katex: {
    version: "0.18.7",
    manifest: { type: "module", main: "./index.js" },
    files: {
      "index.js": `export const ok = 1;`,
      "dist/fonts/KaTeX_AMS-Regular.woff2": "fake-woff2-bytes",
      "dist/fonts/KaTeX_AMS-Regular.woff": "fake-woff-bytes",
      "dist/fonts/KaTeX_AMS-Regular.ttf": "fake-ttf-bytes",
    },
  },
  "@duckdb/duckdb-wasm": {
    version: "1.33.1-dev57.0",
    manifest: { type: "module", main: "./index.js" },
    files: {
      "index.js": `export const ok = 1;`,
      "dist/duckdb-eh.wasm": "fake-wasm-bytes",
    },
  },
};

const mk = () => newModuleServer({ cache: new MemFilesApi(), sources: [memSource(PKGS)] });

describe("served content types", () => {
  it.each([
    ["dist/fonts/KaTeX_AMS-Regular.woff2", "font/woff2"],
    ["dist/fonts/KaTeX_AMS-Regular.woff", "font/woff"],
    ["dist/fonts/KaTeX_AMS-Regular.ttf", "font/ttf"],
  ])("serves %s as %s", async (file, expected) => {
    const server = mk();
    await server.resolve({ pkg: "katex" }); // warm the raw cache (see tests/server.test.ts)
    const res = await server.fetch(new Request(`http://h/katex@0.18.7/${file}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(expected);
  });

  it("still serves wasm as application/wasm", async () => {
    const server = mk();
    await server.resolve({ pkg: "@duckdb/duckdb-wasm" });
    const res = await server.fetch(
      new Request("http://h/@duckdb/duckdb-wasm@1.33.1-dev57.0/dist/duckdb-eh.wasm"),
    );
    expect(res.headers.get("content-type")).toBe("application/wasm");
  });
});

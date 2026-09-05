import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { PackageManifest, Source } from "../src/types.js";

/**
 * `ghost` is the shape that broke `import("esbuild")`: a package that RESOLVES —
 * it is on the registry and its manifest loads — but ships nothing to import. The
 * real one is `pnpapi`, Yarn PnP's virtual module, squatted on npm as a placeholder
 * carrying only a `package.json`; with no `main`, entry resolution falls through to
 * `index.js`, which does not exist.
 */
const ghostSource: Source = {
  matches: (ref) => "pkg" in ref && ref.pkg === "ghost",
  async load() {
    const files = new MemFilesApi();
    await writeText(files, "/package.json", `{"name":"ghost","version":"0.0.0"}`);
    return {
      name: "ghost",
      version: "0.0.0",
      files,
      manifest: { name: "ghost", version: "0.0.0" } as PackageManifest,
    };
  },
};

/** A CJS package using the optional-require idiom, plus one real dependency. */
const appSource: Source = {
  matches: (ref) => "pkg" in ref && ref.pkg === "app",
  async load() {
    const files = new MemFilesApi();
    await writeText(
      files,
      "/index.js",
      [
        "let opt;",
        'try { opt = require("ghost"); } catch (e) { opt = null; }',
        'const real = require("solid");',
        "module.exports = { hasOpt: !!opt, real: real.tag };",
      ].join("\n"),
    );
    return {
      name: "app",
      version: "1.0.0",
      files,
      manifest: {
        name: "app",
        version: "1.0.0",
        main: "./index.js",
        dependencies: { ghost: "0.0.0", solid: "1.0.0" },
      } as PackageManifest,
    };
  },
};

const solidSource: Source = {
  matches: (ref) => "pkg" in ref && ref.pkg === "solid",
  async load() {
    const files = new MemFilesApi();
    await writeText(files, "/index.js", `exports.tag = "solid";`);
    return {
      name: "solid",
      version: "1.0.0",
      files,
      manifest: { name: "solid", version: "1.0.0", main: "./index.js" } as PackageManifest,
    };
  },
};

const newServer = () =>
  newModuleServer({
    cache: new MemFilesApi(),
    sources: [appSource, ghostSource, solidSource],
  });

describe("optional require of a dependency with nothing to import", () => {
  it("does not emit an import for a specifier it cannot place", async () => {
    const code = await (await newServer().fetch(new Request("http://h/app@1.0.0/index.js"))).text();
    // Nothing may link to the ghost: a 404 on it fails the WHOLE graph, and the
    // source's own try/catch never gets to run.
    expect(code).not.toContain("~deps/ghost");
    // `require("ghost")` must still be reachable at runtime — and throw there.
    expect(code).toContain('require("ghost")');
  });

  it("still links the dependency that does resolve", async () => {
    const server = newServer();
    const code = await (await server.fetch(new Request("http://h/app@1.0.0/index.js"))).text();
    expect(code).toContain("~deps/solid");
    const proxy = await server.fetch(new Request("http://h/app@1.0.0/~deps/solid/index.js"));
    expect(proxy.status).toBe(200);
  });
});

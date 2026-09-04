import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { PackageManifest, Source } from "@statewalker/webrun-modules";
import { describe, expect, it } from "vitest";
import { newProjectBuild } from "./index.js";

/** In-memory Source serving fixed packages (no network) — mirrors build.test.ts. */
function memSource(
  pkgs: Record<string, { version: string; files: Record<string, string> }>,
): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg in pkgs,
    async load(ref) {
      if (!("pkg" in ref)) throw new Error("bad ref");
      const p = pkgs[ref.pkg];
      if (!p) throw new Error(`no pkg ${ref.pkg}`);
      const files = new MemFilesApi();
      for (const [path, content] of Object.entries(p.files)) {
        await writeText(files, `/${path}`, content);
      }
      return {
        name: ref.pkg,
        version: p.version,
        files,
        manifest: {
          name: ref.pkg,
          version: p.version,
          type: "module",
          main: "./index.js",
        } as PackageManifest,
      };
    },
  };
}

const PKGS = {
  greet: {
    version: "1.0.0",
    files: { "index.js": `export const hi = "hi";\nexport const yo = "yo";` },
  },
};

/** MemFilesApi stamps `lastModified` with `Date.now()`; a couple of ms guarantees
 *  the scanner sees a distinct mtime after an edit. */
const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * The accumulated export surface of a shared proxy is per-run in-memory state
 * (`ctx.proxies`), but the emitted proxy is durable. A second build in a FRESH
 * process walks only the changed importer, so without a durable record of the
 * accumulated shape the shared proxy is rewritten with that one importer's names
 * and the unchanged importer's already-emitted module imports names that no
 * longer exist.
 */
describe("newProjectBuild — a shared proxy never narrows across builds", () => {
  it("keeps both importers' names when a fresh build re-emits a shared npm proxy", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/a.ts", `import { hi } from "greet";\nexport const A = hi;`);
    await writeText(project, "/b.ts", `import { yo } from "greet";\nexport const B = yo;`);
    const cache = new MemFilesApi();
    const sources = [memSource(PKGS)];

    await newProjectBuild({ project, cache, sources }).build();
    const cold = await readText(cache, "/~/~deps/greet/index.js");
    expect(cold).toContain("hi");
    expect(cold).toContain("yo");
    // Both emitted modules import from the one shared proxy.
    expect(await readText(cache, "/~/a.js")).toContain(`"./~deps/greet/index.js"`);
    expect(await readText(cache, "/~/b.js")).toContain(`"./~deps/greet/index.js"`);

    await tick();
    await writeText(project, "/b.ts", `import { yo } from "greet";\nexport const B = yo + "!";`);

    // A brand-new engine + host over the SAME project + cache: `ctx.proxies` starts
    // empty and only `b.ts` is walked.
    await newProjectBuild({ project, cache, sources }).build();

    const warm = await readText(cache, "/~/~deps/greet/index.js");
    expect(warm).toContain("yo");
    expect(warm).toContain("hi"); // the unchanged importer's name must survive
  });

  it("keeps both importers' globals when a fresh build re-emits the globals proxy", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/a.ts", `export const A = process.env.NODE_ENV;`);
    await writeText(project, "/b.ts", `export const B = typeof Buffer;`);
    const cache = new MemFilesApi();

    await newProjectBuild({ project, cache }).build();
    const cold = await readText(cache, "/~/~deps/~globals.js");
    expect(cold).toContain("as process }");
    expect(cold).toContain("as Buffer }");

    await tick();
    await writeText(project, "/b.ts", `export const B = typeof Buffer + "!";`);

    await newProjectBuild({ project, cache }).build();

    const warm = await readText(cache, "/~/~deps/~globals.js");
    expect(warm).toContain("as Buffer }");
    expect(warm).toContain("as process }"); // the unchanged importer's global must survive
  });

  it("re-contributes a walked importer's globals even with no shape sidecar to seed from", async () => {
    // The globals key `""` must be resolved in `walkFrom`'s spec loop, like every
    // named specifier — NOT only in `jsTransform`, which sits behind the
    // `ctx.skipTransform` gate. Here `a.ts` is re-walked but content-identical, so
    // the gate skips its transform; with the sidecar removed (a cache written
    // before the sidecar existed) the spec loop is the ONLY thing that can put
    // `process` back into the accumulated shape.
    const project = new MemFilesApi();
    await writeText(project, "/a.ts", `export const A = process.env.NODE_ENV;`);
    await writeText(project, "/b.ts", `export const B = typeof Buffer;`);
    const cache = new MemFilesApi();

    await newProjectBuild({ project, cache }).build();
    expect(await cache.exists("/~/~deps/~globals.js.shape.json")).toBe(true);
    await cache.remove("/~/~deps/~globals.js.shape.json"); // nothing left to seed from

    await tick();
    await writeText(project, "/a.ts", `export const A = process.env.NODE_ENV;`); // same bytes
    await writeText(project, "/b.ts", `export const B = typeof Buffer + "!";`); // changed

    await newProjectBuild({ project, cache }).build();

    const warm = await readText(cache, "/~/~deps/~globals.js");
    expect(warm).toContain("as Buffer }");
    expect(warm).toContain("as process }");
  });
});

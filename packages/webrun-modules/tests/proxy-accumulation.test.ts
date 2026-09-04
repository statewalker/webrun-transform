import { readText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import type { PreprocessContext } from "../src/preprocess/context.js";
import { ensureGlobalsProxy, ensureProxy } from "../src/preprocess/resolve.js";

/** A partial context carrying only what the proxy writers touch. The codebase
 *  already casts partial contexts in tests (see webrun-modules-build's
 *  url-policy.test.ts), because building a full context needs a network source. */
function mkCtx(cache: MemFilesApi): PreprocessContext {
  return {
    cache,
    depsPath: "",
    tRoot: "/t/browser",
    inflight: new Map(),
    proxies: new Map(),
    globals: { process: "globalThis.process", Buffer: "globalThis.Buffer" },
    policy: {
      servedUrl: (targetId: string) => `./${targetId}`,
      emittedPath: (id: string) => `/t/browser/${id}`,
    },
  } as unknown as PreprocessContext;
}

const PID = "~/~deps/react/index.js";
const HOST = { kind: "host", name: "react" } as const;

describe("proxy shape accumulation", () => {
  it("unions the export surface across importers with different shapes", async () => {
    const cache = new MemFilesApi();
    const ctx = mkCtx(cache);
    await ensureProxy(
      PID,
      HOST,
      { names: ["useState"], hasDefault: true, hasNamespace: false },
      ctx,
    );
    await ensureProxy(
      PID,
      HOST,
      { names: ["useEffect"], hasDefault: false, hasNamespace: false },
      ctx,
    );
    const body = await readText(cache, "/t/browser/~/~deps/react/index.js");
    expect(body).toContain('globalThis.__webrunHostRegistry.get("react")');
    expect(body).toContain("export default __m"); // kept from the first importer
    expect(body).toContain("export const useState = __m.useState");
    expect(body).toContain("export const useEffect = __m.useEffect");
  });

  it("does not rewrite when a later importer adds nothing", async () => {
    const cache = new MemFilesApi();
    const ctx = mkCtx(cache);
    const imp = { names: ["useState"], hasDefault: false, hasNamespace: false };
    await ensureProxy(PID, HOST, imp, ctx);
    const first = await readText(cache, "/t/browser/~/~deps/react/index.js");
    await ensureProxy(PID, HOST, { ...imp, names: ["useState"] }, ctx);
    expect(await readText(cache, "/t/browser/~/~deps/react/index.js")).toBe(first);
  });

  it("keeps both names when two importers race on one proxy id", async () => {
    // The regression test for the single-flight hazard: coalescing two calls that
    // carry DIFFERENT imps would drop the loser's names.
    const cache = new MemFilesApi();
    const ctx = mkCtx(cache);
    await Promise.all([
      ensureProxy(PID, HOST, { names: ["useState"], hasDefault: false, hasNamespace: false }, ctx),
      ensureProxy(PID, HOST, { names: ["useEffect"], hasDefault: false, hasNamespace: false }, ctx),
    ]);
    const body = await readText(cache, "/t/browser/~/~deps/react/index.js");
    expect(body).toContain("export const useState = __m.useState");
    expect(body).toContain("export const useEffect = __m.useEffect");
  });

  it("throws when two specifiers reach one path with unequal bindings", async () => {
    const cache = new MemFilesApi();
    const ctx = mkCtx(cache);
    const imp = { names: [], hasDefault: true, hasNamespace: false };
    await ensureProxy(PID, HOST, imp, ctx);
    await expect(
      ensureProxy(PID, { kind: "local", url: "react@19.0.0/index.js" }, imp, ctx),
    ).rejects.toThrow(/conflicting bindings/);
  });

  it("unions the globals proxy name set across importers", async () => {
    const cache = new MemFilesApi();
    const ctx = mkCtx(cache);
    const gid = "~/~deps/~globals.js";
    await ensureGlobalsProxy(gid, ["process"], ctx);
    await ensureGlobalsProxy(gid, ["Buffer"], ctx);
    const body = await readText(cache, "/t/browser/~/~deps/~globals.js");
    expect(body).toContain("as process }");
    expect(body).toContain("as Buffer }");
  });
});

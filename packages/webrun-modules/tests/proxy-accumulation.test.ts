import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { readText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import type { PreprocessContext } from "../src/preprocess/context.js";
import { ensureGlobalsProxy, ensureProxy } from "../src/preprocess/resolve.js";

/**
 * Delays the FIRST call to `write` so it settles after a later call — makes a
 * same-key write race deterministic instead of relying on FIFO luck. Delegates
 * every other method verbatim.
 */
class DelayFirstWriteFilesApi implements FilesApi {
  private writeCount = 0;
  constructor(private readonly delegate: FilesApi) {}

  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void> {
    const isFirst = ++this.writeCount === 1;
    const run = () => this.delegate.write(path, content);
    return isFirst ? new Promise<void>((resolve) => setTimeout(resolve, 20)).then(run) : run();
  }

  read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    return this.delegate.read(path, options);
  }
  mkdir(path: string): Promise<void> {
    return this.delegate.mkdir(path);
  }
  list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    return this.delegate.list(path, options);
  }
  stats(path: string): Promise<FileStats | undefined> {
    return this.delegate.stats(path);
  }
  exists(path: string): Promise<boolean> {
    return this.delegate.exists(path);
  }
  remove(path: string): Promise<boolean> {
    return this.delegate.remove(path);
  }
  move(source: string, target: string): Promise<boolean> {
    return this.delegate.move(source, target);
  }
  copy(source: string, target: string): Promise<boolean> {
    return this.delegate.copy(source, target);
  }
}

/** A partial context carrying only what the proxy writers touch. The codebase
 *  already casts partial contexts in tests (see webrun-modules-build's
 *  url-policy.test.ts), because building a full context needs a network source. */
function mkCtx(cache: FilesApi): PreprocessContext {
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

  it("keeps the fuller shape even when the stale write settles LAST", async () => {
    // Regression test for the write-ordering hazard: two `ensureProxy` calls for
    // one pid build their bodies at different times and `await writeText` onto
    // the SAME cache key with nothing ordering the two writes. This wraps the
    // cache so the FIRST write (the thinner, stale one, built before the second
    // importer's shape merged in) settles strictly after the second (fuller)
    // write — reproducing the exact interleaving that a plain `Promise.all` only
    // reproduces by FIFO luck. If the stale write lands last, it silently wins
    // and `ctx.proxies` already holds the union, so nothing ever repairs it.
    const cache = new DelayFirstWriteFilesApi(new MemFilesApi());
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

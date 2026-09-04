import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newHostRegistry } from "../src/deps/host-registry.js";
import { normalizeDepsFolder } from "../src/preprocess/context.js";
import { newModuleServer } from "../src/server/new-module-server.js";

describe("normalizeDepsFolder", () => {
  it("accepts a single non-empty path segment", () => {
    expect(normalizeDepsFolder("~deps")).toBe("~deps");
    expect(normalizeDepsFolder("vendor")).toBe("vendor");
    expect(normalizeDepsFolder(".deps")).toBe(".deps");
    expect(normalizeDepsFolder("deps_2")).toBe("deps_2");
  });

  it("rejects anything that is not one segment", () => {
    expect(() => normalizeDepsFolder("")).toThrow(/single non-empty path segment/);
    expect(() => normalizeDepsFolder("a/b")).toThrow(/single non-empty path segment/);
    expect(() => normalizeDepsFolder(".")).toThrow(/single non-empty path segment/);
    expect(() => normalizeDepsFolder("..")).toThrow(/single non-empty path segment/);
  });

  it("rejects characters that are unsafe as a URL path segment", () => {
    expect(() => normalizeDepsFolder("a?b")).toThrow(/single non-empty path segment/);
    expect(() => normalizeDepsFolder("a#b")).toThrow(/single non-empty path segment/);
    expect(() => normalizeDepsFolder("a b")).toThrow(/single non-empty path segment/);
    expect(() => normalizeDepsFolder("a\\b")).toThrow(/single non-empty path segment/);
  });
});

describe("depsFolder option", () => {
  it("serves proxies from the configured folder instead of ~deps", async () => {
    const p = new MemFilesApi();
    await p.write("/app.ts", [
      new TextEncoder().encode(`import React from "react"; export const A = React;`),
    ]);
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project: p,
      provided: newHostRegistry({ react: { marker: "ME" } }),
      depsFolder: "vendor",
    });
    await server.prime({ url: "/app.ts" });
    const code = await (await server.fetch(new Request("http://h/~/app.ts"))).text();
    expect(code).toContain("./vendor/react/index.js");
    expect(code).not.toContain("~deps");
    const proxy = await server.fetch(new Request("http://h/~/vendor/react/index.js"));
    expect(proxy.status).toBe(200);
    expect(await proxy.text()).toContain('globalThis.__webrunHostRegistry.get("react")');
  });

  it("404s an uncached path under the configured folder instead of falling through to a live transform", async () => {
    // A REAL project file sits at the exact path the `vendor` proxy folder would
    // occupy, so if the 404 guard's folder check were wrong (e.g. still hardcoded
    // to `~deps`) the request would fall through to `transformAndCache` and this
    // file WOULD transform successfully (it's valid, cache-free JS) — giving a
    // false-negative 200 that a "just throws" fixture can't distinguish. No
    // `prime()` is called, so `${tRoot}/${id}` is never cached and `cached` is
    // false at fetch time: the only thing that can produce a 404 here is the
    // guard's `id.includes(\`/${ctx.depsFolder}/\`)` check firing correctly.
    const p = new MemFilesApi();
    await p.write("/vendor/vue/index.js", [new TextEncoder().encode(`export const A = 1;`)]);
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project: p,
      depsFolder: "vendor",
    });
    const res = await server.fetch(new Request("http://h/~/vendor/vue/index.js"));
    expect(res.status).toBe(404);
  });
});

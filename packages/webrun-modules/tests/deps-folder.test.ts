import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newHostRegistry } from "../src/deps/host-registry.js";
import { normalizeDepsFolder } from "../src/preprocess/context.js";
import { newModuleServer } from "../src/server/new-module-server.js";

describe("normalizeDepsFolder", () => {
  it("accepts a single non-empty path segment", () => {
    expect(normalizeDepsFolder("~deps")).toBe("~deps");
    expect(normalizeDepsFolder("vendor")).toBe("vendor");
  });

  it("rejects anything that is not one segment", () => {
    expect(() => normalizeDepsFolder("")).toThrow(/single non-empty path segment/);
    expect(() => normalizeDepsFolder("a/b")).toThrow(/single non-empty path segment/);
    expect(() => normalizeDepsFolder(".")).toThrow(/single non-empty path segment/);
    expect(() => normalizeDepsFolder("..")).toThrow(/single non-empty path segment/);
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
});

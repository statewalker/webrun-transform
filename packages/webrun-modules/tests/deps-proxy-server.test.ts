import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newHostRegistry } from "../src/deps/host-registry.js";
import { newModuleServer } from "../src/server/new-module-server.js";

// A project file that imports a provided module + uses a free global.
function projectWith(source: string) {
  const p = new MemFilesApi();
  return { p, ready: p.write("/app.ts", [new TextEncoder().encode(source)]) };
}

describe("~deps proxy layer", () => {
  it("rewrites a provided import to a ~deps proxy that reads the host registry", async () => {
    const registry = newHostRegistry({ react: { useState: () => 0, marker: "ME" } });
    const { p, ready } = projectWith(
      `import React, { useState } from "react";\nexport const v = useState;`,
    );
    await ready;
    const cache = new MemFilesApi();
    const server = newModuleServer({ cache, project: p, provided: registry });

    const res = await server.fetch(new Request("http://h/~/app.ts"));
    const code = await res.text();
    // The module imports only relative / ./~deps/* — no bare "react".
    expect(code).toContain("./~deps/react/index.js");
    expect(code).not.toContain('from "react"');

    // The proxy reads the shared registry (identity path).
    const proxy = await server.fetch(new Request("http://h/~/~deps/react/index.js"));
    const proxyCode = await proxy.text();
    expect(proxyCode).toContain('globalThis.__webrunHostRegistry.get("react")');
    expect(proxyCode).toContain("export const useState = __m.useState");
  });

  it("prepends a globals proxy import for a free global (process) and never for a declared one", async () => {
    const { p, ready } = projectWith(`export const env = process.env.NODE_ENV;`);
    await ready;
    const server = newModuleServer({ cache: new MemFilesApi(), project: p, target: "browser" });
    const code = await (await server.fetch(new Request("http://h/~/app.ts"))).text();
    expect(code).toContain("./~deps/~globals.js");
    const g = await (await server.fetch(new Request("http://h/~/~deps/~globals.js"))).text();
    expect(g).toContain("export { __g0 as process }"); // alias form (no TDZ)
  });

  it("emits a globals proxy for `globalThis`/`global` that loads without a TDZ ReferenceError", async () => {
    const { p, ready } = projectWith(`export const a = global;\nexport const b = globalThis;`);
    await ready;
    const server = newModuleServer({ cache: new MemFilesApi(), project: p, target: "browser" });
    await server.fetch(new Request("http://h/~/app.ts")); // generate the globals proxy
    const g = await (await server.fetch(new Request("http://h/~/~deps/~globals.js"))).text();
    // The self-referential `export const globalThis = globalThis` form is the bug.
    expect(g).not.toContain("export const globalThis");
    expect(g).not.toContain("export const global ");
    expect(g).toContain("as globalThis }"); // alias
    expect(g).toContain("as global }"); // alias
    // Strongest check: the served module actually evaluates without throwing.
    const mod = await import(`data:text/javascript,${encodeURIComponent(g)}`);
    expect(mod.globalThis).toBe(globalThis);
    expect(mod.global).toBe(globalThis);
  });

  it("routes an ordinary npm import through a local proxy (custom source, no network)", async () => {
    // Minimal in-memory Source for a fake package "dep".
    const files = new MemFilesApi();
    await files.write("/index.js", [new TextEncoder().encode(`export const hi = 1;`)]);
    await files.write("/package.json", [
      new TextEncoder().encode(`{"name":"dep","version":"1.0.0"}`),
    ]);
    const source = {
      matches: (r: unknown) => typeof r === "object" && r !== null && "pkg" in r,
      load: async () => ({
        name: "dep",
        version: "1.0.0",
        files,
        manifest: { name: "dep", version: "1.0.0" },
      }),
    };
    const { p, ready } = projectWith(`import { hi } from "dep";\nexport const v = hi;`);
    await ready;
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project: p,
      sources: [source as never],
    });
    const code = await (await server.fetch(new Request("http://h/~/app.ts"))).text();
    expect(code).toContain("./~deps/dep/index.js");
    const proxy = await (await server.fetch(new Request("http://h/~/~deps/dep/index.js"))).text();
    expect(proxy).toContain("export { hi } from");
    expect(proxy).toContain("dep@1.0.0/index.js"); // re-exports the pinned local endpoint
  });

  it("sees a name registered LATE on the passed live registry (it IS the realm-global)", async () => {
    // The registry is empty at construction; `react` is set afterwards. Because a
    // live HostRegistry becomes globalThis[KEY], providedNames + the served proxy
    // both read the same object, so the late name binds to host (not local).
    const registry = newHostRegistry();
    const { p, ready } = projectWith(
      `import { useState } from "react";\nexport const v = useState;`,
    );
    await ready;
    const server = newModuleServer({ cache: new MemFilesApi(), project: p, provided: registry });
    registry.set("react", { useState: () => 0 }); // late registration

    const code = await (await server.fetch(new Request("http://h/~/app.ts"))).text();
    expect(code).toContain("./~deps/react/index.js");
    const proxy = await (await server.fetch(new Request("http://h/~/~deps/react/index.js"))).text();
    expect(proxy).toContain('globalThis.__webrunHostRegistry.get("react")'); // host, not local
  });

  it("does not treat a free identifier named like an Object.prototype member as a global (I1)", async () => {
    // `toString` is a free global here, but it is NOT an own key of the allowlist —
    // `n in globalsMap` would falsely match it (prototype chain) and emit a broken
    // `export const toString = function toString(){…}` module. `Object.hasOwn` must not.
    const { p, ready } = projectWith(`export const x = toString;`);
    await ready;
    const server = newModuleServer({ cache: new MemFilesApi(), project: p });
    const code = await (await server.fetch(new Request("http://h/~/app.ts"))).text();
    expect(code).not.toContain("./~deps/~globals.js"); // no globals proxy prepended
    expect(code).not.toContain("export const toString"); // never a broken globals export
    // and the (never-generated) globals proxy is a 404, not a syntax-error module
    const g = await server.fetch(new Request("http://h/~/~deps/~globals.js"));
    expect(g.status).toBe(404);
  });

  it("binds a provided-root subpath to the registered root key, not the full spec (I2)", async () => {
    // Only `react` is registered; `react/jsx-runtime` (sucrase auto-injects it for
    // any JSX) must bind host to `react`, not the unregistered `react/jsx-runtime`.
    const { p, ready } = projectWith(
      `import { jsx } from "react/jsx-runtime";\nexport const j = jsx;`,
    );
    await ready;
    const rootServer = newModuleServer({
      cache: new MemFilesApi(),
      project: p,
      provided: newHostRegistry({ react: { jsx: () => 0 } }), // ROOT only
    });
    await rootServer.fetch(new Request("http://h/~/app.ts")); // generate the proxy
    const rootProxy = await (
      await rootServer.fetch(new Request("http://h/~/~deps/react/jsx-runtime.js"))
    ).text();
    expect(rootProxy).toContain('globalThis.__webrunHostRegistry.get("react")');
    expect(rootProxy).not.toContain('.get("react/jsx-runtime")');

    // …but an explicitly-registered subpath uses its own key (most specific wins).
    const { p: p2, ready: ready2 } = projectWith(
      `import { jsx } from "react/jsx-runtime";\nexport const j = jsx;`,
    );
    await ready2;
    const subServer = newModuleServer({
      cache: new MemFilesApi(),
      project: p2,
      provided: newHostRegistry({ "react/jsx-runtime": { jsx: () => 0 } }),
    });
    await subServer.fetch(new Request("http://h/~/app.ts")); // generate the proxy
    const subProxy = await (
      await subServer.fetch(new Request("http://h/~/~deps/react/jsx-runtime.js"))
    ).text();
    expect(subProxy).toContain('globalThis.__webrunHostRegistry.get("react/jsx-runtime")');
  });

  it("two modules importing a provided react see the SAME instance (identity)", async () => {
    const instance = { useState: () => 0, tag: Symbol("react") };
    const registry = newHostRegistry({ react: instance });
    const p = new MemFilesApi();
    await p.write("/a.ts", [
      new TextEncoder().encode(`import React from "react"; export const A = React;`),
    ]);
    await p.write("/b.ts", [
      new TextEncoder().encode(`import { useState } from "react"; export const B = useState;`),
    ]);
    const server = newModuleServer({ cache: new MemFilesApi(), project: p, provided: registry });
    await server.prime({ url: "/a.ts" });
    await server.prime({ url: "/b.ts" });
    // Both importers share ONE proxy at the project root; its body is the union of
    // their shapes, and it reads the one registry entry → identity holds at runtime.
    const proxy = await (await server.fetch(new Request("http://h/~/~deps/react/index.js"))).text();
    expect(proxy).toContain('globalThis.__webrunHostRegistry.get("react")');
    expect(proxy).toContain("export default __m"); // from a.ts: `import React from "react"`
    expect(proxy).toContain("export const useState = __m.useState"); // from b.ts: `{ useState }`
    // No npm react was fetched (identity, not a copy):
    const files = await server.listResources({ url: "/a.ts" });
    expect(files.some((u) => u.includes("react@"))).toBe(false);
  });

  it("class-as-adapter-key: two importers share one root proxy, so the class is one reference", async () => {
    class K {}
    const registry = newHostRegistry({ "@app/keys": { K } });
    const p = new MemFilesApi();
    await p.write("/a.ts", [
      new TextEncoder().encode(`import { K } from "@app/keys"; export const A = K;`),
    ]);
    await p.write("/b.ts", [
      new TextEncoder().encode(`import { K } from "@app/keys"; export const B = K;`),
    ]);
    const server = newModuleServer({ cache: new MemFilesApi(), project: p, provided: registry });
    await server.fetch(new Request("http://h/~/a.ts")); // generates a.ts's proxy
    await server.fetch(new Request("http://h/~/b.ts")); // generates b.ts's proxy
    const proxy = await (
      await server.fetch(new Request("http://h/~/~deps/@app/keys/index.js"))
    ).text();
    expect(proxy).toContain('globalThis.__webrunHostRegistry.get("@app/keys")');
    expect(proxy).toContain("export const K = __m.K");
  });

  it("namespace import of an ordinary npm dep works via export *", async () => {
    const files = new MemFilesApi();
    await files.write("/index.js", [
      new TextEncoder().encode(`export const a = 1; export const b = 2;`),
    ]);
    await files.write("/package.json", [
      new TextEncoder().encode(`{"name":"ns","version":"1.0.0"}`),
    ]);
    const source = {
      matches: () => true,
      load: async () => ({
        name: "ns",
        version: "1.0.0",
        files,
        manifest: { name: "ns", version: "1.0.0" },
      }),
    };
    const p = new MemFilesApi();
    await p.write("/app.ts", [
      new TextEncoder().encode(`import * as ns from "ns"; export const v = ns;`),
    ]);
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project: p,
      sources: [source as never],
    });
    await server.fetch(new Request("http://h/~/app.ts")); // generates the proxy
    const proxy = await (await server.fetch(new Request("http://h/~/~deps/ns/index.js"))).text();
    expect(proxy).toContain("export * from");
  });

  it("re-link: a custom resolver changes only the proxy body, not the module's own imports", async () => {
    const src = `import x from "dep"; export const v = x;`;
    const pA = new MemFilesApi();
    await pA.write("/app.ts", [new TextEncoder().encode(src)]);
    const pB = new MemFilesApi();
    await pB.write("/app.ts", [new TextEncoder().encode(src)]);
    const localish = {
      matches: () => true,
      load: async () => {
        const f = new MemFilesApi();
        await f.write("/index.js", [new TextEncoder().encode("export default 1;")]);
        await f.write("/package.json", [
          new TextEncoder().encode(`{"name":"dep","version":"1.0.0"}`),
        ]);
        return {
          name: "dep",
          version: "1.0.0",
          files: f,
          manifest: { name: "dep", version: "1.0.0" },
        };
      },
    };
    const sA = newModuleServer({
      cache: new MemFilesApi(),
      project: pA,
      sources: [localish as never],
    });
    const cdnResolver = {
      resolve: async (spec: string) => ({ kind: "cdn" as const, url: `https://esm.sh/${spec}` }),
    };
    const sB = newModuleServer({
      cache: new MemFilesApi(),
      project: pB,
      sources: [localish as never],
      resolveEndpoint: cdnResolver,
    });
    const codeA = await (await sA.fetch(new Request("http://h/~/app.ts"))).text();
    const codeB = await (await sB.fetch(new Request("http://h/~/app.ts"))).text();
    // The module is env-agnostic: it imports the SAME relative proxy path
    // regardless of resolver — only the proxy body differs.
    expect(codeA).toContain("./~deps/dep/index.js");
    expect(codeB).toContain("./~deps/dep/index.js");
    const proxyB = await (await sB.fetch(new Request("http://h/~/~deps/dep/index.js"))).text();
    expect(proxyB).toContain("https://esm.sh/dep");
  });

  it("env-agnostic output: every import in a transformed module is relative or ./~deps/*", async () => {
    const registry = newHostRegistry({ react: { useState: () => 0 } });
    const files = new MemFilesApi();
    await files.write("/index.js", [new TextEncoder().encode(`export const hi = 1;`)]);
    await files.write("/package.json", [
      new TextEncoder().encode(`{"name":"dep","version":"1.0.0"}`),
    ]);
    const source = {
      matches: () => true,
      load: async () => ({
        name: "dep",
        version: "1.0.0",
        files,
        manifest: { name: "dep", version: "1.0.0" },
      }),
    };
    const p = new MemFilesApi();
    await p.write("/lib.ts", [new TextEncoder().encode(`export const lib = 1;`)]);
    await p.write("/app.ts", [
      new TextEncoder().encode(
        `import React from "react";\nimport { hi } from "dep";\nimport { lib } from "./lib.ts";\nexport const v = [React, hi, lib];`,
      ),
    ]);
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project: p,
      provided: registry,
      sources: [source as never],
    });
    const code = await (await server.fetch(new Request("http://h/~/app.ts"))).text();
    const specifiers = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec.startsWith(".")).toBe(true); // relative — no bare specifier, no absolute/CDN URL
    }
  });

  it("marks proxy responses no-cache so a later importer's widened body is seen", async () => {
    const { p, ready } = projectWith(`import React from "react"; export const A = React;`);
    await ready;
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project: p,
      provided: newHostRegistry({ react: { marker: "ME" } }),
    });
    await server.prime({ url: "/app.ts" });
    const proxy = await server.fetch(new Request("http://h/~/~deps/react/index.js"));
    expect(proxy.status).toBe(200);
    expect(proxy.headers.get("cache-control")).toBe("no-cache");
    // A normal module keeps its existing (absent) cache header.
    const mod = await server.fetch(new Request("http://h/~/app.ts"));
    expect(mod.headers.get("cache-control")).toBe(null);
  });
});

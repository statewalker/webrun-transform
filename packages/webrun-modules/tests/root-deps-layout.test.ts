import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newHostRegistry } from "../src/deps/host-registry.js";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { PackageManifest, Source } from "../src/types.js";

/** In-memory Source serving one vendored package that itself imports `react`. */
function memSource(): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg === "widget",
    async load() {
      const files = new MemFilesApi();
      await writeText(
        files,
        "/index.js",
        `import { useState } from "react";\nexport const w = () => useState(0);`,
      );
      return {
        name: "widget",
        version: "1.0.0",
        files,
        manifest: {
          name: "widget",
          version: "1.0.0",
          type: "module",
          main: "./index.js",
          dependencies: { react: "^19" },
        } as PackageManifest,
      };
    },
  };
}

describe("module-root ~deps layout", () => {
  it("an authored file and a vendored package each bind react through their OWN root proxy, to one instance", async () => {
    const instance = { useState: () => 0, tag: "THE-ONE" };
    const p = new MemFilesApi();
    await writeText(
      p,
      "/app.ts",
      `import React from "react";\nimport { w } from "widget";\nexport const A = [React, w];`,
    );
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project: p,
      sources: [memSource()],
      provided: newHostRegistry({ react: instance }),
    });
    await server.prime({ url: "/app.ts" });

    // Two module roots → two proxies, each at its own root, both reading the SAME
    // registry key. That single key is what makes the instance shared.
    const authored = await server.fetch(new Request("http://h/~/~deps/react/index.js"));
    const vendored = await server.fetch(new Request("http://h/widget@1.0.0/~deps/react/index.js"));
    expect(authored.status).toBe(200);
    expect(vendored.status).toBe(200);
    expect(await authored.text()).toContain('globalThis.__webrunHostRegistry.get("react")');
    expect(await vendored.text()).toContain('globalThis.__webrunHostRegistry.get("react")');

    // The vendored package's own file points UP to its package root, not sideways.
    const widget = await (await server.fetch(new Request("http://h/widget@1.0.0/index.js"))).text();
    expect(widget).toContain(`from "./~deps/react/index.js"`);

    // No npm react was ever fetched — identity, not a copy.
    const urls = await server.listResources({ url: "/app.ts" });
    expect(urls.some((u) => u.includes("react@"))).toBe(false);
  });

  it("re-priming over a warm cache converges back to the full export union", async () => {
    // The accumulator is per-run and starts empty, so a second server re-writes a
    // proxy left complete by the first. It converges because walkFrom resolves
    // every node's specifiers on every run — the incremental gate skips transforms,
    // never resolution.
    const p = new MemFilesApi();
    await writeText(p, "/main.ts", `import "./a.js";\nimport "./b.js";`);
    await writeText(p, "/a.ts", `import React from "react";\nexport const A = React;`);
    await writeText(p, "/b.ts", `import { useState } from "react";\nexport const B = useState;`);
    const cache = new MemFilesApi();
    const mk = () =>
      newModuleServer({
        cache,
        project: p,
        provided: newHostRegistry({ react: { useState: () => 0 } }),
      });

    await mk().prime({ url: "/main.ts" });
    const first = await (await mk().fetch(new Request("http://h/~/~deps/react/index.js"))).text();
    expect(first).toContain("export default __m");
    expect(first).toContain("export const useState = __m.useState");

    // A second, independent server over the SAME cache: fresh empty accumulator.
    await mk().prime({ url: "/main.ts" });
    const second = await (await mk().fetch(new Request("http://h/~/~deps/react/index.js"))).text();
    expect(second).toContain("export default __m");
    expect(second).toContain("export const useState = __m.useState");
  });
});

import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { PackageManifest, Source } from "../src/types.js";

/**
 * A package whose file is present and readable but imports something no source can
 * supply — astro's shape, where `dist/content/mutable-data-store.js` imports the
 * virtual module `astro:data-layer-content` and the registry 404s it.
 */
const appSource: Source = {
  matches: (ref) => "pkg" in ref && ref.pkg === "app",
  async load() {
    const files = new MemFilesApi();
    await writeText(files, "/index.js", `import x from "no-such-dep";\nexport default x;`);
    return {
      name: "app",
      version: "1.0.0",
      files,
      manifest: { name: "app", version: "1.0.0", main: "./index.js" } as PackageManifest,
    };
  },
};

const newServer = () => newModuleServer({ cache: new MemFilesApi(), sources: [appSource] });

describe("failure reporting", () => {
  it("reports a file it cannot process as 500, with the reason", async () => {
    const res = await newServer().fetch(new Request("http://h/app@1.0.0/index.js"));
    // 404 would say "this file does not exist" about a file that plainly does, and
    // a bodiless one discards the only explanation anyone gets.
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("no-such-dep");
  });

  it("still reports a genuinely missing file as 404", async () => {
    const res = await newServer().fetch(new Request("http://h/app@1.0.0/nope.js"));
    expect(res.status).toBe(404);
  });

  it("still reports a missing package as 404", async () => {
    const res = await newServer().fetch(new Request("http://h/absent@9.9.9/index.js"));
    expect(res.status).toBe(404);
  });
});

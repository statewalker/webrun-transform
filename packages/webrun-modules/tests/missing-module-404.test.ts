import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { PackageManifest, Source } from "../src/types.js";

/**
 * A missing file read through `FilesApi` yields zero bytes rather than an error,
 * so an absent module would transform to an EMPTY module and be served 200. The
 * browser then accepts it and fails later at "does not provide an export named
 * …", far from the real cause. A miss must be a 404.
 */
function pkgSource(): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg === "p",
    async load() {
      const files = new MemFilesApi();
      await writeText(files, "/index.js", `export const v = 1;`);
      return {
        name: "p",
        version: "1.0.0",
        files,
        manifest: {
          name: "p",
          version: "1.0.0",
          type: "module",
          main: "./index.js",
        } as PackageManifest,
      };
    },
  };
}

describe("missing modules 404", () => {
  it("404s a missing project module instead of serving an empty one", async () => {
    const project = new MemFilesApi();
    await writeText(project, "/a.js", `export const a = 1;`);
    const server = newModuleServer({ cache: new MemFilesApi(), project });
    const res = await server.fetch(new Request("http://h/~/missing.js"));
    expect(res.status).toBe(404);
  });

  it("404s a missing file inside a real package", async () => {
    const server = newModuleServer({ cache: new MemFilesApi(), sources: [pkgSource()] });
    await server.fetch(new Request("http://h/p@1.0.0/index.js")); // warm the package
    const res = await server.fetch(new Request("http://h/p@1.0.0/nope.js"));
    expect(res.status).toBe(404);
  });

  it("still serves a module that does exist", async () => {
    const server = newModuleServer({ cache: new MemFilesApi(), sources: [pkgSource()] });
    const res = await server.fetch(new Request("http://h/p@1.0.0/index.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("export const v = 1;");
  });
});

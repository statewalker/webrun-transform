import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { PackageManifest, Source } from "../src/types.js";

/**
 * A package whose `./parser` specifier names a DIRECTORY holding `index.js` —
 * the shape sucrase's `dist/esm/parser` has. `exists()` is true for the
 * directory, so a resolver that probes existence rather than file-ness stops at
 * the directory and never reaches `parser/index.js`.
 */
function shadowSource(): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg === "shadow",
    async load() {
      const files = new MemFilesApi();
      await writeText(files, "/index.js", `export { p } from "./parser";`);
      await writeText(files, "/parser/index.js", `export const p = 1;`);
      return {
        name: "shadow",
        version: "1.0.0",
        files,
        manifest: {
          name: "shadow",
          version: "1.0.0",
          type: "module",
          main: "./index.js",
        } as PackageManifest,
      };
    },
  };
}

const newServer = () => newModuleServer({ cache: new MemFilesApi(), sources: [shadowSource()] });

describe("directory-shadowed index resolution", () => {
  it("resolves a relative specifier naming a directory to its index.js", async () => {
    const res = await newServer().fetch(new Request("http://h/shadow@1.0.0/index.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("./parser/index.js");
  });

  it("serves the resolved index.js as a module", async () => {
    const server = newServer();
    await server.fetch(new Request("http://h/shadow@1.0.0/index.js")); // warm the package
    const res = await server.fetch(new Request("http://h/shadow@1.0.0/parser/index.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
  });

  it("404s a directory path instead of serving an empty octet-stream body", async () => {
    const server = newServer();
    await server.fetch(new Request("http://h/shadow@1.0.0/index.js")); // warm the package
    const res = await server.fetch(new Request("http://h/shadow@1.0.0/parser"));
    expect(res.status).toBe(404);
  });
});

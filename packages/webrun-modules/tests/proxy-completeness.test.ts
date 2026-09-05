import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { PackageManifest, Source } from "../src/types.js";

/**
 * One module root whose files need DIFFERENT bindings from the same external
 * dependency — sucrase's shape, where `Options.js` imports `{ createCheckers }`
 * from `ts-interface-checker` and `Options-gen-types.js` does `import * as t`.
 *
 * Both files share ONE proxy, and a client links that proxy URL as soon as the
 * first of them is linked. Whatever surface the proxy has at that moment is the
 * surface that client has forever — it never refetches the URL.
 */
function appSource(secondImport: string): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg === "app",
    async load() {
      const files = new MemFilesApi();
      await writeText(files, "/first.js", `import { alpha } from "dep";\nexport const a = alpha;`);
      await writeText(files, "/second.js", secondImport);
      await writeText(
        files,
        "/index.js",
        `export { a } from "./first.js";\nexport { b } from "./second.js";`,
      );
      return {
        name: "app",
        version: "1.0.0",
        files,
        manifest: {
          name: "app",
          version: "1.0.0",
          type: "module",
          main: "./index.js",
          dependencies: { dep: "1.0.0" },
        } as PackageManifest,
      };
    },
  };
}

function depSource(withDefault = false): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg === "dep",
    async load() {
      const files = new MemFilesApi();
      const body = `export const alpha = 1;\nexport const beta = 2;`;
      await writeText(files, "/index.js", withDefault ? `${body}\nexport default 42;` : body);
      return {
        name: "dep",
        version: "1.0.0",
        files,
        manifest: {
          name: "dep",
          version: "1.0.0",
          type: "module",
          main: "./index.js",
        } as PackageManifest,
      };
    },
  };
}

const PROXY = "http://h/app@1.0.0/~deps/dep/index.js";

/** The proxy body this server serves after transforming exactly `files`. */
async function proxyAfter(
  secondImport: string,
  files: string[],
  depHasDefault = false,
): Promise<string> {
  const server = newModuleServer({
    cache: new MemFilesApi(),
    sources: [appSource(secondImport), depSource(depHasDefault)],
  });
  for (const f of files) await server.fetch(new Request(`http://h/app@1.0.0/${f}`));
  return (await server.fetch(new Request(PROXY))).text();
}

describe("shared proxy completeness", () => {
  const namedSecond = `import { beta } from "dep";\nexport const b = beta;`;
  const namespaceSecond = `import * as ns from "dep";\nexport const b = ns.beta;`;

  it("serves one body regardless of which importers have been transformed", async () => {
    const early = await proxyAfter(namedSecond, ["first.js"]);
    const late = await proxyAfter(namedSecond, ["first.js", "second.js"]);
    expect(early).toBe(late);
  });

  it("serves one body when the later importer needs a namespace", async () => {
    const early = await proxyAfter(namespaceSecond, ["first.js"]);
    const late = await proxyAfter(namespaceSecond, ["first.js", "second.js"]);
    expect(early).toBe(late);
  });

  const defaultSecond = `import d from "dep";\nexport const b = d;`;

  // `export *` carries no `default`, so the proxy needs a separate line for it —
  // and that line cannot be keyed to the importers seen so far either.
  it("serves one body when the later importer needs the default", async () => {
    const early = await proxyAfter(defaultSecond, ["first.js"], true);
    const late = await proxyAfter(defaultSecond, ["first.js", "second.js"], true);
    expect(early).toBe(late);
    expect(early).toContain("export { default } from");
  });

  // ...but only when the ENDPOINT actually has one: re-exporting a `default` the
  // endpoint lacks is a link error, which would break every importer of the proxy
  // rather than just the one asking for a default that isn't there.
  it("omits the default when the endpoint does not export one", async () => {
    const early = await proxyAfter(defaultSecond, ["first.js"], false);
    const late = await proxyAfter(defaultSecond, ["first.js", "second.js"], false);
    expect(early).toBe(late);
    expect(late).not.toContain("export { default } from");
  });
});

import { describe, expect, it } from "vitest";
import { depsEntryPath, depsRoot, proxyBody, proxyId } from "../src/deps/proxy.js";

describe("depsRoot", () => {
  it("is the project root for authored sources and the package root for npm files", () => {
    expect(depsRoot("~/app.ts")).toBe("~");
    expect(depsRoot("~/pages/deep/x.tsx")).toBe("~");
    expect(depsRoot("react-dom@19.0.0/cjs/impl.js")).toBe("react-dom@19.0.0");
    expect(depsRoot("@scope/pkg@1.2.3/lib/a.js")).toBe("@scope/pkg@1.2.3");
  });
});

describe("depsEntryPath", () => {
  it("maps a specifier to its path, from the specifier alone", () => {
    expect(depsEntryPath("react")).toBe("react/index.js");
    expect(depsEntryPath("react/jsx-runtime")).toBe("react/jsx-runtime.js");
    expect(depsEntryPath("@scope/pkg")).toBe("@scope/pkg/index.js");
    expect(depsEntryPath("@scope/pkg/sub")).toBe("@scope/pkg/sub.js");
    expect(depsEntryPath("lodash/fp")).toBe("lodash/fp.js");
  });

  it("normalizes JS-family extensions to .js so both drivers agree on one URL", () => {
    expect(depsEntryPath("foo/bar.mjs")).toBe("foo/bar.js");
    expect(depsEntryPath("foo/bar.js")).toBe("foo/bar.js");
    expect(depsEntryPath("foo/bar.tsx")).toBe("foo/bar.js");
  });

  it("gives the reserved free-globals key its own file", () => {
    expect(depsEntryPath("")).toBe("~globals.js");
  });

  it("merges the specifiers that name one entry (documented collision)", () => {
    // `foo` and `foo/index` deliberately land on one path: in practice they resolve
    // to the same endpoint, and `ensureProxy` throws if they ever do not.
    expect(depsEntryPath("foo/index")).toBe(depsEntryPath("foo"));
    expect(depsEntryPath("foo/bar.mjs")).toBe(depsEntryPath("foo/bar"));
  });
});

describe("proxyId", () => {
  it("places the proxy in the importer's MODULE-ROOT deps folder", () => {
    expect(proxyId("pkg@1.0.0/dir/foo.js", "react")).toBe("pkg@1.0.0/~deps/react/index.js");
    expect(proxyId("pkg@1.0.0/foo.js", "react/jsx-runtime")).toBe(
      "pkg@1.0.0/~deps/react/jsx-runtime.js",
    );
    expect(proxyId("~/pages/deep/x.tsx", "react")).toBe("~/~deps/react/index.js");
    expect(proxyId("~/app.ts", "")).toBe("~/~deps/~globals.js");
  });

  it("every file of one package shares one proxy", () => {
    expect(proxyId("pkg@1.0.0/a.js", "react")).toBe(proxyId("pkg@1.0.0/deep/b.js", "react"));
  });

  it("honours a custom deps folder name", () => {
    expect(proxyId("~/app.ts", "react", "vendor")).toBe("~/vendor/react/index.js");
  });
});

describe("proxyBody", () => {
  it("local binding re-exports names + default + namespace from the relative endpoint", () => {
    const id = proxyId("pkg@1/foo.js", "lodash-es");
    const body = proxyBody({
      proxyId: id,
      binding: { kind: "local", url: "IGNORED" },
      imp: { names: ["debounce"], hasNamespace: true, hasDefault: false },
      registryKey: "__webrunHostRegistry",
    });
    // endpoint is resolved by the server and passed as binding.url; here we assert re-export shape
    expect(body).toContain("export { debounce } from");
    expect(body).toContain("export * from");
  });

  it("host binding reads the shared registry and preserves the instance as default", () => {
    const id = proxyId("pkg@1/foo.js", "react");
    const body = proxyBody({
      proxyId: id,
      binding: { kind: "host", name: "react" },
      imp: { names: ["useState"], hasNamespace: false, hasDefault: true },
      registryKey: "__webrunHostRegistry",
    });
    expect(body).toContain('globalThis.__webrunHostRegistry.get("react")');
    expect(body).toContain("export default __m");
    expect(body).toContain("export const useState = __m.useState");
  });
});

---
"@statewalker/webrun-modules": minor
"@statewalker/webrun-modules-build": minor
---

One `~deps/` folder per module root, instead of one per importing file.

A module's external dependencies are now concentrated in a single folder at its
root — the project root for authored sources, `{name}@{version}/` for an npm
package — so every file of a module resolves `react` through the one file
`~deps/react/index.js`. That folder is the seam at which a dependency can be
substituted for a host-provided singleton, a pinned build, or a patched copy, and
one predictable file per module is a seam that can actually be operated on.

**Breaking:** emitted proxy URLs move from `<dir>/~deps/<file>/deps.<slug>.js` to
`<module-root>/~deps/<specifier>/index.js` (subpaths to
`<module-root>/~deps/<specifier>.js`, free globals to
`<module-root>/~deps/~globals.js`). Any consumer holding emitted URLs must
re-prime its cache.

**Breaking:** `PreprocessContext` gains two required fields, `depsFolder` and
`proxies`. This affects only code constructing a context directly; both bundled
drivers set them.

**Breaking:** a subpath's JS-family extension is normalized away when its proxy path
is derived, so `pkg/x.mjs` and `pkg/x.cjs` now map to one proxy. A package importing
both forms of the same subpath fails loudly with `conflicting bindings for one proxy
path` rather than silently binding one of them. This is a deliberate trade for
producing one identical URL under both the keep-ext server and the ext-map build.

A proxy's accumulated export surface is now persisted beside its emitted artifact
as a `<emitted-path>.shape.json` sidecar (the same sidecar convention as the
build's `.hash` gate) and seeded back on the first touch of that proxy id. One
proxy serves every importer in its module root, but the in-memory accumulator only
lives for one run: an incremental build walks just the changed importers, so
without the sidecar a rebuild would rewrite a shared proxy with only those
importers' names and delete exports that unchanged, already-emitted modules still
import. Emitted output therefore gains one extra small JSON file per proxy.

New: `depsFolder` on `ModuleServerOptions` and `ProjectBuildOptions` renames the
folder (default `"~deps"`). Its value is a **reserved path segment**: any project
id containing `/{depsFolder}/` is treated as generated — never walked, and 404'd by
the server unless already cached. Proxy responses are now served `cache-control:
no-cache`, because a proxy's export surface grows as more files of its module are
transformed.

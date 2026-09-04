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

New: `depsFolder` on `ModuleServerOptions` and `ProjectBuildOptions` renames the
folder (default `"~deps"`). Proxy responses are now served `cache-control:
no-cache`, because a proxy's export surface grows as more files of its module are
transformed.

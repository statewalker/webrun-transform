---
"@statewalker/webrun-bundler": patch
---

A `.js` file under a `"type": "module"` package.json is bundled as Node treats it: its imports of CommonJS modules get Node's interop (the default import is `module.exports`, even with `__esModule`). tslib 2.3's `modules/index.js` needs it; React apps depending on it failed to hydrate. New option `sourcemap: false`: no map is built (a large bundle's map, with every source's content, can take more memory than the bundle); `map` is then empty and `warnings` are still returned. With `sourcemap: false`, the inputs' own source maps are no longer read and inlined into what esbuild parses (EmDash's server bundle: 58.9 → 27.0 MB of input).

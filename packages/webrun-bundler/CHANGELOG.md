# @statewalker/webrun-bundler

## 0.1.1

### Patch Changes

- 176e41c: A `.js` file under a `"type": "module"` package.json is bundled as Node treats it: its imports of CommonJS modules get Node's interop (the default import is `module.exports`, even with `__esModule`). tslib 2.3's `modules/index.js` needs it; React apps depending on it failed to hydrate. New option `sourcemap: false`: no map is built (a large bundle's map, with every source's content, can take more memory than the bundle); `map` is then empty and `warnings` are still returned. With `sourcemap: false`, the inputs' own source maps are no longer read and inlined into what esbuild parses (EmDash's server bundle: 58.9 → 27.0 MB of input).

## 0.1.0

### Minor Changes

- 9a3f1d4: New package: a transpiler, resolver and bundler on esbuild-wasm that reads every file through a FilesApi (never node:fs), finds packages in node_modules folders or fetches them from the npm registry, and keeps an unbroken source map from each bundled line to the user's file or the npm package's original source (packages' own maps are composed in). `await` lowering is an option.

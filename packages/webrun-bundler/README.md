# @statewalker/webrun-bundler

## What it is

A transpiler, resolver and bundler on [esbuild-wasm](https://esbuild.github.io/getting-started/#wasm)
that reads every file through a
[`FilesApi`](https://www.npmjs.com/package/@statewalker/webrun-files): a `MemFilesApi` in tests,
OPFS or a folder the user picked in a browser, a FilesApi served over a `MessagePort` to a worker.
It never touches `node:fs`, and esbuild never reads a file itself.

Every transformation keeps a source map. TypeScript, JSX, CommonJS-to-ESM, `await` lowering and
bundling all happen in one esbuild pass, and where a package ships its own map (TypeScript compiled
to `.js`), that map is composed in. Each line of a bundle traces back to the user's file or to the
npm package's original source, and the map carries the text of each.

## Why it exists

Code that runs in Durable Objects, workers and browsers is built in places without a disk: in a
browser worker, in a ServiceWorker, inside a Worker runtime. esbuild-wasm runs there, but it can only
read what it is handed, and a bundle whose map stops at a package's compiled `dist/` (or at an
intermediate transform) says little about where an error comes from. This package hands esbuild
the files from a FilesApi, finds packages in `node_modules` folders or fetches them from the npm
registry (through `@statewalker/webrun-modules`' `npmRegistrySource`), and keeps the map chain
unbroken.

## How to use

### Install

```sh
pnpm add @statewalker/webrun-bundler esbuild-wasm
```

`esbuild-wasm` is a peer dependency: initialize it once (in a browser, `esbuild.initialize({
wasmURL })`; on Node it needs nothing) and pass it in. Native `esbuild` works too on Node.

### Bundle a project

```ts
import * as esbuild from "esbuild-wasm";
import { getOPFSFilesApi } from "@statewalker/webrun-files-browser";
import { bundle, chainPackages, nodeModulesPackages, npmPackages } from "@statewalker/webrun-bundler";

await esbuild.initialize({ wasmURL: "/esbuild.wasm" });
const files = await getOPFSFilesApi();

const { code, map } = await bundle({
  esbuild,
  files,
  root: "/my-project",
  entry: "/src/index.ts",
  // node_modules in the FilesApi first, then the npm registry
  packages: chainPackages(nodeModulesPackages(), npmPackages()),
  external: ["cloudflare:*", "node:*"], // left to the runtime
  conditions: ["workerd", "worker", "browser"],
  lowerAwait: true,
});
// `code` ends with `//# sourceMappingURL=bundle.js.map`; `map` is that map.
```

`map.sources` are file ids: `~/src/index.ts` for the project, `npm:<name>@<version>/<file>` for
packages (`npm:hono@4.6.3/src/hono.ts` when the package ships its TypeScript and a map).

### Transpile one file

```ts
import { transpile } from "@statewalker/webrun-bundler";

const { code, map } = await transpile(source, { esbuild, path: "~/src/f.ts", lowerAwait: true });
```

### `bundle` options

| Option | Default | Meaning |
|---|---|---|
| `esbuild` | required | `esbuild-wasm` (or native `esbuild`) |
| `files`, `root` | required, `/` | the project's FilesApi and its directory |
| `entry` | required | the entry module, a project path |
| `packages` | `nodeModulesPackages()` | where bare specifiers go |
| `external` | `[]` | specifiers kept as imports; `"x:*"` is a prefix. `http(s):`/`data:` always are |
| `modules` | | modules the host supplies by specifier (a record, or a function returning source or `undefined`); mapped as `virtual:<specifier>` |
| `inject` | | modules whose exports replace same-named globals in every file (esbuild `inject`), resolved like imports |
| `conditions` | `["browser"]` | `exports` conditions besides `import`/`require` and `default` |
| `format`, `platform`, `target` | `esm`, `browser`, `es2022` | as in esbuild |
| `lowerAwait` | `false` | lower `async`/`await`, async generators and `for await` to generators |
| `minify`, `define` | | as in esbuild |
| `outfile` | `bundle.js` | the name the map link uses (`<outfile>.map`) |
| `sourcemap` | `external` | `inline` also puts the map in `code`; `false` builds no map (`map` is empty, `code` has no link) and does not read the inputs' maps |
| `esbuildOptions` | | other esbuild options, applied last (the plugin and source maps stay) |

## Examples

### Packages from the registry, at the versions the project asks for

`npmPackages()` takes each package at the range the importer's `package.json` declares (the
project's for project files, the package's own for its dependencies), else the latest. One range
loads once, and two ranges that land on one version share it. Pass `source` to fetch from
elsewhere (any `@statewalker/webrun-modules` `Source`).

### The host supplies its runtime's modules

A runtime embedding the bundle provides modules the bundle cannot read from files: `cloudflare:workers`,
`node:*` polyfills from its own realm, its own `Response`. `modules` gives their source by
specifier (a function can cover a whole family), and `inject` replaces globals with a module's
exports:

```ts
await bundle({
  esbuild, files, entry: "/src/index.ts",
  modules: (spec) =>
    spec.startsWith("node:")
      ? `const m = globalThis.__host.get(${JSON.stringify(spec)}); export default m; export const { Buffer } = m;`
      : undefined,
  inject: ["/src/runtime-globals.ts"],
});
```

### `lowerAwait` for an AsyncLocalStorage polyfill

Browsers have no async context propagation yet (TC39 AsyncContext is at Stage 2). A polyfill that
patches `Promise.prototype.then` cannot see a native `await`; with `lowerAwait`, each `await`
resumes through `then`, and the source map follows the lowered code.

### Tests

`pnpm test` runs the Node suite: esbuild-wasm on `MemFilesApi` projects, with packages from a fake
registry and from `node_modules`, checking that the bundles run and that their lines trace to the
right files and lines. `pnpm test:browser` runs `e2e/browser.mjs`: a Dedicated Worker in Chromium
bundles a project stored in OPFS with esbuild-wasm and checks the same.

## Internals

### One esbuild pass, one plugin

The bundler is an esbuild plugin. `onResolve` resolves every specifier (relative paths with
extension and `index` resolution, `./x.js` written for `./x.ts`, `#imports`, packages with their
`exports` conditions, `module` and `main`) and names the file by its id; `onLoad` reads it from its
FilesApi. esbuild does the rest. There is no intermediate file, so there is no intermediate map
to lose.

### Input maps are inlined, and their sources renamed

esbuild composes a loaded file's map with its own only when the map is inline. A published file
usually links one (`//# sourceMappingURL=index.js.map`): the bundler reads it from the package's
tree, rewrites its sources to ids of that tree (`../src/index.ts` → `npm:pkg@1.0.0/src/index.ts`),
fills a missing `sourcesContent` from the package's files, and inlines it. A map that is missing
or broken is dropped: the file then maps to itself.

With `sourcemap: false` none of this happens: the `sourceMappingURL` comment is removed and the map
is not read. An inlined map carries its sources' text and can outweigh the code: for EmDash's
server bundle (cellb.dev's in-browser builder) esbuild's input goes from 58.9 MB to 27.0 MB.

### Module types follow Node

esbuild reads a `package.json` `"type"` only for files on its own file system. For the files this
plugin loads, a `.js` file in a `"type": "module"` scope gets an id ending in `?type=module.mjs`,
so esbuild treats it as ESM the way Node does: a default import of a CommonJS module is its
`module.exports`, even when it sets `__esModule`. tslib 2.3's `modules/index.js` depends on it.
The suffix is dropped from the ids in the source map.

### pnpm layouts

In a pnpm install, `node_modules/x` is a symlink into `node_modules/.pnpm`, and `x`'s own
dependencies sit next to its real directory there. Node follows the real path; a FilesApi sees
only the link. When the usual walk up the `node_modules` folders finds nothing,
`nodeModulesPackages` tries each ancestor's `node_modules/.pnpm/node_modules`, where pnpm links
every installed package (with one version per name: a package that two dependencies need in
different versions resolves to the hoisted one).

### What has no source

esbuild's own runtime (`__commonJS`, `__toESM`, `__async` when lowering), the wrapper lines of a
CommonJS module, and the bundle's closing `export { … }` are written by esbuild, not by an input:
they have no mapping. Every other line maps to a file.

### What does not work yet

- The `browser` field as a map of substitutions (only a string `browser` entry is used).
- CSS bundling beyond what esbuild's `css` loader does; `@import` of packages resolves like JS.
- Packages are matched by name and range, not deduplicated across ranges that resolve to
  different versions (as npm would install both).

### Dependencies

`@statewalker/webrun-files` (FilesApi), `@statewalker/webrun-modules` (the npm registry `Source`,
loaded only when `npmPackages()` falls back to it), `resolve.exports` (`exports`/`imports` maps);
`esbuild-wasm` as a peer.

## License

MIT

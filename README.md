# webrun-transform

**Incremental resource transformation** — a build engine, a module resolver/server,
and the transforms that run inside them. Given a set of source files, produce the
derived files, and on a later change redo only the part that actually changed.

The engine is host-agnostic and the module server is isomorphic: the same code drives
a batch build on Node and a request-time server in the browser.

This repository was extracted from [`webrun-files`](https://github.com/statewalker/webrun-files),
which is now purely the FilesApi. The full history of all five packages came with the
extraction.

## Packages

| Package | What it does |
| --- | --- |
| `@statewalker/webrun-dataflow` | Signal-driven dataflow graph: forward impact propagation and a filtered topological order. The substrate everything else schedules on. |
| `@statewalker/webrun-builder` | `BuildEngine<THost>` — a Project-free, signal-driven build engine with a frontier scheduler and file-backed stores, so a build interrupted mid-flight resumes instead of restarting. |
| `@statewalker/webrun-modules` | Isomorphic module/dependency server: resolve, download and transform modules, serving them over HTTP or from memory. |
| `@statewalker/webrun-modules-build` | Batch module builder — drives the `webrun-modules` transforms through the build engine for the change-driven path. |
| `@statewalker/webrun-tailwind` | A build-only registered transform that generates Tailwind CSS. |

Internal direction: `webrun-dataflow` → `webrun-builder` → `webrun-modules-build`,
with `webrun-modules` and `webrun-tailwind` supplying the transforms.

## Cross-repo dependencies

This repository depends on one other repository, and only on the FilesApi:

| Repository | Packages used |
| --- | --- |
| [`webrun-files`](https://github.com/statewalker/webrun-files) | `@statewalker/webrun-files`, `@statewalker/webrun-files-mem` |

Everything reads and writes through `FilesApi`, which is what lets the same engine run
against a real filesystem, an in-memory tree, or the browser.

Cross-repo dependencies are declared `workspace:*` rather than `catalog:`. This is
deliberate: turbo derives its task graph from `workspace:` specifiers and does **not**
resolve `catalog:`, so a `catalog:` cross-repo dependency is invisible to the scheduler
and its consumer can be built before it.

## Development

```sh
pnpm install
pnpm -r build
pnpm -r test
```

This repository composes into a StateWalker umbrella workspace, which lists
`workspaces/<repo>/packages/*` as its members — the repository directory itself is
not one. Turbo therefore never reads this `turbo.json` from the umbrella root: a
task there resolves against the umbrella's own definitions. Run from anywhere
*inside* this repository, turbo instead roots here (there is a `pnpm-lock.yaml` and
a `pnpm-workspace.yaml`) and reads this file as a root config, so it must not carry
`extends` — which turbo rejects in a root config. `biome.json` keeps `root: false`;
that one works with or without an ancestor config.

## License

MIT.

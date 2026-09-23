---
"@statewalker/webrun-dataflow": patch
"@statewalker/webrun-builder": patch
"@statewalker/webrun-modules-build": patch
"@statewalker/webrun-tailwind": patch
---

Point the package entry at the built `dist/`, not at `src/index.ts`.

Node refuses to strip types under `node_modules`, so these packages could
not be imported by any consumer that was not a bundler. `source` is
retained as a bundler hint.

# @statewalker/webrun-tailwind

## 0.1.2

### Patch Changes

- Republish both with `pnpm publish`, which resolves `catalog:` and `workspace:` specifiers
  into real version ranges. `webrun-tailwind@0.1.1` was published with plain `npm publish`,
  which ships them verbatim, so its manifest reached the registry carrying
  `"@statewalker/webrun-files": "catalog:"` — unresolvable for any consumer outside this
  workspace. `webrun-modules-build` pinned that exact version, so it broke too.

## 0.1.1

### Patch Changes

- Updated dependencies
  - @statewalker/webrun-modules@0.2.1

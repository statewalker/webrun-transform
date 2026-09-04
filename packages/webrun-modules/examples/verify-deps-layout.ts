/**
 * Verify the module-root `~deps/` layout against REAL npm packages over the real
 * HTTP server. Fixture trees are too shallow to catch a bad relative URL; these
 * packages are not.
 *
 * Run (needs network):
 *   pnpm --filter @statewalker/webrun-modules exec tsx examples/verify-deps-layout.ts
 *
 * For each entry: prime it, then fetch every URL in its reachable graph and
 * resolve every relative import in every body against that body's own URL. A
 * proxy that moved up the tree without its `../` count following it 404s here.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { newModuleServer, npmRegistrySource } from "../src/index.js";

// Chosen for shape, not popularity: a CJS package with a dep and free globals, a
// package with a scoped dependency, and one with a deep directory structure whose
// files sit well below their package root.
const ENTRIES = [
  { pkg: "debug", version: "^4" },
  { pkg: "react-dom", version: "^18" },
  { pkg: "lodash-es", version: "^4", subpath: "merge" },
];

// Matches both static forms (`from "…"`, side-effect `import "…"`) and the
// dynamic form (`import("…")`) — the optional `\(?` covers the parenthesis that
// sits between `import` and the quote in the dynamic case.
const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

// A module root is either the project root (`~`, for authored sources) or an npm
// package root (`{name}@{version}`, scope-aware) — see `depsRoot` in
// `src/deps/proxy.ts`. Every proxy must sit directly under one of these, never
// under an importer's own path.
const MODULE_ROOT_RE = /^(?:@[^/]+\/)?[^/]+@[^/]+$/;

/** Resolve a relative specifier against a module's own absolute URL path. */
function resolveAgainst(fromPath: string, spec: string): string {
  return new URL(spec, `http://h${fromPath}`).pathname;
}

const cacheDir = await mkdtemp(join(tmpdir(), "webrun-verify-deps-"));
const server = newModuleServer({
  cache: new NodeFilesApi({ rootDir: cacheDir }),
  sources: [npmRegistrySource()],
  target: "browser",
});

let failures = 0;
let checked = 0;
let bodiesChecked = 0;
let proxyRootsValidated = 0;

for (const entry of ENTRIES) {
  const label = `${entry.pkg}${entry.subpath ? `/${entry.subpath}` : ""}`;
  console.log(`\n=== ${label} ===`);
  const urls = await server.listResources(entry);
  const proxies = urls.filter((u) => u.includes("/~deps/"));
  console.log(`  ${urls.length} modules, ${proxies.length} proxies`);

  // Every proxy sits directly under a module root: `<root>/~deps/<spec>/index.js`
  // or `<root>/~deps/<spec>.js` or `<root>/~deps/~globals.js` — never nested under
  // an importer's filename, which is what the old layout produced.
  for (const u of proxies) {
    const idx = u.indexOf("/~deps/");
    const before = u.slice(0, idx).replace(/^\/+/, "");
    const after = u.slice(idx + "/~deps/".length);
    if (/\.[cm]?[jt]sx?\/deps\./.test(u)) {
      console.error(`  ✗ old co-located layout leaked through: ${u}`);
      failures++;
    }
    if (after.split("/").length > 3) {
      console.error(`  ✗ unexpectedly deep proxy path: ${u}`);
      failures++;
    }
    // The part BEFORE `/~deps/` must itself be exactly a module root — `~` (the
    // project root) or `{name}@{version}` (scope-aware) — never an importer's own
    // path (e.g. `pkg@1.0.0/src/foo.js`), which is what wrong nesting looks like.
    proxyRootsValidated++;
    if (before !== "~" && !MODULE_ROOT_RE.test(before)) {
      console.error(
        `  ✗ proxy not rooted at a module root: ${u} (root segment: ${JSON.stringify(before)})`,
      );
      failures++;
    }
  }

  // One proxy per (module root, specifier) — no duplicates.
  const dupes = proxies.filter((u, i) => proxies.indexOf(u) !== i);
  if (dupes.length) {
    console.error(`  ✗ duplicate proxy ids: ${dupes.join(", ")}`);
    failures++;
  }

  for (const url of urls) {
    const res = await server.fetch(new Request(`http://h${url}`));
    if (res.status !== 200) {
      console.error(`  ✗ ${url} → ${res.status}`);
      failures++;
      continue;
    }
    const body = await res.text();
    bodiesChecked++;
    if (body.trim().length === 0) {
      console.error(`  ✗ ${url} → 200 with an EMPTY body`);
      failures++;
      continue;
    }
    // Every proxy body form (`export {…} from`, `export *`, `export default`,
    // `export const`, the `host` shim's `export default`/`export const`) contains
    // the token "export" — an empty-string transform overwriting a proxy body
    // (a real failure mode seen in an earlier task) still reports 200 but would
    // fail this.
    if (url.includes("/~deps/") && !body.includes("export")) {
      console.error(`  ✗ ${url} → proxy body has no "export" (truncated/wrong body)`);
      failures++;
      continue;
    }
    for (const m of body.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith(".")) {
        if (!/^(https?:|data:|node:)/.test(spec)) {
          console.error(`  ✗ ${url} still imports the BARE specifier ${JSON.stringify(spec)}`);
          failures++;
        }
        continue;
      }
      const target = resolveAgainst(url, spec.replace(/\?module$/, ""));
      const hit = await server.fetch(new Request(`http://h${target}`));
      checked++;
      if (hit.status !== 200) {
        console.error(`  ✗ ${url} → ${spec} → ${target} → ${hit.status}`);
        failures++;
      }
    }
  }
  console.log(`  ok`);
}

console.log(
  `\n${checked} relative imports resolved, ${bodiesChecked} bodies checked, ` +
    `${proxyRootsValidated} proxy roots validated, ${failures} failures`,
);
if (failures) process.exit(1);

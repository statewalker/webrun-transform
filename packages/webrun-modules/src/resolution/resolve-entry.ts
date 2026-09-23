import { legacy, resolve as resolveExports } from "resolve.exports";
import type { ModuleTarget, PackageManifest } from "../types.js";

/** Strip a leading `./` or `/` so the result is a package-relative file path. */
function norm(p: string): string {
  return p.replace(/^\.?\//, "");
}

type ResolveOpts = { browser: boolean; conditions: string[]; require?: boolean };

/** Call resolve.exports, swallowing its "no known conditions" throw. */
function tryResolve(
  manifest: PackageManifest,
  entry: string,
  opts: ResolveOpts,
): string[] | undefined {
  try {
    return resolveExports(manifest, entry, opts) as string[] | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a package + subpath to the concrete file path inside the package,
 * honoring `package.json` `exports` conditions for the given `target`, with a
 * `main`/`module`/`browser` legacy fallback. Returns a package-relative path
 * (e.g. `"dist/index.js"`).
 */
export function resolveEntry(
  manifest: PackageManifest,
  subpath: string | undefined,
  target: ModuleTarget,
): string {
  const browser = target === "browser";
  const clean = (subpath ?? "").replace(/^\.?\//, "");
  const entry = clean ? `./${clean}` : ".";

  if (manifest.exports !== undefined) {
    const conditions = browser ? ["browser"] : ["node"];
    // resolve.exports *throws* when no condition matches — try ESM (import) then
    // CJS-only (require) exports maps, swallowing the no-match throw.
    const out =
      tryResolve(manifest, entry, { browser, conditions }) ??
      tryResolve(manifest, entry, { browser, conditions, require: true });
    if (out?.length) return norm(out[0]);
    // exports present but subpath not exported: fall through to the raw path.
  }

  if (entry === ".") {
    const leg = legacy(manifest, {
      browser,
      fields: browser ? ["browser", "module", "main"] : ["module", "main"],
    });
    if (typeof leg === "string") return norm(leg);
    // A `browser` field has two meanings (browserify): a STRING is the browser
    // entry, an OBJECT is a per-module substitution MAP — and `legacy` hands the
    // map back verbatim, which is not an entry. Treating that as "no legacy main"
    // fell through to the fabricated `index.js` below; for jszip (`main:
    // "./lib/index"`, `browser: { "./lib/index": "./dist/jszip.min.js" }`) that is
    // a path no file backs, so the package 404s. Take `module`/`main` as the entry
    // and let the map remap it — which is what the map is for.
    if (browser && leg && typeof leg === "object") {
      const base = legacy(manifest, { fields: ["module", "main"] });
      if (typeof base === "string") {
        // `legacy` with a STRING `browser` looks the entry up in the map and
        // returns the entry itself when the map has nothing to say about it.
        const mapped = legacy(manifest, { browser: base, fields: ["browser"] });
        return norm(typeof mapped === "string" ? mapped : base);
      }
    }
    // `exports` present but neither `.` nor a legacy main resolves: the package has
    // no root entry (e.g. `@jspm/core`). Fabricating `index.js` here yields a dead
    // URL that 404s; fail loudly instead (Node throws ERR_PACKAGE_PATH_NOT_EXPORTED).
    if (manifest.exports !== undefined) {
      throw new Error(`${manifest.name}: package has no root entry ("." is not exported)`);
    }
  }

  return clean || "index.js";
}

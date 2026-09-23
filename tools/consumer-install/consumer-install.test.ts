import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

export type ConsumerTarget = {
  /** Published package name. */
  name: string;
  /** Directory under packages/ holding it. */
  dir: string;
  /** Export subpaths to import. "." is the root entry. */
  subpaths: string[];
  /** Subpaths that legitimately cannot import under Node (browser-only). */
  browserOnly?: string[];
};

export const PACKAGES: ConsumerTarget[] = [
  { name: "@statewalker/webrun-dataflow", dir: "webrun-dataflow", subpaths: ["."] },
  { name: "@statewalker/webrun-builder", dir: "webrun-builder", subpaths: ["."] },
  { name: "@statewalker/webrun-modules", dir: "webrun-modules", subpaths: ["."] },
  { name: "@statewalker/webrun-modules-build", dir: "webrun-modules-build", subpaths: ["."] },
  { name: "@statewalker/webrun-tailwind", dir: "webrun-tailwind", subpaths: ["."] },
];

const REPO = resolve(import.meta.dirname, "../..");
const scratches: string[] = [];

afterAll(() => {
  for (const s of scratches) rmSync(s, { recursive: true, force: true });
});

/** Names this repo's own dependencies (direct + peer) a package's package.json declares. */
function ownWorkspaceDeps(dir: string): string[] {
  const pkgPath = join(REPO, "packages", dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
}

/**
 * The target plus every package in `packages/` it depends on, transitively — so the
 * install below never has to reach the npm registry for a workspace sibling that only
 * exists, fixed, in this working tree.
 */
function workspaceClosure(target: ConsumerTarget): ConsumerTarget[] {
  const byName = new Map(PACKAGES.map((p) => [p.name, p]));
  const closure = new Map<string, ConsumerTarget>();
  const stack: ConsumerTarget[] = [target];
  while (stack.length > 0) {
    const t = stack.pop() as ConsumerTarget;
    if (closure.has(t.name)) continue;
    closure.set(t.name, t);
    for (const depName of ownWorkspaceDeps(t.dir)) {
      const dep = byName.get(depName);
      if (dep) stack.push(dep);
    }
  }
  return [...closure.values()];
}

function packOne(target: ConsumerTarget): string {
  const pkgDir = join(REPO, "packages", target.dir);
  const out = execFileSync("pnpm", ["pack", "--pack-destination", pkgDir], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  return resolve(pkgDir, out.trim().split("\n").at(-1) as string);
}

/**
 * Pack the target and its transitive workspace-dependency closure, then install every
 * tarball together in one `npm install`. Installing the closure's tarballs alongside the
 * target is what lets npm satisfy a workspace sibling from the working tree instead of
 * fetching whatever is currently published on the registry.
 */
function installFromTarball(target: ConsumerTarget): string {
  const closure = workspaceClosure(target);
  const tarballs = closure.map(packOne);

  const scratch = mkdtempSync(join(tmpdir(), "consumer-"));
  scratches.push(scratch);
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "c", type: "module", private: true }));
  try {
    execFileSync("npm", ["install", "--no-audit", "--no-fund", ...tarballs], {
      cwd: scratch,
      encoding: "utf8",
    });
  } finally {
    for (const tarball of tarballs) rmSync(tarball, { force: true });
  }
  return scratch;
}

describe.each(PACKAGES)("$name installs and imports as an external consumer", (target) => {
  it("packs, installs, and imports every export subpath", () => {
    const scratch = installFromTarball(target);

    // (5) the tarball must actually ship dist/
    const installed = join(scratch, "node_modules", ...target.name.split("/"));
    expect(readdirSync(installed)).toContain("dist");

    const importable = target.subpaths.filter((s) => !target.browserOnly?.includes(s));
    for (const subpath of importable) {
      const specifier = subpath === "." ? target.name : `${target.name}/${subpath.replace(/^\.\//, "")}`;
      const script = `import * as m from ${JSON.stringify(specifier)};
        if (Object.keys(m).length === 0) { console.error("EMPTY"); process.exit(2); }
        console.log("OK");`;
      writeFileSync(join(scratch, "probe.mjs"), script);
      const result = execFileSync("node", ["probe.mjs"], { cwd: scratch, encoding: "utf8" });
      expect(result, `${specifier} must import and export something`).toContain("OK");
    }
  });

  // (2) an exclusion list that excludes nothing is dead code
  it("browserOnly, if declared, names a subpath that exists", () => {
    for (const s of target.browserOnly ?? []) {
      expect(target.subpaths, `browserOnly "${s}" is not in subpaths`).toContain(s);
    }
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
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

/** Pack a workspace package and install the tarball into a fresh directory. */
function installFromTarball(target: ConsumerTarget): string {
  const pkgDir = join(REPO, "packages", target.dir);
  const out = execFileSync("pnpm", ["pack", "--pack-destination", pkgDir], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  const tarball = resolve(pkgDir, out.trim().split("\n").at(-1) as string);

  const scratch = mkdtempSync(join(tmpdir(), "consumer-"));
  scratches.push(scratch);
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "c", type: "module", private: true }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: scratch,
    encoding: "utf8",
  });
  rmSync(tarball, { force: true });
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

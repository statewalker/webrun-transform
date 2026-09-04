import { parseSpecifier } from "../server/specifiers.js";
import type { EndpointBinding, ModuleImport } from "../types.js";

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The module root that owns a `~deps/`: the project root (`~`) for authored
 *  sources, the package root (`{name}@{version}`) for npm files. The `""` fallback
 *  is defensive — every id reaching here is one of those two forms, because they
 *  are the only forms `loadRaw` accepts. */
export function depsRoot(importerId: string): string {
  if (importerId.startsWith("~/")) return "~";
  return importerId.match(/^((?:@[^/]+\/)?[^/]+@[^/]+)\//)?.[1] ?? "";
}

/**
 * Path of one specifier's proxy inside its module's deps folder.
 *
 * Derived from the SPECIFIER ALONE, never from the resolved package: a `host`
 * binding short-circuits before any package is loaded, so there is no manifest to
 * read — and a specifier-derived path is what keeps a URL stable when a dependency
 * is swapped between host-provided and bundled, which is the whole point of the
 * folder. Extensions normalize to `.js` HERE rather than in the URL policy, so the
 * keep-ext server and the ext-map build produce one identical URL.
 */
export function depsEntryPath(specifier: string): string {
  if (specifier === "") return "~globals.js"; // the reserved free-globals pseudo-module
  const { pkg, subpath } = parseSpecifier(specifier);
  if (!subpath) return `${pkg}/index.js`;
  return `${pkg}/${subpath.replace(/\.(?:m|c)?[jt]sx?$/i, "")}.js`;
}

/** Proxy id for one external specifier, in its importer's module-root deps folder.
 *  Every file of a module shares one proxy per specifier. */
export function proxyId(importerId: string, specifier: string, depsFolder = "~deps"): string {
  const root = depsRoot(importerId);
  const prefix = root ? `${root}/` : "";
  return `${prefix}${depsFolder}/${depsEntryPath(specifier)}`;
}

/**
 * The proxy module's ESM source. `local`/`cdn` re-export from a real ESM endpoint
 * (`binding.url` is the ready endpoint URL for BOTH — the caller shapes the local
 * one through the URL policy, so `proxyBody` never relativizes and the build's
 * ext-map policy is honored); `host` reads the shared runtime registry so every
 * proxy of a name yields the SAME instance; `inline` is the bundled body verbatim.
 */
export function proxyBody(args: {
  binding: EndpointBinding;
  imp: ModuleImport;
  registryKey: string;
}): string {
  const { binding, imp } = args;
  const named = imp.names.filter((n) => IDENT_RE.test(n) && n !== "default");

  if (binding.kind === "inline") return binding.code;

  if (binding.kind === "host") {
    const lines = [
      `const __m = globalThis.${args.registryKey}.get(${JSON.stringify(binding.name)});`,
    ];
    if (imp.hasDefault || (!named.length && !imp.hasNamespace)) lines.push("export default __m;");
    for (const n of [...new Set(named)]) lines.push(`export const ${n} = __m.${n};`);
    // Namespace (`* as X`) of a host module can't be enumerated — default-as-instance
    // covers property access; a true enumerated namespace is unsupported (documented).
    return lines.join("\n");
  }

  // local | cdn — a real ESM endpoint we can re-export from; `binding.url` is the
  // ready endpoint URL (relative for `local`, absolute for `cdn`).
  const q = JSON.stringify(binding.url);
  const lines: string[] = [];
  if (named.length) lines.push(`export { ${[...new Set(named)].join(", ")} } from ${q};`);
  if (imp.hasDefault) lines.push(`export { default } from ${q};`);
  if (imp.hasNamespace || (!named.length && !imp.hasDefault)) lines.push(`export * from ${q};`);
  return lines.join("\n");
}

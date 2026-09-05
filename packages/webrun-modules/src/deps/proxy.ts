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
  /** Whether the ENDPOINT itself exports a `default`, for `local`/`cdn` bindings.
   *  Supplied by the caller because only it can read the endpoint. When given it
   *  decides the `export { default }` line; when omitted (a `cdn` URL nothing can
   *  introspect) the line falls back to this importer's shape. */
  endpointHasDefault?: boolean;
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
  // Re-export the endpoint WHOLESALE rather than the bindings this importer asked
  // for. One proxy is shared by every file of a module root, but on the lazy server
  // path those files are transformed one at a time — and a client links the proxy
  // URL as soon as the FIRST of them is linked, then never refetches it. A surface
  // narrowed to the importers seen so far is therefore a surface that breaks every
  // later importer needing anything more. `export *` is a superset of any named
  // list, so the body no longer depends on transform order.
  const lines: string[] = [`export * from ${q};`];
  // `export *` deliberately does not carry `default`, so the default needs its own
  // line — and it cannot be keyed to the importers seen so far either, for the same
  // reason the named list could not be. It is keyed to the ENDPOINT instead: emit it
  // exactly when the endpoint has a default to give, which no importer can change.
  // Re-exporting a `default` the endpoint lacks is a link error that would break
  // every importer of the proxy, not only the one that asked for a default.
  // `endpointHasDefault` undefined means the caller could not read the endpoint (an
  // opaque `cdn` URL); fall back to this importer's shape, as before.
  if (args.endpointHasDefault ?? imp.hasDefault) lines.push(`export { default } from ${q};`);
  return lines.join("\n");
}

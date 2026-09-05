import type { FilesApi } from "@statewalker/webrun-files";
import { readText, tryReadText, writeText } from "@statewalker/webrun-files";
import semver from "semver";
import { newDefaultEndpointResolver } from "../deps/endpoint-resolver.js";
import { HOST_REGISTRY_KEY } from "../deps/host-registry.js";
import { proxyBody, proxyId } from "../deps/proxy.js";
import { resolveNodeBuiltin } from "../resolution/node-builtins.js";
import { resolveEntry } from "../resolution/resolve-entry.js";
import { parseSpecifier, relativeUrl } from "../server/specifiers.js";
import { analyze, detectFormat } from "../transform/index.js";
import type { EndpointBinding, EndpointResolver, ModuleImport, PackageManifest } from "../types.js";
import { ModuleResolveError } from "../types.js";
import { isCssFile, type PreprocessContext, urlPath } from "./context.js";

const RAW_EXT = ["", ".js", ".mjs", ".cjs", ".json", "/index.js", "/index.mjs"];

/** Coalesce truly-concurrent identical async work; a settled entry is dropped so
 *  a sequential driver never reuses a stale result (a no-op for the server). */
function singleFlight<T>(ctx: PreprocessContext, key: string, fn: () => Promise<T>): Promise<T> {
  const existing = ctx.inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => ctx.inflight.delete(key));
  ctx.inflight.set(key, p);
  return p;
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of chunks) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** A name is host-provided when the registry holds the exact name OR its package
 *  root (so both `react` and `react/jsx-runtime` bind to the `react` instance). */
export function providedNames(name: string, ctx: PreprocessContext): boolean {
  return name !== "" && (ctx.registry.has(name) || ctx.registry.has(parseSpecifier(name).pkg));
}

/** The default linker: `host` for provided names, same-origin `local` (via package
 *  resolution) otherwise. Built inside the core because it closes over
 *  `importerVersion` + `ensurePackage`. */
export function makeDefaultEndpointResolver(ctx: PreprocessContext): EndpointResolver {
  return newDefaultEndpointResolver({
    providedNames: (n) => (n === "" ? false : providedNames(n, ctx)),
    localUrl: async (spec, ectx) => {
      const { pkg, subpath } = parseSpecifier(spec);
      const version = await importerVersion(pkg, ectx.importerId, ctx);
      const t = await ensurePackage({ pkg, version, subpath }, ctx);
      return t.id; // canonical id; the served endpoint url is `urlPath(t.id)`
    },
  });
}

function matchSource(ref: { pkg: string; version?: string }, ctx: PreprocessContext) {
  const s = ctx.sources.find((x) => x.matches(ref));
  if (!s) throw new ModuleResolveError(ref, "no source matches");
  return s;
}

function reusable(locked: string, spec: string | undefined): boolean {
  if (!spec) return true;
  if (semver.valid(spec)) return locked === spec;
  if (semver.validRange(spec)) return semver.satisfies(locked, spec);
  return true; // dist-tag → reuse the locked version
}

async function cachedManifest(pkgKey: string, ctx: PreprocessContext): Promise<PackageManifest> {
  return JSON.parse(await readText(ctx.cache, `/raw/${pkgKey}/package.json`));
}

/** Persist a loaded package's files under `/raw/{name}@{version}/…` (idempotent). */
async function cacheRaw(
  name: string,
  version: string,
  files: FilesApi,
  manifest: PackageManifest,
  ctx: PreprocessContext,
): Promise<void> {
  const key = `${name}@${version}`;
  return singleFlight(ctx, `cacheRaw:${key}`, async () => {
    if (await ctx.cache.exists(`/raw/${key}/package.json`)) return;
    for await (const info of files.list("/", { recursive: true })) {
      if (info.kind === "file") {
        await ctx.cache.write(`/raw/${key}${info.path}`, [await collect(files.read(info.path))]);
      }
    }
    if (!(await ctx.cache.exists(`/raw/${key}/package.json`))) {
      await writeText(ctx.cache, `/raw/${key}/package.json`, JSON.stringify(manifest));
    }
  });
}

/** Lazily load a package's raw files by its `name@version` cache key (idempotent). */
export async function ensureRawByKey(pkgKey: string, ctx: PreprocessContext): Promise<void> {
  return singleFlight(ctx, `raw:${pkgKey}`, async () => {
    if (await ctx.cache.exists(`/raw/${pkgKey}/package.json`)) return;
    const at = pkgKey.lastIndexOf("@");
    const ref = { pkg: pkgKey.slice(0, at), version: pkgKey.slice(at + 1) };
    const loaded = await matchSource(ref, ctx).load(ref);
    await cacheRaw(loaded.name, loaded.version, loaded.files, loaded.manifest, ctx);
  });
}

/** Ensure a package's raw files + manifest are cached; return its pinned id. */
export async function ensurePackage(
  ref: { pkg: string; version?: string; subpath?: string },
  ctx: PreprocessContext,
): Promise<{ name: string; version: string; file: string; id: string; manifest: PackageManifest }> {
  const name = ref.pkg;
  return singleFlight(ctx, `pkg:${name}@${ref.version ?? ""}#${ref.subpath ?? ""}`, async () => {
    const locked = ctx.lock[name];
    let version: string;
    let manifest: PackageManifest;
    if (locked && reusable(locked, ref.version)) {
      // Honor the lock even on a cold cache — load the *locked* version, not latest.
      version = locked;
      await ensureRawByKey(`${name}@${version}`, ctx);
      manifest = await cachedManifest(`${name}@${version}`, ctx);
    } else {
      const loaded = await matchSource(ref, ctx).load({ pkg: name, version: ref.version });
      version = loaded.version;
      await cacheRaw(name, version, loaded.files, loaded.manifest, ctx);
      manifest = loaded.manifest;
      if (!locked) ctx.lock[name] = version;
    }
    const entry = resolveEntry(manifest, ref.subpath, ctx.target);
    const file = await resolveRawFile(`${name}@${version}`, entry, ctx); // real ext/index
    return { name, version, file, id: `${name}@${version}/${file}`, manifest };
  });
}

/** Resolve an import specifier (from `fromId`) to what to emit + its cache id. A
 *  bare external specifier is rewritten to a proxy in the importer's module-root
 *  deps folder; the proxy's real endpoint (for a `local` binding) is returned as
 *  `endpointId` so the graph walker caches it. */
export async function resolveSpec(
  spec: string,
  fromId: string,
  imp: ModuleImport,
  ctx: PreprocessContext,
): Promise<{ url: string; id?: string; endpointId?: string }> {
  if (/^(https?:|data:)/.test(spec)) return { url: spec }; // absolute — pass through
  const builtin = resolveNodeBuiltin(spec, ctx.target); // node: builtins → polyfill/external
  if (builtin) {
    if ("external" in builtin) return { url: builtin.external };
    const t = await ensurePackage(builtin.ref, ctx);
    return { url: ctx.policy.servedUrl(t.id, fromId), id: t.id };
  }
  if (spec.startsWith(".")) {
    const id = await resolveRelativeId(fromId, spec, ctx);
    // The policy emits the extension-resolved relative URL (`./x` → `./x.js`) and
    // marks json/css with `?module`; the browser fetches this URL verbatim.
    return { url: ctx.policy.servedUrl(id, fromId), id };
  }
  // Host-provided/builtin wins before the CSS reroute below.
  const provided = providedNames(spec, ctx);
  // Bare CSS-looking specifier — CSS never goes through `~deps`; resolve it directly
  // like the relative branch, then classify by the RESOLVED file, not the raw spec.
  if (!provided && isCssFile(spec)) {
    const { id } = await resolveCssSpec(spec, fromId, ctx);
    if (id && isCssFile(id)) return { url: ctx.policy.servedUrl(id, fromId), id };
  }
  // Bare external specifier → generate a proxy in the module root's deps folder;
  // import the proxy.
  const pid = proxyId(fromId, spec, ctx.depsFolder);
  let binding: EndpointBinding;
  let endpointId: string | undefined;
  if (provided) {
    // Bind to the registered key — the exact spec if registered, else its package
    // root (so `react/jsx-runtime` reads the `react` instance).
    const providedKey = ctx.registry.has(spec) ? spec : parseSpecifier(spec).pkg;
    binding = { kind: "host", name: providedKey };
  } else {
    binding = await ctx.resolveEndpoint.resolve(spec, { importerId: fromId, target: ctx.target });
    if (binding.kind === "local") endpointId = binding.url; // canonical id → walked
  }
  await ensureProxy(pid, binding, imp, ctx);
  return { url: ctx.policy.servedUrl(pid, fromId), id: pid, endpointId };
}

/** Structural identity of a binding: its kind plus the field that identifies it. */
function bindingKey(b: EndpointBinding): string {
  if (b.kind === "host") return `host:${b.name}`;
  if (b.kind === "inline") return `inline:${b.code}`;
  return `${b.kind}:${b.url}`;
}

/** Where a proxy's accumulated import shape is persisted, beside its emitted
 *  artifact — same `.<kind>` sidecar convention the build already uses for the
 *  per-id `.hash` gate. The sidecar is written BEFORE the body it describes (see
 *  the write callbacks), so a torn write can only ever leave it LEADING the
 *  artifact, which the mandatory first-touch re-emit repairs. */
function shapePath(pid: string, ctx: PreprocessContext): string {
  return `${ctx.policy.emittedPath(pid)}.shape.json`;
}

/**
 * Seed `ctx.proxies` for `pid` from its durable sidecar, ONCE per run, before the
 * caller merges its own shape in.
 *
 * `ctx.proxies` is per-run in-memory state but the emitted proxy is durable, and a
 * shared proxy's export surface is the union of ALL its importers'. An incremental
 * driver walks only the CHANGED importers, so a fresh run would otherwise start
 * from an empty accumulator and rewrite the proxy with just those importers'
 * names — silently deleting exports that unchanged, already-emitted modules still
 * import. Seeding from the sidecar makes the accumulator monotone across runs.
 *
 * The seed goes through `mergeProxyShape`, so it UNIONS with whatever a concurrent
 * caller already merged instead of overwriting it, and concurrent callers for one
 * pid share a single read via `singleFlight`. Only the import shape is persisted,
 * never the binding: a binding legitimately changes between runs (a version bump
 * moves a `local` endpoint url) and a stale persisted one would raise a spurious
 * `conflicting bindings` error. The seeded shape is unioned under the CURRENT
 * caller's binding, and the run's first touch of a pid always re-emits (see
 * `ensureProxy`), so a changed binding still reaches the emitted body.
 */
async function seedProxyShape(
  pid: string,
  binding: EndpointBinding,
  ctx: PreprocessContext,
): Promise<void> {
  if (ctx.proxies.has(pid)) return; // already touched in this run — nothing to seed
  await singleFlight(ctx, `proxyseed:${pid}`, async () => {
    const raw = await tryReadText(ctx.cache, shapePath(pid, ctx));
    if (!raw) return;
    let imp: ModuleImport | undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<ModuleImport>;
      if (Array.isArray(parsed?.names)) {
        imp = {
          names: parsed.names.filter((n): n is string => typeof n === "string"),
          hasDefault: !!parsed.hasDefault,
          hasNamespace: !!parsed.hasNamespace,
        };
      }
    } catch {
      imp = undefined; // a corrupt sidecar degrades to the pre-seed behaviour
    }
    if (!imp) return;
    // `grew` is discarded: the run's first touch of this pid re-emits unconditionally
    // anyway, so nothing here needs to request a write.
    mergeProxyShape(pid, binding, imp, ctx);
  });
}

/**
 * Merge one importer's import shape into a proxy's accumulated shape; returns
 * `true` when the shape grew and the body must be re-emitted.
 *
 * SYNCHRONOUS BY DESIGN, and it MUST run outside `singleFlight`. The flight
 * coalesces concurrent calls for one pid; those calls now carry DIFFERENT `imp`s,
 * so coalescing before the merge would silently drop an importer's names and
 * produce a proxy missing exports nobody notices until runtime.
 *
 * `seedProxyShape` is the one call that DOES merge inside a flight. Its `imp` is
 * read from the pid's sidecar, so no importer's names can be dropped there — but
 * its `binding` IS caller-specific, and on the `!prev` path the winning caller's
 * binding is what establishes the entry. That is nonetheless safe, and not because
 * the payload is identical: it is safe because every caller re-merges its OWN
 * binding through this function immediately after the flight resolves, so a
 * genuine conflict still reaches the `conflicting bindings` guard and throws.
 */
function mergeProxyShape(
  pid: string,
  binding: EndpointBinding,
  imp: ModuleImport,
  ctx: PreprocessContext,
): boolean {
  const prev = ctx.proxies.get(pid);
  if (!prev) {
    ctx.proxies.set(pid, {
      binding,
      imp: {
        names: [...new Set(imp.names)],
        hasDefault: imp.hasDefault,
        hasNamespace: imp.hasNamespace,
      },
    });
    return true;
  }
  if (bindingKey(prev.binding) !== bindingKey(binding)) {
    throw new ModuleResolveError(
      { url: pid },
      `conflicting bindings for one proxy path: ${bindingKey(prev.binding)} vs ${bindingKey(binding)}`,
    );
  }
  const names = new Set(prev.imp.names);
  const before = names.size;
  for (const n of imp.names) names.add(n);
  let grew = names.size !== before;
  prev.imp.names = [...names];
  if (imp.hasDefault && !prev.imp.hasDefault) {
    prev.imp.hasDefault = true;
    grew = true;
  }
  if (imp.hasNamespace && !prev.imp.hasNamespace) {
    prev.imp.hasNamespace = true;
    grew = true;
  }
  return grew;
}

/**
 * Does the endpoint module itself export a `default`?
 *
 * Asked of the ENDPOINT rather than of any importer, so a proxy's `export
 * { default }` line does not depend on which files of the module root have been
 * transformed yet — the same reason the named list is not narrowed to them.
 *
 * A CJS endpoint always has one: its translation emits `export default` for the
 * `module.exports` object no matter what the source's own lexed exports look like.
 * Otherwise the source is analyzed. Unreadable (or unanalyzable) ⇒ `undefined`, and
 * the caller falls back to the importer's shape rather than guessing — emitting a
 * `default` the endpoint lacks is a link error for every importer of the proxy.
 */
async function endpointExportsDefault(
  endpointId: string,
  ctx: PreprocessContext,
): Promise<boolean | undefined> {
  return singleFlight(ctx, `endpointdefault:${endpointId}`, async () => {
    try {
      const { source, format } = await loadRaw(endpointId, ctx);
      if (format === "cjs") return true;
      const { exports } = await analyze(source, format, ctx.target === "browser");
      return exports.includes("default");
    } catch {
      return undefined;
    }
  });
}

/** Serialize writes per proxy id. Each link builds its body from the LIVE
 *  accumulated shape when it RUNS, not when it is queued, so a stale body can
 *  never land after a fuller one — the last write always carries the union.
 *  Two `ensureProxy` calls for one pid now carry DIFFERENT `imp`s and settle at
 *  different times; without this chain their writes race unordered onto the
 *  SAME cache key, and a slow write for a thinner shape can silently overwrite
 *  a fuller one that already landed — permanently, since `ctx.proxies` already
 *  holds the union and a later call sees `grew === false` and skips the write. */
function queueProxyWrite(
  ctx: PreprocessContext,
  pid: string,
  write: () => Promise<void>,
): Promise<void> {
  const key = `proxywrite:${pid}`;
  const prev = (ctx.inflight.get(key) as Promise<unknown> | undefined) ?? Promise.resolve();
  const next = prev.then(write, write); // a failed link must not stall the chain
  ctx.inflight.set(key, next);
  return next.finally(() => {
    if (ctx.inflight.get(key) === next) ctx.inflight.delete(key);
  });
}

/** Generate + cache a proxy module. One proxy serves every importer in its module
 *  root, so the body is built from the ACCUMULATED shape (see `mergeProxyShape`)
 *  and re-emitted whenever that shape grows. A `local` endpoint's URL is shaped
 *  through the URL policy (`servedUrl(endpointId, pid)`) so it carries the driver's
 *  extension decision and is already relativized — `proxyBody` splices it in
 *  verbatim. */
export async function ensureProxy(
  pid: string,
  binding: EndpointBinding,
  imp: ModuleImport,
  ctx: PreprocessContext,
): Promise<void> {
  // FIRST touch of this pid in this run — checked BEFORE the seed populates the map.
  const firstTouch = !ctx.proxies.has(pid);
  await seedProxyShape(pid, binding, ctx); // durable union across runs; awaited BEFORE the merge
  const grew = mergeProxyShape(pid, binding, imp, ctx);
  const key = ctx.policy.emittedPath(pid);
  // The run's first touch ALWAYS re-emits, even when the seeded shape did not grow.
  // The body is a function of the shape AND the binding (plus everything else
  // `proxyBody` renders), and only the shape is persisted: without this a changed
  // binding — a version bump moving a `local` endpoint url, a `host` ↔ `local` flip,
  // a registry change — would leave the old body in place forever, and a later
  // growth would then pair the NEW url with a name set that predates it. It also
  // makes a torn body/sidecar state self-healing: the body is rebuilt from the
  // seeded union rather than trusted. Subsequent touches keep the growth-only rule.
  if (!firstTouch && !grew && (await ctx.cache.exists(key))) return;
  return queueProxyWrite(ctx, pid, async () => {
    const merged = ctx.proxies.get(pid) as { binding: EndpointBinding; imp: ModuleImport };
    const wire: EndpointBinding =
      merged.binding.kind === "local"
        ? { kind: "local", url: ctx.policy.servedUrl(merged.binding.url, pid) }
        : merged.binding;
    // Read the endpoint, not the importer, for the `default` decision (see
    // `endpointExportsDefault`). Only a `local` endpoint is ours to read.
    const endpointHasDefault =
      merged.binding.kind === "local"
        ? await endpointExportsDefault(merged.binding.url, ctx)
        : undefined;
    const body = proxyBody({
      binding: wire,
      imp: merged.imp,
      registryKey: HOST_REGISTRY_KEY,
      endpointHasDefault,
    });
    const shape = JSON.stringify(merged.imp); // snapshotted with the body, synchronously
    // Sidecar BEFORE the body, from the SAME snapshot. A torn write must leave the
    // sidecar LEADING the artifact, never lagging it: a leading sidecar is repaired
    // by the next run's mandatory first-touch re-emit, whereas a lagging one would
    // seed a union narrower than what the artifact already exports and re-narrow it.
    await writeText(ctx.cache, shapePath(pid, ctx), shape);
    await writeText(ctx.cache, key, body);
  });
}

/** Generate + cache the module-root globals proxy exporting the used allowlisted
 *  free globals. Accumulates its name set across every importer in the root, by
 *  the same growth-only rule as `ensureProxy`; `""` is the codebase's reserved
 *  free-globals pseudo-module key (see `ModuleDescriptor.imports`). */
export async function ensureGlobalsProxy(
  gid: string,
  names: string[],
  ctx: PreprocessContext,
): Promise<void> {
  const globalsBinding: EndpointBinding = { kind: "host", name: "" };
  const firstTouch = !ctx.proxies.has(gid); // checked BEFORE the seed populates the map
  await seedProxyShape(gid, globalsBinding, ctx); // durable union across runs
  const grew = mergeProxyShape(
    gid,
    globalsBinding,
    { names, hasDefault: false, hasNamespace: false },
    ctx,
  );
  const key = ctx.policy.emittedPath(gid);
  // First touch always re-emits — same rule, same reasons, as `ensureProxy`: the
  // body splices in `ctx.globals[n]` expressions that are NOT part of the persisted
  // shape and can change between runs (a different target, a user override).
  if (!firstTouch && !grew && (await ctx.cache.exists(key))) return;
  return queueProxyWrite(ctx, gid, async () => {
    const merged = ctx.proxies.get(gid) as { binding: EndpointBinding; imp: ModuleImport };
    // Alias form (`const __gI = <expr>; export { __gI as name }`) avoids a TDZ
    // ReferenceError for a global whose expression is the bare `globalThis` token.
    const body = merged.imp.names
      .map((n, i) => `const __g${i} = ${ctx.globals[n]};\nexport { __g${i} as ${n} };`)
      .join("\n");
    const shape = JSON.stringify(merged.imp); // snapshotted with the body, synchronously
    await writeText(ctx.cache, shapePath(gid, ctx), shape); // leads the body — see `ensureProxy`
    await writeText(ctx.cache, key, body);
  });
}

/** The version constraint a bare specifier should resolve to, from the importer's
 *  package: self-reference → own version; a dependency → the importer's range. */
export async function importerVersion(
  pkg: string,
  fromId: string,
  ctx: PreprocessContext,
): Promise<string | undefined> {
  const m = fromId.match(/^((?:@[^/]+\/)?[^/]+)@([^/]+)\//);
  if (!m) return undefined; // project file — no package context
  const [, impName, impVersion] = m;
  if (pkg === impName) return impVersion; // self-reference → same version
  const manifest = await cachedManifest(`${impName}@${impVersion}`, ctx).catch(() => undefined);
  return (
    manifest?.dependencies?.[pkg] ??
    manifest?.peerDependencies?.[pkg] ??
    (manifest?.optionalDependencies as Record<string, string> | undefined)?.[pkg]
  );
}

/** Direct CSS specifier resolution. A bare package specifier is resolved straight
 *  to its same-origin URL — never proxied through `~deps`. The returned url is
 *  PLAIN (no `?module`): CSS `@import` urls are substituted into the CSS text. */
export async function resolveCssSpec(
  spec: string,
  fromId: string,
  ctx: PreprocessContext,
): Promise<{ url: string; id?: string }> {
  if (/^(https?:|data:)/.test(spec)) return { url: spec }; // absolute — pass through
  if (spec.startsWith(".")) {
    const id = await resolveRelativeId(fromId, spec, ctx);
    return { url: relativeUrlCss(fromId, id, ctx), id };
  }
  // Bare package specifier (e.g. "some-pkg/reset.css") — resolve directly.
  const { pkg, subpath } = parseSpecifier(spec);
  const version = await importerVersion(pkg, fromId, ctx);
  const t = await ensurePackage({ pkg, version, subpath }, ctx);
  return { url: relativeUrlCss(fromId, t.id, ctx), id: t.id };
}

/** Plain urlPath-space relative URL (no ext decision / no `?module`) for CSS
 *  `@import`/`url()` substitution — identical under keep-ext and ext-map. */
function relativeUrlCss(fromId: string, id: string, ctx: PreprocessContext): string {
  return relativeUrl(urlPath(fromId, ctx), urlPath(id, ctx));
}

/** Run one CSS-transform pass that only CAPTURES the @import/url() specifiers a
 *  file references (via the seam's `rewrite`), without resolving them. */
export async function cssSpecifiers(
  path: string,
  source: string,
  ctx: PreprocessContext,
): Promise<string[]> {
  const cssModules = /\.module\.css$/.test(path);
  const specs = new Set<string>();
  await ctx.css.transform({ path, source, cssModules }, (s) => {
    specs.add(s);
    return s;
  });
  return [...specs];
}

/** Resolve a relative specifier against an importer id to a concrete cache id. */
export async function resolveRelativeId(
  fromId: string,
  spec: string,
  ctx: PreprocessContext,
): Promise<string> {
  const dir = fromId.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") dir.pop();
    else dir.push(part);
  }
  const base = dir.join("/");
  const pkgKey = base.match(/^(?:@[^/]+\/)?[^/]+@[^/]+/)?.[0];
  if (pkgKey) {
    const rel = base.slice(pkgKey.length + 1);
    const file = await resolveRawFile(pkgKey, rel, ctx);
    return `${pkgKey}/${file}`;
  }
  return await resolveProjectId(base, ctx); // project-relative
}

/** Source extensions probed for a project-relative id, in priority order. TS/TSX
 *  first so an ESM-convention `.js` import resolves to its `.ts`/`.tsx` source. */
const PROJECT_EXT = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json"];

/**
 * Map a project-relative id (`~/…`) to the id of the source file that actually
 * exists. A `.js`/`.jsx` specifier (the standard ESM convention) commonly names a
 * `.ts`/`.tsx` source; the raw id would then have no backing file. If the literal
 * id already exists it is returned unchanged (no behaviour change for real `.js`
 * sources or `.json`/`.css` ids); otherwise the JS-family extension is swapped for
 * each source extension, then `index.*` is tried. The literal is the last resort so
 * an unresolvable id stays identical to the pre-probe behaviour.
 */
export async function resolveProjectId(base: string, ctx: PreprocessContext): Promise<string> {
  const files = ctx.files;
  if (!files || !base.startsWith("~/")) return base;
  const has = (id: string) => files.exists(`/${id.slice(2)}`);
  if (await has(base)) return base;
  const stem = base.replace(/\.(?:m|c)?jsx?$/, ""); // ./app.js → ./app, then probe source exts
  for (const ext of PROJECT_EXT) if (await has(stem + ext)) return stem + ext;
  for (const ext of PROJECT_EXT) if (await has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return base;
}

/** Try extension/index variants for a package-relative file; return what exists.
 *  Probes for a FILE, not mere existence: `exists()` is true for directories, so a
 *  specifier like `./parser` would otherwise stop at the `parser/` directory and
 *  never reach the `/index.js` candidate below it. */
export async function resolveRawFile(
  pkgKey: string,
  file: string,
  ctx: PreprocessContext,
): Promise<string> {
  for (const ext of RAW_EXT) {
    const stats = await ctx.cache.stats(`/raw/${pkgKey}/${file}${ext}`);
    if (stats?.kind === "file") return file + ext;
  }
  return file;
}

/** Load a canonical id's raw source + format context. */
export async function loadRaw(
  id: string,
  ctx: PreprocessContext,
): Promise<{ path: string; source: string; format: ReturnType<typeof detectFormat> }> {
  // Reading a missing path (or a directory) yields zero bytes rather than an
  // error, which would transform into an EMPTY module served 200 — the browser
  // then fails far away at "does not provide an export named …". A miss is a miss.
  if (id.startsWith("~/")) {
    if (!ctx.files) throw new ModuleResolveError({ url: id }, "no project FilesApi");
    const path = `/${id.slice(2)}`;
    if ((await ctx.files.stats(path))?.kind !== "file")
      throw new ModuleResolveError({ url: id }, "no such file");
    const source = await readText(ctx.files, path);
    return { path, source, format: detectFormat(path, source) };
  }
  const m = id.match(/^((?:@[^/]+\/)?[^/]+@[^/]+)\/(.+)$/);
  if (!m) throw new ModuleResolveError({ url: id }, "not a module id");
  const [, pkgKey, rawFile] = m;
  await ensureRawByKey(pkgKey, ctx);
  const file = await resolveRawFile(pkgKey, rawFile, ctx);
  if ((await ctx.cache.stats(`/raw/${pkgKey}/${file}`))?.kind !== "file")
    throw new ModuleResolveError({ url: id }, "no such file");
  const source = await readText(ctx.cache, `/raw/${pkgKey}/${file}`);
  const manifest = await cachedManifest(pkgKey, ctx).catch(() => undefined);
  return { path: `/${pkgKey}/${file}`, source, format: detectFormat(file, source, manifest) };
}

/** Resolve a file id (project `~/…` or `{pkg}@{ver}/{file}`) to its raw bytes. */
export async function rawBytes(
  id: string,
  ctx: PreprocessContext,
): Promise<Uint8Array | undefined> {
  // `exists()` is true for directories, and reading one yields zero bytes with no
  // error — which would surface as an empty 200 instead of a miss. Probe for a file.
  if (id.startsWith("~/")) {
    const path = `/${id.slice(2)}`;
    if (!ctx.files || (await ctx.files.stats(path))?.kind !== "file") return undefined;
    return collect(ctx.files.read(path));
  }
  const m = id.match(/^((?:@[^/]+\/)?[^/]+@[^/]+)\/(.+)$/);
  if (!m) return undefined;
  await ensureRawByKey(m[1], ctx);
  // The id is already canonical (the resolver did the extension/index probing), so
  // read it literally: probing here would serve `dir/index.js`'s bytes at the `dir`
  // URL, splitting one module across two URLs.
  if ((await ctx.cache.stats(`/raw/${m[1]}/${m[2]}`))?.kind !== "file") return undefined;
  return collect(ctx.cache.read(`/raw/${m[1]}/${m[2]}`));
}

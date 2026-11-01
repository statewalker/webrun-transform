import { readText } from "@statewalker/webrun-files";
import type { Loader, Plugin } from "esbuild-wasm";
import { inlineInputMap, withoutInputMap } from "./input-maps.js";
import { nodeModulesPackages } from "./packages.js";
import { dirOf, idOf, isFile, joinWithin, pathOf, readManifest } from "./paths.js";
import { resolveSpecifier } from "./resolve.js";
import type {
  BundleOptions,
  BundleResult,
  ExternalPattern,
  Mount,
  SourceMap,
  TranspileOptions,
  TranspileResult,
} from "./types.js";

/** esbuild's namespace for the files the bundler serves; its source-map names drop it. */
const NS = "webrun";
/** esbuild's namespace for the host's modules (`modules`): `virtual:<specifier>` in maps. */
const VNS = "webrun-virtual";
/** Marks an `inject` entry, so that it resolves like an import, not like the entry point. */
const INJECT = "webrun-inject:";

/** esbuild `supported` flags that lower `await` to generators. */
const LOWER_AWAIT = { "async-await": false, "async-generator": false, "for-await": false };

const LOADERS: Record<string, Loader> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  jsx: "jsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  json: "json",
  css: "css",
  txt: "text",
  wasm: "binary",
};
export const loaderFor = (path: string): Loader =>
  LOADERS[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ""] ?? "js";

const isExternal = (spec: string, patterns: ExternalPattern[]) =>
  /^(https?:|data:)/.test(spec) ||
  patterns.some((p) =>
    typeof p === "string"
      ? p.endsWith("*")
        ? spec.startsWith(p.slice(0, -1))
        : spec === p
      : p.test(spec),
  );

/** A source name of esbuild's map → the file id it stands for. */
const sourceId = (s: string) =>
  s
    .replace(/^(\.\.\/)*/, "")
    .replace(new RegExp(`^${VNS}:`), "virtual:")
    .replace(new RegExp(`^${NS}:`), "")
    .replace("?type=module.mjs", ""); // ESM_SUFFIX: the file's id, as in the map's other sources

const toBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** `code` with its trailing map link replaced: by `map` inlined, or by a link to `name`. */
function linkMap(code: string, map: SourceMap, how: "external" | "inline", name: string) {
  const body = code.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, "");
  const url =
    how === "inline"
      ? `data:application/json;base64,${toBase64(JSON.stringify(map))}`
      : `${name.split("/").pop()}.map`;
  return `${body}\n//# sourceMappingURL=${url}\n`;
}

/**
 * Bundles `entry` of a project into one module with esbuild (esbuild-wasm in browsers).
 * Every file is read through FilesApi (the project's, or a package's from `packages`):
 * esbuild resolves and loads nothing itself. esbuild transpiles TypeScript and JSX,
 * converts CommonJS, lowers `await` when asked, and bundles, all in one pass, and its
 * source map goes back through each step to the files it read; where a package ships
 * its own map (TypeScript compiled to `.js`), to the package's original source. The
 * map's sources are file ids: `~/src/app.ts`, `npm:pkg@1.2.3/src/index.ts`.
 */
/** Marks the id of a `.js` file in a `"type": "module"` package scope (see `moduleTypeOf`). */
const ESM_SUFFIX = "?type=module.mjs";

export async function bundle(opts: BundleOptions): Promise<BundleResult> {
  const root = opts.root ?? "/";
  const project: Mount = {
    prefix: "~",
    files: opts.files,
    root,
    manifest: await readManifest(opts.files, root),
  };
  const packages = opts.packages ?? nodeModulesPackages();
  const external = opts.external ?? [];
  const browser = (opts.platform ?? "browser") === "browser";
  const conditions = opts.conditions ?? ["browser"];
  const outfile = opts.outfile ?? "bundle.js";
  const mounts = new Map<string, Mount>([[project.prefix, project]]);
  const supplied = opts.modules;
  const virtualSource = (spec: string) =>
    typeof supplied === "function" ? supplied(spec) : supplied?.[spec];

  /** The mount and path of a file id; the longest prefix wins (`npm:@a/b@1.0.0/…`). */
  /**
   * The module type of a `.js` file, as Node.js decides it: the `type` of the nearest
   * `package.json` (tslib ships `modules/package.json` with `"type": "module"`). esbuild reads
   * that only for files on its own file system; for ours, a file in a `"type": "module"` scope
   * gets an id ending in ESM_SUFFIX (`.mjs`), so that esbuild gives its imports of CommonJS
   * modules Node's interop: the default import is `module.exports`, even with `__esModule`.
   * Vite gets the same from esbuild by pre-bundling dependencies from disk.
   */
  const scopeTypes = new Map<string, string | undefined>();
  const moduleTypeOf = async (mount: Mount, path: string): Promise<string | undefined> => {
    const root = mount.root.replace(/\/$/, "");
    for (let dir = dirOf(path); dir.length >= root.length; dir = dirOf(dir)) {
      const key = `${mount.prefix}:${dir}`;
      if (scopeTypes.has(key)) return scopeTypes.get(key);
      const pj = `${dir === "/" ? "" : dir}/package.json`;
      if (await isFile(mount, pj)) {
        let type: string | undefined;
        try {
          type = JSON.parse(await readText(mount.files, pj)).type;
        } catch {}
        scopeTypes.set(key, type);
        return type;
      }
      if (dir === root || dir === "/" || !dir) break;
    }
    return undefined;
  };

  const locate = (id: string) => {
    if (id.endsWith(ESM_SUFFIX)) id = id.slice(0, -ESM_SUFFIX.length);
    let best: Mount | undefined;
    for (const m of mounts.values())
      if (id.startsWith(`${m.prefix}/`) && (!best || m.prefix.length > best.prefix.length))
        best = m;
    const path = best && pathOf(best, id);
    if (!best || !path) throw new Error(`webrun-bundler: no file ${id}`);
    return { mount: best, path };
  };

  const plugin: Plugin = {
    name: "webrun-files",
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        const injected = args.path.startsWith(INJECT);
        const spec = injected ? args.path.slice(INJECT.length) : args.path;
        if (args.kind === "entry-point" && !injected) {
          const path = joinWithin(root, root, args.path.replace(/^\/+/, ""));
          if (!path) return { errors: [{ text: `entry ${args.path} is outside the project` }] };
          return { path: idOf(project, path), namespace: NS };
        }
        if (virtualSource(spec) !== undefined) return { path: spec, namespace: VNS };
        if (isExternal(spec, external)) return { path: spec, external: true };
        // The host's modules and `inject` entries import from the project's root.
        const importer =
          injected || args.namespace === VNS
            ? { mount: project, path: `${root === "/" ? "" : root}/` }
            : locate(args.importer);
        const require = args.kind === "require-call" || args.kind === "require-resolve";
        const failed = (why?: string) => ({
          errors: [
            {
              text: `Could not resolve "${spec}" (imported by ${args.importer || "inject"})${why ? `: ${why}` : ""}`,
            },
          ],
        });
        let r: Awaited<ReturnType<typeof resolveSpecifier>>;
        try {
          r = await resolveSpecifier(spec, importer, packages, {
            conditions,
            require,
            browser,
          });
        } catch (e) {
          return failed((e as Error)?.message ?? String(e));
        }
        if (!r) return failed();
        mounts.set(r.mount.prefix, r.mount);
        const esm = /\.js$/.test(r.path) && (await moduleTypeOf(r.mount, r.path)) === "module";
        return { path: idOf(r.mount, r.path) + (esm ? ESM_SUFFIX : ""), namespace: NS };
      });
      b.onLoad({ filter: /.*/, namespace: VNS }, (args) => ({
        contents: virtualSource(args.path) ?? "",
        loader: "js",
      }));
      b.onLoad({ filter: /.*/, namespace: NS }, async (args) => {
        const { mount, path } = locate(args.path);
        const loader = loaderFor(path);
        if (loader === "binary") {
          const chunks: Uint8Array[] = [];
          for await (const c of mount.files.read(path)) chunks.push(c);
          const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
          let at = 0;
          for (const c of chunks) {
            bytes.set(c, at);
            at += c.length;
          }
          return { contents: bytes, loader };
        }
        const text = await readText(mount.files, path);
        const js = loader === "js" || loader === "ts" || loader === "jsx" || loader === "tsx";
        // Without an output map, the inputs' own maps are not read: esbuild would only parse them.
        if (!js) return { contents: text, loader };
        if (opts.sourcemap === false) return { contents: withoutInputMap(text), loader };
        return { contents: await inlineInputMap(mount, path, text), loader };
      });
    },
  };

  const { plugins: extraPlugins = [], ...rest } = opts.esbuildOptions ?? {};
  const result = await opts.esbuild.build({
    entryPoints: [opts.entry],
    bundle: true,
    write: false,
    format: opts.format ?? "esm",
    platform: opts.platform ?? "browser",
    target: opts.target ?? "es2022",
    outfile,
    absWorkingDir: "/",
    metafile: true,
    logLevel: "silent",
    minify: opts.minify,
    define: opts.define,
    ...(opts.lowerAwait ? { supported: LOWER_AWAIT } : {}),
    ...rest,
    ...(opts.inject?.length ? { inject: opts.inject.map((s) => INJECT + s) } : {}),
    // `sourcemap: false`: no map at all (a large bundle's map, with every source's content,
    // can take more memory than the bundle).
    sourcemap: opts.sourcemap === false ? false : "external",
    sourcesContent: opts.sourcemap !== false,
    plugins: [...extraPlugins, plugin],
  });
  const out = result.outputFiles ?? [];
  const jsFile = out.find((f) => !f.path.endsWith(".map"));
  const mapFile = out.find((f) => f.path.endsWith(".map"));
  if (!jsFile) throw new Error("webrun-bundler: esbuild produced no output");
  if (!mapFile)
    return {
      code: jsFile.text,
      map: { version: 3, sources: [], names: [], mappings: "" } as unknown as SourceMap,
      metafile: result.metafile as BundleResult["metafile"],
      warnings: result.warnings,
    } as BundleResult;
  const raw = JSON.parse(mapFile.text) as SourceMap;
  const map: SourceMap = {
    ...raw,
    file: outfile.split("/").pop(),
    sources: raw.sources.map(sourceId),
  };
  delete map.sourceRoot;
  return {
    code: linkMap(jsFile.text, map, opts.sourcemap || "external", outfile),
    map,
    metafile: result.metafile as BundleResult["metafile"],
    warnings: result.warnings,
  };
}

/**
 * Transpiles one file (TypeScript, JSX, modern syntax down to `target`; `await` lowered
 * when asked) with a source map back to it. A map the code carries (`sourceMappingURL`,
 * inline) is composed in, so the result still traces to the original.
 */
export async function transpile(code: string, opts: TranspileOptions): Promise<TranspileResult> {
  const r = await opts.esbuild.transform(code, {
    loader: loaderFor(opts.path),
    sourcefile: opts.path,
    sourcemap: "external",
    sourcesContent: true,
    format: opts.format,
    target: opts.target ?? "es2022",
    minify: opts.minify,
    define: opts.define,
    ...(opts.lowerAwait ? { supported: LOWER_AWAIT } : {}),
  });
  const map = JSON.parse(r.map) as SourceMap;
  return {
    code: linkMap(r.code, map, opts.sourcemap ?? "external", opts.path.replace(/\.[^./]+$/, ".js")),
    map,
    warnings: r.warnings,
  };
}

import type { FilesApi } from "@statewalker/webrun-files";
import type { BuildOptions, build, Message, Metafile, transform } from "esbuild-wasm";

/**
 * The esbuild API the bundler calls: `esbuild-wasm` (initialized, in browsers and
 * workers) or native `esbuild` on Node. Only `build` and `transform` are used, and
 * every file reaches esbuild through the bundler's plugin: esbuild never touches a
 * file system itself.
 */
export interface Esbuild {
  build: typeof build;
  transform: typeof transform;
}

/** The fields of a `package.json` the resolver reads. */
export interface PackageManifest {
  name?: string;
  version?: string;
  exports?: unknown;
  imports?: unknown;
  main?: string;
  module?: string;
  browser?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * A tree of files the bundler reads: the project, or one npm package. Its files get
 * ids `<prefix><path>` (`~/src/app.ts`, `npm:react@18.3.1/index.js`); the ids are what
 * the source maps name, so every bundled line traces back to the user's file or to the
 * package it came from.
 */
export interface Mount {
  /** `~` for the project, `npm:<name>@<version>` for a package. */
  prefix: string;
  files: FilesApi;
  /** The tree's directory in `files` (`/` for a package of its own, `/node_modules/x`). */
  root: string;
  /** Its `package.json`, when it has one. */
  manifest?: PackageManifest;
}

/** Where an import comes from: a file of a mount. */
export interface Importer {
  mount: Mount;
  /** The importing file's path in `mount.files` (root included). */
  path: string;
}

/**
 * Finds the npm packages bare specifiers name: in `node_modules` folders of a FilesApi
 * (`nodeModulesPackages`), fetched from a registry on demand (`npmPackages`), or both
 * (`chainPackages`).
 */
export interface PackageStore {
  /** The package `name` as `importer` sees it; `undefined` when it has none. */
  get(name: string, importer: Importer): Promise<Mount | undefined>;
}

/** A specifier left to the runtime (`cloudflare:workers`, `node:fs`): a string ending in `*` is a prefix. */
export type ExternalPattern = string | RegExp;

export interface BundleOptions {
  /** `esbuild-wasm` (or native `esbuild` on Node). */
  esbuild: Esbuild;
  /** The project's files. */
  files: FilesApi;
  /** The project's directory in `files` (default `/`). */
  root?: string;
  /** The entry module, a path in the project (`/src/index.ts`). */
  entry: string;
  /** Where bare specifiers go (default: `node_modules` folders of `files`). */
  packages?: PackageStore;
  /** Specifiers kept as imports for the runtime. `http(s):` and `data:` URLs always are. */
  external?: ExternalPattern[];
  /**
   * Modules the host supplies, by specifier (`cloudflare:workers`, `node:buffer`): their
   * JavaScript source, or `undefined` to resolve the specifier as usual. They come before
   * `external`. Their own imports resolve from the project's root; they name themselves
   * `virtual:<specifier>` in the source map.
   */
  modules?: Record<string, string> | ((specifier: string) => string | undefined);
  /**
   * Modules whose exports replace the globals of the same name in every bundled file
   * (esbuild `inject`): specifiers or project paths, resolved like imports (`modules` too).
   */
  inject?: string[];
  /**
   * `package.json` `exports` conditions besides `import`/`require` and `default`
   * (default `["browser"]`; a workerd target takes `["workerd", "worker", "browser"]`).
   */
  conditions?: string[];
  /** Output format (default `esm`). */
  format?: "esm" | "iife" | "cjs";
  /** esbuild platform (default `browser`): sets `process.env.NODE_ENV` handling and the like. */
  platform?: "browser" | "node" | "neutral";
  /** Language target (default `es2022`). */
  target?: string | string[];
  /**
   * Lower `async`/`await`, async generators and `for await` to generators, so that each
   * `await` resumes through `Promise.prototype.then` (an AsyncLocalStorage polyfill can then
   * carry its context through it). Source maps follow the lowered code.
   */
  lowerAwait?: boolean;
  minify?: boolean;
  define?: Record<string, string>;
  /** Name of the output file: the map is linked as `<outfile>.map` (default `bundle.js`). */
  outfile?: string;
  /** `external` (default): `code` links `<outfile>.map`, which `map` holds; `inline`: `code` carries it too. */
  sourcemap?: "external" | "inline" | false;
  /** Other esbuild options, applied last (the bundler's plugin and source maps stay). */
  esbuildOptions?: Partial<BuildOptions>;
}

/** A source map (version 3). */
export interface SourceMap {
  version: 3;
  file?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
  sourceRoot?: string;
}

export interface BundleResult {
  code: string;
  /** The bundle's source map: sources are file ids (`~/src/app.ts`, `npm:pkg@1.0.0/src/x.ts`). */
  map: SourceMap;
  metafile: Metafile;
  warnings: Message[];
}

export interface TranspileOptions {
  esbuild: Esbuild;
  /** The file's id or path: names it in the source map and picks the loader by extension. */
  path: string;
  format?: "esm" | "iife" | "cjs";
  target?: string | string[];
  lowerAwait?: boolean;
  minify?: boolean;
  define?: Record<string, string>;
  sourcemap?: "external" | "inline";
}

export interface TranspileResult {
  code: string;
  map: SourceMap;
  warnings: Message[];
}

import { tryReadText } from "@statewalker/webrun-files";
import { dirOf, idOf, joinWithin } from "./paths.js";
import type { Mount, SourceMap } from "./types.js";

// The last `//# sourceMappingURL=…` (or `//@`) comment of a JS file.
const MAP_COMMENT = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/;

const toBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromBase64 = (b64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

/**
 * A file's own source map, made usable by esbuild, which reads only maps inlined in
 * the file it loads (it cannot follow a linked `.map` through a FilesApi):
 *
 * - a linked map (`//# sourceMappingURL=index.js.map`) is read from the same tree and
 *   inlined; an inline `data:` map is kept;
 * - its sources become ids of the same tree (`npm:pkg@1.0.0/src/index.ts`), so the
 *   bundle's map names the package's original files, not the published JavaScript;
 * - missing `sourcesContent` is filled from the tree when the original file ships
 *   with the package.
 *
 * esbuild then composes it with its own: a bundled line traces to the original source.
 * A map that is missing or unreadable is dropped (the file maps to itself).
 */
/**
 * `code` without its trailing `sourceMappingURL` comment (and without reading the map): for
 * bundles built with no source map, where an inlined input map would only add to what esbuild
 * parses and holds (a package's maps, with their sources' text, can outweigh its code).
 */
export function withoutInputMap(code: string): string {
  const end = code.trimEnd();
  const nl = end.lastIndexOf("\n");
  return MAP_COMMENT.test(end.slice(nl + 1)) ? end.slice(0, Math.max(0, nl)) : code;
}

export async function inlineInputMap(mount: Mount, path: string, code: string): Promise<string> {
  const lines = code.trimEnd().split("\n");
  const last = lines[lines.length - 1] ?? "";
  const match = MAP_COMMENT.exec(last);
  if (!match) return code;
  const url = match[1] as string;
  const body = lines.slice(0, -1).join("\n");
  let text: string | undefined;
  let mapDir = dirOf(path);
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const meta = url.slice(5, comma);
    const payload = url.slice(comma + 1);
    try {
      text = meta.endsWith(";base64") ? fromBase64(payload) : decodeURIComponent(payload);
    } catch {
      text = undefined;
    }
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    const mapPath = joinWithin(mount.root, dirOf(path), decodeURIComponent(url));
    if (mapPath) {
      text = await tryReadText(mount.files, mapPath);
      mapDir = dirOf(mapPath);
    }
  }
  let map: SourceMap;
  try {
    map = JSON.parse(text ?? "") as SourceMap;
  } catch {
    return body; // no usable map: the file is its own source
  }
  const sourceDir = map.sourceRoot
    ? (joinWithin("/", mapDir, map.sourceRoot.replace(/\/$/, "")) ?? mapDir)
    : mapDir;
  const contents: (string | null)[] = map.sourcesContent ? [...map.sourcesContent] : [];
  const sources: string[] = [];
  for (let i = 0; i < map.sources.length; i++) {
    const src = map.sources[i] as string;
    const local = /^[a-z][a-z0-9+.-]*:/i.test(src)
      ? undefined
      : joinWithin(mount.root, sourceDir, src);
    sources.push(local ? idOf(mount, local) : src);
    if (contents[i] == null && local) contents[i] = (await tryReadText(mount.files, local)) ?? null;
  }
  const fixed: SourceMap = { ...map, sources, sourcesContent: contents };
  delete fixed.sourceRoot;
  return `${body}\n//# sourceMappingURL=data:application/json;base64,${toBase64(JSON.stringify(fixed))}\n`;
}

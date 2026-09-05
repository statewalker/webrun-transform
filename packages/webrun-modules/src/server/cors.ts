/**
 * CORS for the module server. Browsers fetch module scripts in CORS mode even for
 * a plain `import`, and follow redirects in that same mode, so a cross-origin
 * consumer needs these headers on every response — 302s and 404s included.
 */

/** Permissive defaults for `cors: true`. */
const DEFAULT_CORS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
};

/**
 * Normalize the `cors` option to the header set to merge onto every response.
 * `true` → permissive defaults; a record → exactly those headers; omitted or
 * `false` → none. Exported so a server that adds its own routes around
 * `ModuleServer.fetch` (redirects, index pages) can apply the same set.
 */
export function corsHeaders(cors?: boolean | Record<string, string>): Record<string, string> {
  if (!cors) return {};
  return cors === true ? { ...DEFAULT_CORS } : { ...cors };
}

/** Return `response` with `headers` merged in (a new Response; bodies are reused). */
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  const keys = Object.keys(headers);
  if (keys.length === 0) return response;
  const merged = new Headers(response.headers);
  for (const k of keys) merged.set(k, headers[k]);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

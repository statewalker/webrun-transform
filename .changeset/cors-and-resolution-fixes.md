---
"@statewalker/webrun-modules": minor
---

Cross-origin imports of a real npm package now work end to end.

New: `cors` on `ModuleServerOptions`. `true` merges a permissive header set
(`*`, GET/HEAD/OPTIONS) onto every response `fetch` returns — 302s and 404s
included — and answers `OPTIONS` with 204; a record supplies exactly those
headers. Omitted, nothing changes. A browser fetches a module script in CORS
mode even for a plain `import` and follows redirects in that same mode, so the
headers have to be on the whole chain, not just the response carrying the code.
`corsHeaders` and `withHeaders` are exported so a host adding its own routes
around `ModuleServer.fetch` applies the same set from the library.

**Fix:** static `require(...)` specifiers are found on the AST instead of by
scanning raw text. A text scan also matched `require(...)` appearing inside a
string or template literal — sucrase's `CJSImportProcessor` emits the text
`` `require('${path}');` `` — which was then resolved as a package name and
404'd the module that contained it.

**Fix:** a directory no longer shadows its own index. `exists()` is true for a
directory, so `./parser` stopped at `parser/` and never reached
`parser/index.js`; resolution now accepts a candidate only when it is a file.
Relatedly, `rawBytes` no longer re-runs the extension/index probe on an
already-canonical id, which had served `dir/index.js`'s bytes at the `dir` URL
and split one module across two URLs.

**Fix:** a missing module returns 404 instead of an empty 200. Reading a
missing path yields zero bytes with no error, which was transformed into an
empty module — the browser then failed far from the cause, at "does not provide
an export named …".

**Fix:** CJS/ESM detection consults the AST when a source carries BOTH a CJS and
an ESM marker. `module.exports` / `exports.` matched wherever they appeared —
inside a string, a template literal or a comment included — and won over real
`import`/`export` syntax, so sucrase's ESM transformers (which emit that text as
their output) were wrapped in the CJS function wrapper and rejected by the
browser. Unambiguous sources keep the cheap regex path, and a source that will
not parse falls back to the previous heuristics.

**Behaviour change:** a `local`/`cdn` `~deps` proxy now re-exports its endpoint
WHOLESALE (`export *`) instead of naming the bindings its importers asked for.
One proxy is shared by every file of a module root, but on the lazy server path
those files are transformed one at a time, and a client links the proxy URL as
soon as the first of them is linked — so a surface narrowed to the importers seen
so far broke every later importer needing anything more, and the emitted body
depended on transform order. `export *` is a superset of any named list, so the
body is now identical whichever importer arrives first. `export { default }` is
still emitted only for an importer that wants one, because `export *` does not
carry `default` and re-exporting one the endpoint lacks is a link error.

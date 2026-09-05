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

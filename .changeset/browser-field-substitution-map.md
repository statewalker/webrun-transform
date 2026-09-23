---
"@statewalker/webrun-modules": patch
---

A package whose legacy `browser` field is an OBJECT now resolves to a real entry.

Browserify's `browser` field has two meanings: a string is the browser entry, an
object is a per-module substitution map. `resolveEntry` asked `resolve.exports`
for a legacy main, got the map object back, read "not a string" as "no legacy
main", and fell through to a fabricated `index.js`.

For jszip (`main: "./lib/index"`, `browser: { "./lib/index":
"./dist/jszip.min.js", … }`) that named a file the tarball does not contain, so
`{ pkg: "jszip" }` resolved to `/jszip@3.10.2/index.js` and 404'd — and before
the miss-is-a-miss fix it was served as an EMPTY module, which is why the symptom
in a browser was a lone `default` export equal to `{}` rather than the JSZip
constructor.

The entry now comes from `module`/`main` and the map is applied to it, which is
what the map is for; a map that says nothing about the entry leaves it alone.

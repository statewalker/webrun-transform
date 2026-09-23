---
"@statewalker/webrun-modules": patch
---

Fonts are now served with the correct `font/*` content type.

`.woff2`, `.woff`, `.ttf`, `.otf` and `.eot` fell through the served-content-type
map to `application/octet-stream`. Browsers sniff fonts so they rendered
anyway, but the wrong `Content-Type` affects caching intermediaries and `Font
Loading API` error reporting. The map now carries the IANA-registered
`font/*` types (`font/woff2`, `font/woff`, `font/ttf`, `font/otf`) plus
`application/vnd.ms-fontobject` for `.eot`.

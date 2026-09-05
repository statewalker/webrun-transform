/**
 * A TSX page in a real browser — no `npm install react`, no bundler, no build step.
 *
 * Run (needs network for the first request, to fetch react + react-dom from npm):
 *   pnpm --filter @statewalker/webrun-modules exec tsx examples/tsx-page.ts
 *
 * Then open http://localhost:8788 — you get an interactive React page whose source
 * is the `.tsx` written below. Nothing was installed into this repo and nothing was
 * bundled: the browser asks for `/~/main.tsx`, and the module server transpiles it
 * (TS types stripped, JSX compiled), rewrites `react` / `react-dom/client` to
 * same-origin URLs, and downloads those packages from the npm registry into a temp
 * cache on the way. `/~/App.tsx`'s `import "./styles.css"` is handled the same way:
 * Lightning CSS flattens the nesting and the server hands back a tiny ESM module
 * that injects a `<style>` tag.
 *
 * The whole browser-facing surface is `server.fetch` — a standard Web handler. The
 * only route this file adds is `/` → the page.
 *
 * One caveat worth knowing before you point this at a real source directory: a
 * file's transformed output is cached under its path and reused, so editing a
 * source file does NOT invalidate it — a reload keeps serving the old module. This
 * example gets a fresh temp cache per run, so restarting it is enough; a watch-mode
 * dev loop would need the cached artifact evicted on change.
 */

import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { analyze, newModuleServer, npmRegistrySource } from "../src/index.js";

const PORT = Number(process.env.PORT ?? 8788);
const ENTRY = "/index.html";

// ---------------------------------------------------------------------------
// The "project": authored sources exactly as you would write them by hand. They
// live in memory here only to keep the example one self-contained file — a
// NodeFilesApi over a real directory behaves identically, and then editing a
// file and reloading the page is the entire dev loop.
// ---------------------------------------------------------------------------
const project = new MemFilesApi();

await writeText(
  project,
  ENTRY,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TSX — no install, no build</title>
  </head>
  <body>
    <div id="root"></div>
    <!-- The browser imports .tsx directly; the server is what makes that legal. -->
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
`,
);

await writeText(
  project,
  "/main.tsx",
  `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App title="webrun-modules" />
  </StrictMode>,
);
`,
);

await writeText(
  project,
  "/App.tsx",
  `import { useState } from "react";
import "./styles.css";

type AppProps = { title: string };

export function App({ title }: AppProps): JSX.Element {
  const [clicks, setClicks] = useState<number>(0);
  return (
    <main className="card">
      <h1>Hello from {title}</h1>
      <p>
        This page is a <code>.tsx</code> file served straight to the browser. No{" "}
        <code>npm install react</code>, no bundler, no build step — it was
        transpiled and its imports resolved on the way here.
      </p>
      <button type="button" onClick={() => setClicks(clicks + 1)}>
        clicked {clicks} {clicks === 1 ? "time" : "times"}
      </button>
      <p className="hint">
        View source: what you are reading is App.tsx, transpiled on request.
      </p>
    </main>
  );
}
`,
);

// Nested rules on purpose: browsers accept native nesting now, but the flattened
// output in the response proves the CSS went through Lightning CSS, not a static
// file handler.
await writeText(
  project,
  "/styles.css",
  `:root {
  color-scheme: light dark;
  --fg: #16181d;
  --bg: #f6f7f9;
  --accent: #4f46e5;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

.card {
  max-width: 34rem;
  padding: 2rem 2.25rem;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 6%), 0 12px 32px rgb(0 0 0 / 8%);

  & h1 {
    margin: 0 0 0.75rem;
    font-size: 1.6rem;
    letter-spacing: -0.02em;
  }

  & code {
    padding: 0.1em 0.35em;
    border-radius: 5px;
    background: #eceef3;
    font-size: 0.9em;
  }

  & button {
    margin-top: 0.5rem;
    padding: 0.6rem 1.1rem;
    border: 0;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    font: inherit;
    cursor: pointer;

    &:hover { filter: brightness(1.1); }
  }

  & .hint {
    margin-bottom: 0;
    color: #6b7280;
    font-size: 0.85rem;
  }
}
`,
);

// ---------------------------------------------------------------------------
// The server. `project` makes the authored files addressable under `~/`; react and
// react-dom are fetched from npm on demand into `cacheDir` and served same-origin.
// ---------------------------------------------------------------------------
const cacheDir = await mkdtemp(join(tmpdir(), "webrun-modules-tsx-page-"));

const server = newModuleServer({
  cache: new NodeFilesApi({ rootDir: cacheDir }),
  sources: [npmRegistrySource()],
  project,
  target: "browser",
  // A bare `import "react"` floats to *latest* unless pinned. A real project would
  // seed this from its package.json; pinning here keeps the example reproducible
  // and keeps react and react-dom on the same major.
  lock: { react: "18.3.1", "react-dom": "18.3.1" },
});

/** Everything is `server.fetch`; `/` is the one route this file owns. */
async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/") {
    return new Response(null, { status: 302, headers: { location: `/~${ENTRY}` } });
  }
  return server.fetch(request);
}

// Minimal Node http → Web-fetch adapter (no framework: server.fetch is standard).
const http = createServer(async (nodeReq, nodeRes) => {
  const url = `http://${nodeReq.headers.host ?? `localhost:${PORT}`}${nodeReq.url}`;
  const response = await handle(new Request(url, { method: nodeReq.method }));
  nodeRes.statusCode = response.status;
  response.headers.forEach((v, k) => {
    nodeRes.setHeader(k, v);
  });
  nodeRes.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
});

/**
 * Every import specifier in a served module body, read off the AST with the
 * package's own `analyze`. Not a regex: compiled JSX is full of string data that
 * looks like syntax — `["Hello from ", title]` contains `from "…"`, and a text
 * scan cheerfully reports it as an import. (`analyze` files free globals under
 * the reserved `""` key; drop it.)
 */
async function importsOf(js: string): Promise<string[]> {
  const { imports } = await analyze(js, "esm");
  return Object.keys(imports).filter((spec) => spec !== "");
}

http.listen(PORT, async () => {
  const base = `http://localhost:${PORT}`;
  console.log(`\n  ▶ open ${base}   (cache: ${cacheDir})\n`);
  console.log("Self-check — what the browser is about to receive:\n");

  // 1. The HTML: an ordinary file, served as-is. It references ./main.tsx.
  const html = await fetch(`${base}/~${ENTRY}`);
  console.log(`  GET /~${ENTRY} → ${html.status} ${html.headers.get("content-type")}`);

  // 2. main.tsx: TS stripped, JSX compiled, bare specifiers rewritten same-origin.
  const main = await fetch(`${base}/~/main.tsx`);
  const mainJs = await main.text();
  console.log(`  GET /~/main.tsx  → ${main.status} ${main.headers.get("content-type")}`);
  const mainSpecs = await importsOf(mainJs);
  for (const spec of mainSpecs) console.log(`      import "${spec}"`);
  console.log(`      JSX compiled: ${!mainJs.includes("<StrictMode>")}`);
  // Bare `react` / `react-dom/client` are gone: each now points at a file in this
  // module's own `~deps/` folder, which re-exports the resolved package.
  console.log(`      every import same-origin: ${mainSpecs.every((s) => s.startsWith("."))}`);

  // 3. App.tsx: same, plus the CSS import turned into a fetchable module URL.
  const app = await fetch(`${base}/~/App.tsx`);
  const appJs = await app.text();
  console.log(`  GET /~/App.tsx   → ${app.status} ${app.headers.get("content-type")}`);
  for (const spec of await importsOf(appJs)) console.log(`      import "${spec}"`);

  // 4. The CSS module the browser will import: nesting flattened by Lightning CSS.
  const css = await fetch(`${base}/~/styles.css?module`);
  const cssJs = await css.text();
  console.log(`  GET /~/styles.css?module → ${css.status} ${css.headers.get("content-type")}`);
  console.log(`      nesting flattened: ${cssJs.includes(".card h1")}`);

  // 5. The exact script set the browser will pull — no more, no less.
  const urls = await server.listResources({ url: "/main.tsx" });
  console.log(`\n  listResources("/main.tsx") → ${urls.length} modules, e.g.`);
  for (const u of urls.slice(0, 6)) console.log(`      ${u}`);
  console.log(`      … and ${Math.max(0, urls.length - 6)} more\n`);
  console.log(`  Ready — open ${base} and click the button.`);
});

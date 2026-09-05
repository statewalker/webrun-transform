import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { corsHeaders } from "../src/server/cors.js";
import { newModuleServer } from "../src/server/new-module-server.js";

async function project() {
  const p = new MemFilesApi();
  await writeText(p, "/a.js", `export const a = 1;`);
  return p;
}

const ACAO = "access-control-allow-origin";

describe("cors option", () => {
  it("sends no CORS headers when the option is omitted", async () => {
    const server = newModuleServer({ cache: new MemFilesApi(), project: await project() });
    const res = await server.fetch(new Request("http://h/~/a.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get(ACAO)).toBeNull();
  });

  it("`cors: true` sends permissive headers on a served module", async () => {
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project: await project(),
      cors: true,
    });
    const res = await server.fetch(new Request("http://h/~/a.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get(ACAO)).toBe("*");
    expect(res.headers.get("content-type")).toBe("text/javascript");
  });

  it("`cors: true` answers an OPTIONS preflight with 204", async () => {
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project: await project(),
      cors: true,
    });
    const res = await server.fetch(new Request("http://h/~/a.js", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get(ACAO)).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  // A cross-origin module fetch that 404s must still be readable as a 404 by the
  // page; without the header the browser reports an opaque CORS failure instead.
  it("`cors: true` applies to 404 responses too", async () => {
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project: await project(),
      cors: true,
    });
    const res = await server.fetch(new Request("http://h/no-such-pkg@1.0.0/x.js"));
    expect(res.status).toBe(404);
    expect(res.headers.get(ACAO)).toBe("*");
  });

  it("a record sets exactly the given headers", async () => {
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project: await project(),
      cors: { [ACAO]: "https://app.example" },
    });
    const res = await server.fetch(new Request("http://h/~/a.js"));
    expect(res.headers.get(ACAO)).toBe("https://app.example");
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
  });

  it("corsHeaders() exposes the same set for servers that add their own routes", () => {
    expect(corsHeaders(true)[ACAO]).toBe("*");
    expect(corsHeaders(undefined)).toEqual({});
    expect(corsHeaders(false)).toEqual({});
    expect(corsHeaders({ [ACAO]: "https://x" })).toEqual({ [ACAO]: "https://x" });
  });
});

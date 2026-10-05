import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import { preparePublishBundle } from "../src/publishing/manifest.js";

test("actual workerd compiler client sends once and rejects redirects without forwarding credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loopy-compiler-workerd-"));
  let redirect = false;
  const destinations: string[] = [];
  const source = `import { HttpIsolatedCompiler } from ${JSON.stringify(resolve(import.meta.dir, "../src/publishing/compiler-http.ts"))};
    export default { async fetch(request) {
      try { const input = await request.json(); const result = await new HttpIsolatedCompiler({origin:"https://compiler.test", serviceToken:"offline-service-token"}).compile({...input, signal:request.signal}); return Response.json(result); }
      catch { return new Response("Compiler request rejected", {status:422}); }
    } };`;
  const entrypoint = join(directory, "worker.ts");
  await writeFile(entrypoint, source);
  const build = await Bun.build({ entrypoints: [entrypoint], target: "browser", format: "esm" });
  if (!build.success || !build.outputs[0]) throw new Error("Workerd test compilation failed");
  const imageDigest = `sha256:${"a".repeat(64)}`;
  const mf = new Miniflare({
    modules: true,
    script: await build.outputs[0].text(),
    compatibilityDate: "2026-07-30",
    outboundService: (request: Request) => {
      destinations.push(request.url);
      expect(request.headers.get("authorization")).toBe("Bearer offline-service-token");
      return redirect
        ? new Response(null, {
            status: 302,
            headers: { Location: "https://redirect.test/collect" },
          })
        : Response.json({ workflow: { version: 1, slug: "test", nodes: [] }, imageDigest });
    },
  });
  try {
    const bundle = await preparePublishBundle(
      {
        entrypoint: "main.ts",
        files: ["main.ts", "bun.lock"],
        sources: [],
        lockfile: "bun.lock",
        compiler: "compiler@1",
        runtime: { build: "runtime@1", graphSchema: 1 },
      },
      async () => new TextEncoder().encode("source"),
    );
    const body = () =>
      JSON.stringify({
        bundle,
        policy: {
          deadlineMs: Date.now() + 5_000,
          maxOutputBytes: 100_000,
          serviceCredentials: false,
          dependencies: "locked-only",
        },
      });
    expect(
      (await mf.dispatchFetch("http://localhost/", { method: "POST", body: body() })).status,
    ).toBe(200);
    redirect = true;
    expect(
      (await mf.dispatchFetch("http://localhost/", { method: "POST", body: body() })).status,
    ).toBe(422);
    expect(destinations).toEqual([
      "https://compiler.test/compile",
      "https://compiler.test/compile",
    ]);
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

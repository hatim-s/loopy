import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compile } from "../src/compiler/index.js";
import {
  MAX_SOURCE_BYTES,
  putLoopyBodySchema,
  type SourceArtifact,
  sourceArtifactSchema,
} from "../src/contract/index.js";
import { Registry, SecretStore } from "../src/local/index.js";
import { saveCompiled } from "../src/local/save-compiled.js";
import { compiledBody } from "./compiled-fixture.js";

const roots: string[] = [];

const sdk = resolve(import.meta.dir, "../src/sdk/graph/index.ts");

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopy-source-")));
  roots.push(root);

  return { root, file: join(root, "entry.ts"), home: join(root, "home") };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function artifact(revision: string, content: string): SourceArtifact {
  return {
    version: 1,
    status: "available",
    revision,
    files: [{ id: "file-0", path: "entry.ts", content }],
    ranges: [],
  };
}

async function compiled(file: string, root: string) {
  const result = await compile(file);

  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }

  return {
    ...result,
    bundles: result.bundles.map((bundle) => ({
      ...bundle,
      bytes: Buffer.from(bundle.bytes).toString("base64"),
    })),
    source: { path: file, workspace: root },
    replace: false,
  };
}

test("source stays pinned after author edits, same-revision saves and later revisions", async () => {
  const f = await fixture();
  const source = `import {loopy,wait} from ${JSON.stringify(sdk)};\nexport default loopy("pinned", {input:{},run:()=>\nwait("hook", {payload:{kind:"value",type:"string"}})});\n`;
  await writeFile(f.file, source);
  const first = await compiled(f.file, f.root);
  expect(first.sourceArtifact).toMatchObject({
    status: "available",
    files: [{ content: source }],
    ranges: [{ nodeId: first.graph.nodes[0]?.id, startLine: 3, endLine: 3 }],
  });
  const registry = new Registry(f.home, f.root);
  await saveCompiled(registry, first);
  await writeFile(f.file, `\n${source}`);
  const formatting = await compiled(f.file, f.root);
  expect(formatting.revision).toBe(first.revision);
  await saveCompiled(registry, formatting);
  expect(await registry.revisionSource("pinned", first.revision)).toEqual(first.sourceArtifact);
  await writeFile(f.file, source.replace('wait("hook"', 'wait("changed"'));
  const changed = await compiled(f.file, f.root);
  expect(changed.revision).not.toBe(first.revision);
  await saveCompiled(registry, changed);
  await rm(f.file);
  expect(await registry.revisionSource("pinned", first.revision)).toEqual(first.sourceArtifact);
  expect(await registry.revisionSource("pinned", changed.revision)).toEqual(changed.sourceArtifact);
  expect(
    (await stat(join(f.home, "sources", "pinned", `${first.revision}.json`))).mode & 0o777,
  ).toBe(0o600);
});

test("old registry metadata never gains today's source for an existing revision", async () => {
  const f = await fixture();
  const body = await compiledBody("legacy", f.file);
  const registry = new Registry(f.home, f.root);
  registry.save(body);

  const unavailable = {
    version: 1,
    status: "unavailable",
    revision: body.revision,
    reason: "not_captured",
  } satisfies SourceArtifact;

  expect(await registry.revisionSource("legacy", body.revision)).toEqual(unavailable);
  await saveCompiled(registry, { ...body, sourceArtifact: artifact(body.revision, "today") });
  expect(await registry.revisionSource("legacy", body.revision)).toEqual(unavailable);
  expect(registry.get("legacy").version).toBe(2);
});

test("source lookup rejects traversal and never opens source metadata paths", async () => {
  const f = await fixture();
  const body = await compiledBody("safe", join(f.root, "never-read-this.ts"));
  const registry = new Registry(f.home, f.root);
  await saveCompiled(registry, body);
  await expect(registry.revisionSource("../outside", body.revision)).rejects.toThrow();
  await expect(registry.revisionSource("safe", "../../outside")).rejects.toThrow();
  await expect(registry.revisionSource("safe", body.revision)).resolves.toMatchObject({
    status: "unavailable",
    reason: "not_captured",
  });
  expect(
    sourceArtifactSchema.safeParse({
      ...artifact(body.revision, "x"),
      files: [{ id: "file-0", path: "../outside", content: "x" }],
    }).success,
  ).toBe(false);
});

test("save validates source identity, exact ranges and byte caps", async () => {
  const f = await fixture();
  const body = await compiledBody("validated", f.file);
  const registry = new Registry(f.home, f.root);
  await expect(
    saveCompiled(registry, { ...body, sourceArtifact: artifact("a".repeat(64), "x") }),
  ).rejects.toThrow("Source must name");
  const available = artifact(body.revision, "x");
  expect(available.status).toBe("available");

  if (available.status !== "available") {
    throw new Error("Expected source");
  }

  await expect(
    saveCompiled(registry, {
      ...body,
      sourceArtifact: {
        ...available,
        ranges: [{ nodeId: body.graph.entry, fileId: "file-0", startLine: 2, endLine: 2 }],
      },
    }),
  ).rejects.toThrow();
  await expect(
    saveCompiled(registry, {
      ...body,
      sourceArtifact: sourceArtifactSchema.parse({
        ...available,
        ranges: [{ nodeId: "missing", fileId: "file-0", startLine: 1, endLine: 1 }],
      }),
    }),
  ).rejects.toThrow("Source must name");
  expect(
    putLoopyBodySchema.safeParse({
      ...body,
      sourceArtifact: { ...available, resolvedSecrets: { TOKEN: "forbidden" } },
    }).success,
  ).toBe(false);
  expect(
    sourceArtifactSchema.safeParse(artifact(body.revision, "é".repeat(MAX_SOURCE_BYTES))).success,
  ).toBe(false);
  await writeFile(f.file, " ".repeat(MAX_SOURCE_BYTES + 1));
  expect(await compile(f.file)).toMatchObject({
    ok: false,
    diagnostics: [{ code: "source_error" }],
  });
});

test("source containing a stored secret is withheld before persistence and on later retrieval", async () => {
  const f = await fixture();
  const body = await compiledBody("private", f.file);
  const registry = new Registry(f.home, f.root);
  const secrets = new SecretStore(f.home);
  secrets.set("TOKEN", "private-token-42");
  await saveCompiled(registry, {
    ...body,
    sourceArtifact: artifact(body.revision, '// "private-token-42"'),
  });
  expect(await registry.revisionSource("private", body.revision)).toMatchObject({
    status: "unavailable",
    reason: "redacted",
  });
  expect(
    await readFile(join(f.home, "sources", "private", `${body.revision}.json`), "utf8"),
  ).not.toContain("private-token-42");
  const later = await compiledBody("later", f.file);
  await saveCompiled(registry, {
    ...later,
    sourceArtifact: artifact(later.revision, "secret-added-later"),
  });
  secrets.set("LATER", "secret-added-later");
  expect(await registry.revisionSource("later", later.revision)).toMatchObject({
    status: "unavailable",
    reason: "redacted",
  });
});

test("repeated subgraph labels have authentic source without invented node ranges", async () => {
  const f = await fixture();
  await writeFile(
    f.file,
    `import {loopy,wait,subgraph} from ${JSON.stringify(sdk)};\nconst child=subgraph("child",()=>wait("hook",{payload:{kind:"value",type:"string"}}));\nexport default loopy("ambiguous",{input:{},run:()=>{child();return child();}});`,
  );
  const result = await compiled(f.file, f.root);
  expect(result.sourceArtifact).toMatchObject({ status: "available", ranges: [] });
});

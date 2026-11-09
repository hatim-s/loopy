import { expect, test } from "bun:test";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compile } from "@loopy/compiler";
import {
  decodeBoundary,
  MAX_SOURCE_BYTES,
  putLoopyBodySchema,
  type SourceArtifact,
  sourceArtifactOrUnavailable,
  sourceArtifactSchema,
} from "@loopy/contract";
import { Effect, Schema } from "effect";
import { Registry } from "../src/local";
import { saveCompiled } from "../src/local/save-compiled";
import { SecretStore } from "../src/os";
import { compiledBody } from "./fixtures/compiled";
import { qualityTestRoot } from "./fixtures/quality-test-root";

const sdk = "loopy";

async function fixture() {
  const root = qualityTestRoot("source");

  return { root, file: join(root, "entry.ts"), home: join(root, "home") };
}

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
  const result = await Effect.runPromise(compile(file));

  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }

  return {
    ...result,
    bundles: result.bundles,
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
  const registry = await Effect.runPromise(Registry.make(f.home, f.root));
  await Effect.runPromise(saveCompiled(registry, first));
  await writeFile(f.file, `\n${source}`);
  const formatting = await compiled(f.file, f.root);
  expect(formatting.revision).toBe(first.revision);
  await Effect.runPromise(saveCompiled(registry, formatting));
  expect(await Effect.runPromise(registry.revisionSource("pinned", first.revision))).toEqual(
    first.sourceArtifact,
  );
  await writeFile(f.file, source.replace('wait("hook"', 'wait("changed"'));
  const changed = await compiled(f.file, f.root);
  expect(changed.revision).not.toBe(first.revision);
  await Effect.runPromise(saveCompiled(registry, changed));
  await rm(f.file);
  expect(await Effect.runPromise(registry.revisionSource("pinned", first.revision))).toEqual(
    first.sourceArtifact,
  );
  expect(await Effect.runPromise(registry.revisionSource("pinned", changed.revision))).toEqual(
    changed.sourceArtifact,
  );
  expect(
    (await stat(join(f.home, "sources", "pinned", `${first.revision}.json`))).mode & 0o777,
  ).toBe(0o600);
});

test("old registry metadata never gains today's source for an existing revision", async () => {
  const f = await fixture();
  const body = await compiledBody("legacy", f.file);
  const registry = await Effect.runPromise(Registry.make(f.home, f.root));
  await Effect.runPromise(registry.save(body));

  const unavailable = {
    version: 1,
    status: "unavailable",
    revision: body.revision,
    reason: "not_captured",
  } satisfies SourceArtifact;

  expect(await Effect.runPromise(registry.revisionSource("legacy", body.revision))).toEqual(
    unavailable,
  );
  await Effect.runPromise(
    saveCompiled(registry, { ...body, sourceArtifact: artifact(body.revision, "today") }),
  );
  expect(await Effect.runPromise(registry.revisionSource("legacy", body.revision))).toEqual(
    unavailable,
  );
  expect((await Effect.runPromise(registry.get("legacy")))?.version).toBe(3);
});

test("source lookup rejects traversal and never opens source metadata paths", async () => {
  const f = await fixture();
  const body = await compiledBody("safe", join(f.root, "never-read-this.ts"));
  const registry = await Effect.runPromise(Registry.make(f.home, f.root));
  await Effect.runPromise(saveCompiled(registry, body));
  await expect(
    Effect.runPromise(registry.revisionSource("../outside", body.revision)),
  ).rejects.toThrow();
  await expect(
    Effect.runPromise(registry.revisionSource("safe", "../../outside")),
  ).rejects.toThrow();
  await expect(
    Effect.runPromise(registry.revisionSource("safe", body.revision)),
  ).resolves.toMatchObject({
    status: "unavailable",
    reason: "not_captured",
  });
  expect(
    Schema.decodeUnknownExit(sourceArtifactSchema)(
      {
        ...artifact(body.revision, "x"),
        files: [{ id: "file-0", path: "../outside", content: "x" }],
      },
      { onExcessProperty: "error" },
    )._tag === "Success",
  ).toBe(false);
});

test("source boundaries validate ranges and byte caps while save checks graph identity", async () => {
  const f = await fixture();
  const body = await compiledBody("validated", f.file);
  const registry = await Effect.runPromise(Registry.make(f.home, f.root));
  await expect(
    Effect.runPromise(
      saveCompiled(registry, { ...body, sourceArtifact: artifact("a".repeat(64), "x") }),
    ),
  ).rejects.toThrow("Source must name");
  const available = artifact(body.revision, "x");
  expect(available.status).toBe("available");

  if (available.status !== "available") {
    throw new Error("Expected source");
  }

  expect(() =>
    decodeBoundary(putLoopyBodySchema)({
      ...body,
      sourceArtifact: {
        ...available,
        ranges: [{ nodeId: body.graph.entry, fileId: "file-0", startLine: 2, endLine: 2 }],
      },
    }),
  ).toThrow();
  await expect(
    Effect.runPromise(
      saveCompiled(registry, {
        ...body,
        sourceArtifact: decodeBoundary(sourceArtifactSchema)({
          ...available,
          ranges: [{ nodeId: "missing", fileId: "file-0", startLine: 1, endLine: 1 }],
        }),
      }),
    ),
  ).rejects.toThrow("Source must name");
  expect(
    Schema.decodeUnknownExit(putLoopyBodySchema)(
      {
        ...body,
        sourceArtifact: { ...available, resolvedSecrets: { TOKEN: "forbidden" } },
      },
      { onExcessProperty: "error" },
    )._tag === "Success",
  ).toBe(false);
  const file = { id: "file-0", path: "entry.ts", content: "é".repeat(MAX_SOURCE_BYTES) };
  expect(sourceArtifactOrUnavailable({ ...available, files: [file] })).toMatchObject({
    status: "unavailable",
    reason: "too_large",
  });
  expect(
    sourceArtifactOrUnavailable({
      ...available,
      files: [{ ...file, path: "a/b.ts", content: "" }],
    }),
  ).toMatchObject({ status: "unavailable", reason: "not_captured" });
  await writeFile(f.file, " ".repeat(MAX_SOURCE_BYTES + 1));
  expect(await Effect.runPromise(compile(f.file))).toMatchObject({
    ok: false,
    diagnostics: [{ code: "source_error" }],
  });
});

test("source containing a stored secret is withheld before persistence and on later retrieval", async () => {
  const f = await fixture();
  const body = await compiledBody("private", f.file);
  const registry = await Effect.runPromise(Registry.make(f.home, f.root));
  const secrets = new SecretStore(f.home);
  await Effect.runPromise(secrets.set("TOKEN", "private-token-42"));
  await Effect.runPromise(
    saveCompiled(registry, {
      ...body,
      sourceArtifact: artifact(body.revision, '// "private-token-42"'),
    }),
  );
  expect(await Effect.runPromise(registry.revisionSource("private", body.revision))).toMatchObject({
    status: "unavailable",
    reason: "redacted",
  });
  expect(
    await readFile(join(f.home, "sources", "private", `${body.revision}.json`), "utf8"),
  ).not.toContain("private-token-42");
  const later = await compiledBody("later", f.file);
  await Effect.runPromise(
    saveCompiled(registry, {
      ...later,
      sourceArtifact: artifact(later.revision, "secret-added-later"),
    }),
  );
  await Effect.runPromise(secrets.set("LATER", "secret-added-later"));
  expect(await Effect.runPromise(registry.revisionSource("later", later.revision))).toMatchObject({
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

import { expect, test } from "bun:test";
import { revision, sha256Hex } from "@loopy/core";
import { Effect } from "effect";
import {
  decodeBoundary,
  graphSchema,
  nodeIdSchema,
  type PutLoopyBody,
  type SourceArtifact,
} from "../src";
import { validateCompiled } from "../src/server";

function artifact(hash: string, content: string): SourceArtifact {
  return {
    version: 1,
    status: "available",
    revision: hash,
    files: [{ id: "file-0", path: "entry.ts", content }],
    ranges: [],
  };
}

/** One code node with its bundle, as the compiler saves `code("execute", ...)`. */
async function executable(): Promise<PutLoopyBody> {
  const bytes = new TextEncoder().encode('export default () => "ok";');
  const bundleHash = await sha256Hex(bytes);

  const graph = decodeBoundary(graphSchema)({
    version: 1,
    name: "executable",
    meta: { description: null, schedule: null, secrets: [], mode: "sandbox", scope: "project" },
    input: {},
    entry: "0:execute",
    outputs: null,
    edges: [],
    nodes: [
      {
        id: "0:execute",
        kind: "code",
        label: "execute",
        scope: null,
        in: {},
        out: { kind: "value", type: "string" },
        module: { path: "./entry.ts", bundleHash },
        rateLimit: null,
        retry: { attempts: 3, retryOnExit: false },
        timeout: null,
      },
    ],
  });

  return {
    graph,
    revision: await revision(graph),
    replace: false,
    bundles: [{ nodeId: decodeBoundary(nodeIdSchema)("0:execute"), bundleHash, bytes }],
    source: { path: "/entry.ts", workspace: "validation" },
  };
}

const validate = (body: PutLoopyBody) => Effect.runPromise(validateCompiled(body));

test("validation rejects forged bundles, revisions and source mappings", async () => {
  const body = await executable();
  await expect(validate(body)).resolves.toBeDefined();
  await expect(validate({ ...body, revision: "f".repeat(64) })).rejects.toThrow(
    "The graph revision does not match its contents.",
  );
  await expect(validate({ ...body, bundles: [] })).rejects.toThrow(
    "Supply exactly one bundle for each code node and parser in node order.",
  );
  await expect(
    validate({
      ...body,
      bundles: body.bundles.map((bundle) => ({
        ...bundle,
        bytes: new TextEncoder().encode("wrong"),
      })),
    }),
  ).rejects.toThrow("Bundle bytes do not match their hash.");
  await expect(
    validate({ ...body, sourceArtifact: artifact("f".repeat(64), "wrong") }),
  ).rejects.toThrow("Source must name this compiled revision and its graph nodes.");

  const source = artifact(body.revision, "source");

  if (source.status !== "available") {
    throw new Error("Fixture requires source files.");
  }

  // Both an unknown node and a range past the file's last line fail the same source check.
  for (const endLine of [2, 1]) {
    source.ranges = [
      {
        nodeId: decodeBoundary(nodeIdSchema)("missing-node"),
        fileId: "file-0",
        startLine: 1,
        endLine,
      },
    ];
    await expect(validate({ ...body, sourceArtifact: source })).rejects.toThrow(
      "Source must name this compiled revision and its graph nodes.",
    );
  }
});

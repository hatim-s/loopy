import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type PutLoopyBody, sourceArtifactSchema } from "../contract/index.js";
import { canonicalJson, revision, validateGraph } from "../core/index.js";
import { writeFileAtomically } from "./fs.js";
import type { Registry } from "./registry.js";
import { redactSourceArtifact } from "./source-view.js";

export async function saveCompiled(registry: Registry, body: PutLoopyBody) {
  const diagnostics = validateGraph(body.graph);

  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map((item) => item.message).join("\n"));
  }

  const expected = body.graph.nodes.flatMap((node) =>
    node.kind === "code"
      ? [{ nodeId: node.id, bundleHash: node.module.bundleHash }]
      : node.kind === "command" && node.parse
        ? [{ nodeId: node.id, bundleHash: node.parse.bundleHash }]
        : [],
  );

  if (
    expected.length !== body.bundles.length ||
    expected.some(
      (value, index) =>
        value.bundleHash === null ||
        value.nodeId !== body.bundles[index]?.nodeId ||
        value.bundleHash !== body.bundles[index]?.bundleHash,
    )
  ) {
    throw new Error("Supply exactly one bundle for each code node and parser in node order.");
  }

  if ((await revision(body.graph)) !== body.revision) {
    throw new Error("The graph revision does not match its contents.");
  }

  const bundles = body.bundles.map((value) => ({
    ...value,
    bytes: Buffer.from(value.bytes, "base64"),
  }));

  if (
    bundles.some(
      (value) => createHash("sha256").update(value.bytes).digest("hex") !== value.bundleHash,
    )
  ) {
    throw new Error("Bundle bytes do not match their hash.");
  }

  const unchanged = registry.unchanged(body);

  const artifact = sourceArtifactSchema.parse(
    body.sourceArtifact ?? {
      version: 1,
      status: "unavailable",
      revision: body.revision,
      reason: "not_captured",
    },
  );

  if (
    artifact.revision !== body.revision ||
    (artifact.status === "available" &&
      artifact.ranges.some((range) => !body.graph.nodes.some((node) => node.id === range.nodeId)))
  ) {
    throw new Error("Source must name this compiled revision and its graph nodes.");
  }

  // An old revision cannot gain today's source, even when formatting left its graph hash unchanged.
  const historical = unchanged.ok || existsSync(registry.graphPath(body.revision));

  const sourceArtifact = historical
    ? sourceArtifactSchema.parse({
        version: 1,
        status: "unavailable",
        revision: body.revision,
        reason: "not_captured",
      })
    : redactSourceArtifact(registry.home, artifact);

  if (unchanged.ok) {
    registry.pinSource(body.graph.name, sourceArtifact);

    return unchanged.entry;
  }

  await mkdir(join(registry.home, "bundles"), { recursive: true, mode: 0o700 });

  for (const value of bundles) {
    writeFileAtomically(registry.bundlePath(value.bundleHash), value.bytes, 0o600);
  }

  await mkdir(join(registry.home, "graphs"), { recursive: true, mode: 0o700 });
  writeFileAtomically(registry.graphPath(body.revision), canonicalJson(body.graph), 0o600);

  return registry.save({ ...body, sourceArtifact });
}

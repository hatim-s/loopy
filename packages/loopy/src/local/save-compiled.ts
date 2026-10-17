import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PutLoopyBody } from "../contract/index.js";
import { canonicalJson, validateGraph } from "../core/index.js";
import { writeFileAtomically } from "./fs.js";
import type { Registry } from "./registry.js";

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

  const revision = createHash("sha256")
    .update(canonicalJson(body.graph))
    .update(body.bundles.map((value) => value.bundleHash).join(""))
    .digest("hex");

  if (revision !== body.revision) {
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

  await mkdir(join(registry.home, "bundles"), { recursive: true, mode: 0o700 });

  for (const value of bundles) {
    writeFileAtomically(registry.bundlePath(value.bundleHash), value.bytes, 0o600);
  }

  await mkdir(join(registry.home, "graphs"), { recursive: true, mode: 0o700 });
  writeFileAtomically(registry.graphPath(body.revision), canonicalJson(body.graph), 0o600);

  return registry.save(body);
}

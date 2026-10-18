import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PutLoopyBody } from "../contract/index.js";
import { bundleRefs, canonicalJson, revision, sha256Hex, validateGraph } from "../core/index.js";
import { writeFileAtomically } from "../executor/index.js";
import type { Registry } from "./registry.js";

export async function saveCompiled(registry: Registry, body: PutLoopyBody) {
  const diagnostics = validateGraph(body.graph);

  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map((item) => item.message).join("\n"));
  }

  const expected = bundleRefs(body.graph);

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

  const hashes = await Promise.all(bundles.map((value) => sha256Hex(value.bytes)));

  if (bundles.some((value, index) => hashes[index] !== value.bundleHash)) {
    throw new Error("Bundle bytes do not match their hash.");
  }

  const unchanged = registry.unchanged(body);

  if (unchanged.ok) {
    return unchanged.entry;
  }

  await mkdir(join(registry.home, "bundles"), { recursive: true, mode: 0o700 });

  for (const value of bundles) {
    await writeFileAtomically(registry.bundlePath(value.bundleHash), value.bytes, {
      mode: 0o600,
      syncDirectory: true,
    });
  }

  await mkdir(join(registry.home, "graphs"), { recursive: true, mode: 0o700 });
  await writeFileAtomically(registry.graphPath(body.revision), canonicalJson(body.graph), {
    mode: 0o600,
    syncDirectory: true,
  });

  return registry.save(body);
}

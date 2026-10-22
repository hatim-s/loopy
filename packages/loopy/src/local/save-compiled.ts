import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type PutLoopyBody, sourceArtifactSchema, validateCompiled } from "../contract/index.js";
import { canonicalJson } from "../core/index.js";
import { writeFileAtomically } from "./fs.js";
import type { Registry } from "./registry.js";
import { redactSourceArtifact } from "./source-view.js";

export async function saveCompiled(registry: Registry, body: PutLoopyBody) {
  const { bundles, sourceArtifact: artifact } = await validateCompiled(body);
  const unchanged = registry.unchanged(body);

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

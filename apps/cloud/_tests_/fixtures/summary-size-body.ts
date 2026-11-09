import type { PutLoopyBody } from "@loopy/contract";
import { canonicalJson, revision } from "@loopy/core";
import { compiledBody } from "../../../../packages/loopy/_tests_/compiled-fixture";
import { ARTIFACT_LIMITS } from "../../src/artifacts/storage";

export function utf8(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function fillBytes(pattern: string, bytes: number): string {
  const count = Math.floor(bytes / utf8(pattern));

  return pattern.repeat(count) + "x".repeat(bytes - utf8(pattern) * count);
}

export async function summarySizeBody(source: string, pattern = "x"): Promise<PutLoopyBody> {
  const body = await compiledBody("summary", source, { workspace: "summaries", description: "" });
  // These are wire-valid field names and default schedule metadata accepted by publication.
  body.graph.input = { [fillBytes(pattern, 120_000)]: "string" };
  body.graph.meta.schedule = { cron: "* * * * *", tz: "UTC" };
  const base = utf8(canonicalJson(body.graph));
  const escapedPatternBytes = utf8(JSON.stringify(pattern)) - 2;
  body.graph.meta.description = pattern.repeat(
    Math.floor((ARTIFACT_LIMITS.graphBytes - base) / escapedPatternBytes),
  );
  const remaining = ARTIFACT_LIMITS.graphBytes - utf8(canonicalJson(body.graph));
  body.graph.meta.description += "x".repeat(remaining);
  body.revision = await revision(body.graph);

  return body;
}

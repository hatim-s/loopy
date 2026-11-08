import { type SourceArtifact, unavailableSource } from "@loopy/contract";
import { canonicalJson } from "@loopy/core";
import { Effect } from "effect";
import { SecretStore, secretRedactor } from "../os";

// Source never contains runtime substitutions. Withhold a snapshot that also contains a stored secret.
export const redactSourceArtifact = (home: string, artifact: SourceArtifact) =>
  Effect.gen(function* () {
    if (artifact.status === "unavailable") {
      return artifact;
    }

    const source = canonicalJson(artifact);
    const redact = secretRedactor(Object.values(yield* new SecretStore(home).snapshot()));

    return redact(source) === source ? artifact : unavailableSource(artifact.revision, "redacted");
  });

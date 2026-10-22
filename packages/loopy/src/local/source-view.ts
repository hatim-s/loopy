import type { SourceArtifact } from "../contract/index.js";
import { canonicalJson } from "../core/index.js";
import { secretRedactor } from "./secret-redactor.js";
import { SecretStore } from "./secrets.js";

// Source never contains runtime substitutions. Withhold a snapshot that also contains a stored secret.
export function redactSourceArtifact(home: string, artifact: SourceArtifact): SourceArtifact {
  if (artifact.status === "unavailable") {
    return artifact;
  }

  const source = canonicalJson(artifact);
  const redact = secretRedactor(Object.values(new SecretStore(home).snapshot()));

  return redact(source) === source
    ? artifact
    : { version: 1, status: "unavailable", revision: artifact.revision, reason: "redacted" };
}

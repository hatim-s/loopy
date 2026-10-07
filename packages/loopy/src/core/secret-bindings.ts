import type { SecretBindings } from "./model.js";
import { UUID_PATTERN, validateEnvironmentName, validateSecretName } from "./names.js";
import { allowKeys, requireRecord, requireString } from "./validation.js";

export function validateSecretBindings(value: unknown): asserts value is SecretBindings {
  const bindings = requireRecord(value, "Secret bindings");
  allowKeys(bindings, "Secret bindings", ["ownerId", "env"]);
  if (typeof bindings.ownerId !== "string" || !UUID_PATTERN.test(bindings.ownerId)) {
    throw new Error("Invalid secret binding owner.");
  }
  const env = requireRecord(bindings.env, "Secret bindings.env");
  for (const [key, name] of Object.entries(env)) {
    validateEnvironmentName(key);
    validateSecretName(requireString(name, `Secret binding '${key}'`));
  }
}

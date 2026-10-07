import type { SecretBindings } from "./model.js";

export function validateEnvironmentName(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error("A secret binding requires a valid environment variable name.");
  }
}

export function validateSecretBindings(value: unknown): asserts value is SecretBindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid secret bindings.");
  }
  const bindings = value as Record<string, unknown>;
  if (typeof bindings.ownerId !== "string" || !/^[a-f0-9-]{36}$/.test(bindings.ownerId)) {
    throw new Error("Invalid secret binding owner.");
  }
  if (!bindings.env || typeof bindings.env !== "object" || Array.isArray(bindings.env)) {
    throw new Error("Invalid secret binding environment.");
  }
  for (const [key, name] of Object.entries(bindings.env)) {
    validateEnvironmentName(key);
    if (typeof name !== "string") {
      throw new Error("Invalid secret binding reference.");
    }
    validateSecretName(name);
  }
}

export function validateSecretName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) {
    throw new Error(
      "Secret names must contain 1-80 letters, numbers, dots, underscores, or hyphens, starting with a letter or number.",
    );
  }
}

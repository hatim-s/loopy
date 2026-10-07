/** Identifier formats shared by authoring, validation, storage and the CLI. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const NODE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
export const UUID_PATTERN = /^[a-f0-9-]{36}$/;
export const ARRAY_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/;

export function validateSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error("A slug must contain 1-80 lowercase letters, numbers, or hyphens.");
  }
}

export function validateNodeId(id: string, location: string): void {
  if (!NODE_ID_PATTERN.test(id)) {
    throw new Error(`${location} must start with a letter and contain letters, numbers, _ or -`);
  }
}

export function validateEnvironmentName(name: string): void {
  if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
    throw new Error(`'${name}' is not a valid environment variable name.`);
  }
}

export function validateSecretName(name: string): void {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new Error(
      "Secret names must contain 1-80 letters, numbers, dots, underscores, or hyphens, starting with a letter or number.",
    );
  }
}

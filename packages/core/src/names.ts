import { Schema } from "effect";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

const SECRET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

export function validateSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error("A slug must contain 1-80 lowercase letters, numbers, or hyphens.");
  }
}

const SECRET_NAME_MESSAGE =
  "Secret names must contain 1-80 letters, numbers, dots, underscores, or hyphens, starting with a letter or number.";

export const secretNameSchema = Schema.String.check(
  Schema.isPattern(SECRET_NAME_PATTERN, { message: SECRET_NAME_MESSAGE }),
);

export function validateSecretName(name: string): void {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new Error(SECRET_NAME_MESSAGE);
  }
}

export const MAX_SECRET_VALUE_BYTES = 64 * 1024;

const ENCODER = new TextEncoder();

export const secretValueSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value !== "" &&
      !value.includes("\0") &&
      ENCODER.encode(value).byteLength <= MAX_SECRET_VALUE_BYTES,
    {
      message: `A secret must be nonempty, contain no NUL bytes, and fit within ${MAX_SECRET_VALUE_BYTES / 1024} KiB.`,
    },
  ),
);

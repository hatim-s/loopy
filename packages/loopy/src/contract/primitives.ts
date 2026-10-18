import { z } from "zod";
import { SECRET_NAME_PATTERN, SLUG_PATTERN } from "../core/index.js";

export const slugSchema = z.string().regex(SLUG_PATTERN);

export const secretNameSchema = z.string().regex(SECRET_NAME_PATTERN);

export const SECRET_VALUE_MAX_BYTES = 64 * 1024;

export const secretValueSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\0") && new TextEncoder().encode(value).byteLength <= SECRET_VALUE_MAX_BYTES,
    { message: "A secret must be nonempty, contain no NUL bytes, and fit within 64 KiB." },
  );

export const utcTimestamp = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

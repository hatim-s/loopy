import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Decodes canonical base64 and returns the bytes only when they match the claimed SHA-256. */
export function verifiedBytes(base64: string, sha256: string) {
  const bytes = Buffer.from(base64, "base64");

  return bytes.toString("base64") === base64 && sha256Hex(bytes) === sha256 ? bytes : null;
}

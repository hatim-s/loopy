import { sha256Hex } from "@loopy/core";
import { Schema } from "effect";
import { base64Decode, base64Length, base64Text, canonicalPadding } from "./codec";

const isBase64 = Schema.is(base64Text);

/** Decodes canonical base64 and returns the bytes only when they fit and match the SHA-256. */
export async function verifiedBase64(text: string, sha256: string, limit: number) {
  if (text.length > base64Length(limit) || !isBase64(text) || !canonicalPadding(text)) {
    return null;
  }

  const bytes = base64Decode(text);

  return bytes.byteLength <= limit && (await sha256Hex(bytes)) === sha256 ? bytes : null;
}

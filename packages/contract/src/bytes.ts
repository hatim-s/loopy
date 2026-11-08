import { sha256Hex } from "@loopy/core";
import { Schema } from "effect";
import { base64Text } from "./codec";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const isBase64 = Schema.is(base64Text);

// atob ignores the unused low bits of the last symbol, so only zero bits there are canonical.
function canonicalPadding(text: string) {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;

  if (padding === 0) {
    return true;
  }

  const last = ALPHABET.indexOf(text.charAt(text.length - padding - 1));

  return (last & (padding === 2 ? 0x0f : 0x03)) === 0;
}

/** Decodes canonical base64 and returns the bytes only when they fit and match the SHA-256. */
export async function verifiedBase64(text: string, sha256: string, limit: number) {
  if (text.length > Math.ceil(limit / 3) * 4 || !isBase64(text) || !canonicalPadding(text)) {
    return null;
  }

  const bytes = Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

  return bytes.byteLength <= limit && (await sha256Hex(bytes)) === sha256 ? bytes : null;
}

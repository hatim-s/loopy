import { jsonSchema } from "@loopy/core";
import { decodeJson } from "./codec";

export function parseModuleOutput(stdout: string) {
  const text = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  const boundary = text.lastIndexOf("\n");

  try {
    const output = decodeJson(jsonSchema)(text.slice(boundary + 1));

    return { ok: true as const, output, stdout: text.slice(0, boundary + 1) };
  } catch {
    return { ok: false as const, code: "invalid_result" as const };
  }
}

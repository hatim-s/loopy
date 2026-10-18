import { jsonSchema } from "./json.js";

export function parseModuleOutput(stdout: string) {
  const text = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  const boundary = text.lastIndexOf("\n");

  try {
    const output = jsonSchema.safeParse(JSON.parse(text.slice(boundary + 1)));

    if (output.success) {
      return { ok: true as const, output: output.data, stdout: text.slice(0, boundary + 1) };
    }
  } catch {
    return { ok: false as const, code: "invalid_result" as const };
  }

  return { ok: false as const, code: "invalid_result" as const };
}

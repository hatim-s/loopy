import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Infer } from "loopy";

export const inputSchema = {
  kind: "record",
  fields: { batch: "string", ordinal: "number", fail: "boolean", items: "number[]" },
} as const;

export type RunInput = Infer<typeof inputSchema>;

export interface Context {
  workspace: string;
  log(message: string, data?: Record<string, string | number | boolean>): void;
}

export function repo(context: Context) {
  return join(context.workspace, "loopies-playground");
}

export async function put(context: Context, path: string, content: string) {
  const target = join(repo(context), path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

export function read(context: Context, path: string) {
  return readFile(join(repo(context), path), "utf8");
}

export async function finish(
  input: Pick<RunInput, "batch" | "ordinal">,
  context: Context,
  slug: string,
  files: { path: string; content: string }[],
) {
  for (const file of files) {
    await put(context, file.path, file.content);
  }

  const result = { batch: input.batch, ordinal: input.ordinal, slug, files };
  const content = `${JSON.stringify(result, null, 2)}\n`;

  if (Buffer.byteLength(content) > 8192) {
    throw new Error("Repository report exceeds 8 KiB. Reduce fixture input size.");
  }

  await put(context, "results/result.json", content);
  context.log("repository-report-written", { slug, ordinal: input.ordinal, files: files.length });

  return { artifactPath: "loopies-playground/results/result.json", files: files.length };
}

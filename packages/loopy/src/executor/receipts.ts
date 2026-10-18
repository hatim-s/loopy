import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { executionKeySchema, executionResultSchema } from "../contract/index.js";
import { type ExecutionKey, errnoCode, executionKeyString } from "../core/index.js";
import { syncDirectory, writeFileAtomically } from "./fs.js";

const identity = { executionKey: executionKeySchema, attempt: z.number().int().positive() };

export const receiptSchema = z.discriminatedUnion("kind", [
  z.object({ ...identity, kind: z.literal("started"), pid: z.number().int().positive() }),
  z.object({ ...identity, kind: z.literal("finished"), result: executionResultSchema }),
]);

export async function receiptPath(home: string, key: ExecutionKey, attempt: number) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  let directory = await realpath(home);

  for (const segment of [
    "receipts",
    encodeURIComponent(key.runId).replaceAll(".", "%2E"),
    encodeURIComponent(executionKeyString(key)),
  ]) {
    directory = join(directory, segment);

    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (cause) {
      if (errnoCode(cause) !== "EEXIST") {
        throw cause;
      }
    }

    if (!(await lstat(directory)).isDirectory()) {
      throw new Error("Receipt directories must be real directories inside the daemon home.");
    }
  }

  return join(directory, `${attempt}.json`);
}

export async function lookupFile(path: string) {
  try {
    return receiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return { kind: "none" as const };
    }

    throw error;
  }
}

export async function startReceipt(path: string, executionKey: ExecutionKey, attempt: number) {
  const file = await open(path, "wx", 0o600);

  try {
    await file.writeFile(
      JSON.stringify({ kind: "started", executionKey, attempt, pid: process.pid }),
    );
    await file.sync();
  } finally {
    await file.close();
  }

  await syncDirectory(path);
}

export async function finishReceipt(path: string, value: z.infer<typeof receiptSchema>) {
  await writeFileAtomically(path, JSON.stringify(value), { mode: 0o600, syncDirectory: true });
}

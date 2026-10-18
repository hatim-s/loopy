import { lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { executionKeySchema, executionResultSchema } from "../contract/index.js";
import { type ExecutionKey, errnoCode, executionKeyString } from "../core/index.js";

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
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { kind: "none" as const };
    }

    throw error;
  }
}

async function syncDirectory(path: string) {
  const directory = await open(dirname(path), "r");

  try {
    await directory.sync();
  } finally {
    await directory.close();
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
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "wx", 0o600);

  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }

  await rename(temporary, path);
  await syncDirectory(path);
}

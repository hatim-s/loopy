import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { executionKeySchema, executionResultSchema } from "../contract/index.js";
import { type ExecutionKey, errnoCode, executionKeyString } from "../core/index.js";
import { syncDirectory, writeFileAtomically } from "./fs.js";
import { homePaths } from "./paths.js";

const identity = { executionKey: executionKeySchema, attempt: z.number().int().positive() };

export const receiptSchema = z.discriminatedUnion("kind", [
  z.object({ ...identity, kind: z.literal("started"), pid: z.number().int().positive() }),
  z.object({ ...identity, kind: z.literal("finished"), result: executionResultSchema }),
]);

function pathSegment(value: string) {
  // Encoding every dot prevents '.' and '..' from naming parent directories.
  return encodeURIComponent(value).replaceAll(".", "%2E");
}

export async function receiptPath(home: string, key: ExecutionKey, attempt: number) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const receipts = homePaths(await realpath(home)).receipts;
  const run = join(receipts, pathSegment(key.runId));
  const execution = join(run, pathSegment(executionKeyString(key)));

  for (const directory of [receipts, run, execution]) {
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

  return join(execution, `${attempt}.json`);
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

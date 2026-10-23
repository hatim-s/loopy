import { lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { executionKeySchema, sandboxExecutionResultSchema } from "../contract/index.js";
import { type ExecutionKey, errnoCode, executionKeyString } from "../core/index.js";

export const filesystemReceiptsDescriptorSchema = z.strictObject({
  kind: z.literal("filesystem"),
  home: z.string().min(1),
});

export type FilesystemReceiptsDescriptor = z.infer<typeof filesystemReceiptsDescriptorSchema>;

const identity = { executionKey: executionKeySchema, attempt: z.number().int().positive() };

export const receiptSchema = z.discriminatedUnion("kind", [
  z.object({ ...identity, kind: z.literal("started"), pid: z.number().int().positive() }),
  z.object({ ...identity, kind: z.literal("finished"), result: sandboxExecutionResultSchema }),
]);

export type LocalReceipt = z.infer<typeof receiptSchema>;

export type AttemptIdentity = Pick<LocalReceipt, "executionKey" | "attempt">;

export type FinishedLocalReceipt = Extract<LocalReceipt, { kind: "finished" }>;

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

async function syncDirectory(path: string) {
  const directory = await open(dirname(path), "r");

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Terminal writers are serialized by child liveness, not rename. Only the claiming
 * child finishes live work. A parent must confirm its death and reread first.
 */
export class FilesystemReceipts {
  constructor(private readonly home: string) {}

  get descriptor(): FilesystemReceiptsDescriptor {
    return { kind: "filesystem", home: this.home };
  }

  async read(identity: AttemptIdentity): Promise<LocalReceipt | null> {
    const path = await receiptPath(this.home, identity.executionKey, identity.attempt);
    let receipt: LocalReceipt;

    try {
      receipt = receiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (cause) {
      if (errnoCode(cause) === "ENOENT") {
        return null;
      }

      throw cause;
    }

    if (
      executionKeyString(receipt.executionKey) !== executionKeyString(identity.executionKey) ||
      receipt.attempt !== identity.attempt
    ) {
      throw new Error("Receipt identity does not match this execution attempt.");
    }

    return receipt;
  }

  async claim(identity: AttemptIdentity) {
    const path = await receiptPath(this.home, identity.executionKey, identity.attempt);
    let file;

    try {
      file = await open(path, "wx", 0o600);
    } catch (cause) {
      if (errnoCode(cause) !== "EEXIST") {
        throw cause;
      }

      const receipt = await this.read(identity);

      if (!receipt) {
        throw new Error("Claimed receipt disappeared. Inspect the daemon home before retrying.");
      }

      return { kind: "existing" as const, receipt };
    }

    try {
      await file.writeFile(JSON.stringify({ ...identity, kind: "started", pid: process.pid }));
      await file.sync();
    } finally {
      await file.close();
    }

    await syncDirectory(path);

    return { kind: "created" as const };
  }

  async finish(value: FinishedLocalReceipt): Promise<FinishedLocalReceipt> {
    const receipt = await this.read(value);

    if (receipt?.kind === "finished") {
      return receipt;
    }

    if (!receipt) {
      throw new Error("Execution has no claimed receipt. Claim it before performing work.");
    }

    if (receipt.pid !== process.pid) {
      try {
        process.kill(receipt.pid, 0);
      } catch (cause) {
        if (errnoCode(cause) !== "ESRCH") {
          throw cause;
        }

        // A child can publish between the first read and the confirmed death.
        const latest = await this.read(value);

        if (latest?.kind === "finished") {
          return latest;
        }

        return this.publish(value);
      }

      throw new Error("Execution worker is still alive. Reconcile its receipt before finishing.");
    }

    return this.publish(value);
  }

  private async publish(value: FinishedLocalReceipt): Promise<FinishedLocalReceipt> {
    const path = await receiptPath(this.home, value.executionKey, value.attempt);
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

    return value;
  }
}

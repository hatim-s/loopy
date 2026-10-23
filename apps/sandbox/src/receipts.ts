import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { sandboxExecutionResultSchema } from "../../../packages/loopy/src/contract/index.js";
import { dockerAttemptPlanSchema } from "../../../packages/loopy/src/contract/sandbox-journal.js";

export const storedReceiptSchema = z.discriminatedUnion("kind", [
  dockerAttemptPlanSchema.extend({ kind: z.literal("started") }),
  dockerAttemptPlanSchema.extend({
    kind: z.literal("finished"),
    result: sandboxExecutionResultSchema,
  }),
]);

export type StoredReceipt = z.infer<typeof storedReceiptSchema>;

export type StartedReceipt = Extract<StoredReceipt, { kind: "started" }>;

async function syncDirectory(path: string) {
  const directory = await open(path, "r");

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

const lockSchema = z.strictObject({ pid: z.number().int().positive(), nonce: z.string() });

async function readLock(path: string) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      const stat = await file.stat();

      if (!stat.isFile() || stat.size > 1024) {
        throw new Error("Sandbox process lock must be a bounded regular file.");
      }

      return lockSchema.parse(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return null;
    }

    throw cause;
  }
}

export async function lockStateRoot(root: string): Promise<() => Promise<void>> {
  const path = join(root, "service.lock");
  const guardPath = join(root, "service-start.lock");
  const value = { pid: process.pid, nonce: randomUUID() };

  // A separate exclusive guard prevents concurrent restarts from both reclaiming a dead PID.
  const guard = await open(guardPath, "wx", 0o600).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") {
      throw new Error(
        "Sandbox startup guard is held. Verify no startup process is running before removing service-start.lock.",
      );
    }

    throw cause;
  });

  try {
    const owner = await readLock(path);

    if (owner !== null) {
      let alive = true;

      try {
        process.kill(owner.pid, 0);
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) {
          throw cause;
        }

        alive = false;
      }

      if (alive) {
        throw new Error("Another sandbox service owns this state root.");
      }

      await unlink(path);
    }

    const file = await open(path, "wx", 0o600);

    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }

    await syncDirectory(root);
  } finally {
    await guard.close();
    await unlink(guardPath);
  }

  return async () => {
    const current = await readLock(path);

    if (current?.nonce !== value.nonce) {
      throw new Error(
        "Sandbox process lock changed owner. Leave it intact and inspect the state root.",
      );
    }

    await unlink(path);
    await syncDirectory(root);
  };
}

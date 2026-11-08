import { mock } from "bun:test";
import * as filesystem from "node:fs";
import { executionKeySchema } from "@loopy/contract";
import { Effect, Schema } from "effect";

const request = Schema.decodeUnknownSync(
  Schema.Struct({
    home: Schema.String,
    ready: Schema.String,
    release: Schema.String,
    identity: Schema.Struct({ executionKey: executionKeySchema, attempt: Schema.Number }),
  }),
)(await Bun.stdin.json());

const originalWrite = filesystem.writeFileSync;

// The claim is the only write in this process, so pause it until the test releases it.
mock.module("node:fs", () => ({
  ...filesystem,
  writeFileSync: (...args: Parameters<typeof originalWrite>) => {
    originalWrite(request.ready, "write paused");

    for (let index = 0; index < 1000; index++) {
      if (filesystem.existsSync(request.release)) {
        return originalWrite(...args);
      }

      Bun.sleepSync(10);
    }

    throw new Error("Receipt fixture was not released.");
  },
}));

const { FilesystemReceipts } = await import("../../../runtime/src/executor/receipts");

const result = await Effect.runPromise(
  new FilesystemReceipts(request.home).claim(request.identity),
);

console.log(JSON.stringify(result));

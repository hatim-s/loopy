import { mock } from "bun:test";
import * as filesystem from "node:fs/promises";
import { Effect, Schema } from "effect";
import { executionKeySchema } from "../../src/contract/index.js";

const request = Schema.decodeUnknownSync(
  Schema.Struct({
    home: Schema.String,
    ready: Schema.String,
    release: Schema.String,
    identity: Schema.Struct({ executionKey: executionKeySchema, attempt: Schema.Number }),
  }),
)(await Bun.stdin.json());

const originalOpen = filesystem.open;

mock.module("node:fs/promises", () => ({
  ...filesystem,
  open: async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args);
    const write = file.writeFile.bind(file);

    file.writeFile = async (...args) => {
      await Bun.write(request.ready, "write paused");

      for (let index = 0; index < 1000; index++) {
        if (await Bun.file(request.release).exists()) {
          return write(...args);
        }

        await Bun.sleep(10);
      }

      throw new Error("Receipt fixture was not released.");
    };

    return file;
  },
}));

const { FilesystemReceipts } = await import("../../src/executor/receipts.js");

const result = await Effect.runPromise(
  new FilesystemReceipts(request.home).claim(request.identity),
);

console.log(JSON.stringify(result));

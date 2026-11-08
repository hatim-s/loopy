import { executionKeySchema } from "@loopy/contract";
import { Effect, Schema } from "effect";
import { FilesystemReceipts, type LocalReceipt } from "../../src/executor/receipts";
import { waitForFile } from "./wait";

const request = Schema.decodeUnknownSync(
  Schema.Struct({
    home: Schema.String,
    ready: Schema.String,
    release: Schema.String,
    identity: Schema.Struct({ executionKey: executionKeySchema, attempt: Schema.Number }),
  }),
)(await Bun.stdin.json());

// Holds the claim before it publishes until the test releases it, so a competitor can go first.
class PausedReceipts extends FilesystemReceipts {
  protected override publishStarted(path: string, started: LocalReceipt) {
    return Effect.promise(async () => {
      await Bun.write(request.ready, "claim paused");
      await waitForFile(request.release);
    }).pipe(Effect.andThen(super.publishStarted(path, started)));
  }
}

const result = await Effect.runPromise(new PausedReceipts(request.home).claim(request.identity));

console.log(JSON.stringify(result));

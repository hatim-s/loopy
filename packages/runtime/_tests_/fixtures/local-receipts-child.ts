import { executionKeySchema } from "@loopy/contract";
import { Effect, Schema } from "effect";
import { FilesystemReceipts } from "../../src/executor/receipts";
import { waitForFile } from "./wait";

const request = Schema.decodeUnknownSync(
  Schema.Struct({
    home: Schema.String,
    identity: Schema.Struct({ executionKey: executionKeySchema, attempt: Schema.Number }),
    ready: Schema.String,
    finish: Schema.String,
  }),
  { onExcessProperty: "error" },
)(await Bun.stdin.json());

const receipts = new FilesystemReceipts(request.home);

await Effect.runPromise(receipts.claim(request.identity));

await Bun.write(request.ready, "claimed");

await waitForFile(request.finish);

await Effect.runPromise(
  receipts.finish({
    ...request.identity,
    kind: "finished",
    result: { kind: "succeeded", output: 42, logs: [] },
  }),
);

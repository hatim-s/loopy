import { Effect, Schema } from "effect";
import { FilesystemReceipts, receiptSchema } from "../../../runtime/src/executor/receipts";
import { waitForFile } from "./wait";

const request = Schema.decodeUnknownSync(
  Schema.Struct({
    home: Schema.String,
    identity: Schema.Struct({
      executionKey: receiptSchema.members[0].fields.executionKey,
      attempt: receiptSchema.members[0].fields.attempt,
    }),
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

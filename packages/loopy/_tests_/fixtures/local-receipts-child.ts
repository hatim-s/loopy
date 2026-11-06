import { Effect, Schema } from "effect";
import { FilesystemReceipts, receiptSchema } from "../../src/executor/receipts";

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

for (let index = 0; index < 300 && !(await Bun.file(request.finish).exists()); index++) {
  await Bun.sleep(10);
}

if (!(await Bun.file(request.finish).exists())) {
  throw new Error("Receipt publication gate was not released.");
}

await Effect.runPromise(
  receipts.finish({
    ...request.identity,
    kind: "finished",
    result: { kind: "succeeded", output: 42, logs: [] },
  }),
);

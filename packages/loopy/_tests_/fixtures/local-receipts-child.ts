import { z } from "zod";
import { FilesystemReceipts, receiptSchema } from "../../src/executor/receipts.js";

const request = z
  .strictObject({
    home: z.string(),
    identity: receiptSchema.options[0].pick({ executionKey: true, attempt: true }),
    ready: z.string(),
    finish: z.string(),
  })
  .parse(await Bun.stdin.json());

const receipts = new FilesystemReceipts(request.home);

await receipts.claim(request.identity);

await Bun.write(request.ready, "claimed");

for (let index = 0; index < 300 && !(await Bun.file(request.finish).exists()); index++) {
  await Bun.sleep(10);
}

if (!(await Bun.file(request.finish).exists())) {
  throw new Error("Receipt publication gate was not released.");
}

await receipts.finish({
  ...request.identity,
  kind: "finished",
  result: { kind: "succeeded", output: 42, logs: [] },
});

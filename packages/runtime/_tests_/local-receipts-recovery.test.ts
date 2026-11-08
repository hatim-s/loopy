import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Effect } from "effect";
import {
  type AttemptIdentity,
  FilesystemReceipts,
  type FinishedLocalReceipt,
} from "../src/executor/receipts";
import { receiptsFixture } from "./fixtures/local-receipts";
import { waitForFile } from "./fixtures/wait";

test("parent rereads completion published between its started read and confirmed child death", async () => {
  const f = await receiptsFixture();
  const ready = resolve(f.root, "ready");
  const finish = resolve(f.root, "finish");

  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "fixtures/local-receipts-child.ts"),
    ],
    {
      cwd: f.workspace,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: f.home, LOOPY_HOME: f.home },
      stdin: new Response(JSON.stringify({ home: f.home, identity: f.identity, ready, finish })),
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  class PublicationRaceReceipts extends FilesystemReceipts {
    private released = false;

    constructor(home: string) {
      super(home);
      const baseRead = this.read.bind(this);

      this.read = (identity: AttemptIdentity) =>
        Effect.gen({ self: this }, function* () {
          const receipt = yield* baseRead(identity);

          if (!this.released && receipt?.kind === "started") {
            this.released = true;
            yield* Effect.promise(() => Bun.write(finish, "publish"));
            expect(yield* Effect.promise(() => child.exited)).toBe(0);
          }

          return receipt;
        });
    }
  }

  try {
    await waitForFile(ready);
    const receipts = new PublicationRaceReceipts(f.home);

    expect(await Effect.runPromise(receipts.reconcile(f.identity))).toEqual({
      kind: "finished",
      source: "stored",
      receipt: {
        ...f.identity,
        kind: "finished",
        result: { kind: "succeeded", output: 42, logs: [] },
      },
    });
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});

test("a stored completion wins over an aborted caller", async () => {
  const f = await receiptsFixture();

  const result: FinishedLocalReceipt["result"] = {
    kind: "succeeded",
    output: "authoritative",
    logs: [],
  };

  await Effect.runPromise(f.receipts.claim(f.identity));
  await Effect.runPromise(f.receipts.finish({ ...f.identity, kind: "finished", result }));
  const controller = new AbortController();
  controller.abort();

  expect(await Effect.runPromise(f.executor.execute(f.key, 1, f.spec, controller.signal))).toEqual(
    result,
  );
});

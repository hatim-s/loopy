import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Effect } from "effect";
import { type AttemptIdentity, FilesystemReceipts } from "../src/executor/receipts";
import { receiptsFixture } from "./fixtures/local-receipts";
import { onCleanup } from "./fixtures/test-scope";
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

  onCleanup(async () => {
    child.kill("SIGKILL");
    await child.exited;
  });

  let childExit: number | undefined;

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
            childExit = yield* Effect.promise(() => child.exited);
          }

          return receipt;
        });
    }
  }

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
  expect(childExit).toBe(0);
});

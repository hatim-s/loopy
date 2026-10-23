import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { LocalExecutor } from "../src/executor/local.js";
import {
  type AttemptIdentity,
  FilesystemReceipts,
  type FinishedLocalReceipt,
} from "../src/executor/receipts.js";
import { receiptsFixture } from "./fixtures/local-receipts.js";

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
      stdin: new Response(JSON.stringify({ home: f.home, identity: f.identity, ready, finish })),
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  class PublicationRaceReceipts extends FilesystemReceipts {
    finishes = 0;
    private released = false;

    override async read(identity: AttemptIdentity) {
      const receipt = await super.read(identity);

      if (!this.released && receipt?.kind === "started") {
        this.released = true;
        await Bun.write(finish, "publish");
        expect(await child.exited).toBe(0);
      }

      return receipt;
    }

    override finish(value: FinishedLocalReceipt) {
      this.finishes++;

      return super.finish(value);
    }
  }

  try {
    for (let index = 0; index < 200 && !(await Bun.file(ready).exists()); index++) {
      await Bun.sleep(10);
    }

    expect(await Bun.file(ready).exists()).toBe(true);
    const receipts = new PublicationRaceReceipts(f.home);

    const executor = new LocalExecutor({
      home: f.home,
      workspace: f.workspace,
      mode: "sandbox",
      secrets: [],
      bundlePath: () => f.bundle,
      receipts,
    });

    expect(await executor.lookup(f.key, 1)).toEqual({
      ...f.identity,
      kind: "finished",
      result: { kind: "succeeded", output: 42, logs: [] },
    });
    expect(receipts.finishes).toBe(0);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});

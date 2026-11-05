import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Effect } from "effect";
import { LocalExecutor } from "../src/executor/local.js";
import {
  type AttemptIdentity,
  FilesystemReceipts,
  type FinishedLocalReceipt,
  type LocalReceipt,
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
      cwd: f.workspace,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: f.home, LOOPY_HOME: f.home },
      stdin: new Response(JSON.stringify({ home: f.home, identity: f.identity, ready, finish })),
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  class PublicationRaceReceipts extends FilesystemReceipts {
    finishes = 0;
    private released = false;

    constructor(home: string) {
      super(home);
      const baseRead = this.read.bind(this);
      const baseFinish = this.finish.bind(this);

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

      this.finish = (value: FinishedLocalReceipt) =>
        Effect.suspend(() => {
          this.finishes++;

          return baseFinish(value);
        });
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

    expect(await Effect.runPromise(executor.lookup(f.key, 1))).toEqual({
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

for (const transport of ["aborted", "worker_report"] as const) {
  for (const readTiming of ["lookup", "death_reread"] as const) {
    for (const outcome of ["succeeded", "uncertain"] as const) {
      test(`stored ${outcome} at ${readTiming} wins over ${transport}`, async () => {
        const f = await receiptsFixture();

        const result: FinishedLocalReceipt["result"] =
          outcome === "succeeded"
            ? { kind: "succeeded", output: "authoritative", logs: [] }
            : {
                kind: "failed",
                error: { code: "uncertain", message: "Previously reconciled." },
                exitCode: null,
                logs: [],
              };

        const finished: FinishedLocalReceipt = { ...f.identity, kind: "finished", result };
        const controller = new AbortController();

        if (transport === "aborted") {
          controller.abort();
        } else {
          // The real worker sees this live claim and emits its infrastructure error report.
          await Effect.runPromise(f.receipts.claim(f.identity));
        }

        const reads: (LocalReceipt | null)[] = [null, null];

        if (readTiming === "death_reread") {
          const child = Bun.spawn([process.execPath, "--no-env-file", "-e", "process.exit(0)"], {
            cwd: f.workspace,
            env: { PATH: process.env.PATH, HOME: f.home },
            stdout: "ignore",
            stderr: "ignore",
          });

          await child.exited;
          reads.push({ ...f.identity, kind: "started", pid: child.pid });
        }

        reads.push(finished);

        class OrderedReceipts extends FilesystemReceipts {
          reads = 0;
          override read = () =>
            Effect.sync(() => {
              const receipt = reads[this.reads++];

              if (receipt === undefined) {
                throw new Error("Unexpected extra receipt read.");
              }

              return receipt;
            });
        }

        const receipts = new OrderedReceipts(f.home);

        const executor = new LocalExecutor({
          home: f.home,
          workspace: f.workspace,
          mode: "sandbox",
          secrets: [],
          bundlePath: () => f.bundle,
          receipts,
        });

        expect(
          await Effect.runPromise(executor.execute(f.key, 1, f.spec, controller.signal)),
        ).toEqual(result);
        expect(receipts.reads).toBe(reads.length);

        if (transport === "worker_report") {
          expect(await Effect.runPromise(f.receipts.read(f.identity))).toMatchObject({
            kind: "started",
            pid: process.pid,
          });
        }
      });
    }
  }
}

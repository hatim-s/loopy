import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { graphSchema } from "@loopy/contract";
import { Effect, Schema } from "effect";
import { approveDemoGraph } from "../../core/_tests_/fixtures/graphs";
import { newRun } from "../../core/_tests_/fixtures/run";
import { LocalExecutor } from "../src/executor";
import { receiptPath } from "../src/executor/receipts";
import { activate } from "../src/host";
import { SecretStore } from "../src/os";
import { withBundles } from "./fixtures/compiled";
import { fixture } from "./fixtures/executor";
import { MemorySqlStore } from "./fixtures/stores";

// A bundle that kills itself after synchronous writes stops mid-record with its output already in
// the pipe, as a timeout or crash would, without racing a timer against bun startup.
const KILLED = 'process.kill(process.pid, "SIGKILL");';

for (const ending of ["success", "killed", "output_limit", "nonzero"] as const) {
  test(`bundle ${ending} masks secrets printed as plain text on stdout and stderr`, async () => {
    const f = await fixture();
    const secrets = { TOKEN: 'alpha"beta', WINDOWS: "C:\\new", MULTILINE: "line1\nline2" };
    const store = new SecretStore(f.home);

    for (const [name, value] of Object.entries(secrets)) {
      await Effect.runPromise(store.set(name, value));
    }

    const executor = new LocalExecutor({
      home: f.home,
      workspace: f.workspace,
      mode: "sandbox",
      secrets: Object.keys(secrets),
      bundlePath: () => f.bundle,
    });

    const tail = {
      success: "console.log(JSON.stringify({words: 1}));",
      killed: KILLED,
      output_limit: 'process.stdout.write("x".repeat(3 * 1024 * 1024));',
      nonzero: "process.exit(2);",
    }[ending];

    await writeFile(
      f.bundle,
      `const { writeSync } = require("node:fs"); const out = (text) => writeSync(1, text + "\\n"); const err = (text) => writeSync(2, text + "\\n"); const escaped = JSON.stringify(process.env.TOKEN).slice(1,-1); out(escaped); err(escaped); out('say "hi there"'); out('token="' + process.env.WINDOWS + '"'); err('token="' + process.env.WINDOWS + '"'); err(process.env.MULTILINE); ${tail}`,
    );
    const graph = withBundles(structuredClone(approveDemoGraph));
    const node = graph.nodes[0];

    if (node?.kind !== "code") {
      throw new Error("Expected code fixture.");
    }

    node.retry = { attempts: 1, retryOnExit: false };
    const runs = new MemorySqlStore();
    await Effect.runPromise(runs.createRun({ ...newRun(), input: { subject: "test" } }));

    const outcome = await Effect.runPromise(
      activate({
        store: runs,
        executor,
        graph: Schema.decodeUnknownSync(graphSchema)(graph),
        runId: "run",
      }),
    );

    const nodes = await Effect.runPromise(runs.getNodeRuns("run"));
    expect(nodes[0]?.status).toBe(ending === "success" ? "succeeded" : "failed");
    const logs = await Effect.runPromise(runs.getLogs("run"));
    const key = nodes[0]?.key;

    if (!key) {
      throw new Error("Missing stored execution key.");
    }

    const receipt = JSON.parse(
      await readFile(await Effect.runPromise(receiptPath(f.home, key, 1)), "utf8"),
    );

    const events = await Effect.runPromise(runs.events(0, 1000));

    for (const value of [nodes, logs, events, outcome, receipt]) {
      const serialized = JSON.stringify(value);

      for (const fragment of ["alpha", "C:", "line1", "line2"]) {
        expect(serialized).not.toContain(fragment);
      }
    }

    expect(logs).toContainEqual(
      expect.objectContaining({
        message: "stderr",
        data: '[redacted]\ntoken="[redacted]"\n[redacted]\n',
      }),
    );

    if (ending === "success") {
      expect(logs).toContainEqual(
        expect.objectContaining({
          message: "stdout",
          data: '[redacted]\nsay "hi there"\ntoken="[redacted]"\n',
        }),
      );
    }
  });
}

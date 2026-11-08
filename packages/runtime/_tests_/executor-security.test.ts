import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { LocalExecutor } from "../src/executor";
import { receiptPath } from "../src/executor/receipts";
import { fixture } from "./fixtures/executor";

for (const mode of ["sandbox", "full"] as const) {
  test(`${mode} bundle cannot read, replace, remove or create daemon receipts`, async () => {
    const f = await fixture();
    const receipt = await Effect.runPromise(receiptPath(f.home, f.key, 1));
    await writeFile(
      f.bundle,
      `import {readFile, writeFile, unlink, readdir} from "node:fs/promises";
const path = ${JSON.stringify(receipt)}; const results = [];
for (const action of [() => readdir(${JSON.stringify(f.home)}), () => readFile(path), () => writeFile(path,"forged"), () => unlink(path), () => writeFile(path + ".forged", "fake")]) {try {await action(); results.push(true);} catch {results.push(false);}}
process.stdout.write(JSON.stringify(results)+"\\n");`,
    );

    const executor = new LocalExecutor({
      home: f.home,
      workspace: f.workspace,
      mode,
      secrets: [],
      bundlePath: () => f.bundle,
    });

    const result = await Effect.runPromise(
      executor.execute(f.key, 1, f.spec, new AbortController().signal),
    );

    expect(result).toEqual({
      kind: "succeeded",
      output: [false, false, false, false, false],
      logs: [],
    });
    expect(await Effect.runPromise(executor.lookup(f.key, 1))).toEqual({
      kind: "finished",
      executionKey: f.key,
      attempt: 1,
      result,
    });
  });
}

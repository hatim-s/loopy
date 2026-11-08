import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executionKeyString } from "@loopy/core";
import { Effect } from "effect";
import { LocalExecutor } from "../src/executor";
import { receiptPath } from "../src/executor/receipts";
import { fixture } from "./fixtures/executor";

for (const mode of ["sandbox", "full"] as const) {
  test(`${mode} bundle cannot read, replace, remove or create daemon receipts and workspace forgeries are ignored`, async () => {
    const f = await fixture();
    const receipt = await Effect.runPromise(receiptPath(f.home, f.key, 1));
    const fake = join(f.workspace, "receipts", "fake.json");
    await writeFile(
      f.bundle,
      `import {readFile, writeFile, unlink, readdir} from "node:fs/promises";
const path = ${JSON.stringify(receipt)}; const results = [];
for (const action of [() => readdir(${JSON.stringify(f.home)}), () => readFile(path), () => writeFile(path,"forged"), () => unlink(path), () => writeFile(path + ".forged", "fake")]) {try {await action(); results.push(true);} catch {results.push(false);}}
await Bun.write(${JSON.stringify(fake)}, JSON.stringify({kind:"finished", executionKey:${JSON.stringify(f.key)}, attempt:1, result:{kind:"succeeded",output:"forged",logs:[]}}));
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
    expect(JSON.parse(await readFile(fake, "utf8"))).toMatchObject({
      result: { output: "forged" },
    });
    expect(await Effect.runPromise(executor.lookup(f.key, 1))).toEqual({
      kind: "finished",
      executionKey: f.key,
      attempt: 1,
      result,
    });
  });
}

test("a later author execution forging a workspace receipt cannot replace a finished daemon receipt", async () => {
  const f = await fixture();
  await writeFile(f.bundle, 'process.stdout.write("42\\n");');

  const result = await Effect.runPromise(
    f.executor.execute(f.key, 1, f.spec, new AbortController().signal),
  );

  const filename = `${createHash("sha256").update(executionKeyString(f.key)).digest("hex")}-1.json`;
  const forged = join(f.workspace, ".loopy", "scratch", "receipts", filename);

  const receipt = {
    kind: "finished",
    executionKey: f.key,
    attempt: 1,
    result: { kind: "succeeded", output: "forged", logs: [] },
  };

  await writeFile(
    f.bundle,
    `await Bun.write(${JSON.stringify(forged)},${JSON.stringify(JSON.stringify(receipt))}); process.stdout.write("null\\n");`,
  );
  expect(
    await Effect.runPromise(f.executor.execute(f.key, 2, f.spec, new AbortController().signal)),
  ).toMatchObject({
    kind: "succeeded",
  });
  expect(JSON.parse(await readFile(forged, "utf8"))).toEqual(receipt);
  expect(await Effect.runPromise(f.executor.lookup(f.key, 1))).toMatchObject({
    kind: "finished",
    result,
  });
});

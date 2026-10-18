import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executionKeyString } from "../src/core/index.js";
import { LocalExecutor } from "../src/executor/index.js";
import { receiptPath } from "../src/executor/receipts.js";
import { SecretStore } from "../src/local/index.js";
import { fixture } from "./fixtures/executor.js";

for (const secret of ['quote"and\nnewline', "42"]) {
  test(`decoded result and log strings redact ${JSON.stringify(secret)} without changing numeric values`, async () => {
    const f = await fixture();
    new SecretStore(f.home).set("TOKEN", secret);

    const executor = new LocalExecutor({
      home: f.home,
      workspace: f.workspace,
      mode: "sandbox",
      secrets: ["TOKEN"],
      bundlePath: () => f.bundle,
    });

    await writeFile(
      f.bundle,
      `const secret = process.env.TOKEN; process.stderr.write(JSON.stringify({message: secret, data: {nested: [secret, JSON.stringify(secret).slice(1,-1)]}})+"\\n"); process.stdout.write(JSON.stringify({secret, nested: [secret], number: 42})+"\\n");`,
    );
    const result = await executor.execute(f.key, 1, f.spec, new AbortController().signal);
    expect(result).toEqual({
      kind: "succeeded",
      output: { secret: "[redacted]", nested: ["[redacted]"], number: 42 },
      logs: [{ message: "[redacted]", data: { nested: ["[redacted]", "[redacted]"] } }],
    });
    const receipt = await readFile(await receiptPath(f.home, f.key, 1), "utf8");
    expect(JSON.parse(receipt).result).toEqual(result);
    expect(receipt).not.toContain(JSON.stringify(secret));
  });
}

for (const mode of ["sandbox", "full"] as const) {
  test(`${mode} bundle cannot read, replace, remove or create daemon receipts and workspace forgeries are ignored`, async () => {
    const f = await fixture();
    const receipt = await receiptPath(f.home, f.key, 1);
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

    const result = await executor.execute(f.key, 1, f.spec, new AbortController().signal);
    expect(result).toEqual({
      kind: "succeeded",
      output: [false, false, false, false, false],
      logs: [],
    });
    expect(JSON.parse(await readFile(fake, "utf8"))).toMatchObject({
      result: { output: "forged" },
    });
    expect(await executor.lookup(f.key, 1)).toEqual({
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
  const result = await f.executor.execute(f.key, 1, f.spec, new AbortController().signal);
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
  expect(await f.executor.execute(f.key, 2, f.spec, new AbortController().signal)).toMatchObject({
    kind: "succeeded",
  });
  expect(JSON.parse(await readFile(forged, "utf8"))).toEqual(receipt);
  expect(await f.executor.lookup(f.key, 1)).toMatchObject({ kind: "finished", result });
});

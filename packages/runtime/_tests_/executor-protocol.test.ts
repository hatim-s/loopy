import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleResult, runnerSource } from "../src/executor/protocol";
import { secretRedactor } from "../src/os/secret-redactor";
import { qualityTestRoot } from "./fixtures/quality-test-root";

const decode = (stdout: string) =>
  bundleResult({ stdout, stderr: "", exitCode: 0 }, (text) => text);

test("module stdout rejects a missing or malformed final JSON line", () => {
  const protocolError = {
    kind: "failed" as const,
    error: {
      code: "protocol" as const,
      message: "Bundle stdout must end with one JSON result line.",
    },
    exitCode: null,
    logs: [],
  };

  expect(decode("")).toEqual(protocolError);
  expect(decode('{"earlier":true}\nnoise\n')).toEqual({
    ...protocolError,
    logs: [{ message: "stdout", data: '{"earlier":true}\nnoise\n' }],
  });
  expect(decode('leading noise\n{"answer":42}\n')).toEqual({
    kind: "succeeded",
    output: { answer: 42 },
    logs: [{ message: "stdout", data: "leading noise\n" }],
  });
});

test("bundle results redact once, so a secret inside the marker leaves it intact", () => {
  const result = bundleResult(
    {
      stdout: `${JSON.stringify("a cat")}\n`,
      stderr: `${JSON.stringify({ message: "pet", data: "a cat" })}\n`,
      exitCode: 0,
    },
    secretRedactor(["a"]),
  );

  expect(result).toEqual({
    kind: "succeeded",
    output: "[redacted] c[redacted]t",
    logs: [{ message: "pet", data: "[redacted] c[redacted]t" }],
  });
});

for (const secret of ['quote"and\nnewline', "42"]) {
  test(`decoded result and log strings redact ${JSON.stringify(secret)} without changing numeric values`, () => {
    const escaped = JSON.stringify(secret).slice(1, -1);

    const result = bundleResult(
      {
        stdout: `${JSON.stringify({ secret, nested: [secret], number: 42 })}\n`,
        stderr: `${JSON.stringify({ message: secret, data: { nested: [secret, escaped] } })}\n`,
        exitCode: 0,
      },
      secretRedactor([secret]),
    );

    expect(result).toEqual({
      kind: "succeeded",
      output: { secret: "[redacted]", nested: ["[redacted]"], number: 42 },
      logs: [{ message: "[redacted]", data: { nested: ["[redacted]", "[redacted]"] } }],
    });
  });
}

test("escaped and doubly nested secrets are masked in complete records and at every capture boundary", () => {
  const secret = 'alpha"beta';
  const escaped = JSON.stringify(secret).slice(1, -1);
  const nested = JSON.stringify({ auth: JSON.stringify({ token: secret }) });

  for (const record of [
    JSON.stringify({ message: escaped, data: { nested: [escaped] } }),
    JSON.stringify({ message: "resp", data: nested }),
  ]) {
    for (let end = record.indexOf("alpha") + 5; end <= record.length; end++) {
      const result = bundleResult(
        { stdout: "", stderr: record.slice(0, end), exitCode: 1 },
        secretRedactor([secret]),
        { code: "output_limit", message: "Capture limit" },
      );

      expect(JSON.stringify(result)).not.toContain("alpha");
    }

    const complete = bundleResult(
      {
        stdout: `${JSON.stringify({ escaped })}\n`,
        stderr: `${record}\n`,
        exitCode: 0,
      },
      secretRedactor([secret]),
    );

    expect(JSON.stringify(complete)).not.toContain("alpha");
    expect(JSON.stringify(complete.logs)).toContain("[redacted]");
  }
});

test("complete log records keep keys and values that end in a secret prefix", () => {
  const record = { message: "status", data: { s: 1, su: 2, sup: 3, kept: "pass" } };

  for (const failure of [undefined, { code: "output_limit" as const, message: "Capture limit" }]) {
    const result = bundleResult(
      {
        stdout: JSON.stringify({ ok: true }),
        stderr: `${JSON.stringify(record)}\n`,
        exitCode: 0,
      },
      secretRedactor(["supersecret"]),
      failure,
    );

    expect(result.logs[0]).toEqual(record);
  }
});

test("the runner turns console output into logs and keeps author stdout apart from the result", async () => {
  const root = qualityTestRoot("runner");
  const module = join(root, "context.ts");
  const runner = join(root, "runner.ts");
  await writeFile(
    module,
    'console.log("module loaded"); export default (input,context)=>{context.log("ready",{value:input.value}); console.log("captured"); console.debug("debug"); console.trace("trace"); console.table("table"); console.dir("dir"); process.stdout.write("author noise\\npartial"); return {value:input.value,workspace:context.workspace};};',
  );
  await writeFile(runner, runnerSource(module, "default", "code"));

  const child = Bun.spawn([process.execPath, runner], {
    cwd: root,
    stdin: new Blob([JSON.stringify({ value: 42 })]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(code).toBe(0);
  expect(decode(stdout)).toEqual({
    kind: "succeeded",
    output: { value: 42, workspace: root },
    logs: [{ message: "stdout", data: "author noise\npartial\n" }],
  });

  const logs = stderr
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  expect(logs).toEqual(
    expect.arrayContaining([
      { message: "module loaded", data: null },
      { message: "ready", data: { value: 42 } },
      { message: "captured", data: null },
      ...["debug", "trace", "table", "dir"].map((message) => ({ message, data: null })),
    ]),
  );
});

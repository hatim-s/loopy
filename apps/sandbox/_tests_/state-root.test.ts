import { expect, test } from "bun:test";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Result, Schema } from "effect";
import { sandboxConfigSchema } from "../src/config";
import { stateLayout, validateStateRoot } from "../src/state-root";
import { attemptServices, dependencies, fixture } from "./fixtures/attempts";
import { succeedingBackend } from "./fixtures/authority";
import { openAttempts } from "./fixtures/run";

const { services, open } = attemptServices();

test("state roots reject symlinks and public binding; live root ownership is exclusive", async () => {
  const config = await fixture();
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(sandboxConfigSchema)({ ...config, hostname: "0.0.0.0" }),
    ),
  ).toBe(false);
  const other = await fixture();
  await rm(join(other.stateRoot, "receipts"), { recursive: true });
  await symlink(config.stateRoot, join(other.stateRoot, "receipts"));
  await expect(validateStateRoot(other)).rejects.toThrow("without symlinks");

  await open(config, succeedingBackend);
  await expect(openAttempts(config, dependencies(config, succeedingBackend))).rejects.toThrow(
    `Process ${process.pid} holds`,
  );
});

test("a lock file from an older sandbox version stops startup with its cleanup steps", async () => {
  const config = await fixture();
  const lock = stateLayout(config.stateRoot).lock;
  await writeFile(lock, JSON.stringify({ pid: 999_999, nonce: "old" }));

  await expect(openAttempts(config, dependencies(config, succeedingBackend))).rejects.toThrow(
    `Lock file '${lock}' was written by an older sandbox version.`,
  );
  expect(await readFile(lock, "utf8")).toBe(JSON.stringify({ pid: 999_999, nonce: "old" }));
});

test("concurrent restarts reclaim a dead process lock under one startup owner", async () => {
  const config = await fixture();

  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {acquirePidLock} from ${JSON.stringify(resolve(import.meta.dir, "../../../packages/runtime/src/os/pid-lock.ts"))}; acquirePidLock(${JSON.stringify(stateLayout(config.stateRoot).lock)});`,
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  expect(await child.exited).toBe(0);

  const results = await Promise.allSettled([
    openAttempts(config, dependencies(config, succeedingBackend)),
    openAttempts(config, dependencies(config, succeedingBackend)),
  ]);

  expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
  expect(results.filter((result) => result.status === "rejected").length).toBe(1);

  for (const result of results) {
    if (result.status === "fulfilled") {
      services.push(result.value);
    }
  }
});

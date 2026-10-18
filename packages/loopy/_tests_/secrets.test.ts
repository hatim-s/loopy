import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readDaemonFile } from "../src/local/index.js";
import { SecretStore } from "../src/local/secrets.js";
import { until } from "./fixture.js";

const directories: string[] = [];

const daemons: { stop(): Promise<void> }[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "loopy-secrets-"));
  directories.push(directory);

  return { directory, store: new SecretStore(join(directory, "home")) };
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("private CRUD preserves other secrets and lists names only", async () => {
  const { store } = setup();
  expect(store.list()).toEqual([]);
  await store.set("orbit-cookie", "private-cookie");
  await store.set("other", "other-value");
  await store.set("orbit-cookie", "rotated-cookie");
  expect(store.get("orbit-cookie")).toBe("rotated-cookie");
  expect(store.list()).toEqual(["orbit-cookie", "other"]);
  expect(statSync(store.directory).mode & 0o777).toBe(0o700);
  expect(statSync(store.file).mode & 0o777).toBe(0o600);
  await store.remove("orbit-cookie");
  expect(store.get("other")).toBe("other-value");
  expect(() => store.get("orbit-cookie")).toThrow("No stored secret");
});

test("repairs permissive permissions before reading", async () => {
  const { store } = setup();
  await store.set("one", "value");
  chmodSync(store.directory, 0o755);
  chmodSync(store.file, 0o644);
  expect(store.get("one")).toBe("value");
  expect(statSync(store.directory).mode & 0o777).toBe(0o700);
  expect(statSync(store.file).mode & 0o777).toBe(0o600);
});

test("refuses symlink directories, symlink files, and hard links", async () => {
  const { directory, store } = setup();
  const target = join(directory, "target");
  mkdirSync(target);
  symlinkSync(target, store.directory);
  await expect(store.set("one", "value")).rejects.toThrow("real directory");
  rmSync(store.directory);
  mkdirSync(store.directory);
  const original = join(directory, "original.json");
  writeFileSync(original, '{"one":"private-value"}');
  symlinkSync(original, store.file);
  expect(() => store.get("one")).toThrow("Cannot open");
  rmSync(store.file);
  linkSync(original, store.file);
  expect(() => store.get("one")).toThrow("hard links");
  expect(readFileSync(original, "utf8")).toContain("private-value");
});

test("a competing writer cannot overwrite the store", async () => {
  const { store } = setup();
  await store.set("one", "value");
  mkdirSync(join(store.directory, ".secrets.lock"));
  await expect(store.set("two", "value")).rejects.toThrow("Another secret update");
  expect(store.list()).toEqual(["one"]);
});

test("malformed stores and invalid values never echo secret contents", async () => {
  const { store } = setup();
  await store.set("one", "value");
  writeFileSync(store.file, '{"one":"sensitive-marker" BROKEN}');
  expect(() => store.snapshot()).toThrow("The secret store contains invalid JSON.");
  await expect(store.set("../bad", "value")).rejects.toThrow("Secret names");
  await expect(store.set("one", "\0sensitive-marker")).rejects.toThrow("no NUL");
});

test("CLI stdin entry and name-only listing do not disclose values", async () => {
  const { directory, store } = setup();
  daemons.push({
    stop: async () => {
      const record = readDaemonFile(store.directory);

      if (record) {
        process.kill(record.pid, "SIGTERM");
        await until(() => readDaemonFile(store.directory) === undefined);
      }
    },
  });
  const command = [process.execPath, resolve(import.meta.dir, "../src/cli/index.ts")];

  const child = Bun.spawn(
    [...command, "secrets", "set", "orbit-cookie", "--stdin", "--home", store.directory],
    { cwd: directory, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );

  child.stdin.write("sensitive-marker\n");
  child.stdin.end();
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).not.toContain("sensitive-marker");
  expect(await new Response(child.stderr).text()).not.toContain("sensitive-marker");
  expect(store.get("orbit-cookie")).toBe("sensitive-marker");

  const listed = Bun.spawn([...command, "secrets", "list", "--home", store.directory], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await listed.exited).toBe(0);
  expect(JSON.parse(await new Response(listed.stdout).text())).toEqual(["orbit-cookie"]);
});

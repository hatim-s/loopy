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
import { localDaemon, openRunStore } from "@loopy/runtime/local";
import { Effect, Exit, Scope } from "effect";
import { secretRedactor } from "../../runtime/src/os/secret-redactor";
import { SecretStore } from "../../runtime/src/os/secrets";

const scopes: Scope.Closeable[] = [];

function fixtureScope() {
  const scope = Scope.makeUnsafe();
  scopes.push(scope);

  return scope;
}

const directories: string[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "loopy-secrets-"));
  directories.push(directory);

  return { directory, store: new SecretStore(join(directory, "home")) };
}

afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("private CRUD preserves other secrets and lists names only", () => {
  const { store } = setup();
  expect(Effect.runSync(store.list())).toEqual([]);
  Effect.runSync(store.set("orbit-cookie", "private-cookie"));
  Effect.runSync(store.set("other", "other-value"));
  Effect.runSync(store.set("orbit-cookie", "rotated-cookie"));
  expect(Effect.runSync(store.values(["orbit-cookie"]))).toEqual({
    "orbit-cookie": "rotated-cookie",
  });
  expect(Effect.runSync(store.list())).toEqual(["orbit-cookie", "other"]);
  expect(statSync(store.directory).mode & 0o777).toBe(0o700);
  expect(statSync(store.file).mode & 0o777).toBe(0o600);
  Effect.runSync(store.remove("orbit-cookie"));
  expect(Effect.runSync(store.values(["other"]))).toEqual({ other: "other-value" });
  expect(Effect.runSync(Effect.flip(store.values(["orbit-cookie"])))).toMatchObject({
    _tag: "SecretError",
    cause: expect.objectContaining({ message: expect.stringContaining("No stored secret") }),
  });
});

test("repairs permissive permissions before reading", () => {
  const { store } = setup();
  Effect.runSync(store.set("one", "value"));
  chmodSync(store.directory, 0o755);
  chmodSync(store.file, 0o644);
  expect(Effect.runSync(store.values(["one"]))).toEqual({ one: "value" });
  expect(statSync(store.directory).mode & 0o777).toBe(0o700);
  expect(statSync(store.file).mode & 0o777).toBe(0o600);
});

test("refuses symlink directories, symlink files, and hard links", () => {
  const { directory, store } = setup();
  const target = join(directory, "target");
  mkdirSync(target);
  symlinkSync(target, store.directory);
  expect(Effect.runSync(Effect.flip(store.set("one", "value")))).toMatchObject({
    _tag: "SecretError",
    cause: expect.objectContaining({ message: expect.stringContaining("real directory") }),
  });
  rmSync(store.directory);
  mkdirSync(store.directory);
  const original = join(directory, "original.json");
  writeFileSync(original, '{"one":"private-value"}');
  symlinkSync(original, store.file);
  expect(Effect.runSync(Effect.flip(store.values(["one"])))).toMatchObject({
    _tag: "SecretError",
    cause: expect.objectContaining({ message: expect.stringContaining("Cannot open") }),
  });
  rmSync(store.file);
  linkSync(original, store.file);
  expect(Effect.runSync(Effect.flip(store.values(["one"])))).toMatchObject({
    _tag: "SecretError",
    cause: expect.objectContaining({ message: expect.stringContaining("hard links") }),
  });
  expect(readFileSync(original, "utf8")).toContain("private-value");
});

test("a competing writer cannot overwrite the store", () => {
  const { store } = setup();
  Effect.runSync(store.set("one", "value"));
  mkdirSync(join(store.directory, ".secrets.lock"));
  expect(Effect.runSync(Effect.flip(store.set("two", "value")))).toMatchObject({
    _tag: "SecretError",
    cause: expect.objectContaining({ message: expect.stringContaining("Another secret update") }),
  });
  expect(Effect.runSync(store.list())).toEqual(["one"]);
});

test("malformed stores and invalid values never echo secret contents", () => {
  const { store } = setup();
  Effect.runSync(store.set("one", "value"));
  writeFileSync(store.file, '{"one":"sensitive-marker" BROKEN}');
  expect(Effect.runSync(Effect.flip(store.snapshot()))).toMatchObject({
    _tag: "SecretError",
    cause: expect.objectContaining({
      message: expect.stringContaining("The secret store contains invalid JSON."),
    }),
  });
  expect(Effect.runSync(Effect.flip(store.set("../bad", "value")))).toMatchObject({
    _tag: "SecretError",
    cause: expect.objectContaining({ message: expect.stringContaining("Secret names") }),
  });
  expect(Effect.runSync(Effect.flip(store.set("one", "\0sensitive-marker")))).toMatchObject({
    _tag: "SecretError",
    cause: expect.objectContaining({ message: expect.stringContaining("no NUL") }),
  });
});

test("CLI stdin entry and name-only listing do not disclose values", async () => {
  const { directory, store } = setup();
  mkdirSync(join(directory, ".loopy", "loopies"), { recursive: true });
  const scope = fixtureScope();

  const runStore = await Effect.runPromise(
    openRunStore(store.directory).pipe(Effect.provideService(Scope.Scope, scope)),
  );

  const daemon = await Effect.runPromise(
    localDaemon({
      home: store.directory,
      cwd: directory,
      store: runStore,
      concurrency: 4,
      port: 0,
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );

  await Effect.runPromise(daemon.start);

  const command = [
    process.execPath,
    "--no-env-file",
    resolve(import.meta.dir, "../../cli/src/index.ts"),
  ];

  const env = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    HOME: directory,
    LOOPY_HOME: store.directory,
  };

  const child = Bun.spawn(
    [...command, "secrets", "set", "orbit-cookie", "--stdin", "--home", store.directory],
    { cwd: directory, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );

  child.stdin.write("sensitive-marker\n");
  child.stdin.end();
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).not.toContain("sensitive-marker");
  expect(await new Response(child.stderr).text()).not.toContain("sensitive-marker");
  expect(Effect.runSync(store.values(["orbit-cookie"]))).toEqual({
    "orbit-cookie": "sensitive-marker",
  });

  const listed = Bun.spawn([...command, "secrets", "list", "--home", store.directory], {
    cwd: directory,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await listed.exited).toBe(0);
  expect(JSON.parse(await new Response(listed.stdout).text())).toEqual(["orbit-cookie"]);
});

test("redaction handles overlapping values, regex punctuation and truncated secrets", () => {
  expect(secretRedactor(["abc", "abcdef", "a.b?"])("abcdef abc a.b?")).toBe(
    "[redacted] [redacted] [redacted]",
  );
  expect(secretRedactor(["abcdef"])("prefix abc", true)).toBe("prefix [redacted]");
});

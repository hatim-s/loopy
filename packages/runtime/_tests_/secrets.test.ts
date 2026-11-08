import { expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { secretRedactor } from "../src/os/secret-redactor";
import { SecretStore } from "../src/os/secrets";
import { qualityTestRoot } from "./fixtures/quality-test-root";

function setup() {
  const directory = qualityTestRoot("secrets");

  return { directory, store: new SecretStore(join(directory, "home")) };
}

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

test("redaction handles overlapping values, regex punctuation and truncated secrets", () => {
  expect(secretRedactor(["abc", "abcdef", "a.b?"])("abcdef abc a.b?")).toBe(
    "[redacted] [redacted] [redacted]",
  );
  expect(secretRedactor(["abcdef"])("prefix abc", true)).toBe("prefix [redacted]");
});

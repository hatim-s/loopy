import { expect, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { Registry } from "../src/local/registry";
import { makeArtifactRegistry, saveCompiled } from "../src/local/save-compiled";
import { compiledBody } from "./fixtures/compiled";
import { qualityTestRoot } from "./fixtures/quality-test-root";

function fixture() {
  const root = qualityTestRoot("save-compiled");
  const registry = Effect.runSync(Registry.make(join(root, "home"), root));

  return { root, registry };
}

test("save validates before publication and pins a private historical graph", async () => {
  const { root, registry } = fixture();
  const body = await compiledBody("saved", join(root, "saved.ts"));
  const saved = await Effect.runPromise(saveCompiled(registry, body));
  expect(saved.revision).toBe(body.revision);
  expect(statSync(registry.graphPath(body.revision)).mode & 0o777).toBe(0o600);
  const historical = readFileSync(registry.graphPath(body.revision), "utf8");
  const invalid = { ...body, revision: "a".repeat(64) };
  const exit = await Effect.runPromiseExit(saveCompiled(registry, invalid));
  expect(exit).toMatchObject({
    _tag: "Failure",
    cause: { reasons: [{ _tag: "Fail", error: { _tag: "ArtifactValidationError" } }] },
  });
  expect(Effect.runSync(registry.get("saved"))?.revision).toBe(body.revision);
  expect(readFileSync(registry.graphPath(body.revision), "utf8")).toBe(historical);
  expect(await Effect.runPromise(makeArtifactRegistry(registry).get("absent"))).toBeNull();
});

test("publication failure leaves the previous registry identity intact", async () => {
  const { root, registry } = fixture();
  const source = join(root, "saved.ts");
  const first = await compiledBody("saved", source);
  await Effect.runPromise(saveCompiled(registry, first));
  const before = readFileSync(join(registry.projectDirectory, "saved.json"), "utf8");
  const changed = await compiledBody("saved", source, { description: "changed" });
  rmSync(join(registry.home, "graphs"), { recursive: true });
  writeFileSync(join(registry.home, "graphs"), "not a directory");
  expect(await Effect.runPromiseExit(saveCompiled(registry, changed))).toMatchObject({
    _tag: "Failure",
    cause: {
      reasons: [
        { _tag: "Fail", error: { _tag: "RegistryError", operation: "create graph directory" } },
      ],
    },
  });
  expect(readFileSync(join(registry.projectDirectory, "saved.json"), "utf8")).toBe(before);
});

test("persisted entries retain slug validation", async () => {
  const { root, registry } = fixture();
  const body = await compiledBody("saved", join(root, "saved.ts"));
  const entry = await Effect.runPromise(saveCompiled(registry, body));
  writeFileSync(
    join(registry.projectDirectory, "saved.json"),
    JSON.stringify({ ...entry, slug: "../escaped" }),
  );
  expect(await Effect.runPromiseExit(registry.list())).toMatchObject({
    _tag: "Failure",
    cause: {
      reasons: [{ _tag: "Fail", error: { _tag: "RegistryError", operation: "list definitions" } }],
    },
  });
});

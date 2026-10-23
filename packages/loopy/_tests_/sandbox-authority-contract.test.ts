import { afterEach, expect, test } from "bun:test";
import { readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FilesystemAuthority } from "../../../apps/sandbox/src/filesystem-authority.js";
import { resultReference } from "../../../apps/sandbox/src/immutable-results.js";
import { AuthorityError } from "../src/contract/sandbox-journal.js";
import { authorityCommandSchema } from "../src/contract/sandbox-journal-rpc.js";
import { authorityFixture, successful, uncertain } from "./fixtures/sandbox-authority.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const value = await authorityFixture();
  roots.push(value.root);

  return value;
}

test("filesystem authority deduplicates, rejects stale/changed requests and seals a hash-verified terminal result", async () => {
  const { authority, resultsFor, plan, config } = await fixture();
  const session = await authority.openSession({ expectedEpoch: 0, nonce: "first" });
  const input = { session, plan: plan() };
  const responses = await Promise.all(Array.from({ length: 8 }, () => authority.admit(input)));
  expect(responses.filter((reply) => reply.kind === "created")).toHaveLength(1);
  expect(responses.filter((reply) => reply.kind === "existing")).toHaveLength(7);
  expect(
    await authority.admit({ ...input, plan: { ...input.plan, requestHash: "a".repeat(64) } }),
  ).toEqual({ kind: "rejected", code: "request_conflict" });
  expect(await authority.admit({ ...input, session: { ...session, nonce: "foreign" } })).toEqual({
    kind: "rejected",
    code: "stale_session",
  });
  expect(
    await authority.admit({ session, plan: { ...plan(2), container: input.plan.container } }),
  ).toEqual({ kind: "rejected", code: "invalid_state" });
  const result = await resultsFor(input.plan.workspace).put(successful);
  expect(await resultsFor(input.plan.workspace).get(result)).toEqual(successful);
  await expect(resultsFor("other-workspace").get(result)).rejects.toThrow("missing");
  const complete = { session, id: input.plan.id, requestHash: input.plan.requestHash, result };
  expect((await authority.complete(complete)).kind).toBe("finished");
  expect((await authority.complete(complete)).kind).toBe("finished");
  const changed = await resultsFor(input.plan.workspace).put(uncertain);
  expect(await authority.complete({ ...complete, result: changed })).toEqual({
    kind: "rejected",
    code: "request_conflict",
  });

  const before = await readFile(
    join(config.stateRoot, "receipts", `${input.plan.id}.json`),
    "utf8",
  );

  await authority.close();
  await expect(authority.admit(input)).rejects.toEqual(new AuthorityError("stale_session"));
  const second = new FilesystemAuthority(config.stateRoot);
  const next = await second.openSession({ expectedEpoch: 0, nonce: "second" });
  expect(next.epoch).toBe(session.epoch);
  expect(next.nonce).not.toBe(session.nonce);
  expect((await second.read(input.plan.id))?.session).toEqual(session);
  expect(await readFile(join(config.stateRoot, "receipts", `${input.plan.id}.json`), "utf8")).toBe(
    before,
  );
});

test("export guards persist, block only their volume and release older guards under the current caller session", async () => {
  const { authority, resultsFor, plan, config } = await fixture();
  const session = await authority.openSession({ expectedEpoch: 0, nonce: "first" });
  const first = plan();
  await authority.admit({ session, plan: first });
  await authority.complete({
    session,
    id: first.id,
    requestHash: first.requestHash,
    result: await resultsFor(first.workspace).put(successful),
  });
  const guard = await authority.beginExport({ session, attemptId: first.id, token: "guard-one" });
  expect(guard.kind).toBe("granted");
  expect(guard.kind === "granted" && guard.record.helper).toBe(`loopy-artifact-${first.id}`);
  expect(await authority.admit({ session, plan: plan(2) })).toEqual({
    kind: "rejected",
    code: "workspace_busy",
  });
  expect((await authority.admit({ session, plan: plan(1, "other") })).kind).toBe("created");
  expect((await authority.admit({ session, plan: first })).kind).toBe("existing");
  await authority.close();
  const second = new FilesystemAuthority(config.stateRoot);
  const next = await second.openSession({ expectedEpoch: 0, nonce: "second" });
  expect((await second.recoverable({ after: null, limit: 200 })).exports).toHaveLength(1);
  await expect(second.endExport({ session, token: "guard-one" })).rejects.toEqual(
    new AuthorityError("stale_session"),
  );
  await second.endExport({ session: next, token: "foreign-token" });
  expect((await second.recoverable({ after: null, limit: 200 })).exports).toHaveLength(1);
  await second.endExport({ session: next, token: "guard-one" });
  await second.endExport({ session: next, token: "guard-one" });
  expect(
    await second.beginExport({ session: next, attemptId: first.id, token: "guard-one" }),
  ).toEqual({ kind: "rejected", code: "invalid_state" });
  expect(
    (await second.beginExport({ session: next, attemptId: first.id, token: "guard-two" })).kind,
  ).toBe("granted");
  await second.endExport({ session: next, token: "guard-one" });
  expect((await second.recoverable({ after: null, limit: 200 })).exports).toHaveLength(1);
  await second.endExport({ session: next, token: "guard-two" });
  expect((await second.admit({ session: next, plan: plan(2) })).kind).toBe("created");
});

test("legacy receipts decode without rewriting, missing/corrupt results never become absence, and recovery pages cover every entry", async () => {
  const { authority, config, plan, resultsFor } = await fixture();
  const session = await authority.openSession({ expectedEpoch: 0, nonce: "session" });
  const legacy = { ...plan(), kind: "finished", result: successful };
  const path = join(config.stateRoot, "receipts", `${legacy.id}.json`);
  const content = JSON.stringify(legacy);
  await writeFile(path, content);
  const decoded = await authority.read(legacy.id);
  expect(decoded?.kind === "finished" && decoded.result).toEqual({
    kind: "inline",
    value: successful,
  });
  expect(await readFile(path, "utf8")).toBe(content);
  expect(
    (
      await authority.complete({
        session,
        id: legacy.id,
        requestHash: legacy.requestHash,
        result: resultReference(successful),
      })
    ).kind,
  ).toBe("finished");

  for (let index = 2; index <= 5; index++) {
    await authority.admit({ session, plan: plan(index) });
  }

  await authority.beginExport({ session, attemptId: legacy.id, token: "guard" });
  let after: string | null = null;
  const seen: string[] = [];

  do {
    const page = await authority.recoverable({ after, limit: 1 });
    expect(page.attempts.length + page.exports.length).toBeLessThanOrEqual(1);
    seen.push(
      ...page.attempts.map((record) => record.plan.id),
      ...page.exports.map((record) => record.token),
    );
    after = page.next;
  } while (after !== null);

  // The guard was denied while attempts sharing the volume were running.
  expect(seen).toHaveLength(4);
  expect(new Set(seen).size).toBe(4);
  const missingRef = resultReference(successful);
  await expect(
    authority.complete({
      session,
      id: plan(2).id,
      requestHash: plan(2).requestHash,
      result: missingRef,
    }),
  ).rejects.toThrow("missing");
  expect((await authority.read(plan(2).id))?.kind).toBe("started");
  await resultsFor("fixture").put(successful);

  const resultFile = (await readdir(join(config.stateRoot, "results"))).find((name) =>
    name.endsWith(`${missingRef.sha256}.json`),
  );

  expect(resultFile).toBeDefined();
  await writeFile(join(config.stateRoot, "results", resultFile ?? "unexpected"), "{}");
  await expect(resultsFor("fixture").get(missingRef)).rejects.toThrow("immutable");
  await writeFile(path, "{malformed");
  await expect(authority.read(legacy.id)).rejects.toThrow();
});

test("wire operations reject missing admitting sessions and unscoped results", () => {
  expect(
    authorityCommandSchema.safeParse({ operation: "resultPut", input: { value: successful } })
      .success,
  ).toBe(false);
  expect(
    authorityCommandSchema.safeParse({
      operation: "resultGet",
      input: { ref: resultReference(successful) },
    }).success,
  ).toBe(false);
  expect(
    authorityCommandSchema.safeParse({ operation: "admit", input: { plan: {} } }).success,
  ).toBe(false);
});

test("export-only recovery filters exact volume metadata without reading receipts", async () => {
  const { authority, resultsFor, config, plan } = await fixture();
  const session = await authority.openSession({ expectedEpoch: 0, nonce: "export-pages" });
  const expected = [];

  for (const token of ["z", "A", "a"]) {
    const target = plan(1, `export-${token}`);
    await authority.admit({ session, plan: target });
    await authority.complete({
      session,
      id: target.id,
      requestHash: target.requestHash,
      result: await resultsFor(target.workspace).put(successful),
    });
    const reply = await authority.beginExport({ session, attemptId: target.id, token });

    if (reply.kind !== "granted") {
      throw new Error("Expected export authority");
    }

    expected.push(reply.record);
  }

  // Export discovery reads metadata. Cleanup still must resolve and validate the attempt.
  for (const guard of expected) {
    await unlink(join(config.stateRoot, "receipts", `${guard.attemptId}.json`));
  }

  for (const target of expected) {
    expect(await authority.exportGuards({ after: null, limit: 1, volume: target.volume })).toEqual({
      exports: [target],
      next: null,
    });
    expect(
      await authority.exportGuards({ after: target.token, limit: 1, volume: target.volume }),
    ).toEqual({
      exports: [],
      next: null,
    });
  }

  await expect(authority.recoverable({ after: null, limit: 200 })).rejects.toThrow(
    "does not match its admitted workspace",
  );
});

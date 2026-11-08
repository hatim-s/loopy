import { expect, test } from "bun:test";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionResult } from "@loopy/contract";
import {
  AuthorityError,
  type AuthorityOutput,
  authorityCommandSchema,
  resultBytes,
  resultRef,
  SANDBOX_MAX_CAPTURE_BYTES,
} from "@loopy/contract/sandbox";
import { Result, Schema } from "effect";
import { FilesystemAuthority } from "../src/filesystem/authority";
import { stateLayout } from "../src/state-root";
import { authorityFixture, successful, uncertain } from "./fixtures/authority";
import { authorityContract } from "./fixtures/authority-contract";
import { run } from "./fixtures/run";

authorityContract("filesystem", async () => {
  const { authority, config, plan, resultsFor } = await authorityFixture();
  let current = authority;

  return {
    get authority() {
      return current;
    },
    resultsFor,
    plan: (runId, attempt) => plan(attempt, runId),
    async restart() {
      await run(current.close());
      current = new FilesystemAuthority(config.stateRoot);
    },
  };
});

function resultReference(result: ExecutionResult) {
  const bytes = resultBytes(result);

  if (bytes === null) {
    throw new Error("Fixture result exceeds the capture limit.");
  }

  return resultRef(bytes);
}

test("filesystem authority deduplicates, rejects stale/changed requests and seals a hash-verified terminal result", async () => {
  const { authority, resultsFor, plan, config } = await authorityFixture();
  const session = await run(authority.openSession({ expectedEpoch: 0, nonce: "first" }));
  const input = { session, plan: await plan() };
  const responses = await Promise.all(Array.from({ length: 8 }, () => run(authority.admit(input))));
  expect(responses.filter((reply) => reply.kind === "created")).toHaveLength(1);
  expect(responses.filter((reply) => reply.kind === "existing")).toHaveLength(7);
  expect(
    await run(authority.admit({ ...input, plan: { ...input.plan, requestHash: "a".repeat(64) } })),
  ).toEqual({ kind: "rejected", code: "request_conflict" });
  expect(
    await run(authority.admit({ ...input, session: { ...session, nonce: "foreign" } })),
  ).toEqual({
    kind: "rejected",
    code: "stale_session",
  });
  expect(
    await run(
      authority.admit({ session, plan: { ...(await plan(2)), container: input.plan.container } }),
    ),
  ).toEqual({ kind: "rejected", code: "invalid_state" });
  const result = await run(resultsFor(input.plan.workspace).put(successful));
  expect(await run(resultsFor(input.plan.workspace).get(result))).toEqual(successful);
  await expect(run(resultsFor("other-workspace").get(result))).rejects.toThrow("missing");
  const complete = { session, id: input.plan.id, requestHash: input.plan.requestHash, result };
  expect((await run(authority.complete(complete))).kind).toBe("finished");
  expect((await run(authority.complete(complete))).kind).toBe("finished");
  const changed = await run(resultsFor(input.plan.workspace).put(uncertain));
  expect(await run(authority.complete({ ...complete, result: changed }))).toEqual({
    kind: "rejected",
    code: "request_conflict",
  });

  const before = await readFile(
    join(stateLayout(config.stateRoot).receipts, `${input.plan.id}.json`),
    "utf8",
  );

  await run(authority.close());
  await expect(run(authority.admit(input))).rejects.toEqual(new AuthorityError("stale_session"));
  const second = new FilesystemAuthority(config.stateRoot);
  const next = await run(second.openSession({ expectedEpoch: 0, nonce: "second" }));
  expect(next.epoch).toBe(session.epoch);
  expect(next.nonce).not.toBe(session.nonce);
  expect((await run(second.read({ id: input.plan.id })))?.session).toEqual(session);
  expect(
    await readFile(join(stateLayout(config.stateRoot).receipts, `${input.plan.id}.json`), "utf8"),
  ).toBe(before);
});

test("legacy receipts decode without rewriting, missing/corrupt results never become absence, and recovery pages cover every entry", async () => {
  const { authority, config, plan, resultsFor } = await authorityFixture();
  const session = await run(authority.openSession({ expectedEpoch: 0, nonce: "session" }));
  const legacy = { ...(await plan()), kind: "finished", result: successful };
  const path = join(stateLayout(config.stateRoot).receipts, `${legacy.id}.json`);
  const content = JSON.stringify(legacy);
  await writeFile(path, content);
  const decoded = await run(authority.read({ id: legacy.id }));
  expect(decoded?.kind === "finished" && decoded.result).toEqual({
    kind: "inline",
    value: successful,
  });
  expect(await readFile(path, "utf8")).toBe(content);
  expect(
    (
      await run(
        authority.complete({
          session,
          id: legacy.id,
          requestHash: legacy.requestHash,
          result: await resultReference(successful),
        }),
      )
    ).kind,
  ).toBe("finished");

  for (let index = 2; index <= 5; index++) {
    await run(authority.admit({ session, plan: await plan(index) }));
  }

  await run(authority.beginExport({ session, attemptId: legacy.id, token: "guard" }));
  let after: string | null = null;
  const seen: string[] = [];

  do {
    const page: AuthorityOutput<"recoverable"> = await run(
      authority.recoverable({ after, limit: 1 }),
    );

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
  const missingRef = await resultReference(successful);
  await expect(
    run(
      authority.complete({
        session,
        id: (await plan(2)).id,
        requestHash: (await plan(2)).requestHash,
        result: missingRef,
      }),
    ),
  ).rejects.toThrow("missing");
  expect((await run(authority.read({ id: (await plan(2)).id })))?.kind).toBe("started");
  await run(resultsFor("fixture").put(successful));

  const resultFile = (await readdir(stateLayout(config.stateRoot).results)).find((name) =>
    name.endsWith(`${missingRef.sha256}.json`),
  );

  expect(resultFile).toBeDefined();
  await writeFile(join(stateLayout(config.stateRoot).results, resultFile ?? "unexpected"), "{}");
  await expect(run(resultsFor("fixture").get(missingRef))).rejects.toThrow("immutable");
  await writeFile(path, "{malformed");
  await expect(run(authority.read({ id: legacy.id }))).rejects.toThrow();
});

test("filesystem results reject an oversized canonical result as invalid_state, like the DO", async () => {
  const { resultsFor } = await authorityFixture();

  await expect(
    run(
      resultsFor("fixture").put({
        kind: "succeeded",
        output: "x".repeat(SANDBOX_MAX_CAPTURE_BYTES),
        logs: [],
      }),
    ),
  ).rejects.toEqual(new AuthorityError("invalid_state"));
});

test("wire operations reject missing admitting sessions and unscoped results", async () => {
  for (const command of [
    { operation: "resultPut", input: { value: successful } },
    { operation: "resultGet", input: { ref: await resultReference(successful) } },
    { operation: "admit", input: { plan: {} } },
  ]) {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(authorityCommandSchema, { onExcessProperty: "error" })(command),
      ),
    ).toBe(true);
  }
});

test("export-only recovery filters exact volume metadata without reading receipts", async () => {
  const { authority, resultsFor, config, plan } = await authorityFixture();
  const session = await run(authority.openSession({ expectedEpoch: 0, nonce: "export-pages" }));
  const expected = [];

  for (const token of ["z", "A", "a"]) {
    const target = await plan(1, `export-${token}`);
    await run(authority.admit({ session, plan: target }));
    await run(
      authority.complete({
        session,
        id: target.id,
        requestHash: target.requestHash,
        result: await run(resultsFor(target.workspace).put(successful)),
      }),
    );
    const reply = await run(authority.beginExport({ session, attemptId: target.id, token }));

    if (reply.kind !== "granted") {
      throw new Error("Expected export authority");
    }

    expected.push(reply.record);
  }

  // Export discovery reads metadata. Cleanup still must resolve and validate the attempt.
  for (const guard of expected) {
    await unlink(join(stateLayout(config.stateRoot).receipts, `${guard.attemptId}.json`));
  }

  for (const target of expected) {
    expect(
      await run(authority.exportGuards({ after: null, limit: 1, volume: target.volume })),
    ).toEqual({
      exports: [target],
      next: null,
    });
    expect(
      await run(authority.exportGuards({ after: target.token, limit: 1, volume: target.volume })),
    ).toEqual({
      exports: [],
      next: null,
    });
  }

  await expect(run(authority.recoverable({ after: null, limit: 200 }))).rejects.toThrow(
    "does not match its admitted workspace",
  );
});

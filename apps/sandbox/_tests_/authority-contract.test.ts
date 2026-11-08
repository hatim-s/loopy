import { expect, test } from "bun:test";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionResult } from "@loopy/contract";
import { AuthorityError, resultBytes, resultRef } from "@loopy/contract/sandbox";
import { FilesystemAuthority } from "../src/filesystem/authority";
import { stateLayout } from "../src/state-root";
import { authorityFixture, successful } from "./fixtures/authority";
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

test("filesystem authority keeps the admitting session and receipt bytes across a restart", async () => {
  const { authority, resultsFor, plan, config } = await authorityFixture();
  const session = await run(authority.openSession({ expectedEpoch: 0, nonce: "first" }));
  const input = { session, plan: await plan() };
  await run(authority.admit(input));
  await run(
    authority.complete({
      session,
      id: input.plan.id,
      requestHash: input.plan.requestHash,
      result: await run(resultsFor(input.plan.workspace).put(successful)),
    }),
  );

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

test("legacy receipts decode without rewriting and missing or corrupt results never become absence", async () => {
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

  await run(authority.admit({ session, plan: await plan(2) }));
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

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeBoundary, type ExecutionResult, nodeIdSchema } from "@loopy/contract";
import {
  attemptRecordSchema,
  type DockerAttemptPlan,
  type SandboxAttemptRequest,
  sandboxArtifactSchema,
  sandboxAttemptQuerySchema,
  sandboxErrorSchema,
  searchParams,
} from "@loopy/contract/sandbox";
import { Effect } from "effect";
import type { AttemptBackend } from "../src/docker";
import { failure } from "../src/operations";
import { attemptHandler } from "../src/server";
import { stateLayout } from "../src/state-root";
import { attemptServices, dependencies, fixture, request, succeeded } from "./fixtures/attempts";
import { FIXTURE_TOKEN, succeedingBackend } from "./fixtures/authority";
import { openSandbox, run } from "./fixtures/run";

const { services, open } = attemptServices();

const token = FIXTURE_TOKEN;

function post(body: SandboxAttemptRequest, authorization = `Bearer ${token}`) {
  return new Request("http://127.0.0.1/attempts", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function lookup(value: SandboxAttemptRequest) {
  const url = new URL("http://127.0.0.1/attempts");
  url.search = searchParams(sandboxAttemptQuerySchema, value).toString();

  return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}

test("authenticated admission fsyncs once, joins duplicate starts, rejects changed content and replays completion", async () => {
  const config = await fixture();
  const completed = Promise.withResolvers<ExecutionResult>();
  let starts = 0;
  let stored: DockerAttemptPlan | undefined;

  const backend: AttemptBackend = {
    start: (plan) =>
      Effect.gen(function* () {
        starts += 1;
        stored = plan;

        const durable = decodeBoundary(attemptRecordSchema)(
          JSON.parse(
            yield* Effect.promise(() =>
              readFile(join(stateLayout(config.stateRoot).receipts, `${plan.id}.json`), "utf8"),
            ),
          ),
        );

        expect(durable.plan).toEqual(plan);
        expect(durable.session.epoch).toBe(1);
        expect(durable.session.nonce.length).toBeGreaterThan(0);

        return yield* Effect.promise(() => completed.promise);
      }),
    recover: () =>
      Effect.gen(function* () {
        return yield* Effect.fail(failure("fixture", new Error("Unexpected recovery.")));
      }),
  };

  const attempts = await open(config, backend);
  const handler = attemptHandler(attempts, token);
  expect(await (await handler(new Request("http://localhost/health"))).json()).toEqual({
    status: "ok",
  });
  const input = request();
  expect((await handler(post(input, "Bearer wrong"))).status).toBe(401);
  expect(await (await handler(lookup(input))).json()).toEqual({ kind: "none" });
  const responses = await Promise.all(Array.from({ length: 12 }, () => handler(post(input))));
  expect(responses.every((response) => response.status === 202)).toBe(true);
  expect(await Promise.all(responses.map((response) => response.json()))).toEqual(
    Array.from({ length: 12 }, () => ({ kind: "started" })),
  );
  const changed = { ...input, spec: { ...input.spec, input: { different: true } } };
  expect((await handler(post(changed))).status).toBe(409);
  completed.resolve(succeeded);
  await run(attempts.drain());
  expect(starts).toBe(1);
  expect(stored?.workspace).toBe(input.workspace);
  expect(await (await handler(lookup(input))).json()).toEqual({
    kind: "finished",
    result: succeeded,
  });
  expect(await (await handler(post(input))).json()).toEqual({
    kind: "finished",
    result: succeeded,
  });
});

test("invalid bundles and malformed identities fail before backend effects", async () => {
  const config = await fixture();
  let effects = 0;

  const backend: AttemptBackend = {
    start: () =>
      Effect.gen(function* () {
        effects += 1;

        return succeeded;
      }),
    recover: () =>
      Effect.gen(function* () {
        effects += 1;

        return succeeded;
      }),
  };

  const handler = attemptHandler(await open(config, backend), token);
  const value = request();

  const rejected = async (response: Response) => ({
    status: response.status,
    message: decodeBoundary(sandboxErrorSchema)(await response.json()).error.message,
  });

  expect(await rejected(await handler(post({ ...value, bundles: [] })))).toEqual({
    status: 400,
    message: "A required execution bundle is missing.",
  });
  expect(
    await rejected(
      await handler(
        post({ ...value, bundles: [{ hash: value.bundles[0]?.hash ?? "", bytes: "eA==" }] }),
      ),
    ),
  ).toEqual({
    status: 400,
    message: "Supply each required bundle once with matching SHA-256 bytes.",
  });
  expect((await handler(post({ ...value, attempt: 0 }))).status).toBe(400);

  for (const route of ["attempts", "artifacts"]) {
    const response = await handler(
      new Request(`http://localhost/${route}?key=invalid&attempt=1&workspace=w&path=out.txt`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    expect((await rejected(response)).message).toBe(
      route === "attempts"
        ? "Supply workspace, JSON execution key and positive attempt."
        : "Supply an attempt identity and a relative artifact file path.",
    );
  }

  expect(effects).toBe(0);
});

test("workspace and attempt identities isolate receipts while run volumes persist between nodes", async () => {
  const config = await fixture();
  const receipts: DockerAttemptPlan[] = [];

  const service = await open(config, {
    start: (plan) =>
      Effect.gen(function* () {
        receipts.push(plan);

        return succeeded;
      }),
    recover: () =>
      Effect.gen(function* () {
        return succeeded;
      }),
  });

  const value = request();
  value.executionKey.scope = [
    { nodeId: decodeBoundary(nodeIdSchema)("2:each"), index: 3 },
    { nodeId: decodeBoundary(nodeIdSchema)("3:each"), index: 7 },
  ];
  await run(service.start(value));
  await run(service.start({ ...value, attempt: 2 }));
  await run(service.start({ ...value, workspace: "workspace-two" }));
  await run(
    service.start({
      ...value,
      executionKey: { ...value.executionKey, nodeId: decodeBoundary(nodeIdSchema)("1:code") },
    }),
  );
  await run(
    service.start({
      ...value,
      executionKey: { ...value.executionKey, scope: [...value.executionKey.scope].reverse() },
    }),
  );
  await run(service.drain());
  expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(5);
  expect(receipts[0]?.volume).toBe(receipts[1]?.volume);
  expect(receipts[0]?.volume).toBe(receipts[3]?.volume);
  expect(receipts[0]?.volume).not.toBe(receipts[2]?.volume);
  expect(receipts[0]?.volume).toBe(receipts[4]?.volume);

  for (const receipt of receipts) {
    expect(await run(service.lookup(receipt))).toEqual({ kind: "finished", result: succeeded });
  }
});

test("restart reconciles the saved container and never starts another attempt", async () => {
  const config = await fixture();
  let saved: DockerAttemptPlan | undefined;
  let startedRecord = "";

  const first = await open(config, {
    start: (plan) =>
      Effect.gen(function* () {
        saved = plan;
        startedRecord = yield* Effect.promise(() =>
          readFile(join(stateLayout(config.stateRoot).receipts, `${plan.id}.json`), "utf8"),
        );

        return succeeded;
      }),
    recover: () =>
      Effect.gen(function* () {
        return succeeded;
      }),
  });

  const value = request();
  await run(first.start(value));
  await run(first.drain());
  await run(first.close());
  services.splice(services.indexOf(first), 1);

  if (!saved) {
    throw new Error("Expected a started receipt.");
  }

  // Restore the durable point that a killed service leaves before committing completion.
  await writeFile(join(stateLayout(config.stateRoot).receipts, `${saved.id}.json`), startedRecord);
  const original = saved;
  const recovered: DockerAttemptPlan[] = [];

  const second = await open(config, {
    start: () =>
      Effect.gen(function* () {
        return yield* Effect.fail(
          failure("fixture", new Error("Recovery must not dispatch again.")),
        );
      }),
    recover: (plan) =>
      Effect.gen(function* () {
        recovered.push(plan);

        return succeeded;
      }),
  });

  await run(second.drain());
  expect(recovered).toEqual([original]);
  expect(await run(second.lookup(value))).toEqual({ kind: "finished", result: succeeded });
  expect(await run(second.start(value))).toEqual({ kind: "finished", result: succeeded });
});

function artifactLookup(input: SandboxAttemptRequest, path: string) {
  const url = new URL("http://127.0.0.1/artifacts");
  url.search = searchParams(sandboxAttemptQuerySchema, input).toString();
  // The path stays raw so tests can send paths the wire schema rejects.
  url.searchParams.set("path", path);

  return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}

test("artifact export requires its finished receipt and fences same-run admissions", async () => {
  const config = await fixture();
  const completion = Promise.withResolvers<ExecutionResult>();
  const secondCompletion = Promise.withResolvers<ExecutionResult>();
  const read = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const exportedVolumes: string[] = [];
  let starts = 0;

  const service = await open(
    config,
    {
      start: () =>
        Effect.gen(function* () {
          starts += 1;

          return yield* Effect.promise(() =>
            starts === 1 ? completion.promise : secondCompletion.promise,
          );
        }),
      recover: () =>
        Effect.gen(function* () {
          return succeeded;
        }),
    },
    {
      cleanup: () => Effect.void,
      read: (plan, path) =>
        Effect.gen(function* () {
          exportedVolumes.push(plan.volume);
          read.resolve();
          yield* Effect.promise(() => release.promise);

          return {
            path,
            bytes: "aGk=",
            sha256: createHash("sha256").update("hi").digest("hex"),
            size: 2,
          };
        }),
    },
  );

  const handler = attemptHandler(service, token);
  const input = request();
  expect((await handler(new Request(artifactLookup(input, "out.txt").url))).status).toBe(401);
  expect((await handler(artifactLookup(input, "out.txt"))).status).toBe(404);
  await run(service.start(input));
  expect((await handler(artifactLookup(input, "out.txt"))).status).toBe(409);
  completion.resolve(succeeded);
  await run(service.drain());

  for (const path of ["/etc/passwd", "../x", "a/../../x", "a//x", "a/./x", "C:\\x", "a\\x", ""]) {
    expect((await handler(artifactLookup(input, path))).status).toBe(400);
  }

  expect((await handler(artifactLookup({ ...input, workspace: "other" }, "out.txt"))).status).toBe(
    404,
  );
  const exporting = handler(artifactLookup(input, "out.txt"));
  await read.promise;
  expect((await handler(post({ ...input, attempt: 2 }))).status).toBe(409);
  expect(starts).toBe(1);
  release.resolve();
  const exported = await exporting;
  expect(exported.status).toBe(200);
  expect(decodeBoundary(sandboxArtifactSchema)(await exported.json())).toMatchObject({
    path: "out.txt",
    size: 2,
    bytes: "aGk=",
  });
  expect(exportedVolumes).toEqual([expect.stringMatching(/^loopy-workspace-[a-f0-9]{64}$/)]);
  await run(service.start({ ...input, attempt: 2 }));
  expect((await handler(artifactLookup(input, "out.txt"))).status).toBe(409);
  expect(exportedVolumes).toEqual([expect.stringMatching(/^loopy-workspace-[a-f0-9]{64}$/)]);
  secondCompletion.resolve(succeeded);
  await run(service.drain());
});

test("loopback server serves health and an authenticated asynchronous attempt", async () => {
  const config = await fixture();
  const service = await openSandbox(config, dependencies(config, succeedingBackend));

  try {
    const health = await fetch(new URL("/health", service.server.url));
    expect(await health.json()).toEqual({ status: "ok" });
    const input = request();

    const response = await fetch(new URL("/attempts", service.server.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    });

    expect(response.status).toBe(202);
    await run(service.attempts.drain());
    expect(await run(service.attempts.lookup(input))).toEqual({
      kind: "finished",
      result: succeeded,
    });
  } finally {
    await run(service.close());
  }
});

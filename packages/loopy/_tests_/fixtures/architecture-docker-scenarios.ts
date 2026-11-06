import assert from "node:assert/strict";
import {
  decodeBoundary,
  type SandboxAttemptRequest,
  sandboxArtifactSchema,
  sandboxReceiptSchema,
} from "@loopy/contract";
import { Effect } from "effect";
import { type Bridge, type DockerResources, input } from "./architecture-docker-resources";
import { bounded, type DockerRuntime, eventually } from "./architecture-docker-runtime";

export function client(service: Bridge, owned: DockerResources) {
  const headers = { authorization: `Bearer ${owned.config.token}` };

  function url(request: SandboxAttemptRequest, route: string) {
    const value = new URL(route, service.server.url);
    value.searchParams.set("workspace", request.workspace);
    value.searchParams.set("key", JSON.stringify(request.executionKey));
    value.searchParams.set("attempt", String(request.attempt));

    return value;
  }

  return {
    async post(request: SandboxAttemptRequest, expected = 202) {
      const response = await fetch(new URL("/attempts", service.server.url), {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15_000),
      });

      assert.equal(response.status, expected, await response.clone().text());

      return expected === 202 ? decodeBoundary(sandboxReceiptSchema)(await response.json()) : null;
    },
    async lookup(request: SandboxAttemptRequest) {
      const response = await fetch(url(request, "/attempts"), {
        headers,
        signal: AbortSignal.timeout(6000),
      });

      assert.equal(response.status, 200);

      return decodeBoundary(sandboxReceiptSchema)(await response.json());
    },
    async artifact(request: SandboxAttemptRequest, path: string, authenticated = true) {
      const target = url(request, "/artifacts");
      target.searchParams.set("path", path);

      return fetch(target, {
        headers: authenticated ? headers : {},
        signal: AbortSignal.timeout(15_000),
      });
    },
  };
}

async function finished(service: Bridge, owned: DockerResources, request: SandboxAttemptRequest) {
  await bounded(Effect.runPromise(service.attempts.drain()), "Worker completion", 20_000);
  const receipt = await client(service, owned).lookup(request);
  assert.equal(receipt.kind, "finished");
  const saved = await owned.plan(request);
  assert.equal(saved.kind, "finished");

  if (saved.kind === "finished") {
    assert.equal(saved.result.kind, "blob", "DO completion must point to R2 bytes.");
  }

  return receipt;
}

export async function durableAndGuard(
  runtime: DockerRuntime,
  owned: DockerResources,
  setBridge: (bridge: Bridge) => void,
) {
  let service = await owned.open();
  setBridge(service);

  const first = input(
    "shared",
    "await Bun.write('count.txt','A\\n'); process.stdout.write(JSON.stringify({proof:'A'}));",
  );

  const second = input(
    "shared",
    "const fs=await import('node:fs/promises'); await fs.appendFile('count.txt','B\\n'); process.stdout.write(JSON.stringify({proof:'B'}));",
    2,
  );

  let http = client(service, owned);
  await Promise.all([http.post(first), http.post(first)]);
  const terminal = await finished(service, owned, first);
  assert.deepEqual(terminal, {
    kind: "finished",
    result: { kind: "succeeded", output: { proof: "A" }, logs: [] },
  });
  const saved = await owned.plan(first);
  const state = await owned.inspect(saved.plan.container);
  assert(state);
  assert.equal(owned.starts.get(saved.plan.id), 1);
  await http.post(first);
  assert.equal(owned.starts.get(saved.plan.id), 1);
  await http.post(input("shared", "process.stdout.write('changed')"), 409);
  assert.equal((await http.artifact(first, "count.txt", false)).status, 401);
  assert.equal((await http.artifact(first, "../count.txt")).status, 400);
  assert.equal((await http.artifact({ ...first, workspace: "other" }, "count.txt")).status, 404);

  owned.blockCleanup();
  assert.equal((await http.artifact(first, "count.txt")).status, 409);
  const helper = `loopy-artifact-${saved.plan.id}`;
  assert(
    await owned.inspect(helper),
    "An actual helper must remain after injected cleanup failure.",
  );
  const guards = await Effect.runPromise(runtime.direct.recoverable({ after: null, limit: 200 }));
  assert.equal(guards.exports.length, 1);
  assert.equal(guards.exports[0]?.helper, helper);
  await http.post(second, 409);
  assert.equal(owned.starts.get(owned.id(second)) ?? 0, 0);

  await owned.stop(service);
  await runtime.reopen();
  service = await owned.open();
  setBridge(service);
  http = client(service, owned);
  assert.deepEqual(await http.lookup(first), terminal);
  assert.deepEqual(
    await owned.plan(first),
    saved,
    "The plan/session/R2 pointer must survive full reconstruction.",
  );
  await http.post(first);
  assert.equal(owned.starts.get(saved.plan.id), 1);
  assert.equal((await owned.inspect(saved.plan.container))?.Id, state.Id);
  assert.equal((await owned.inspect(saved.plan.container))?.State.StartedAt, state.State.StartedAt);
  await http.post(second, 409);
  assert.equal(
    (await Effect.runPromise(runtime.direct.recoverable({ after: null, limit: 200 }))).exports
      .length,
    1,
  );
  assert(await owned.inspect(helper));
  owned.healCleanup();
  runtime.loseAdmission(3);
  await Promise.all([http.post(second), http.post(second)]);
  const secondTerminal = await finished(service, owned, second);
  assert.deepEqual(secondTerminal, {
    kind: "finished",
    result: { kind: "succeeded", output: { proof: "B" }, logs: [] },
  });
  assert.equal(owned.starts.get(owned.id(second)), 1);
  assert.equal(runtime.faults.admissionRepliesDropped, 1);
  assert.equal(runtime.faults.readsBlocked, 3);
  assert.equal(await owned.inspect(helper), null);
  assert.equal(
    (await Effect.runPromise(runtime.direct.recoverable({ after: null, limit: 200 }))).exports
      .length,
    0,
  );
  const exported = await http.artifact(second, "count.txt");
  assert.equal(exported.status, 200);
  const artifact = decodeBoundary(sandboxArtifactSchema)(await exported.json());
  assert.equal(Buffer.from(artifact.bytes, "base64").toString(), "A\nB\n");
  runtime.record({
    proof: "duplicate-lost-ack-reconstruction-export",
    terminal,
    secondTerminal,
    saved,
    artifact,
    container: state,
    oldGuard: guards.exports[0],
  });
  runtime.heal();

  return service;
}

export async function killedAndDeadline(
  runtime: DockerRuntime,
  owned: DockerResources,
  service: Bridge,
) {
  const http = client(service, owned);
  const killed = input("killed", "setTimeout(()=>{},60000)");
  await http.post(killed);
  const saved = await owned.plan(killed);
  await eventually(
    async () => (await owned.inspect(saved.plan.container))?.State.Running === true,
    "Actual worker running",
    6000,
  );
  const before = await owned.inspect(saved.plan.container);
  assert(before);
  await owned.docker(["kill", saved.plan.container]);
  const terminal = await finished(service, owned, killed);
  assert(terminal.kind === "finished" && terminal.result.kind === "failed");
  assert.equal(terminal.result.error.code, "uncertain");
  await http.post(killed);
  assert.deepEqual(await http.lookup(killed), terminal);
  assert.equal(owned.starts.get(saved.plan.id), 1);
  assert.equal((await owned.inspect(saved.plan.container))?.Id, before.Id);
  assert.equal(
    (await owned.inspect(saved.plan.container))?.State.StartedAt,
    before.State.StartedAt,
  );
  const timeout = input("deadline", "setTimeout(()=>{},60000)");
  await http.post(timeout);
  const timeoutSaved = await owned.plan(timeout);
  await eventually(
    async () => (await owned.inspect(timeoutSaved.plan.container))?.State.Running === true,
    "Deadline worker running",
    6000,
  );
  const timedOut = await finished(service, owned, timeout);
  assert(timedOut.kind === "finished" && timedOut.result.kind === "failed");
  assert.equal(timedOut.result.error.code, "execution");
  assert.equal(timedOut.result.error.message, "Attempt timed out. Its owned container was killed.");
  assert.equal((await owned.inspect(timeoutSaved.plan.container))?.State.Running, false);
  await http.post(timeout);
  assert.equal(owned.starts.get(timeoutSaved.plan.id), 1);
  runtime.record({
    proof: "actual-docker-kill-and-deadline",
    before,
    terminal,
    timeoutSaved,
    timedOut,
  });
}

export async function shutdownOutage(
  runtime: DockerRuntime,
  owned: DockerResources,
  service: Bridge,
) {
  runtime.loseAdmission("all");

  const request = input(
    "shutdown-no-start",
    "process.stdout.write(JSON.stringify({unexpected:true}))",
  );

  const pending = client(service, owned)
    .post(request)
    .then(
      (value) => ({ kind: "reply", value }),
      (cause: unknown) => ({ kind: "rejected", error: String(cause) }),
    );

  await eventually(
    async () => (await Effect.runPromise(runtime.direct.read(owned.id(request)))) !== null,
    "Shutdown admission committed",
  );
  await eventually(
    async () => runtime.faults.readsBlocked > 3,
    "Shutdown handler resolving read failed",
  );
  const saved = await owned.plan(request);
  const startedAt = performance.now();
  await owned.stop(service);
  const closeMs = performance.now() - startedAt;
  assert.equal(await Bun.file(joinLock(owned)).exists(), false);
  const settled = await bounded(pending, "Outstanding admission HTTP handler", 1000);
  assert.equal(owned.starts.get(saved.plan.id) ?? 0, 0);
  assert.equal(await owned.inspect(saved.plan.container), null);
  runtime.heal();
  const successor = await owned.open();

  try {
    const terminal = await finished(successor, owned, request);
    assert(terminal.kind === "finished" && terminal.result.kind === "failed");
    assert.equal(terminal.result.error.code, "uncertain");
    assert.equal(owned.starts.get(saved.plan.id) ?? 0, 0);
    runtime.record({
      proof: "shutdown-read-outage-no-restart",
      closeMs,
      settled,
      terminal,
      saved,
    });
  } finally {
    await owned.stop(successor);
  }
}

function joinLock(owned: DockerResources) {
  return `${owned.config.stateRoot}/service.lock`;
}

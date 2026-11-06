import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { AttemptDependencies } from "../../../apps/sandbox/src/attempt/dependencies";
import { FilesystemAuthority } from "../../../apps/sandbox/src/filesystem/authority";
import { failure } from "../../../apps/sandbox/src/operations";
import type { AuthorityInput } from "../src/contract/sandbox-journal-rpc";
import {
  artifactReader,
  authorityFixture,
  successful,
  uncertain,
} from "./fixtures/sandbox-authority";
import { openSandbox, run } from "./fixtures/sandbox-run";

function within<T>(operation: Promise<T>, message: string) {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(message)), 750);

  return Promise.race([operation, deadline.promise]).finally(() => clearTimeout(timer));
}

async function post(
  service: Awaited<ReturnType<typeof openSandbox>>,
  fixture: Awaited<ReturnType<typeof authorityFixture>>,
) {
  try {
    const response = await fetch(new URL("/attempts", service.server.url), {
      method: "POST",
      headers: { authorization: `Bearer ${fixture.config.token}` },
      body: JSON.stringify(fixture.request),
    });

    await response.arrayBuffer();
  } catch {
    // Forced HTTP shutdown may close the socket before the handler's conflict reply is delivered.
  }
}

class UnavailableAfterAdmit extends FilesystemAuthority {
  readonly reconciling = Promise.withResolvers<void>();
  unavailable = false;
  override admit(input: AuthorityInput<"admit">) {
    const baseadmit = super.admit.bind(this);

    return Effect.gen({ self: this }, function* () {
      yield* baseadmit(input);
      this.unavailable = true;

      return yield* Effect.fail(failure("fixture", new Error("Committed admission reply lost")));
    });
  }
  override read(id: string) {
    const baseread = super.read.bind(this);

    return Effect.gen({ self: this }, function* () {
      if (this.unavailable) {
        this.reconciling.resolve();

        return yield* Effect.fail(failure("fixture", new Error("Authority remains unavailable")));
      }

      return yield* baseread(id);
    });
  }
}

test("server close aborts an outage-bound admission handler and successor only recovers", async () => {
  const fixture = await authorityFixture();
  const authority = new UnavailableAfterAdmit(fixture.config.stateRoot);
  let starts = 0;
  let recoveries = 0;
  let dependencyCloses = 0;

  const backend = {
    start: () =>
      Effect.gen(function* () {
        starts++;

        return successful;
      }),
    recover: () =>
      Effect.gen(function* () {
        recoveries++;

        return uncertain;
      }),
  };

  const service = await openSandbox(fixture.config, () =>
    Effect.promise(async () => ({
      authority,
      resultsFor: fixture.resultsFor,
      artifactReader,
      backend,
      close: () =>
        Effect.gen(function* () {
          dependencyCloses++;
          yield* authority.close();
        }),
    })),
  );

  const pending = post(service, fixture);
  let closing: Promise<void> | undefined;

  try {
    await within(authority.reconciling.promise, "POST handler did not reach reconciliation");
    expect(await Bun.file(join(fixture.config.stateRoot, "service.lock")).exists()).toBe(true);
    closing = run(service.close());
    await within(closing, "Server shutdown waited for unavailable admission reconciliation");
    await within(pending, "HTTP request remained pending after server close");
    expect(authority.unavailable).toBe(true);
    expect(starts).toBe(0);
    expect(dependencyCloses).toBe(1);
    expect(await Bun.file(join(fixture.config.stateRoot, "service.lock")).exists()).toBe(false);

    const successor = await openSandbox(fixture.config, () =>
      Effect.promise(async () => ({
        authority: new FilesystemAuthority(fixture.config.stateRoot),
        resultsFor: fixture.resultsFor,
        artifactReader,
        backend,
      })),
    );

    try {
      await run(successor.attempts.drain());
      expect(await run(successor.attempts.lookup(fixture.request))).toEqual({
        kind: "finished",
        result: uncertain,
      });
      expect(starts).toBe(0);
      expect(recoveries).toBe(1);
    } finally {
      await run(successor.close());
    }
  } finally {
    // Drain even when the original ordering is temporarily restored as a negative control.
    await run(service.attempts.close());
    await closing;
    await run(service.close());
    await pending;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function assertDrainOrdering(kind: "effect" | "artifact") {
  const fixture = await authorityFixture();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const dependenciesClosing = Promise.withResolvers<void>();
  const releaseDependency = Promise.withResolvers<void>();
  let drained = false;
  let dependencyCloses = 0;

  const dependencies: AttemptDependencies = {
    authority: fixture.authority,
    resultsFor: fixture.resultsFor,
    backend: {
      start: () =>
        Effect.gen(function* () {
          if (kind === "effect") {
            entered.resolve();
            yield* Effect.promise(() => finish.promise);
            drained = true;
          }

          return successful;
        }),
      recover: () =>
        Effect.gen(function* () {
          return uncertain;
        }),
    },
    artifactReader: {
      read: (receipt, path) =>
        Effect.gen(function* () {
          entered.resolve();

          return yield* artifactReader.read(receipt, path);
        }),
      cleanup: () =>
        Effect.gen(function* () {
          yield* Effect.promise(() => finish.promise);
          drained = true;
        }),
    },
    close: () =>
      Effect.gen(function* () {
        dependencyCloses++;
        expect(drained).toBe(true);
        dependenciesClosing.resolve();
        yield* Effect.promise(() => releaseDependency.promise);
        yield* fixture.authority.close();
      }),
  };

  const service = await openSandbox(fixture.config, () => Effect.promise(async () => dependencies));
  let request = Promise.resolve();
  let closing: Promise<void> | undefined;

  try {
    if (kind === "artifact") {
      await run(service.attempts.start(fixture.request));
      await run(service.attempts.drain());
      const url = new URL("/artifacts", service.server.url);
      url.searchParams.set("workspace", fixture.request.workspace);
      url.searchParams.set("key", JSON.stringify(fixture.request.executionKey));
      url.searchParams.set("attempt", "1");
      url.searchParams.set("path", "out.txt");
      request = fetch(url, { headers: { authorization: `Bearer ${fixture.config.token}` } }).then(
        async (response) => {
          await response.arrayBuffer();
        },
        () => {},
      );
    } else {
      request = post(service, fixture);
    }

    await within(entered.promise, "In-flight work did not start");
    closing = run(service.close());
    await expect(run(service.attempts.start({ ...fixture.request, attempt: 2 }))).rejects.toThrow(
      "stopping",
    );
    expect(await Bun.file(join(fixture.config.stateRoot, "service.lock")).exists()).toBe(true);
    expect(dependencyCloses).toBe(0);
    finish.resolve();
    await within(dependenciesClosing.promise, "Shutdown did not drain before dependency close");
    expect(drained).toBe(true);
    expect(await Bun.file(join(fixture.config.stateRoot, "service.lock")).exists()).toBe(true);
    releaseDependency.resolve();
    await within(closing, "Shutdown did not finish after safe drain");
    await request;
    expect(dependencyCloses).toBe(1);
    expect(await Bun.file(join(fixture.config.stateRoot, "service.lock")).exists()).toBe(false);
  } finally {
    finish.resolve();
    releaseDependency.resolve();
    await run(service.attempts.close());
    await closing;
    await run(service.close());
    await request;
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test("server close retains its lock until the in-flight backend effect and dependency close drain", async () => {
  await assertDrainOrdering("effect");
});

test("server close retains its lock until the in-flight artifact helper and dependency close drain", async () => {
  await assertDrainOrdering("artifact");
});

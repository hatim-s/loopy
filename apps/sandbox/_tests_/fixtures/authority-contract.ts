import { expect, test } from "bun:test";
import {
  AuthorityError,
  artifactHelperName,
  type DockerAttemptPlan,
} from "@loopy/contract/sandbox";
import { Effect } from "effect";
import type { ResultsFor, SandboxAttemptAuthority } from "../../src/authority";
import { successful, uncertain } from "./authority";
import {
  enumerateAuthorityModel,
  initialModel,
  type ModelAction,
  modelStep,
} from "./authority-model";
import { authorityRules, openCurrent } from "./authority-rules";

const run = Effect.runPromise;

export interface AuthoritySubject {
  /** The authority as of the latest restart. */
  readonly authority: SandboxAttemptAuthority;
  readonly resultsFor: ResultsFor;
  plan(runId: string, attempt?: number): Promise<DockerAttemptPlan>;
  /** Drops in-memory state as a process or isolate restart does and keeps durable state. */
  restart(): Promise<void>;
}

const outcome = (reply: { kind: string; code?: string }) =>
  reply.kind === "rejected" ? reply.code : reply.kind;

/**
 * The rules both authority implementations share. A subject may keep state across tests, so every
 * test names its own runs, nonces and export tokens.
 */
export function authorityContract(name: string, open: () => Promise<AuthoritySubject>) {
  test(`${name}: export guards exclude same-volume admissions across restart and release under the current session`, async () => {
    const subject = await open();
    const session = await openCurrent(subject.authority, "export-first");
    const plan = await subject.plan("export-guard");
    await run(subject.authority.admit({ session, plan }));
    await run(
      subject.authority.complete({
        session,
        id: plan.id,
        requestHash: plan.requestHash,
        result: await run(subject.resultsFor(plan.workspace).put(successful)),
      }),
    );

    const request = { session, attemptId: plan.id, token: "guard-one" };
    const granted = await run(subject.authority.beginExport(request));
    expect(granted).toMatchObject({
      kind: "granted",
      record: { volume: plan.volume, helper: artifactHelperName(plan.id), session },
    });
    expect(await run(subject.authority.beginExport(request))).toEqual(granted);
    const next = await subject.plan("export-guard", 2);
    expect(await run(subject.authority.admit({ session, plan: next }))).toEqual({
      kind: "rejected",
      code: "workspace_busy",
    });
    const other = await subject.plan("export-guard-other");
    expect((await run(subject.authority.admit({ session, plan: other }))).kind).toBe("created");
    expect((await run(subject.authority.admit({ session, plan }))).kind).toBe("existing");

    await subject.restart();
    const authority = subject.authority;
    const successor = await openCurrent(authority, "export-successor");

    const guards = async () =>
      (await run(authority.recoverable({ after: null, limit: 200 }))).exports.filter(
        (guard) => guard.volume === plan.volume,
      );

    expect(await guards()).toMatchObject([{ token: request.token, session }]);
    await expect(run(authority.endExport({ session, token: request.token }))).rejects.toEqual(
      new AuthorityError("stale_session"),
    );
    expect(await run(authority.admit({ session: successor, plan: next }))).toEqual({
      kind: "rejected",
      code: "workspace_busy",
    });
    const later = await subject.plan("export-guard-later");
    expect((await run(authority.admit({ session: successor, plan: later }))).kind).toBe("created");
    // Ending an unknown token is a retried release, so it succeeds and leaves other guards alone.
    expect(
      await run(authority.endExport({ session: successor, token: "foreign-token" })),
    ).toBeNull();
    expect(await guards()).toHaveLength(1);

    // No helper exists here, so the current session may confirm that absence and release.
    await run(authority.endExport({ session: successor, token: request.token }));
    await run(authority.endExport({ session: successor, token: request.token }));
    expect(await run(authority.beginExport({ ...request, session: successor }))).toEqual({
      kind: "rejected",
      code: "invalid_state",
    });
    expect(
      (
        await run(
          authority.beginExport({ session: successor, attemptId: plan.id, token: "guard-two" }),
        )
      ).kind,
    ).toBe("granted");
    await run(authority.endExport({ session: successor, token: request.token }));
    expect(await guards()).toHaveLength(1);
    await run(authority.endExport({ session: successor, token: "guard-two" }));
    expect((await run(authority.admit({ session: successor, plan: next }))).kind).toBe("created");
  });

  test(`${name}: the independent finite model and its shortest representative traces agree`, async () => {
    for (const [index, trace] of enumerateAuthorityModel(7).representatives.entries()) {
      await replay(await open(), trace, `model-${index}`);
    }
  });

  authorityRules(name, open);
}

async function replay(subject: AuthoritySubject, trace: ModelAction[], id: string) {
  const { authority, resultsFor } = subject;
  const nonces = [`${id}-first`, `${id}-second`];
  const first = await openCurrent(authority, `${id}-first`);
  let current = first;
  let model = initialModel();

  const plans = [
    await subject.plan(id),
    await subject.plan(id, 2),
    await subject.plan(`${id}-other`),
  ] as const;

  const a = await run(resultsFor(plans[0].workspace).put(successful));
  const b = await run(resultsFor(plans[0].workspace).put(uncertain));

  async function apply(action: ModelAction): Promise<string | undefined> {
    const session = action.startsWith("stale") ? first : current;

    switch (action) {
      case "rotate":
        current = await openCurrent(authority, `${id}-second`);

        return "session";
      case "admit0":
      case "admit1":
      case "admit2":
      case "staleAdmit":
      case "changed0": {
        const target = action === "admit1" ? plans[1] : action === "admit2" ? plans[2] : plans[0];
        const changed = { ...target, requestHash: "c".repeat(64) };

        return outcome(
          await run(authority.admit({ session, plan: action === "changed0" ? changed : target })),
        );
      }

      case "completeA":
      case "completeB":
      case "staleComplete":
        return outcome(
          await run(
            authority.complete({
              session,
              id: plans[0].id,
              requestHash: plans[0].requestHash,
              result: action === "completeB" ? b : a,
            }),
          ),
        );
      case "begin":
        return outcome(
          await run(
            authority.beginExport({ session, attemptId: plans[0].id, token: `${id}-guard` }),
          ),
        );
      case "end":
      case "staleEnd":
      case "foreignEnd": {
        const token = action === "foreignEnd" ? `${id}-foreign` : `${id}-guard`;

        try {
          await run(authority.endExport({ session, token }));

          return "released";
        } catch (cause) {
          if (cause instanceof AuthorityError) {
            return cause.code;
          }

          throw cause;
        }
      }
    }
  }

  for (const [index, action] of trace.entries()) {
    const expected = modelStep(model, action);

    if (expected.reply === "skip") {
      continue;
    }

    const context = `shortest sampled prefix: ${trace.slice(0, index + 1).join(",")}`;
    expect(await apply(action), context).toBe(expected.reply);
    model = expected.state;

    for (const attempt of [0, 1, 2] as const) {
      const record = await run(authority.read({ id: plans[attempt].id }));
      const expectedAttempt = model.attempts[attempt];

      expect(record?.kind ?? "absent", context).toBe(
        expectedAttempt.startsWith("finished") ? "finished" : expectedAttempt,
      );

      if (record?.kind === "started") {
        expect(nonces, context).toContain(record.session.nonce);
      }
    }

    // Guards from other traces may persist in a shared subject, so count this trace's volume.
    const guards = await run(
      authority.exportGuards({ after: null, limit: 200, volume: plans[0].volume }),
    );

    expect(guards.exports.length, context).toBe(model.guard ? 1 : 0);
  }
}

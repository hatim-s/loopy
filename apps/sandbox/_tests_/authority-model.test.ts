import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { AuthorityError, type AuthoritySession } from "@loopy/contract/sandbox";
import { authorityFixture, successful, uncertain } from "./fixtures/authority";
import {
  enumerateAuthorityModel,
  initialModel,
  type ModelAction,
  modelStep,
} from "./fixtures/authority-model";
import { run } from "./fixtures/run";

async function replay(trace: ModelAction[]) {
  const fixture = await authorityFixture();
  const { authority, plan, resultsFor } = fixture;
  const first = await run(authority.openSession({ expectedEpoch: 0, nonce: "first" }));
  let current = first;
  let model = initialModel();
  const a = await run(resultsFor("fixture").put(successful));
  const b = await run(resultsFor("fixture").put(uncertain));
  const plans = [await plan(), await plan(2), await plan(1, "other")] as const;

  async function apply(action: ModelAction): Promise<string> {
    const session = action.startsWith("stale") ? first : current;

    switch (action) {
      case "rotate":
        current = await run(authority.openSession({ expectedEpoch: 1, nonce: "second" }));

        return "session";
      case "admit0":
      case "admit1":
      case "admit2":
      case "staleAdmit":
      case "changed0": {
        const target = action === "admit1" ? plans[1] : action === "admit2" ? plans[2] : plans[0];

        const reply = await run(
          authority.admit({
            session,
            plan: action === "changed0" ? { ...target, requestHash: "a".repeat(64) } : target,
          }),
        );

        return reply.kind === "rejected" ? reply.code : reply.kind;
      }

      case "completeA":
      case "completeB":
      case "staleComplete": {
        const reply = await run(
          authority.complete({
            session,
            id: plans[0].id,
            requestHash: plans[0].requestHash,
            result: action === "completeB" ? b : a,
          }),
        );

        return reply.kind === "rejected" ? reply.code : reply.kind;
      }

      case "begin": {
        const reply = await run(
          authority.beginExport({
            session,
            attemptId: plans[0].id,
            token: "guard",
          }),
        );

        return reply.kind === "rejected" ? reply.code : reply.kind;
      }

      case "end":
      case "staleEnd":
      case "foreignEnd": {
        try {
          await run(
            authority.endExport({
              session,
              token: action === "foreignEnd" ? "foreign" : "guard",
            }),
          );

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

  try {
    for (let index = 0; index < trace.length; index++) {
      const action = trace[index];

      if (!action) {
        throw new Error("Missing model action");
      }

      const expected = modelStep(model, action);

      if (expected.reply === "skip") {
        continue;
      }

      const context = `shortest sampled prefix: ${trace.slice(0, index + 1).join(",")}`;
      expect(await apply(action), context).toBe(expected.reply);
      model = expected.state;

      for (let attempt = 0; attempt < plans.length; attempt++) {
        const target = plans[attempt];

        if (!target) {
          throw new Error("Missing plan");
        }

        const record = await run(authority.read({ id: target.id }));
        const expectedAttempt = model.attempts[attempt];

        if (!expectedAttempt) {
          throw new Error("Missing model attempt");
        }

        expect(record?.kind ?? "absent", context).toBe(
          expectedAttempt?.startsWith("finished") ? "finished" : expectedAttempt,
        );

        if (record?.kind === "started") {
          const owner: AuthoritySession = record.session;
          expect(["first", "second"], context).toContain(owner.nonce);
        }
      }

      expect(
        (await run(authority.recoverable({ after: null, limit: 200 }))).exports.length,
        context,
      ).toBe(model.guard ? 1 : 0);
    }
  } finally {
    await run(authority.close());
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test("independent finite authority model and shortest representative filesystem traces agree", async () => {
  const explored = enumerateAuthorityModel(7);
  expect(explored.states).toBeGreaterThan(25);
  expect(explored.transitions).toBeGreaterThan(300);
  const samples = explored.representatives;

  for (const trace of samples) {
    await replay(trace);
  }

  process.stdout.write(
    `authority model: depth=7 states=${explored.states} transitions=${explored.transitions} filesystem-traces=${samples.length}\n`,
  );
});

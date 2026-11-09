import { expect, test } from "bun:test";
import {
  AuthorityError,
  type AuthorityOutput,
  attemptResources,
  SANDBOX_MAX_CAPTURE_BYTES,
} from "@loopy/contract/sandbox";
import type { SandboxAttemptAuthority } from "../../src/authority";
import { successful, uncertain } from "./authority";
import type { AuthoritySubject } from "./authority-contract";
import { run } from "./run";

// The filesystem adapter keeps one in-memory epoch and the DO persists a counter, so callers ask.
export async function openCurrent(authority: SandboxAttemptAuthority, nonce: string) {
  const { epoch } = await run(authority.status({}));

  return run(authority.openSession({ expectedEpoch: epoch, nonce }));
}

async function finished(subject: AuthoritySubject, runId: string) {
  const session = await openCurrent(subject.authority, runId);
  const plan = await subject.plan(runId);
  await run(subject.authority.admit({ session, plan }));

  await run(
    subject.authority.complete({
      session,
      id: plan.id,
      requestHash: plan.requestHash,
      result: await run(subject.resultsFor(plan.workspace).put(successful)),
    }),
  );

  return { session, plan };
}

/** Admission, completion, paging and result rules, written once for both adapters. */
export function authorityRules(name: string, open: () => Promise<AuthoritySubject>) {
  test(`${name}: one concurrent admission is created, duplicates join it, and changed or foreign plans are rejected`, async () => {
    const subject = await open();
    const { authority } = subject;
    const session = await openCurrent(authority, "admission");
    const plan = await subject.plan("admission");

    const replies = await Promise.all(
      Array.from({ length: 8 }, () => run(authority.admit({ session, plan }))),
    );

    expect(replies.filter((reply) => reply.kind === "created")).toHaveLength(1);
    expect(replies.filter((reply) => reply.kind === "existing")).toHaveLength(7);
    // The request hash names the content, so a later deadline joins the original admission.
    expect(
      await run(authority.admit({ session, plan: { ...plan, deadline: plan.deadline + 1 } })),
    ).toEqual({ kind: "existing", record: { kind: "started", plan, session } });
    expect(
      await run(authority.admit({ session, plan: { ...plan, requestHash: "b".repeat(64) } })),
    ).toEqual({ kind: "rejected", code: "request_conflict" });
    expect(await run(authority.admit({ session: { ...session, nonce: "foreign" }, plan }))).toEqual(
      { kind: "rejected", code: "stale_session" },
    );

    // Each name derives from this authority's root, so a plan cannot reach another's resources.
    const other = await subject.plan("admission", 2);
    const foreign = await attemptResources("/another-authority-root", plan);

    for (const changed of [
      { ...other, container: plan.container },
      { ...plan, volume: foreign.volume },
      { ...plan, attempt: 2 },
    ]) {
      expect(await run(authority.admit({ session, plan: changed }))).toEqual({
        kind: "rejected",
        code: "invalid_state",
      });
    }

    const results = subject.resultsFor(plan.workspace);
    const result = await run(results.put(successful));
    expect(await run(results.get(result))).toEqual(successful);
    await expect(run(subject.resultsFor("other-workspace").get(result))).rejects.toThrow();
    const complete = { session, id: plan.id, requestHash: plan.requestHash, result };
    expect((await run(authority.complete(complete))).kind).toBe("finished");
    expect((await run(authority.complete(complete))).kind).toBe("finished");
    const changed = await run(results.put(uncertain));
    expect(await run(authority.complete({ ...complete, result: changed }))).toEqual({
      kind: "rejected",
      code: "request_conflict",
    });
  });

  test(`${name}: recovery pages list every started attempt and active guard once under one limit`, async () => {
    const subject = await open();
    const { authority } = subject;
    const { session, plan } = await finished(subject, "pagination");
    await run(authority.beginExport({ session, attemptId: plan.id, token: "pagination-guard" }));

    for (const runId of ["page-a", "page-b", "page-c"]) {
      await run(authority.admit({ session, plan: await subject.plan(runId) }));
    }

    const keys = (page: AuthorityOutput<"recoverable">) => [
      ...page.attempts.map((record) => `a:${record.plan.id}`),
      ...page.exports.map((record) => `e:${record.token}`),
    ];

    const all = keys(await run(authority.recoverable({ after: null, limit: 200 })));
    const seen: string[] = [];
    let after: string | null = null;

    do {
      const page: AuthorityOutput<"recoverable"> = await run(
        authority.recoverable({ after, limit: 2 }),
      );

      expect(keys(page).length).toBeLessThanOrEqual(2);
      seen.push(...keys(page));
      after = page.next;
    } while (after !== null);

    expect(seen).toEqual(all.sort());
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain("e:pagination-guard");
  });

  test(`${name}: export guard pages filter an exact volume and drop a released guard`, async () => {
    const subject = await open();
    const { authority } = subject;
    const { session, plan } = await finished(subject, "export-only");
    await run(authority.beginExport({ session, attemptId: plan.id, token: "export-only-guard" }));

    const page = (after: string | null) =>
      run(authority.exportGuards({ after, limit: 1, volume: plan.volume }));

    expect(await page(null)).toMatchObject({
      exports: [{ token: "export-only-guard" }],
      next: null,
    });
    expect(await page("export-only-guard")).toEqual({ exports: [], next: null });
    await run(authority.endExport({ session, token: "export-only-guard" }));
    expect(await page(null)).toEqual({ exports: [], next: null });
  });

  test(`${name}: an oversized canonical result is invalid_state before publication`, async () => {
    const subject = await open();

    await expect(
      run(
        subject.resultsFor("fixture").put({
          kind: "succeeded",
          output: "x".repeat(SANDBOX_MAX_CAPTURE_BYTES),
          logs: [],
        }),
      ),
    ).rejects.toEqual(new AuthorityError("invalid_state"));
  });
}

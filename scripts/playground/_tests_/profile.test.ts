import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvedDiagnostic, diagnosticPath } from "../metrics/snapshot";
import { playgroundProfile } from "../profile";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function freshRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopy-profile-")));
  temporary.push(root);

  return root;
}

test("architecture isolates roots, every capture directory, ports and child selection", async () => {
  const root = await freshRoot();
  const legacy = playgroundProfile(root, undefined);
  const architecture = playgroundProfile(root, "architecture");

  expect(legacy.state).toBe(join(root, ".loopy/playground"));
  expect(legacy.daemonState).toBe(join(root, ".loopy/playground-daemon"));
  expect(legacy.evidence).toBe(join(root, ".notes/cloud/evidence"));
  expect(legacy.apiPort).toBe(15070);
  expect(legacy.daemonPort).toBe(15170);
  expect(legacy.image).toBe("loopy-sandbox:bun-1.4.0");
  expect(legacy.receiptMode).toBe("filesystem");
  expect(legacy.environment).toEqual({});
  expect(architecture.state).toBe(join(root, ".loopy/playground-architecture"));
  expect(architecture.daemonState).toBe(join(root, ".loopy/playground-daemon-architecture"));
  expect(architecture.repository).toBe(join(architecture.state, "loopies-playground"));
  expect(architecture.sandboxState).toBe(join(architecture.runtime, ".loopy/cloud/sandbox"));
  expect(architecture.evidence).toBe(join(legacy.evidence, "architecture"));
  expect([
    architecture.apiPort,
    architecture.sandboxPort,
    architecture.dashboardPort,
    architecture.inspectorPort,
    architecture.daemonPort,
  ]).toEqual([15270, 15271, 15272, 15273, 15370]);
  expect(architecture.image).toBe("loopy-sandbox:architecture-bun-1.4.0");
  expect(architecture.receiptMode).toBe("durable-object");
  expect(playgroundProfile(root, architecture.environment.LOOPY_PLAYGROUND_PROFILE)).toEqual(
    architecture,
  );

  for (const input of ["", "default", "other", "Architecture", "../playground"]) {
    expect(() => playgroundProfile(root, input)).toThrow();
  }
});

test("diagnostics reject old profiles, directory symlinks, and unapproved or changed copies", async () => {
  const root = await freshRoot();
  const selected = playgroundProfile(root, "architecture");
  const diagnostics = join(selected.state, "diagnostics");
  const old = join(root, "old-diagnostic.sqlite");
  const path = join(diagnostics, "closed.sqlite");
  await mkdir(diagnostics, { recursive: true });
  await writeFile(path, "synthetic closed copy");
  await writeFile(old, "preserved old capture");
  const canonical = await diagnosticPath(path, diagnostics);
  await expect(diagnosticPath(old, diagnostics)).rejects.toThrow("selected playground diagnostics");
  const linked = join(root, "linked-diagnostics");
  await symlink(diagnostics, linked);
  await expect(diagnosticPath(join(linked, "closed.sqlite"), linked)).rejects.toThrow(
    "selected playground diagnostics",
  );
  const approvalPath = join(diagnostics, "closed-copy.json");
  const hash = createHash("sha256").update("synthetic closed copy").digest("hex");

  const approval = {
    profile: "architecture",
    sourceClosed: true,
    path: canonical,
    sha256: hash,
    batch: "fresh-batch",
  };

  await writeFile(approvalPath, JSON.stringify(approval));
  expect(await approvedDiagnostic(canonical, approvalPath, "fresh-batch")).toBe(hash);
  await expect(approvedDiagnostic(canonical, approvalPath, "old-batch")).rejects.toThrow(
    "snapshot path, batch and hash",
  );
  await writeFile(path, "changed copy");
  await expect(approvedDiagnostic(canonical, approvalPath, "fresh-batch")).rejects.toThrow(
    "snapshot path, batch and hash",
  );
  await writeFile(approvalPath, JSON.stringify({ ...approval, sourceClosed: false }));
  await expect(approvedDiagnostic(canonical, approvalPath, "fresh-batch")).rejects.toThrow();
});

test("architecture config requires explicit durable mode and a distinct receipt credential", async () => {
  const { playgroundConfigSchema } = await import("../config-schema");
  const root = await freshRoot();
  const selected = playgroundProfile(root, "architecture");
  const schema = playgroundConfigSchema(selected);

  const input = {
    batch: "synthetic-batch",
    api: selected.api,
    dashboard: selected.dashboard,
    workspace: "playground",
    token: "a".repeat(64),
    otherToken: "b".repeat(64),
    sandboxToken: "c".repeat(64),
    receiptsToken: "d".repeat(64),
    receiptMode: "durable-object",
    apiConcurrency: 4,
    runtimeConcurrency: 4,
    createdAt: new Date().toISOString(),
  };

  expect(schema.safeParse(input).success).toBe(true);

  for (const token of [input.token, input.otherToken, input.sandboxToken]) {
    expect(schema.safeParse({ ...input, receiptsToken: token }).success).toBe(false);
  }

  for (const receiptMode of [undefined, "filesystem", "r2", "auto"]) {
    expect(schema.safeParse({ ...input, receiptMode }).success).toBe(false);
  }

  expect(schema.safeParse({ ...input, receiptsToken: undefined }).success).toBe(false);
  expect(schema.safeParse({ ...input, api: "http://127.0.0.1:15070" }).success).toBe(false);
  expect(schema.safeParse({ ...input, runtimeConcurrency: 5 }).success).toBe(false);
  const legacy = playgroundProfile(root, undefined);
  const { receiptsToken, receiptMode, ...base } = input;
  expect(receiptsToken.length).toBe(64);
  expect(receiptMode).toBe("durable-object");
  expect(
    playgroundConfigSchema(legacy).safeParse({
      ...base,
      api: legacy.api,
      dashboard: legacy.dashboard,
    }).success,
  ).toBe(true);
});

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeBoundary } from "@loopy/contract";
import { qualityTestRoot } from "../../../../../packages/loopy/_tests_/fixtures/quality-test-root";
import { playgroundConfigSchema, withReceiptMode } from "../../../dev/playground/config";
import { approvedDiagnostic, diagnosticPath } from "../../../dev/playground/metrics/snapshot";
import type { PlaygroundProfile } from "../../../dev/playground/profile";
import { playgroundProfile, profilePorts } from "../../../dev/playground/profile";

const decodeConfig = (selected: PlaygroundProfile, input: Record<string, string>) =>
  withReceiptMode(selected, decodeBoundary(playgroundConfigSchema(selected))(input));

const freshRoot = () => qualityTestRoot("profile");

test("the two profiles share no state path, evidence path or port and reject unknown names", async () => {
  const root = freshRoot();
  const legacy = playgroundProfile(root, undefined);
  const architecture = playgroundProfile(root, "architecture");

  for (const key of ["state", "runtime", "sandboxState", "repository", "evidence"] as const) {
    expect(architecture[key]).not.toBe(legacy[key]);
  }

  const ports = [...profilePorts(legacy), ...profilePorts(architecture)];
  expect(new Set(ports).size).toBe(ports.length);
  expect(playgroundProfile(root, architecture.environment.LOOPY_PLAYGROUND_PROFILE)).toEqual(
    architecture,
  );

  for (const input of ["", "default", "other", "Architecture", "../playground"]) {
    expect(() => playgroundProfile(root, input)).toThrow();
  }
});

test("diagnostics reject old profiles, directory symlinks, and unapproved or changed copies", async () => {
  const root = freshRoot();
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

  const check = {
    path: canonical,
    approvalPath,
    batch: "fresh-batch",
    profile: "architecture",
  } as const;

  await writeFile(approvalPath, JSON.stringify(approval));
  expect(await approvedDiagnostic(check)).toBe(hash);
  await expect(approvedDiagnostic({ ...check, batch: "old-batch" })).rejects.toThrow(
    "snapshot path, batch and hash",
  );
  await expect(approvedDiagnostic({ ...check, profile: "default" })).rejects.toThrow(
    "snapshot path, batch and hash",
  );
  await writeFile(path, "changed copy");
  await expect(approvedDiagnostic(check)).rejects.toThrow("snapshot path, batch and hash");
  await writeFile(approvalPath, JSON.stringify({ ...approval, sourceClosed: false }));
  await expect(approvedDiagnostic(check)).rejects.toThrow();
});

test("each profile config holds exactly its own credentials and they stay distinct", async () => {
  const root = freshRoot();
  const legacy = playgroundProfile(root, undefined);
  const architecture = playgroundProfile(root, "architecture");

  const base = {
    batch: "synthetic-batch",
    workspace: "playground",
    token: "a".repeat(64),
    otherToken: "b".repeat(64),
    sandboxToken: "c".repeat(64),
    createdAt: new Date().toISOString(),
  };

  const durable = {
    ...base,
    api: architecture.api,
    dashboard: architecture.dashboard,
    receiptsToken: "d".repeat(64),
  };

  expect(decodeConfig(architecture, durable).receiptMode).toBe("durable-object");
  expect(
    decodeConfig(legacy, { ...base, api: legacy.api, dashboard: legacy.dashboard }).receiptMode,
  ).toBe("filesystem");

  for (const token of [base.token, base.otherToken, base.sandboxToken]) {
    expect(() => decodeConfig(architecture, { ...durable, receiptsToken: token })).toThrow();
  }

  expect(() =>
    decodeConfig(architecture, {
      ...base,
      api: architecture.api,
      dashboard: architecture.dashboard,
    }),
  ).toThrow();
  expect(() =>
    decodeConfig(legacy, { ...durable, api: legacy.api, dashboard: legacy.dashboard }),
  ).toThrow();
  expect(() => decodeConfig(architecture, { ...durable, api: legacy.api })).toThrow();
});

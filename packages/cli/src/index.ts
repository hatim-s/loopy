#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonObject, JsonValue } from "@loopy/contracts";
import { extractImportedSession } from "@loopy/extractor";
import { createDefaultProviderRegistry, type ProviderRegistry } from "@loopy/providers";
import { type ProviderExecutor, RuntimeScheduler, type RuntimeStore } from "@loopy/runtime";
import {
  type CanonicalSessionImportInput,
  type ExtractionResultInput,
  SqliteRuntimeStore,
  type Storage,
} from "@loopy/storage";
import { DeterministicFakeProvider } from "@loopy/testing";
import { doctorCommand } from "./doctor";

export { doctorCommand, formatDoctor, runDoctor } from "./doctor";

const VERSION = "0.1.0";

const COMMANDS = [
  "init",
  "doctor",
  "providers",
  "sessions",
  "import",
  "extract",
  "review",
  "approve",
  "reject",
  "validate",
  "validate-provider",
  "run",
  "pause",
  "resume",
  "cancel",
  "retry",
  "fork",
  "replay",
  "trace",
  "ui",
] as const;

function printHelp(): void {
  console.log(`Loopy ${VERSION}

Local-first workflow runtime for coding agents.

Usage:
  loopy --version
  loopy --help
  loopy <command> [options]

Commands:
  ${COMMANDS.join(", ")}

Local persistence commands:
  loopy import <trace.jsonl> --provider <provider> [--project <dir>] [--json]
  loopy sessions list|show <id> [--project <dir>] [--json]
  loopy extract --import <id>   (deterministic offline extractor by default)
  loopy review list|show <id> [--project <dir>] [--json]
  loopy approve|reject <proposal-or-job-id> [--project <dir>] [--json]
  loopy run <workflow-id> [--local] [--input <json>] [--project <dir>] [--json]`);
  console.log(
    "  loopy validate-provider --provider <provider> --opt-in [--json]  (read-only probe; no run/network)",
  );
}

export interface ExtractionRequest {
  importId: string;
  provider?: string;
  session: JsonValue;
  capabilities: JsonObject;
  lossiness: JsonObject;
}
export type ExtractionRunner = (
  request: ExtractionRequest,
) => Promise<ExtractionResultInput> | ExtractionResultInput;
export type CliDependencies = {
  registry?: ProviderRegistry;
  storageFactory?: (projectDir: string, readOnly?: boolean) => Storage;
  extractor?: ExtractionRunner;
  /** Test and local integrations may provide a deterministic runtime executor. */
  providerExecutor?: ProviderExecutor;
  runtimeFactory?: (store: RuntimeStore, provider: ProviderExecutor) => RuntimeScheduler;
};

/** Offline default: segmentation, proposal, and repair never contact a provider. */
async function defaultExtractionRunner(request: ExtractionRequest): Promise<ExtractionResultInput> {
  const extraction = await extractImportedSession({
    id: request.importId,
    provider: request.provider ?? "codex",
    session: request.session,
    capabilities: request.capabilities,
    lossiness: request.lossiness,
  });
  if (!extraction.result.ok) {
    const detail = extraction.result.diagnostics.map((diagnostic) => diagnostic.code).join(", ");
    throw new Error(
      `Deterministic extraction was rejected after ${extraction.result.attempts} attempt(s): ${detail}`,
    );
  }
  return {
    proposal: extraction.result.proposal,
    audit: extraction.audit as unknown as JsonValue,
  };
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
function positional(args: readonly string[], start = 1): string | undefined {
  const valueOptions = new Set([
    "--project",
    "--provider",
    "--source",
    "--capabilities",
    "--lossiness",
    "--import",
    "--workflow",
    "--input",
    "--version",
  ]);
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg.startsWith("--")) {
      if (arg && valueOptions.has(arg)) index += 1;
      continue;
    }
    if (["list", "show", "run", "approve", "reject"].includes(arg)) continue;
    return arg;
  }
  return undefined;
}
function projectDir(args: readonly string[]): string {
  return resolve(option(args, "--project") ?? process.cwd());
}
async function storageFor(
  args: readonly string[],
  deps: CliDependencies,
  readOnly = false,
): Promise<Storage> {
  if (deps.storageFactory) return deps.storageFactory(projectDir(args), readOnly);
  const { openStorage } = await import("@loopy/storage");
  return openStorage({ projectDir: projectDir(args), readOnly });
  /*
  return (deps.storageFactory ?? ((dir, ro) => openStorage({ projectDir: dir, readOnly: ro })))(
    projectDir(args),
    readOnly,
  );*/
}
function jsonOutput(args: readonly string[]): boolean {
  return args.includes("--json");
}
function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

async function printSessionList(args: readonly string[], deps: CliDependencies): Promise<number> {
  const storage = await storageFor(args, deps, true);
  try {
    const sessions = storage.runtime.listImportedSessions();
    if (jsonOutput(args)) printJson(sessions);
    else
      for (const session of sessions)
        console.log(`${session.id}\t${session.provider}\t${session.source}`);
    return 0;
  } finally {
    storage.close();
  }
}
async function printSession(args: readonly string[], deps: CliDependencies): Promise<number> {
  const id = positional(args);
  if (!id) throw new Error("sessions show requires an import ID");
  const storage = await storageFor(args, deps, true);
  try {
    const session = storage.runtime.getImportedSession(id);
    if (!session) throw new Error(`Unknown imported session ${id}`);
    if (jsonOutput(args)) printJson(session);
    else {
      console.log(`id: ${session.id}`);
      console.log(`provider: ${session.provider}`);
      console.log(`source: ${session.source}`);
      console.log(`contentHash: ${session.contentHash ?? ""}`);
      console.log(`events: ${Array.isArray(session.session) ? session.session.length : 0}`);
      console.log(`capabilities: ${JSON.stringify(session.capabilities)}`);
      console.log(`lossiness: ${JSON.stringify(session.lossiness)}`);
    }
    return 0;
  } finally {
    storage.close();
  }
}
async function printReviews(args: readonly string[], deps: CliDependencies): Promise<number> {
  const storage = await storageFor(args, deps, true);
  try {
    const reviews = storage.runtime.listExtractionReviews();
    if (jsonOutput(args)) printJson(reviews);
    else
      for (const review of reviews)
        console.log(
          `${review.proposal.id}\t${review.proposal.status}\tjob=${review.job.id}\timport=${review.import.id}\tnodes=${review.proposal.workflow.nodes.length}`,
        );
    return 0;
  } finally {
    storage.close();
  }
}
async function printReview(args: readonly string[], deps: CliDependencies): Promise<number> {
  const id = positional(args);
  if (!id) throw new Error("review show requires a proposal or job ID");
  const storage = await storageFor(args, deps, true);
  try {
    const review = storage.runtime.getExtractionReview(id);
    if (!review) throw new Error(`Unknown extraction review ${id}`);
    if (jsonOutput(args)) printJson(review);
    else {
      console.log(`proposal: ${review.proposal.id}`);
      console.log(`status: ${review.proposal.status}`);
      console.log(`job: ${review.job.id} (${review.job.status})`);
      console.log(`import: ${review.import.id}`);
      console.log(
        `workflow: ${review.proposal.workflow.id} v${review.proposal.workflow.workflowVersion}`,
      );
      console.log(`nodes: ${review.proposal.workflow.nodes.length}`);
      console.log(`warnings: ${review.proposal.warnings.length}`);
      console.log(
        `blockingQuestions: ${review.proposal.unresolvedQuestions.filter((question) => question.blocksExecution).length}`,
      );
      console.log(`audit: ${JSON.stringify(review.audit ?? {})}`);
    }
    return 0;
  } finally {
    storage.close();
  }
}
async function importSession(args: readonly string[], deps: CliDependencies): Promise<number> {
  const file = positional(args);
  const provider = option(args, "--provider");
  if (!file || !provider) throw new Error("import requires a JSONL file and --provider");
  const source = option(args, "--source") ?? file;
  const capabilities = option(args, "--capabilities");
  const lossiness = option(args, "--lossiness");
  const rawContent = readFileSync(resolve(file), "utf8");
  const content = rawContent.trimStart().startsWith("[")
    ? `${(JSON.parse(rawContent) as unknown[]).map((event) => JSON.stringify(event)).join("\n")}\n`
    : rawContent;
  const input: CanonicalSessionImportInput = {
    provider,
    source,
    content,
    ...(capabilities ? { capabilities: JSON.parse(capabilities) as JsonObject } : {}),
    ...(lossiness ? { lossiness: JSON.parse(lossiness) as JsonObject } : {}),
  };
  const storage = await storageFor(args, deps);
  try {
    const session = storage.runtime.importCanonicalSession(input);
    if (jsonOutput(args)) printJson(session);
    else console.log(`imported ${session.id} (${session.contentHash})`);
    return 0;
  } finally {
    storage.close();
  }
}
async function extractSession(args: readonly string[], deps: CliDependencies): Promise<number> {
  const importId = option(args, "--import") ?? positional(args);
  if (!importId) throw new Error("extract requires an import ID");
  const storage = await storageFor(args, deps);
  try {
    const imported = storage.runtime.getImportedSession(importId);
    if (!imported) throw new Error(`Unknown imported session ${importId}`);
    const job = storage.runtime.createExtractionJob({
      importId,
      input: { source: imported.source },
    });
    try {
      storage.runtime.updateExtractionJob(job.id, { status: "running" });
      const result = await (deps.extractor ?? defaultExtractionRunner)({
        importId,
        provider: imported.provider,
        session: imported.session,
        capabilities: imported.capabilities,
        lossiness: imported.lossiness,
      });
      const saved = storage.runtime.saveExtractionResult(job.id, result);
      if (jsonOutput(args)) printJson(saved);
      else console.log(`extraction ${saved.id} succeeded`);
    } catch (error) {
      storage.runtime.updateExtractionJob(job.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return 0;
  } finally {
    storage.close();
  }
}
async function approveOrReject(
  args: readonly string[],
  deps: CliDependencies,
  decision: "approve" | "reject",
): Promise<number> {
  const id = positional(args);
  if (!id) throw new Error(`${decision} requires a proposal or job ID`);
  const storage = await storageFor(args, deps);
  try {
    const result =
      decision === "approve"
        ? storage.runtime.approveExtractionProposal(id)
        : storage.runtime.rejectExtractionProposal(id);
    if (jsonOutput(args)) printJson(result);
    else console.log(`${decision}d ${id}`);
    return 0;
  } finally {
    storage.close();
  }
}

function parseRunInput(args: readonly string[]): JsonObject {
  const raw = option(args, "--input");
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("run --input must be a JSON object");
  return parsed as JsonObject;
}

/** Execute only through the local deterministic provider path in this phase. */
async function runWorkflow(args: readonly string[], deps: CliDependencies): Promise<number> {
  const reference = option(args, "--workflow") ?? positional(args);
  if (!reference) throw new Error("run requires a workflow ID");
  const requestedProvider = option(args, "--provider");
  const local =
    args.includes("--local") ||
    args.includes("--fake") ||
    requestedProvider === undefined ||
    requestedProvider === "fake" ||
    requestedProvider === "deterministic-fake";
  if (!local || (requestedProvider && !["fake", "deterministic-fake"].includes(requestedProvider)))
    throw new Error(
      "live provider execution is not implemented; use the explicit local fake provider (--local)",
    );
  const versionValue = option(args, "--version");
  const version = versionValue === undefined ? 1 : Number(versionValue);
  if (!Number.isInteger(version) || version < 1) throw new Error("run --version must be positive");
  const storage = await storageFor(args, deps);
  try {
    let workflow = storage.runtime.getWorkflowVersion(reference, version);
    if (!workflow) {
      const review = storage.runtime.getExtractionReview(reference);
      if (!review) throw new Error(`Unknown approved workflow ${reference}`);
      if (review.proposal.status !== "approved")
        throw new Error(`Workflow proposal ${review.proposal.id} must be approved before running`);
      workflow = storage.runtime.getWorkflowVersion(review.proposal.workflow.id, version);
    }
    if (!workflow) throw new Error(`Unknown approved workflow ${reference}`);
    const provider = deps.providerExecutor ?? new DeterministicFakeProvider();
    const store = new SqliteRuntimeStore(storage);
    const runtime =
      deps.runtimeFactory?.(store, provider) ?? new RuntimeScheduler({ store, provider });
    const snapshot = await runtime.run(
      workflow.definition as Parameters<RuntimeScheduler["run"]>[0],
      parseRunInput(args),
    );
    if (jsonOutput(args)) printJson(snapshot);
    else console.log(`run ${snapshot.run.runId} ${snapshot.run.status}`);
    return snapshot.run.status === "succeeded" ? 0 : 1;
  } finally {
    storage.close();
  }
}

/** Explicit opt-in, read-only installation probe. It never starts a provider run. */
async function validateProvider(args: readonly string[], deps: CliDependencies): Promise<number> {
  if (!args.includes("--opt-in"))
    throw new Error("validate-provider is opt-in; pass --opt-in to probe an installed CLI");
  const id = option(args, "--provider");
  if (!id) throw new Error("validate-provider requires --provider");
  const adapter = (deps.registry ?? createDefaultProviderRegistry()).get(id);
  if (!adapter) throw new Error(`Unknown provider '${id}'`);
  const probe = await adapter.probe();
  if (jsonOutput(args)) printJson(probe);
  else {
    console.log(`${probe.provider}: ${probe.available ? "available" : "unavailable"}`);
    if (probe.version) console.log(`version: ${probe.version}`);
    if (probe.diagnostic) console.log(`diagnostic: ${probe.diagnostic}`);
  }
  return probe.available ? 0 : 1;
}

async function dispatch(args: readonly string[], deps: CliDependencies): Promise<number> {
  const command = args[0];
  if (command === "import") return importSession(args, deps);
  if (command === "sessions")
    return args.includes("show") ? printSession(args, deps) : printSessionList(args, deps);
  if (command === "extract") return extractSession(args, deps);
  if (command === "review") {
    if (args.includes("approve")) return approveOrReject(args, deps, "approve");
    if (args.includes("reject")) return approveOrReject(args, deps, "reject");
    return args.includes("show") ? printReview(args, deps) : printReviews(args, deps);
  }
  if (command === "approve") return approveOrReject(args, deps, "approve");
  if (command === "reject") return approveOrReject(args, deps, "reject");
  if (command === "run") return runWorkflow(args, deps);
  if (command === "validate-provider" || command === "validate")
    return validateProvider(args, deps);
  return 2;
}

export async function mainAsync(
  args: readonly string[] = Bun.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  if (args[0] === "doctor") {
    return doctorCommand(dependencies.registry ?? createDefaultProviderRegistry(), {
      json: args.includes("--json"),
      log: (line) => console.log(line),
    });
  }
  if (
    args[0] === "--help" ||
    args[0] === "-h" ||
    !args[0] ||
    args[0] === "--version" ||
    args[0] === "-v"
  )
    return main(args, dependencies);
  try {
    const result = await dispatch(args, dependencies);
    if (result === 2) {
      console.error(`loopy: '${args[0] ?? ""}' is not implemented in this release.`);
      return 2;
    }
    return result;
  } catch (error) {
    console.error(`loopy: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function main(
  args: readonly string[] = Bun.argv.slice(2),
  dependencies: CliDependencies = {},
): number {
  const [command] = args;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return 0;
  }

  if (command === "doctor") {
    // Keep the historical synchronous shell API while the executable awaits
    // the real async probe through `mainAsync` below.
    void mainAsync(args, dependencies).then((code) => {
      process.exitCode = code;
    });
    return 0;
  }

  if (
    [
      "import",
      "sessions",
      "extract",
      "review",
      "approve",
      "reject",
      "validate-provider",
      "validate",
      "run",
    ].includes(command)
  ) {
    void mainAsync(args, dependencies).then((code) => {
      process.exitCode = code;
    });
    return 0;
  }

  console.error(`loopy: '${command}' is not implemented in this release.`);
  console.error("Run 'loopy --help' to see the planned command surface.");
  return 2;
}

if (import.meta.main) {
  process.exitCode = await mainAsync();
}

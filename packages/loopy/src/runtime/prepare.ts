import type { Json, RunOptions, RunRecord, Workflow } from "../core/model.js";
import { validateWorkflow } from "../core/workflow.js";
import { validateRunInput } from "./preflight.js";
import { assertJson } from "./values.js";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checkRunOptions(options: RunOptions): RunOptions {
  if (options.mode !== "sandbox" && options.mode !== "full")
    throw new Error(`Invalid execution mode ${String(options.mode)}`);
  const workspace = options.workspace;
  if (workspace?.kind === "local" && typeof workspace.path === "string" && workspace.path)
    return { workspace: { kind: "local", path: workspace.path }, mode: options.mode };
  if (workspace?.kind === "managed" && typeof workspace.id === "string" && workspace.id)
    return { workspace: { kind: "managed", id: workspace.id }, mode: options.mode };
  throw new Error("Invalid workspace");
}

/** Preflight and freeze admission data without writing to a host repository. */
export async function prepareRun(
  workflow: Workflow,
  input: Json,
  options: RunOptions,
): Promise<RunRecord> {
  validateWorkflow(workflow);
  assertJson(input);
  validateRunInput(workflow.nodes, input);
  const savedInput = JSON.parse(JSON.stringify(input)) as Json;
  const savedOptions = checkRunOptions(options);
  const snapshot = JSON.stringify(workflow);
  const createdAt = new Date().toISOString();
  const run: RunRecord = {
    id: crypto.randomUUID(),
    slug: workflow.slug,
    workflow: JSON.parse(snapshot) as Workflow,
    workflowHash: await sha256(snapshot),
    input: savedInput,
    options: savedOptions,
    status: "pending",
    createdAt,
    updatedAt: createdAt,
  };
  return run;
}

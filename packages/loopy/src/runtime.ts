import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type {
  AttemptRecord,
  CommandNode,
  ConditionNode,
  ExecuteCommand,
  Json,
  ResolvedCommand,
  RunEvent,
  RunOptions,
  RunRecord,
  Workflow,
  WorkflowNode,
} from "./model";
import { CommandExecutionError, executeCommand } from "./process";
import { RunStore } from "./store";
import { validateWorkflow } from "./workflow";

type Values = Map<string, Json>;
type ExecutionResult = { status: "succeeded" | "failed" | "interrupted"; error?: string };

function assertJson(
  value: unknown,
  path = "input",
  seen = new Set<object>(),
  depth = 0,
): asserts value is Json {
  if (depth > 32) throw new Error(`${path} is too deeply nested`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object") throw new Error(`${path} must be JSON data`);
  if (seen.has(value)) throw new Error(`${path} contains a cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    throw new Error(`${path} must be a plain JSON object`);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1)
      if (!Object.hasOwn(value, index)) throw new Error(`${path} cannot contain array holes`);
    if (Object.keys(value).length !== value.length)
      throw new Error(`${path} cannot contain extra array properties`);
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value))
    assertJson(child, `${path}.${key}`, seen, depth + 1);
  seen.delete(value);
}

function pathValue(value: Json, path: readonly string[], label: string): Json {
  let current: Json = value;
  for (const key of path) {
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length)
        throw new Error(`Missing ${label}.${key}`);
      current = current[index] as Json;
    } else if (current && typeof current === "object" && Object.hasOwn(current, key)) {
      current = current[key] as Json;
    } else {
      throw new Error(`Missing ${label}.${key}`);
    }
  }
  return current;
}

function resolveValue(value: unknown, input: Json, outputs: Values): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Workflow value must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, input, outputs));
  if (!value || typeof value !== "object") throw new Error("Unsupported workflow value");
  const record = value as Record<string, unknown>;
  if ("$ref" in record) {
    const ref = record.$ref as { source: "input" | "steps"; path: string[] };
    if (!Array.isArray(ref.path) || ref.path.some((part) => typeof part !== "string"))
      throw new Error("Invalid workflow reference path");
    if (ref.source === "input") return pathValue(input, ref.path, "input");
    const [step, ...path] = ref.path;
    if (!step || !outputs.has(step)) throw new Error(`Output for ${step ?? "step"} is unavailable`);
    return pathValue(outputs.get(step) as Json, path, `steps.${step}`);
  }
  if ("$op" in record) {
    const op = record.$op;
    const args = record.args;
    if (!Array.isArray(args)) throw new Error("Expression args must be an array");
    const values = args.map((arg) => resolveValue(arg, input, outputs));
    switch (op) {
      case "eq":
        return Object.is(values[0], values[1]);
      case "ne":
        return !Object.is(values[0], values[1]);
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const [left, right] = values;
        if (typeof left !== "number" || typeof right !== "number")
          throw new Error(`${op} requires numbers`);
        return op === "gt"
          ? left > right
          : op === "gte"
            ? left >= right
            : op === "lt"
              ? left < right
              : left <= right;
      }
      case "and":
      case "or": {
        if (values.some((item) => typeof item !== "boolean"))
          throw new Error(`${op} requires booleans`);
        return op === "and" ? values.every(Boolean) : values.some(Boolean);
      }
      case "not":
        if (typeof values[0] !== "boolean") throw new Error("not requires a boolean");
        return !values[0];
      case "contains":
        if (typeof values[0] !== "string" || typeof values[1] !== "string")
          throw new Error("contains requires strings");
        return values[0].includes(values[1]);
      case "concat":
        if (values.some((item) => typeof item !== "string" && typeof item !== "number"))
          throw new Error("concat requires strings or numbers");
        return values.join("");
      default:
        throw new Error(`Unsupported expression ${String(op)}`);
    }
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, resolveValue(item, input, outputs)]),
  );
}

function stringValue(value: Json, label: string): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  throw new Error(`${label} must resolve to a string or number`);
}

function resolveCommand(node: CommandNode, input: Json, outputs: Values): ResolvedCommand {
  const source = node.command;
  const args = source.args.map((arg, index) =>
    stringValue(resolveValue(arg, input, outputs), `Argument ${index + 1}`),
  );
  const stdin =
    source.stdin === undefined
      ? undefined
      : stringValue(resolveValue(source.stdin, input, outputs), "stdin");
  const env = source.env
    ? Object.fromEntries(
        Object.entries(source.env).map(([key, value]) => [
          key,
          stringValue(resolveValue(value, input, outputs), `Environment ${key}`),
        ]),
      )
    : undefined;
  return {
    program: source.program,
    args,
    ...(stdin === undefined ? {} : { stdin }),
    ...(env === undefined ? {} : { env }),
    ...(source.cwd === undefined ? {} : { cwd: source.cwd }),
    ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
    ...(source.maxOutputBytes === undefined ? {} : { maxOutputBytes: source.maxOutputBytes }),
  };
}

function latestAttempts(attempts: AttemptRecord[]): Map<string, AttemptRecord> {
  const latest = new Map<string, AttemptRecord>();
  for (const attempt of attempts) {
    const prior = latest.get(attempt.nodeId);
    if (!prior || attempt.number > prior.number) latest.set(attempt.nodeId, attempt);
  }
  return latest;
}

export class Runtime {
  private readonly store: RunStore;
  private readonly executor: ExecuteCommand;

  constructor(options: { home: string; executor?: ExecuteCommand }) {
    this.store = new RunStore(options.home);
    this.executor = options.executor ?? executeCommand;
  }

  createRun(workflow: Workflow, input: Json, options: RunOptions): RunRecord {
    validateWorkflow(workflow);
    assertJson(input);
    if (options.mode !== "sandbox" && options.mode !== "full")
      throw new Error(`Invalid execution mode ${String(options.mode)}`);
    const cwd = realpathSync(options.cwd);
    if (!statSync(cwd).isDirectory()) throw new Error(`Run directory is not a directory: ${cwd}`);
    const createdAt = new Date().toISOString();
    const snapshot = JSON.parse(JSON.stringify(workflow)) as Workflow;
    const frozenInput = JSON.parse(JSON.stringify(input)) as Json;
    const run: RunRecord = {
      id: randomUUID(),
      slug: workflow.slug,
      workflow: snapshot,
      workflowHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
      input: frozenInput,
      options: { cwd, mode: options.mode },
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    };
    this.store.createRun(run);
    return run;
  }

  getRun(id: string): RunRecord | undefined {
    return this.store.getRun(id);
  }

  listRuns(slug?: string): RunRecord[] {
    return this.store.listRuns(slug);
  }

  getAttempts(id: string): AttemptRecord[] {
    return this.store.getAttempts(id);
  }

  getEvents(id: string, after?: number): RunEvent[] {
    return this.store.getEvents(id, after);
  }

  async execute(
    id: string,
    options: { retryUncertain?: boolean; signal?: AbortSignal } = {},
  ): Promise<RunRecord> {
    const initial = this.store.getRun(id);
    if (!initial) throw new Error(`Unknown run ${id}`);
    if (initial.status === "succeeded") return initial;
    const token = randomUUID();
    const run = this.store.claim(id, token);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const heartbeat = setInterval(() => {
      try {
        if (!this.store.heartbeat(id, token)) controller.abort(new Error("Run ownership lost"));
      } catch (error) {
        controller.abort(error);
      }
    }, 3_000);
    heartbeat.unref?.();
    try {
      const attempts = latestAttempts(this.store.getAttempts(id));
      const outputs: Values = new Map();
      for (const attempt of attempts.values())
        if (attempt.status === "succeeded" && attempt.output !== undefined)
          outputs.set(attempt.nodeId, attempt.output);
      const result = await this.executeNodes(
        run,
        run.workflow.nodes,
        token,
        attempts,
        outputs,
        Boolean(options.retryUncertain),
        controller.signal,
      );
      return this.store.finishRun(id, token, result.status, result.error);
    } finally {
      clearInterval(heartbeat);
      options.signal?.removeEventListener("abort", abort);
      this.store.release(id, token);
    }
  }

  private async executeNodes(
    run: RunRecord,
    nodes: readonly WorkflowNode[],
    token: string,
    attempts: Map<string, AttemptRecord>,
    outputs: Values,
    retryUncertain: boolean,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    for (const node of nodes) {
      if (signal.aborted) return { status: "interrupted", error: "Run interrupted" };
      const previous = attempts.get(node.id);
      if (previous?.status === "uncertain" && !retryUncertain)
        return {
          status: "interrupted",
          error: `Node ${node.id} may have changed external state. Resume with retryUncertain to run it again.`,
        };
      if (node.kind === "condition") {
        const branch = await this.executeCondition(run, node, token, previous, attempts, outputs);
        if (branch.status !== "succeeded") return branch;
        const chosen = branch.branch === "then" ? node.then : node.else;
        const result = await this.executeNodes(
          run,
          chosen,
          token,
          attempts,
          outputs,
          retryUncertain,
          signal,
        );
        if (result.status !== "succeeded") return result;
        continue;
      }
      if (previous?.status === "succeeded") continue;
      let command: ResolvedCommand;
      try {
        command = resolveCommand(node, run.input, outputs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempt = this.store.startAttempt(run.id, token, node.id, {
          command: node.command as Json,
        });
        attempts.set(
          node.id,
          this.store.finishAttempt(run.id, token, attempt.id, "failed", undefined, message),
        );
        return { status: "failed", error: message };
      }
      const attempt = this.store.startAttempt(run.id, token, node.id, command as Json);
      attempts.set(node.id, attempt);
      try {
        const output = await this.executor(command, { ...run.options, signal });
        if (signal.aborted) {
          const error = "Command was interrupted; its external effects are uncertain";
          attempts.set(
            node.id,
            this.store.finishAttempt(run.id, token, attempt.id, "uncertain", output as Json, error),
          );
          return { status: "interrupted", error };
        }
        const status = output.exitCode === 0 ? "succeeded" : "failed";
        const error =
          status === "failed" ? `Command exited with code ${output.exitCode}` : undefined;
        attempts.set(
          node.id,
          this.store.finishAttempt(run.id, token, attempt.id, status, output as Json, error),
        );
        if (status === "failed") return { status, error };
        outputs.set(node.id, output as Json);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const partial = error instanceof CommandExecutionError ? error.output : undefined;
        const status =
          signal.aborted || (error instanceof CommandExecutionError && error.started)
            ? "uncertain"
            : "failed";
        attempts.set(
          node.id,
          this.store.finishAttempt(
            run.id,
            token,
            attempt.id,
            status,
            partial as Json | undefined,
            message,
          ),
        );
        return { status: status === "uncertain" ? "interrupted" : "failed", error: message };
      }
    }
    return { status: "succeeded" };
  }

  private async executeCondition(
    run: RunRecord,
    node: ConditionNode,
    token: string,
    previous: AttemptRecord | undefined,
    attempts: Map<string, AttemptRecord>,
    outputs: Values,
  ): Promise<ExecutionResult & { branch?: "then" | "else" }> {
    if (previous?.status === "succeeded") {
      const branch = (previous.output as { branch?: unknown } | undefined)?.branch;
      if (branch !== "then" && branch !== "else")
        return { status: "failed", error: `Condition ${node.id} has no recorded branch` };
      return { status: "succeeded", branch };
    }
    let test: Json;
    try {
      test = resolveValue(node.test, run.input, outputs);
      if (typeof test !== "boolean")
        throw new Error(`Condition ${node.id} must resolve to boolean`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempt = this.store.startAttempt(run.id, token, node.id, {
        test: node.test as Json,
      });
      attempts.set(
        node.id,
        this.store.finishAttempt(run.id, token, attempt.id, "failed", undefined, message),
      );
      return { status: "failed", error: message };
    }
    const attempt = this.store.startAttempt(run.id, token, node.id, { test });
    const branch = test ? "then" : "else";
    const output = { branch } as const;
    attempts.set(node.id, this.store.finishAttempt(run.id, token, attempt.id, "succeeded", output));
    outputs.set(node.id, output);
    return { status: "succeeded", branch };
  }

  close(): void {
    this.store.close();
  }
}

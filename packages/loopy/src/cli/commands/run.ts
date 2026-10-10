import { resolve } from "node:path";
import type { Json, Workflow } from "../../core/index.js";
import { localRunOptions, Registry } from "../../local/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { withLocalRuntime } from "../local-runtime.js";
import { promptInputs } from "../prompt.js";
import { executeRun } from "../run-execution.js";

function parseJson(text: string): Json {
  const value: Json = JSON.parse(text);

  return value;
}

async function readJsonFile(path: string): Promise<Json> {
  return parseJson(await Bun.file(resolve(path)).text());
}

/** Named flags, --args, --input, or an interactive prompt; args.ts guarantees at most one. */
async function resolveInput(workflow: Workflow, context: CliContext): Promise<Json> {
  const { values, triggerInput } = context;

  if (values.args !== undefined) {
    return readJsonFile(values.args);
  }

  if (values.input !== undefined) {
    return values.input.startsWith("@")
      ? readJsonFile(values.input.slice(1))
      : parseJson(values.input);
  }

  const supplied = triggerInput ?? {};
  const interactive = process.stdin.isTTY && process.stderr.isTTY;

  return interactive ? promptInputs(workflow, supplied) : supplied;
}

export async function runRun(context: CliContext): Promise<void> {
  const { home, cwd, values } = context;
  const saved = new Registry(home, cwd).get(requireTarget(context, "Slug"));
  const input = await resolveInput(saved.workflow, context);

  const options = {
    ...localRunOptions(cwd, values.full ? "full" : "sandbox"),
    secretBindings: saved.secretBindings,
  };

  await withLocalRuntime(home, async ({ runtime }) => {
    const run = await runtime.createRun(saved.workflow, input, options);
    await executeRun(runtime, run.id, values["retry-uncertain"]);
  });
}

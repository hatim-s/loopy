import type { JsonObject } from "@loopy/contracts";
import type { CodexCommandOptions } from "./types.js";

export type ProviderCommand = {
  executable: string;
  args: readonly string[];
};

function nonEmpty(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.includes("\0"))
    throw new Error(`${name} must be non-empty and NUL-free`);
  return value;
}

function schemaArg(schema: string | JsonObject): string {
  return typeof schema === "string" ? schema : JSON.stringify(schema);
}

/** Build argv for the installed Codex CLI. Values stay separate argv entries (never shell interpolated). */
export function buildCodexCommand(options: CodexCommandOptions = {}): ProviderCommand {
  const executable = nonEmpty(options.executable ?? "codex", "executable") ?? "codex";
  const prompt = nonEmpty(options.prompt, "prompt");
  const model = nonEmpty(options.model, "model");
  const cwd = nonEmpty(options.cwd, "cwd");
  const resume = nonEmpty(options.resumeSessionId, "resumeSessionId");
  const args: string[] = ["exec"];
  if (resume !== undefined) args.push("resume", resume);
  args.push("--json");
  if (options.outputSchema !== undefined)
    args.push("--output-schema", schemaArg(options.outputSchema));
  if (options.sandbox !== undefined) args.push("--sandbox", options.sandbox);
  if (model !== undefined) args.push("--model", model);
  if (cwd !== undefined) args.push("--cd", cwd);
  if (prompt !== undefined) args.push("--", prompt);
  return { executable, args };
}

export const buildCodexExecCommand = buildCodexCommand;

import type { ClaudeCommandOptions } from "./types.js";

export type ProviderCommand = { executable: string; args: readonly string[] };

function value(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.includes("\0"))
    throw new Error(`${name} must be non-empty and NUL-free`);
  return value;
}

function csv(values: string[] | undefined, name: string): string | undefined {
  if (values === undefined) return undefined;
  if (values.some((item) => item.length === 0 || item.includes("\0")))
    throw new Error(`${name} entries must be non-empty and NUL-free`);
  return values.join(",");
}

/** Build argv for Claude's documented print/stream-json surface; no shell command is ever assembled. */
export function buildClaudeCommand(options: ClaudeCommandOptions): ProviderCommand {
  const executable = value(options.executable ?? "claude", "executable") ?? "claude";
  const prompt = value(options.prompt, "prompt");
  if (prompt === undefined) throw new Error("prompt is required");
  const args: string[] = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (options.model !== undefined) args.push("--model", value(options.model, "model") as string);
  if (options.maxTurns !== undefined) {
    if (!Number.isInteger(options.maxTurns) || options.maxTurns <= 0)
      throw new Error("maxTurns must be a positive integer");
    args.push("--max-turns", String(options.maxTurns));
  }
  if (options.maxBudgetUsd !== undefined) {
    if (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd <= 0)
      throw new Error("maxBudgetUsd must be positive");
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }
  const tools = csv(options.tools, "tools");
  const allowed = csv(options.allowedTools, "allowedTools");
  const disallowed = csv(options.disallowedTools, "disallowedTools");
  if (tools !== undefined) args.push("--tools", tools);
  if (allowed !== undefined) args.push("--allowedTools", allowed);
  if (disallowed !== undefined) args.push("--disallowedTools", disallowed);
  if (options.permissionMode !== undefined) args.push("--permission-mode", options.permissionMode);
  if (options.sessionId !== undefined)
    args.push("--session-id", value(options.sessionId, "sessionId") as string);
  if (options.resumeSessionId !== undefined)
    args.push("--resume", value(options.resumeSessionId, "resumeSessionId") as string);
  if (options.forwardSubagentText === true) args.push("--forward-subagent-text");
  return { executable, args };
}

export const buildClaudePrintCommand = buildClaudeCommand;

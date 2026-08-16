import type { PiCommand, PiRunRequest } from "./types.js";
import { ensureArg, listArg } from "./util.js";

function option(args: string[], flag: string, value: string | undefined): void {
  if (value === undefined) return;
  ensureArg(value, flag);
  args.push(flag, value);
}

export function buildPiRunCommand(request: PiRunRequest): PiCommand {
  ensureArg(request.prompt, "prompt");
  if (request.noTools && (request.tools?.length || request.excludeTools?.length))
    throw new TypeError("Pi --no-tools cannot be combined with tool lists.");
  const args = ["--print", "--mode", "json"];
  option(args, "--provider", request.provider);
  option(args, "--model", request.model);
  option(args, "--thinking", request.thinking);
  option(args, "--session-id", request.sessionId);
  option(args, "--session-dir", request.sessionDir);
  const tools = listArg(request.tools, "tools");
  const excluded = listArg(request.excludeTools, "excludeTools");
  option(args, "--tools", tools);
  option(args, "--exclude-tools", excluded);
  if (request.noTools) args.push("--no-tools");
  if (request.noExtensions) args.push("--no-extensions");
  if (request.noSkills) args.push("--no-skills");
  if (request.noContextFiles) args.push("--no-context-files");
  // Safe default is no approval. A broad approval flag must be explicit in
  // the policy supplied by the caller.
  args.push(request.approval === "approve" ? "--approve" : "--no-approve");
  if (request.offline) args.push("--offline");
  args.push(request.prompt);
  return { executable: "pi", args };
}

export const createPiRunCommand = buildPiRunCommand;

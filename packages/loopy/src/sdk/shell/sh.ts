import { parseArgv } from "../../core/index.js";
import { command } from "../ambient.js";
import type { CommandOptions } from "../define-command.js";

async function execute(key: string, argv: readonly string[], options: CommandOptions = {}) {
  const [program, ...args] = argv;

  if (!program) {
    throw new Error("Command is empty. Supply a program followed by its arguments.");
  }

  return command(
    key,
    { program, args, cwd: options.cwd, env: options.env, stdin: options.stdin },
    options,
  );
}

async function run(line: string, options?: CommandOptions) {
  return execute("sh.run", parseArgv(line), options);
}

async function exec(argv: readonly string[], options?: CommandOptions) {
  return execute("sh.exec", argv, options);
}

export const sh = { run, exec };

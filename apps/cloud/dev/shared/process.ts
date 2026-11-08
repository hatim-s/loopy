import { DOCKER_CONTEXT, root } from "../stack/constants";
import { assert } from "./assert";

type CommandOptions = { env: Record<string, string | undefined>; timeoutMs?: number };

export async function command(argv: string[], options: CommandOptions) {
  const child = Bun.spawn(argv, { cwd: root, env: options.env, stdout: "pipe", stderr: "pipe" });

  const timer =
    options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill(), options.timeoutMs);

  try {
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    assert(exitCode === 0, "owned_command_failed", { program: argv[0] ?? "", exitCode });

    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

export function docker(args: string[], options: CommandOptions) {
  return command(["docker", "--context", DOCKER_CONTEXT, ...args], options);
}

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Data, Effect } from "effect";
import { spawnCaptured } from "../../os";

export class DaemonInstallError extends Data.TaggedError("DaemonInstallError")<{
  message: string;
  cause?: unknown;
}> {}

const installIO = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new DaemonInstallError({ message: "Daemon service file operation failed.", cause }),
  });

export type DaemonExecResult = { code: number; stdout: string; stderr: string };

export type DaemonOperations = {
  writeFile: (path: string, content: string | undefined) => Effect.Effect<void, DaemonInstallError>;
  exec: (argv: string[]) => Effect.Effect<DaemonExecResult, DaemonInstallError>;
};

export const daemonOperations: DaemonOperations = {
  writeFile: (path, content) =>
    Effect.gen(function* () {
      if (content === undefined) {
        yield* installIO(() => rm(path, { force: true }));

        return;
      }

      yield* installIO(() => mkdir(dirname(path), { recursive: true }));
      yield* installIO(() => writeFile(path, content));
    }),
  exec: (argv) =>
    Effect.gen(function* () {
      const [program, ...args] = argv;

      if (!program) {
        return yield* Effect.fail(new DaemonInstallError({ message: "Service command is empty." }));
      }

      const result = yield* spawnCaptured(
        { program, args, cwd: process.cwd(), env: process.env },
        { timeoutMs: 30000, maxOutputBytes: 1024 * 1024 },
        undefined,
        performance.now(),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new DaemonInstallError({
              message:
                "Daemon service command failed. Inspect the service manager before retrying.",
              cause,
            }),
        ),
      );

      return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    }),
};

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unitQuote(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

export function daemonPlist(home: string, command: readonly string[], path: string): string {
  const log = xml(join(home, "logs/daemon.log"));

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.loopy.daemon</string>
<key>ProgramArguments</key><array>${command.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>WorkingDirectory</key><string>${xml(home)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
<key>StandardOutPath</key><string>${log}</string>
<key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}

export function daemonUnit(home: string, command: readonly string[], path: string): string {
  return `[Unit]
Description=Loopy daemon

[Service]
ExecStart=${command.map((arg) => unitQuote(arg.replaceAll("$", () => "$$"))).join(" ")}
Restart=always
WorkingDirectory=${home.replaceAll("%", "%%")}
Environment=${unitQuote(`LOOPY_HOME=${home}`)} ${unitQuote(`PATH=${path}`)}
StandardOutput=append:${join(home, "logs/daemon.log").replaceAll("%", "%%")}
StandardError=append:${join(home, "logs/daemon.log").replaceAll("%", "%%")}

[Install]
WantedBy=default.target
`;
}

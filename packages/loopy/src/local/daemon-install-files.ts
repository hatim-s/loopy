import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type DaemonExecResult = { code: number; stdout: string; stderr: string };

export type DaemonOperations = {
  /** Undefined content removes the file. Writing content creates parent directories. */
  writeFile: (path: string, content: string | undefined) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  exec: (argv: string[]) => Promise<DaemonExecResult>;
};

export const daemonOperations: DaemonOperations = {
  writeFile: async (path, content) => {
    if (content === undefined) {
      await rm(path, { force: true });

      return;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  },
  exists: async (path) => existsSync(path),
  exec: async (argv) => {
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });

    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    return { code, stdout, stderr };
  },
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

export function daemonPlist(home: string, command: string[], path: string): string {
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

export function daemonUnit(home: string, command: string[], path: string): string {
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

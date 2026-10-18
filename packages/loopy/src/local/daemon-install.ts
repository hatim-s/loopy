import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

type ServiceOptions = {
  platform?: "darwin" | "linux";
  userHome?: string;
  uid: number;
};

type InstallOptions = ServiceOptions & {
  home: string;
  executable: string;
  args?: string[];
  path?: string;
};

function service(options: ServiceOptions) {
  const platform = options.platform ?? process.platform;

  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(
      "Daemon services require macOS or Linux. Run loopy daemon run under a supervisor.",
    );
  }

  const root = options.userHome ?? homedir();

  return {
    platform,
    target: `gui/${options.uid}/com.loopy.daemon`,
    file:
      platform === "darwin"
        ? join(root, "Library/LaunchAgents/com.loopy.daemon.plist")
        : join(root, ".config/systemd/user/loopy-daemon.service"),
  };
}

type Service = ReturnType<typeof service>;

async function checked(argv: string[]) {
  const result = await exec(argv);

  if (result.code !== 0) {
    throw new Error(
      `${argv.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || result.code}. Check your user service manager and retry.`,
    );
  }

  return result;
}

async function startService(target: Service): Promise<void> {
  if (target.platform === "linux") {
    await checked(["systemctl", "--user", "daemon-reload"]);
    await checked(["systemctl", "--user", "enable", "--now", "loopy-daemon.service"]);
    await checked(["systemctl", "--user", "restart", "loopy-daemon.service"]);

    return;
  }

  // bootout fails when nothing is loaded yet; bootstrap reports any real problem.
  await exec(["launchctl", "bootout", target.target]);
  const domain = target.target.slice(0, target.target.lastIndexOf("/"));
  await checked(["launchctl", "bootstrap", domain, target.file]);
}

function validateInstall(options: InstallOptions, path: string): void {
  if (!isAbsolute(options.home) || !isAbsolute(options.executable)) {
    throw new Error(
      "Daemon paths must be absolute. Resolve the home and executable before installing.",
    );
  }

  if (
    [options.home, options.executable, ...(options.args ?? []), path].some((value) =>
      /[\0\r\n]/.test(value),
    )
  ) {
    throw new Error(
      "Service values cannot contain NUL or line breaks. Use paths and arguments without these characters.",
    );
  }
}

export async function installDaemon(options: InstallOptions): Promise<void> {
  const target = service(options);

  const path = options.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  validateInstall(options, path);

  const command = [
    options.executable,
    ...(options.args ?? []),
    "daemon",
    "run",
    "--home",
    options.home,
  ];

  await mkdir(join(options.home, "logs"), { recursive: true });

  const content =
    target.platform === "darwin"
      ? daemonPlist(options.home, command, path)
      : daemonUnit(options.home, command, path);

  await write(target.file, content);
  await startService(target);
}

async function stopMacService(target: Service): Promise<void> {
  const result = await exec(["launchctl", "bootout", target.target]);

  // 3 and 113 mean the service was not loaded, which is what uninstall wants.
  if (![0, 3, 113].includes(result.code)) {
    throw new Error(
      `launchctl bootout ${target.target} failed: ${result.stderr.trim() || result.code}. The plist has been kept.`,
    );
  }
}

export async function uninstallDaemon(options: ServiceOptions): Promise<void> {
  const target = service(options);

  if (target.platform === "darwin") {
    await stopMacService(target);
  } else {
    const result = await exec(["systemctl", "--user", "disable", "--now", "loopy-daemon.service"]);

    if (result.code !== 0 && result.code !== 5) {
      throw new Error(
        "Cannot disable the daemon. Check systemctl --user status loopy-daemon.service and retry.",
      );
    }
  }

  await rm(target.file, { force: true });

  if (target.platform === "linux") {
    await checked(["systemctl", "--user", "daemon-reload"]);
  }
}

async function write(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function exec(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { code, stdout, stderr };
}

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

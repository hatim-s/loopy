import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  type DaemonOperations,
  daemonOperations,
  daemonPlist,
  daemonUnit,
} from "./daemon-install-files.js";

type ServiceOptions = {
  platform?: string;
  userHome?: string;
  uid?: number;
  operations?: DaemonOperations;
};

type InstallOptions = ServiceOptions & {
  home: string;
  executable: string;
  args?: string[];
  path?: string;
};

export type DaemonStatus = { state: "running" | "stopped" | "not-installed"; pid?: number };

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
    target: `gui/${options.uid ?? process.getuid?.() ?? 0}/com.loopy.daemon`,
    file:
      platform === "darwin"
        ? join(root, "Library/LaunchAgents/com.loopy.daemon.plist")
        : join(root, ".config/systemd/user/loopy-daemon.service"),
    operations: options.operations ?? daemonOperations,
  };
}

type Service = ReturnType<typeof service>;

async function checked(target: Service, argv: string[]) {
  const result = await target.operations.exec(argv);

  if (result.code !== 0) {
    throw new Error(
      `${argv.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || result.code}. Check your user service manager and retry.`,
    );
  }

  return result;
}

async function startService(target: Service): Promise<void> {
  if (target.platform === "linux") {
    await checked(target, ["systemctl", "--user", "daemon-reload"]);
    await checked(target, ["systemctl", "--user", "enable", "--now", "loopy-daemon.service"]);
    await checked(target, ["systemctl", "--user", "restart", "loopy-daemon.service"]);

    return;
  }

  await target.operations.exec(["launchctl", "bootout", target.target]);
  const domain = target.target.slice(0, target.target.lastIndexOf("/"));
  const result = await target.operations.exec(["launchctl", "bootstrap", domain, target.file]);

  if (result.code !== 0) {
    await target.operations.exec(["launchctl", "unload", "-w", target.file]);
    await checked(target, ["launchctl", "load", "-w", target.file]);
  }
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

  // Create the log directory through the same file seam without truncating existing logs.
  await target.operations.writeFile(join(options.home, "logs/.daemon"), "");

  const content =
    target.platform === "darwin"
      ? daemonPlist(options.home, command, path)
      : daemonUnit(options.home, command, path);

  await target.operations.writeFile(target.file, content);
  await startService(target);
}

export async function uninstallDaemon(options: ServiceOptions = {}): Promise<void> {
  const target = service(options);

  if (target.platform === "darwin") {
    const result = await target.operations.exec(["launchctl", "bootout", target.target]);

    if (![0, 3, 113].includes(result.code)) {
      await checked(target, ["launchctl", "unload", "-w", target.file]);
    }
  } else {
    const result = await target.operations.exec([
      "systemctl",
      "--user",
      "disable",
      "--now",
      "loopy-daemon.service",
    ]);

    if (result.code !== 0 && result.code !== 5) {
      throw new Error(
        "Cannot disable the daemon. Check systemctl --user status loopy-daemon.service and retry.",
      );
    }
  }

  await target.operations.writeFile(target.file, undefined);

  if (target.platform === "linux") {
    await checked(target, ["systemctl", "--user", "daemon-reload"]);
  }
}

function status(state: DaemonStatus["state"], output: string): DaemonStatus {
  const pid = Number(/(?:pid\s*=\s*|MainPID=)(\d+)/.exec(output)?.[1]);

  if (state === "running" && pid > 0) {
    return { state, pid };
  }

  return { state };
}

export async function daemonStatus(options: ServiceOptions = {}): Promise<DaemonStatus> {
  const target = service(options);

  if (target.platform === "darwin") {
    const result = await target.operations.exec(["launchctl", "print", target.target]);

    if (result.code === 113) {
      return { state: "not-installed" };
    }

    if (result.code !== 0) {
      throw new Error(
        "Cannot inspect the daemon. Check launchctl print for your user session and retry.",
      );
    }

    return status(/state = running\b/.test(result.stdout) ? "running" : "stopped", result.stdout);
  }

  return linuxStatus(target);
}

async function linuxStatus(target: Service): Promise<DaemonStatus> {
  const name = "loopy-daemon.service";
  const active = await target.operations.exec(["systemctl", "--user", "is-active", name]);

  const info = await target.operations.exec([
    "systemctl",
    "--user",
    "show",
    "-p",
    "MainPID",
    "-p",
    "LoadState",
    name,
  ]);

  if (/^LoadState=not-found$/m.test(info.stdout)) {
    return { state: "not-installed" };
  }

  if (
    info.code !== 0 ||
    !/^LoadState=loaded$/m.test(info.stdout) ||
    ![0, 3].includes(active.code)
  ) {
    throw new Error(
      "Cannot inspect the daemon. Check systemctl --user status loopy-daemon.service and retry.",
    );
  }

  return status(active.stdout.trim() === "active" ? "running" : "stopped", info.stdout);
}

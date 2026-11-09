import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect } from "effect";
import {
  DaemonInstallError,
  type DaemonOperations,
  daemonOperations,
  daemonPlist,
  daemonUnit,
} from "./install-files";

type ServiceOptions = {
  platform?: string;
  userHome?: string;
  uid?: number;
  operations?: DaemonOperations;
};

type InstallOptions = ServiceOptions & {
  home: string;
  /** The complete service argv; the first entry is the absolute executable. */
  command: readonly [string, ...string[]];
  path?: string;
};

const service = Effect.fn(function* (options: ServiceOptions) {
  const platform = options.platform ?? process.platform;

  if (platform !== "darwin" && platform !== "linux") {
    return yield* Effect.fail(
      new DaemonInstallError({
        message: "Daemon services require macOS or Linux. Run loopy daemon run under a supervisor.",
      }),
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
});

type Service = Effect.Success<ReturnType<typeof service>>;

function checked(target: Service, argv: string[]) {
  return Effect.gen(function* () {
    const result = yield* target.operations.exec(argv);

    if (result.code !== 0) {
      return yield* Effect.fail(
        new DaemonInstallError({
          message: `${argv.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || result.code}. Check your user service manager and retry.`,
        }),
      );
    }

    return result;
  });
}

function startService(target: Service) {
  return Effect.gen(function* () {
    if (target.platform === "linux") {
      yield* checked(target, ["systemctl", "--user", "daemon-reload"]);
      yield* checked(target, ["systemctl", "--user", "enable", "--now", "loopy-daemon.service"]);
      yield* checked(target, ["systemctl", "--user", "restart", "loopy-daemon.service"]);

      return;
    }

    yield* target.operations.exec(["launchctl", "bootout", target.target]);
    const domain = target.target.slice(0, target.target.lastIndexOf("/"));
    const result = yield* target.operations.exec(["launchctl", "bootstrap", domain, target.file]);

    if (result.code !== 0) {
      yield* target.operations.exec(["launchctl", "unload", "-w", target.file]);
      yield* checked(target, ["launchctl", "load", "-w", target.file]);
      const loaded = yield* target.operations.exec(["launchctl", "print", target.target]);

      if (loaded.code !== 0) {
        return yield* Effect.fail(
          new DaemonInstallError({
            message: `Daemon did not load. Check launchctl print ${target.target} and the daemon logs, then retry installation.`,
          }),
        );
      }
    }
  });
}

const validateInstall = Effect.fn(function* (options: InstallOptions, path: string) {
  if (!isAbsolute(options.home) || !isAbsolute(options.command[0])) {
    return yield* Effect.fail(
      new DaemonInstallError({
        message:
          "Daemon paths must be absolute. Resolve the home and executable before installing.",
      }),
    );
  }

  if ([options.home, ...options.command, path].some((value) => /[\0\r\n]/.test(value))) {
    return yield* Effect.fail(
      new DaemonInstallError({
        message:
          "Service values cannot contain NUL or line breaks. Use paths and arguments without these characters.",
      }),
    );
  }
});

export function installDaemon(options: InstallOptions) {
  return Effect.gen(function* () {
    const target = yield* service(options);
    const path = options.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
    yield* validateInstall(options, path);

    // Create the log directory through the same file seam without truncating existing logs.
    yield* target.operations.writeFile(join(options.home, "logs/.daemon"), "");

    const content =
      target.platform === "darwin"
        ? daemonPlist(options.home, options.command, path)
        : daemonUnit(options.home, options.command, path);

    yield* target.operations.writeFile(target.file, content);
    yield* startService(target);
  });
}

function stopMacService(target: Service) {
  return Effect.gen(function* () {
    const result = yield* target.operations.exec(["launchctl", "bootout", target.target]);

    if ([0, 3, 113].includes(result.code)) {
      return;
    }

    yield* checked(target, ["launchctl", "unload", "-w", target.file]);
    const loaded = yield* target.operations.exec(["launchctl", "print", target.target]);

    if (loaded.code !== 113) {
      return yield* Effect.fail(
        new DaemonInstallError({
          message: `Cannot confirm the daemon was unloaded. Check launchctl print ${target.target} and retry uninstallation. The plist has been kept.`,
        }),
      );
    }
  });
}

export function uninstallDaemon(options: ServiceOptions = {}) {
  return Effect.gen(function* () {
    const target = yield* service(options);

    if (target.platform === "darwin") {
      yield* stopMacService(target);
    } else {
      const result = yield* target.operations.exec([
        "systemctl",
        "--user",
        "disable",
        "--now",
        "loopy-daemon.service",
      ]);

      if (result.code !== 0 && result.code !== 5) {
        return yield* Effect.fail(
          new DaemonInstallError({
            message:
              "Cannot disable the daemon. Check systemctl --user status loopy-daemon.service and retry.",
          }),
        );
      }
    }

    yield* target.operations.writeFile(target.file, undefined);

    if (target.platform === "linux") {
      yield* checked(target, ["systemctl", "--user", "daemon-reload"]);
    }
  });
}

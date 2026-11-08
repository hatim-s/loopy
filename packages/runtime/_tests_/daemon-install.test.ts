import { expect, test } from "bun:test";
import { Effect } from "effect";
import { serviceSpec } from "../src/local/daemon/install";
import type { DaemonExecResult, DaemonOperations } from "../src/local/daemon/install-files";
import { launchdManager, systemdManager } from "../src/local/daemon/managers";

const plist = "/users/test/Library/LaunchAgents/com.loopy.daemon.plist";

const unit = "/users/test/.config/systemd/user/loopy-daemon.service";

const target = "gui/501/com.loopy.daemon";

const ok = { code: 0, stdout: "", stderr: "" };

function fixture(platform: "darwin" | "linux", replies: DaemonExecResult[] = []) {
  const command: [string, ...string[]] = ["/opt/bun", "/opt/loopy/cli.js", "daemon", "run"];
  const files = new Map<string, string>();
  const commands: string[][] = [];

  const operations: DaemonOperations = {
    makeDirectory: () => Effect.void,
    writeFile: (path, content) =>
      Effect.sync(() => {
        files.set(path, content);
      }),
    removeFile: (path) =>
      Effect.sync(() => {
        files.delete(path);
      }),
    exec: (argv) =>
      Effect.sync(() => {
        commands.push(argv);

        return replies.shift() ?? ok;
      }),
  };

  const manager =
    platform === "darwin"
      ? launchdManager({ userHome: "/users/test", uid: 501, operations })
      : systemdManager({ userHome: "/users/test", operations });

  return {
    files,
    commands,
    operations,
    manager,
    spec: { home: "/data/loopy", command, path: "/opt/bin:/usr/bin" },
  };
}

test("macOS plist retains absolute argv, environment, working directory and log paths", async () => {
  const { manager, spec, files, commands } = fixture("darwin");
  await Effect.runPromise(
    manager.install({
      ...spec,
      home: "/data/hatim & loopy",
      command: ["/opt/bun", "/opt/cli.js", "--home", "/data/hatim & loopy", "daemon", "run"],
    }),
  );
  const content = files.get(plist);
  expect(content).toContain("<key>Label</key><string>com.loopy.daemon</string>");
  expect(content).toContain(
    "<array><string>/opt/bun</string><string>/opt/cli.js</string><string>--home</string><string>/data/hatim &amp; loopy</string><string>daemon</string><string>run</string></array>",
  );
  expect(content).toContain("<key>RunAtLoad</key><true/>");
  expect(content).toContain("<key>KeepAlive</key><true/>");
  expect(content).toContain("<key>WorkingDirectory</key><string>/data/hatim &amp; loopy</string>");
  expect(content).toContain("<key>PATH</key><string>/opt/bin:/usr/bin</string>");

  for (const key of ["StandardOutPath", "StandardErrorPath"]) {
    expect(content).toContain(
      `<key>${key}</key><string>/data/hatim &amp; loopy/logs/daemon.log</string>`,
    );
  }

  expect(commands).toEqual([
    ["launchctl", "bootout", target],
    ["launchctl", "bootstrap", "gui/501", plist],
  ]);
});

test("Linux unit escapes command expansion and supplies environment and persistent logs", async () => {
  const { manager, spec, files, commands } = fixture("linux");
  await Effect.runPromise(
    manager.install({
      ...spec,
      home: "/data/loopy % $HOME",
      command: ["/opt/bun", "/opt/cli with spaces.js", "--home", "/data/loopy % $HOME"],
    }),
  );
  const content = files.get(unit);
  expect(content).toContain(
    'ExecStart="/opt/bun" "/opt/cli with spaces.js" "--home" "/data/loopy %% $$HOME"',
  );
  expect(content).toContain("Restart=always");
  expect(content).toContain("WorkingDirectory=/data/loopy %% $HOME");
  expect(content).toContain(
    'Environment="LOOPY_HOME=/data/loopy %% $HOME" "PATH=/opt/bin:/usr/bin"',
  );
  expect(content).toContain("StandardOutput=append:/data/loopy %% $HOME/logs/daemon.log");
  expect(content).toContain("StandardError=append:/data/loopy %% $HOME/logs/daemon.log");
  expect(commands).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "loopy-daemon.service"],
    ["systemctl", "--user", "restart", "loopy-daemon.service"],
  ]);
});

for (const platform of ["darwin", "linux"] as const) {
  test(`${platform} reinstall overwrites the same definition and restarts`, async () => {
    const { manager, spec, files, commands } = fixture(platform);
    await Effect.runPromise(manager.install(spec));
    const first = commands.splice(0);
    await Effect.runPromise(
      manager.install({ ...spec, command: ["/new/bun", "/opt/loopy/cli.js"] }),
    );
    expect(files.size).toBe(1);
    expect(files.get(platform === "darwin" ? plist : unit)).toContain("/new/bun");
    expect(commands).toEqual(first);
  });
  test(`${platform} uninstall removes the definition after stopping`, async () => {
    const { manager, spec, files, commands } = fixture(platform);
    await Effect.runPromise(manager.install(spec));
    commands.splice(0);
    await Effect.runPromise(manager.uninstall);
    expect(files.has(platform === "darwin" ? plist : unit)).toBe(false);
    expect(commands).toEqual(
      platform === "darwin"
        ? [["launchctl", "bootout", target]]
        : [
            ["systemctl", "--user", "disable", "--now", "loopy-daemon.service"],
            ["systemctl", "--user", "daemon-reload"],
          ],
    );
  });
}

test("older launchctl falls back to unload and load -w", async () => {
  const { manager, spec, commands } = fixture("darwin", [ok, { ...ok, code: 1 }]);
  await Effect.runPromise(manager.install(spec));
  expect(commands).toEqual([
    ["launchctl", "bootout", target],
    ["launchctl", "bootstrap", "gui/501", plist],
    ["launchctl", "unload", "-w", plist],
    ["launchctl", "load", "-w", plist],
    ["launchctl", "print", target],
  ]);
});

test("install rejects relative paths and line injection before writing", async () => {
  const { spec } = fixture("linux");
  await expect(
    Effect.runPromise(serviceSpec({ ...spec, command: ["bun", "/opt/loopy/cli.js"] }, spec.path)),
  ).rejects.toThrow("Daemon paths must be absolute.");
  await expect(
    Effect.runPromise(serviceSpec({ ...spec, home: "/data/loopy\nRestart=no" }, spec.path)),
  ).rejects.toThrow("Service values cannot contain NUL or line breaks.");
  await expect(Effect.runPromise(serviceSpec(spec, "/bin\n/evil"))).rejects.toThrow(
    "Service values cannot contain NUL or line breaks.",
  );
  expect(await Effect.runPromise(serviceSpec(spec, spec.path))).toEqual(spec);
});

test("failed install and uninstall report errors without deleting the definition", async () => {
  const failed = fixture("linux", [{ ...ok, code: 1, stderr: "No user bus" }]);
  await expect(Effect.runPromise(failed.manager.install(failed.spec))).rejects.toThrow(
    "Check your user service manager and retry.",
  );
  expect(failed.commands).toEqual([["systemctl", "--user", "daemon-reload"]]);
  const installed = fixture("linux");
  await Effect.runPromise(installed.manager.install(installed.spec));
  installed.operations.exec = () => Effect.succeed({ ...ok, code: 1 });
  await expect(Effect.runPromise(installed.manager.uninstall)).rejects.toThrow(
    "Cannot disable the daemon.",
  );
  expect(installed.files.has(unit)).toBe(true);
});

test("older launchctl uninstall uses unload when bootout is unavailable", async () => {
  const { manager, commands, files } = fixture("darwin", [
    { ...ok, code: 1 },
    ok,
    { ...ok, code: 113 },
  ]);

  files.set(plist, "installed");
  await Effect.runPromise(manager.uninstall);
  expect(files.has(plist)).toBe(false);
  expect(commands).toEqual([
    ["launchctl", "bootout", target],
    ["launchctl", "unload", "-w", plist],
    ["launchctl", "print", target],
  ]);
});

test("zero-exit load rejects when the service remains unloaded", async () => {
  const { manager, spec, commands } = fixture("darwin", [
    ok,
    { ...ok, code: 1 },
    ok,
    ok,
    { ...ok, code: 113 },
  ]);

  await expect(Effect.runPromise(manager.install(spec))).rejects.toThrow(
    `Daemon did not load. Check launchctl print ${target} and the daemon logs, then retry installation.`,
  );
  expect(commands.at(-1)).toEqual(["launchctl", "print", target]);
});

test("zero-exit unload keeps the plist when the service remains loaded", async () => {
  const { manager, files, commands } = fixture("darwin", [{ ...ok, code: 1 }, ok, ok]);
  files.set(plist, "installed");
  await expect(Effect.runPromise(manager.uninstall)).rejects.toThrow(
    `Cannot confirm the daemon was unloaded. Check launchctl print ${target} and retry uninstallation. The plist has been kept.`,
  );
  expect(files.get(plist)).toBe("installed");
  expect(commands.at(-1)).toEqual(["launchctl", "print", target]);
});

import { expect, test } from "bun:test";
import { parseCliArgs } from "../src/cli/args.js";
import { daemonStatus, installDaemon, uninstallDaemon } from "../src/local/daemon-install.js";
import type { DaemonExecResult, DaemonOperations } from "../src/local/daemon-install-files.js";

const plist = "/users/test/Library/LaunchAgents/com.loopy.daemon.plist";

const unit = "/users/test/.config/systemd/user/loopy-daemon.service";

const target = "gui/501/com.loopy.daemon";

const ok = { code: 0, stdout: "", stderr: "" };

function fixture(platform: string, replies: DaemonExecResult[] = []) {
  const files = new Map<string, string>();
  const commands: string[][] = [];

  const operations: DaemonOperations = {
    writeFile: async (path, content) => {
      if (content === undefined) {
        files.delete(path);

        return;
      }

      files.set(path, content);
    },
    exec: async (argv) => {
      commands.push(argv);

      return replies.shift() ?? ok;
    },
  };

  return {
    files,
    commands,
    options: {
      platform,
      userHome: "/users/test",
      uid: 501,
      operations,
      home: "/data/loopy",
      executable: "/opt/bun",
      args: ["/opt/loopy/cli.js"],
      path: "/opt/bin:/usr/bin",
    },
  };
}

test("macOS plist retains absolute argv, environment, working directory and log paths", async () => {
  const { options, files, commands } = fixture("darwin");
  await installDaemon({
    ...options,
    home: "/data/hatim & loopy",
    args: ["/opt/cli.js", "--concurrency", "7"],
  });
  const content = files.get(plist);
  expect(content).toContain("<key>Label</key><string>com.loopy.daemon</string>");
  expect(content).toContain(
    "<array><string>/opt/bun</string><string>/opt/cli.js</string><string>--concurrency</string><string>7</string><string>daemon</string><string>run</string><string>--home</string><string>/data/hatim &amp; loopy</string></array>",
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
  const { options, files, commands } = fixture("linux");
  await installDaemon({
    ...options,
    home: "/data/loopy % $HOME",
    args: ["/opt/cli with spaces.js"],
  });
  const content = files.get(unit);
  expect(content).toContain(
    'ExecStart="/opt/bun" "/opt/cli with spaces.js" "daemon" "run" "--home" "/data/loopy %% $$HOME"',
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

for (const platform of ["darwin", "linux"]) {
  test(`${platform} reinstall overwrites the same definition and restarts`, async () => {
    const { options, files, commands } = fixture(platform);
    await installDaemon(options);
    const first = commands.splice(0);
    await installDaemon({ ...options, executable: "/new/bun" });
    expect(files.size).toBe(2);
    expect(files.get(platform === "darwin" ? plist : unit)).toContain("/new/bun");
    expect(commands).toEqual(first);
  });
  test(`${platform} uninstall removes the definition after stopping`, async () => {
    const { options, files, commands } = fixture(platform);
    await installDaemon(options);
    commands.splice(0);
    await uninstallDaemon(options);
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
  const { options, commands } = fixture("darwin", [ok, { ...ok, code: 1 }]);
  await installDaemon(options);
  expect(commands).toEqual([
    ["launchctl", "bootout", target],
    ["launchctl", "bootstrap", "gui/501", plist],
    ["launchctl", "unload", "-w", plist],
    ["launchctl", "load", "-w", plist],
  ]);
});

for (const item of [
  { code: 0, stdout: "state = running\n pid = 42", state: "running", pid: 42 },
  { code: 0, stdout: "state = waiting", state: "stopped" },
  { code: 113, stdout: "", state: "not-installed" },
] as const) {
  test(`launchctl status parses ${item.state}`, async () => {
    const { options, commands } = fixture("darwin", [{ ...ok, ...item }]);
    const expected = "pid" in item ? { state: item.state, pid: item.pid } : { state: item.state };
    expect(await daemonStatus(options)).toEqual(expected);
    expect(commands).toEqual([["launchctl", "print", target]]);
  });
}

for (const item of [
  {
    active: "active",
    code: 0,
    info: "MainPID=81\nLoadState=loaded\n",
    expected: { state: "running", pid: 81 },
  },
  {
    active: "inactive",
    code: 3,
    info: "MainPID=0\nLoadState=loaded\n",
    expected: { state: "stopped" },
  },
  {
    active: "failed",
    code: 3,
    info: "MainPID=0\nLoadState=loaded\n",
    expected: { state: "stopped" },
  },
  {
    active: "inactive",
    code: 4,
    info: "MainPID=0\nLoadState=not-found\n",
    expected: { state: "not-installed" },
  },
] as const) {
  test(`systemctl status parses ${item.active} / ${item.expected.state}`, async () => {
    const { options, commands } = fixture("linux", [
      { ...ok, code: item.code, stdout: item.active },
      { ...ok, stdout: item.info },
    ]);

    expect(await daemonStatus(options)).toEqual(item.expected);
    expect(commands).toEqual([
      ["systemctl", "--user", "is-active", "loopy-daemon.service"],
      ["systemctl", "--user", "show", "-p", "MainPID", "-p", "LoadState", "loopy-daemon.service"],
    ]);
  });
}

test("supervisor failures are errors rather than an absent service", async () => {
  const { options } = fixture("linux", [
    { ...ok, code: 1 },
    { ...ok, code: 1 },
  ]);

  await expect(daemonStatus(options)).rejects.toThrow(
    "Cannot inspect the daemon. Check systemctl --user status loopy-daemon.service and retry.",
  );
  const mac = fixture("darwin", [{ ...ok, code: 1 }]);
  await expect(daemonStatus(mac.options)).rejects.toThrow("Cannot inspect the daemon.");
});

test("unsupported platforms reject every service action without side effects", async () => {
  const { options, commands, files } = fixture("win32");

  for (const action of [installDaemon, uninstallDaemon, daemonStatus]) {
    await expect(action(options)).rejects.toThrow(
      "Daemon services require macOS or Linux. Run loopy daemon run under a supervisor.",
    );
  }

  expect(commands).toEqual([]);
  expect(files.size).toBe(0);
});

test("install rejects relative paths and line injection before writing", async () => {
  const { options, files } = fixture("linux");
  await expect(installDaemon({ ...options, executable: "bun" })).rejects.toThrow(
    "Daemon paths must be absolute.",
  );
  await expect(installDaemon({ ...options, home: "/data/loopy\nRestart=no" })).rejects.toThrow(
    "Service values cannot contain NUL or line breaks.",
  );
  expect(files.size).toBe(0);
});

test("install concurrency is parsed as a daemon option", () => {
  const result = parseCliArgs(["daemon", "install", "--concurrency", "7", "--home", "/data/loopy"]);
  expect(result.values.concurrency).toBe("7");
  expect(result.values.home).toBe("/data/loopy");
  expect(result.positionals).toEqual(["daemon", "install"]);
});

test("failed install and uninstall report errors without deleting the definition", async () => {
  const failed = fixture("linux", [{ ...ok, code: 1, stderr: "No user bus" }]);
  await expect(installDaemon(failed.options)).rejects.toThrow(
    "Check your user service manager and retry.",
  );
  expect(failed.commands).toEqual([["systemctl", "--user", "daemon-reload"]]);
  const installed = fixture("linux");
  await installDaemon(installed.options);
  installed.options.operations.exec = async () => ({ ...ok, code: 1 });
  await expect(uninstallDaemon(installed.options)).rejects.toThrow("Cannot disable the daemon.");
  expect(installed.files.has(unit)).toBe(true);
});

test("older launchctl uninstall uses unload when bootout is unavailable", async () => {
  const { options, commands } = fixture("darwin", [{ ...ok, code: 1 }]);
  await uninstallDaemon(options);
  expect(commands).toEqual([
    ["launchctl", "bootout", target],
    ["launchctl", "unload", "-w", plist],
  ]);
});

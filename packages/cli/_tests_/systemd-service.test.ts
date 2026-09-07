import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createLoginService, type ServiceCommand } from "../src/login-service";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(resolve(tmpdir(), "loopy-systemd-"));
  homes.push(home);
  const calls: string[][] = [];
  let enabled = false;
  let fail = "";
  const run: ServiceCommand = async (args) => {
    calls.push(args);
    if (args[0] === fail) return { code: 1, stderr: "injected failure" };
    if (args[0] === "is-enabled") return { code: enabled ? 0 : 1, stderr: "" };
    if (args[0] === "enable") enabled = true;
    if (args[0] === "disable") enabled = false;
    return { code: 0, stderr: "", stdout: "loaded\n" };
  };
  const service = createLoginService("/repo/A %test $HOME", {
    platform: "linux",
    home,
    configHome: resolve(home, "config"),
    run,
  });
  const config = {
    executable: "/usr/bin/bun",
    cli: "/repo/Loopy/index.ts",
    studioDir: "/repo/studio",
    path: "/bin:/usr/bin",
  };
  return {
    service,
    calls,
    config,
    fail: (action: string) => {
      fail = action;
    },
  };
}
test("systemd installs a user service with literal arguments and removes its registration", async () => {
  const { service, calls, config } = setup();
  const content = service.prepare(config);
  expect(content).toContain('ExecStart=:"/usr/bin/bun"');
  expect(content).toContain("/repo/A %%test $HOME");
  expect(content).toContain("KillMode=mixed");
  expect(content).toContain("Restart=on-failure");
  await service.install(content);
  expect(calls.map((call) => call[0])).toEqual(["daemon-reload", "enable", "start"]);
  expect(await service.status()).toMatchObject({ supported: true, enabled: true, loaded: true });
  await service.uninstall();
  expect(calls.at(-2)?.slice(0, 2)).toEqual(["disable", "--now"]);
  expect(service.installed()).toBe(false);
});
test("systemd rolls back a failed start and retains configuration after failed removal", async () => {
  const { service, config, fail } = setup();
  fail("start");
  await expect(service.install(service.prepare(config))).rejects.toThrow("injected failure");
  expect(service.installed()).toBe(false);
  fail("");
  await service.install(service.prepare(config));
  fail("disable");
  await expect(service.uninstall()).rejects.toThrow("injected failure");
  expect(service.installed()).toBe(true);
  expect(() => service.prepare({ ...config, path: "/new/bin" })).toThrow("Disable auto-start");
});
test("systemd rejects injected configuration lines before writing", () => {
  const { service, config, calls } = setup();
  expect(() => service.prepare({ ...config, path: "/bin\nExecStart=/bin/false" })).toThrow(
    "control characters",
  );
  expect(calls).toHaveLength(0);
  expect(service.installed()).toBe(false);
});

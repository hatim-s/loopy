import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createLoginService,
  type LoginConfiguration,
  type ServiceCommand,
} from "../src/login-service";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const config: LoginConfiguration = {
  executable: "/tools/Bun & bin/bun",
  cli: "/code/Loopy <dev>/index.ts",
  studioDir: "/code/Loopy <dev>/studio",
  path: "/tools/bin:/usr/bin:/bin",
  port: "4329",
};
function setup() {
  const home = mkdtempSync(resolve(tmpdir(), "loopy-login-unit-"));
  homes.push(home);
  const calls: string[][] = [];
  let loaded = false;
  let fail = "";
  const run: ServiceCommand = async (args) => {
    calls.push(args);
    if (args[0] === fail) return { code: 5, stderr: "injected failure" };
    if (args[0] === "print") return { code: loaded ? 0 : 113, stderr: "" };
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = false;
    return { code: 0, stderr: "" };
  };
  return {
    service: createLoginService("/project/One & two", { home, uid: 501, platform: "darwin", run }),
    calls,
    home,
    run,
    fail: (command: string) => {
      fail = command;
    },
  };
}

test("login registration preserves argv, omits secrets, and stops only its project service", async () => {
  const { service, calls } = setup();
  const definition = service.prepare(config);
  expect(definition).toContain("/tools/Bun &amp; bin/bun");
  expect(definition).toContain("/code/Loopy &lt;dev&gt;/index.ts");
  expect(definition).toContain("<key>SuccessfulExit</key><false/>");
  expect(definition).not.toContain("TOKEN");
  await service.install(definition);
  const status = await service.status();
  expect(status).toMatchObject({ supported: true, enabled: true, loaded: true });
  const file = status.file as string;
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toBe(definition);
  await service.install(definition);
  expect(calls.filter((args) => args[0] === "bootstrap")).toHaveLength(1);
  expect(calls.find((args) => args[0] === "kickstart")).toEqual([
    "kickstart",
    `gui/501/${status.label}`,
  ]);
  expect(() => service.prepare({ ...config, port: "4330" })).toThrow("Disable auto-start");
  await service.uninstall();
  expect(calls.at(-1)).toEqual(["bootout", `gui/501/${status.label}`]);
  expect(existsSync(file)).toBe(false);
  await service.uninstall();
});

test("failed registration rolls back its file and failed removal retains it", async () => {
  const { service, fail } = setup();
  fail("bootstrap");
  await expect(service.install(service.prepare(config))).rejects.toThrow("injected failure");
  expect(service.installed()).toBe(false);
  fail("");
  await service.install(service.prepare(config));
  fail("bootout");
  await expect(service.uninstall()).rejects.toThrow("injected failure");
  expect(service.installed()).toBe(true);
});

test("project registrations stay separate and unrecognized files remain untouched", async () => {
  const { service, home, run } = setup();
  await service.install(service.prepare(config));
  const file = (await service.status()).file as string;
  const second = createLoginService("/project/Other", { home, uid: 501, platform: "darwin", run });
  expect(second.installed()).toBe(false);
  writeFileSync(file, "unrelated file");
  await expect(service.uninstall()).rejects.toThrow("unrecognized");
  expect(readFileSync(file, "utf8")).toBe("unrelated file");
});

test("unsupported platforms and invalid configuration fail before registration", async () => {
  const { service, calls, home, run } = setup();
  const linux = createLoginService("/project", { home, platform: "linux", run });
  expect(await linux.status()).toEqual({ supported: false, enabled: false, loaded: false });
  expect(() => linux.prepare(config)).toThrow("macOS only");
  await expect(linux.uninstall()).rejects.toThrow("macOS only");
  expect(() => service.prepare({ ...config, cli: "/invalid\u0000path" })).toThrow(
    "control characters",
  );
  expect(() => service.prepare({ ...config, port: "70000" })).toThrow("port");
  expect(calls).toHaveLength(0);
});

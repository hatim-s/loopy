import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stop } from "../stack";
import { parseServeIdentity, type StackSelection, supervisorArguments } from "../stack-identity";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function freshLaunch() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopy-stop-identity-")));
  roots.push(root);

  const selection: StackSelection = {
    root,
    state: join(root, ".loopy/playground-architecture"),
    profile: "architecture",
  };

  const identity = { ...selection, nonce: crypto.randomUUID() };
  const argv = [process.execPath, ...supervisorArguments(identity)];
  const manifest = { version: 2, owner: 424242, pgid: 424242, identity, argv };
  const observation = { pid: manifest.owner, pgid: manifest.pgid, command: argv.join(" ") };
  const signals: number[] = [];
  const observations: number[] = [];

  const control = {
    selection,
    manifestPath: join(root, "processes.json"),
    processes: {
      observe: async (pid: number) => {
        observations.push(pid);

        return observation;
      },
      signalGroup: (pgid: number) => {
        signals.push(pgid);
      },
    },
  };

  await writeFile(control.manifestPath, JSON.stringify(manifest));

  return { root, selection, identity, manifest, observation, signals, observations, control };
}

test("actual stop authorizes exactly the matching positive PID and owned process group", async () => {
  const fixture = await freshLaunch();
  await stop(fixture.control);
  expect(fixture.observations).toEqual([424242]);
  expect(fixture.signals).toEqual([424242]);
  expect(fixture.manifest.argv.slice(-6)).toEqual([
    "--profile",
    "architecture",
    "--state-root",
    fixture.selection.state,
    "--launch-nonce",
    fixture.identity.nonce,
  ]);
});

test("actual stop refuses legacy and later same-profile processes from a stale architecture manifest", async () => {
  const fixture = await freshLaunch();

  const incompatible = [
    [
      process.execPath,
      "--no-env-file",
      join(fixture.root, "scripts/playground/index.ts"),
      "serve",
    ].join(" "),
    [
      process.execPath,
      ...supervisorArguments({
        ...fixture.identity,
        profile: "default",
        state: join(fixture.root, ".loopy/playground"),
      }),
    ].join(" "),
    [
      process.execPath,
      ...supervisorArguments({ ...fixture.identity, nonce: crypto.randomUUID() }),
    ].join(" "),
    [
      process.execPath,
      ...supervisorArguments({ ...fixture.identity, state: join(fixture.root, "other-state") }),
    ].join(" "),
  ];

  for (const command of incompatible) {
    await expect(
      stop({
        ...fixture.control,
        processes: {
          ...fixture.control.processes,
          observe: async () => ({ ...fixture.observation, command }),
        },
      }),
    ).rejects.toThrow(
      "Supervisor PID, process group or launch identity does not match. Refusing to signal.",
    );
    expect(fixture.signals).toEqual([]);
  }
});

test("actual stop fails closed on absent or mismatched PID/PGID, old manifests and invalid owners", async () => {
  const fixture = await freshLaunch();

  for (const observation of [
    null,
    { ...fixture.observation, pid: 424243 },
    { ...fixture.observation, pgid: 424243 },
  ]) {
    await expect(
      stop({
        ...fixture.control,
        processes: {
          ...fixture.control.processes,
          observe: async () => observation,
        },
      }),
    ).rejects.toThrow("Refusing to signal.");
    expect(fixture.signals).toEqual([]);
  }

  for (const manifest of [
    { owner: 424242, root: fixture.root, argv: fixture.manifest.argv, children: [] },
    { ...fixture.manifest, owner: 0 },
    { ...fixture.manifest, owner: -1 },
    { ...fixture.manifest, pgid: 0 },
    { ...fixture.manifest, pgid: 424243 },
    { ...fixture.manifest, argv: fixture.manifest.argv.slice(0, -1) },
    { ...fixture.manifest, identity: { ...fixture.identity, profile: "default" } },
  ]) {
    await writeFile(fixture.control.manifestPath, JSON.stringify(manifest));
    await expect(stop(fixture.control)).rejects.toThrow();
    expect(fixture.signals).toEqual([]);
  }
});

test("serve identity rejects missing nonce, another selected profile or state before startup", async () => {
  const fixture = await freshLaunch();

  const input = {
    profile: fixture.identity.profile,
    state: fixture.identity.state,
    nonce: fixture.identity.nonce,
  };

  expect(parseServeIdentity(input, fixture.selection)).toEqual(fixture.identity);

  for (const other of [
    { ...input, profile: "default" },
    { ...input, state: join(fixture.root, "other") },
    { ...input, nonce: undefined },
    { ...input, nonce: "not-a-launch-nonce" },
  ]) {
    expect(() => parseServeIdentity(other, fixture.selection)).toThrow();
  }
});

test("actual stop rejects an otherwise matching process from another selected root, state or profile", async () => {
  const fixture = await freshLaunch();

  for (const identity of [
    { ...fixture.identity, profile: "default" as const },
    { ...fixture.identity, state: join(fixture.root, "other-state") },
    { ...fixture.identity, root: join(fixture.root, "other-root") },
  ]) {
    const argv = [process.execPath, ...supervisorArguments(identity)];
    const manifest = { ...fixture.manifest, identity, argv };
    await writeFile(fixture.control.manifestPath, JSON.stringify(manifest));
    await expect(
      stop({
        ...fixture.control,
        processes: {
          ...fixture.control.processes,
          observe: async () => ({ ...fixture.observation, command: argv.join(" ") }),
        },
      }),
    ).rejects.toThrow(
      "Supervisor PID, process group or launch identity does not match. Refusing to signal.",
    );
    expect(fixture.signals).toEqual([]);
  }
});

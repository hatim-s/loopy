import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  parseServeIdentity,
  requireOwnedSupervisor,
  type StackSelection,
  supervisorArguments,
} from "../../../dev/playground/stack-identity";

const root = "/synthetic/loopy";

const selection: StackSelection = {
  root,
  state: join(root, ".loopy/playground-architecture"),
  profile: "architecture",
};

const identity = { ...selection, nonce: crypto.randomUUID() };

const argv = [process.execPath, ...supervisorArguments(identity)];

const manifest = { owner: 424242, pgid: 424242, identity, argv };

const observation = { pid: manifest.owner, pgid: manifest.pgid, command: argv.join(" ") };

const refusal =
  "Supervisor PID, process group or launch identity does not match. Refusing to signal.";

test("an owned supervisor matches its recorded PID, process group and launch argv", () => {
  expect(() => requireOwnedSupervisor(manifest, observation, selection)).not.toThrow();
});

test("a stale manifest never authorizes a different process, group or command", () => {
  const commands = [
    [process.execPath, "--no-env-file", join(root, "apps/cloud/dev/playground/index.ts"), "serve"],
    [
      process.execPath,
      ...supervisorArguments({
        ...identity,
        profile: "default",
        state: join(root, ".loopy/playground"),
      }),
    ],
    [process.execPath, ...supervisorArguments({ ...identity, nonce: crypto.randomUUID() })],
    [process.execPath, ...supervisorArguments({ ...identity, state: join(root, "other-state") })],
  ];

  const observations = [
    null,
    { ...observation, pid: 424243 },
    { ...observation, pgid: 424243 },
    ...commands.map((command) => ({ ...observation, command: command.join(" ") })),
  ];

  for (const observed of observations) {
    expect(() => requireOwnedSupervisor(manifest, observed, selection)).toThrow(refusal);
  }

  for (const changed of [
    { ...manifest, pgid: 424243 },
    { ...manifest, argv: argv.slice(0, -1) },
  ]) {
    expect(() => requireOwnedSupervisor(changed, observation, selection)).toThrow(refusal);
  }
});

test("a matching process from another selected root, state or profile is refused", () => {
  for (const other of [
    { ...identity, profile: "default" as const },
    { ...identity, state: join(root, "other-state") },
    { ...identity, root: join(root, "other-root") },
  ]) {
    const otherArgv = [process.execPath, ...supervisorArguments(other)];

    expect(() =>
      requireOwnedSupervisor(
        { ...manifest, identity: other, argv: otherArgv },
        { ...observation, command: otherArgv.join(" ") },
        selection,
      ),
    ).toThrow(refusal);
  }
});

test("serve identity rejects a missing nonce, another selected profile or state before startup", () => {
  const input = { profile: identity.profile, state: identity.state, nonce: identity.nonce };

  expect(parseServeIdentity(input, selection)).toEqual(identity);

  for (const other of [
    { ...input, profile: "default" },
    { ...input, state: join(root, "other") },
    { ...input, nonce: undefined },
    { ...input, nonce: "not-a-launch-nonce" },
  ]) {
    expect(() => parseServeIdentity(other, selection)).toThrow();
  }
});

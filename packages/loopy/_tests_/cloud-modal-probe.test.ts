import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  boundedText,
  commands,
  ModalGateway,
  payload,
} from "../../../apps/cloud/dev/modal-probe/gateway";
import { Journal, readPrivate, readPrivateText } from "../../../apps/cloud/dev/modal-probe/journal";
import {
  approvalSchema,
  authorize,
  hash,
  implementationHash,
  parseManifest,
  plan,
  type Role,
  tags,
} from "../../../apps/cloud/dev/modal-probe/plan";
import {
  type Clock,
  execute,
  type Gateway,
  inventory,
  verifyLifetime,
} from "../../../apps/cloud/dev/modal-probe/run";
import { watchChild, workerEnvironment } from "../../../apps/cloud/dev/modal-probe/supervisor";

interface FixtureEffects {
  connects: number;
  creates: Role[];
  starts: string[];
  stops: string[];
}

const roots: string[] = [];

const manifest = plan(
  "a".repeat(24),
  { workspace: "explicit-workspace", environment: "explicit-env" },
  "b".repeat(64),
);

const now = Date.parse("2026-10-22T10:00:00.000Z");

function approval() {
  return approvalSchema.parse({
    approvedBy: "Hatim",
    approvalReference: "prior-user-approval-reference",
    manifestHash: hash(manifest),
    target: manifest.target,
    appName: manifest.appName,
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3600000).toISOString(),
    actions: ["execute", "inventory", "stop"],
    acceptsUnverifiedWorkspaceIdentity: true,
    acceptsSdkRetriesAndUnknownImageBuildCost: true,
  });
}

async function root() {
  const directory = await mkdtemp(join(tmpdir(), "loopy-modal-probe-"));
  roots.push(directory);

  return directory;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(probeManifest = manifest) {
  const journal = await Journal.create(await root(), probeManifest);
  let ticks = now;

  const time: Clock = {
    now: () => ticks,
    sleep: async (ms) => {
      ticks += ms;
    },
  };

  const effects: FixtureEffects = {
    connects: 0,
    creates: [],
    starts: [],
    stops: [],
  };

  const sandboxes = new Map<string, { role: Role; terminal: number | null }>();
  let appId: string | null = null;
  let createError: "before" | "after" | null = null;
  let appError = false;
  let appPopulated = false;
  let wrongTags = false;
  let stuck = false;

  const connect = async (): Promise<Gateway> => {
    effects.connects++;

    return {
      app: async () => (appId ? { id: appId, populated: appPopulated } : null),
      createApp: async () => {
        expect(await journal.get("app-intent")).not.toBeNull();
        appId = "ap-fixture";

        if (appError) {
          throw new Error("lost-app-response");
        }

        return appId;
      },
      create: async (role) => {
        expect(await journal.get(`${role}-intent`)).not.toBeNull();
        effects.creates.push(role);

        if (createError === "before") {
          throw new Error("lost-create-response");
        }

        if (role === "lifetime") {
          expect(await journal.get("recovery-terminated")).not.toBeNull();
        }

        const id = `sb-${role}`;
        sandboxes.set(id, { role, terminal: null });

        if (createError === "after") {
          throw new Error("lost-create-response");
        }

        return id;
      },
      lookup: async (role) => {
        const item = [...sandboxes].find(
          ([, value]) => value.role === role && value.terminal === null,
        );

        return item ? { id: item[0], tags: wrongTags ? {} : tags(probeManifest, role) } : null;
      },
      byId: async (id) => {
        const sandbox = sandboxes.get(id);

        if (!sandbox) {
          throw new Error("not-found");
        }

        return { id, tags: wrongTags ? {} : tags(probeManifest, sandbox.role) };
      },
      start: async (id, command) => {
        if (!sandboxes.has(id)) {
          throw new Error("missing-fixture-sandbox");
        }

        effects.starts.push(command);

        if (command === "effect") {
          expect(await journal.get("effect-intent")).not.toBeNull();
        }

        return { result: async () => (command === "recover" ? "recovered-once" : "shared-ok") };
      },
      poll: async (id) => sandboxes.get(id)?.terminal ?? null,
      terminate: async (id) => {
        effects.stops.push(id);
        const sandbox = sandboxes.get(id);

        if (sandbox && !stuck) {
          sandbox.terminal = 137;
        }
      },
      close() {},
    };
  };

  return {
    journal,
    time,
    effects,
    connect,
    sandboxes,
    loseCreate: () => {
      createError = "before";
    },
    loseAllocatedCreate: () => {
      createError = "after";
    },
    loseApp: () => {
      appError = true;
    },
    existingApp: (id: string, populated: boolean) => {
      appId = id;
      appPopulated = populated;
    },
    corruptTags: () => {
      wrongTags = true;
    },
    refuseTermination: () => {
      stuck = true;
    },
  };
}

test("approval binds code manifest, target, cleanup and remaining lifetime", () => {
  expect(() =>
    authorize(approval(), manifest, {
      action: "execute",
      now,
      implementationHash: manifest.implementationHash,
    }),
  ).not.toThrow();

  for (const changed of [
    { ...approval(), manifestHash: "c".repeat(64) },
    { ...approval(), target: { ...manifest.target, environment: "other" } },
    { ...approval(), expiresAt: new Date(now + 239999).toISOString() },
    { ...approval(), approvedAt: new Date(now + 1).toISOString() },
    { ...approval(), appName: "other" },
  ]) {
    expect(() =>
      authorize(changed, manifest, {
        action: "execute",
        now,
        implementationHash: manifest.implementationHash,
      }),
    ).toThrow("approval-scope-or-expiry-mismatch");
  }

  expect(() =>
    authorize({ ...approval(), actions: ["execute"] }, manifest, {
      action: "execute",
      now,
      implementationHash: manifest.implementationHash,
    }),
  ).toThrow("approval-must-include-cleanup");
  expect(() => parseManifest(JSON.stringify({ ...manifest, appName: "unowned-app" }))).toThrow(
    "manifest-policy-mismatch",
  );
});

test("private durable journal refuses duplicate plans, symlinks, broad permissions and identity edits", async () => {
  const directory = await root();
  const journal = await Journal.create(directory, manifest);
  await expect(Journal.create(directory, manifest)).rejects.toThrow("EEXIST");
  await journal.put("recovery-intent", { at: now });
  await expect(journal.put("recovery-intent", { at: now })).rejects.toThrow("EEXIST");
  const path = join(journal.directory, "approval.json");
  await writeFile(path, JSON.stringify(approval()), { mode: 0o644 });
  await expect(readPrivate(path, approvalSchema)).rejects.toThrow("private-file-required");
  await chmod(path, 0o600);
  const link = join(journal.directory, "link.json");
  await symlink(path, link);
  await expect(readPrivateText(link)).rejects.toThrow();
  await writeFile(
    join(journal.directory, "manifest.json"),
    JSON.stringify({ ...manifest, id: "f".repeat(24) }),
  );
  await expect(Journal.load(directory, manifest.id)).rejects.toThrow();
});

test("one admission orders two creates, reconnects and never repeats the effect", async () => {
  const f = await fixture();
  await execute(f.journal, f.connect, f.time);
  expect(f.effects.creates).toEqual(["recovery", "lifetime"]);
  expect(f.effects.connects).toBe(2);
  expect(f.effects.starts).toEqual(["writer", "reader", "effect", "recover"]);
  expect(f.effects.stops).toEqual(["sb-recovery"]);
  const before = f.effects.connects;
  await expect(execute(f.journal, f.connect, f.time)).rejects.toThrow("EEXIST");
  expect(f.effects.connects).toBe(before);
});

test("ambiguous create plus absent name remains unknown and blocks a rerun", async () => {
  const f = await fixture();
  f.loseCreate();
  await expect(execute(f.journal, f.connect, f.time)).rejects.toThrow("lost-create-response");
  const report = await inventory(f.journal, f.connect, "stop", f.time);
  expect(report.observations[0]?.state).toBe("unknown-create-intent");
  expect(await f.journal.get("recovery-intent")).not.toBeNull();
  expect(await f.journal.get("recovery-created")).toBeNull();
  await expect(execute(f.journal, f.connect, f.time)).rejects.toThrow("EEXIST");
  expect(f.effects.creates).toEqual(["recovery"]);
});

test("cleanup fences wrong tags and continues to account for both roles", async () => {
  const f = await fixture();
  await execute(f.journal, f.connect, f.time);
  f.corruptTags();
  const before = f.effects.stops.length;
  const report = await inventory(f.journal, f.connect, "stop", f.time);
  expect(report.observations.map((item) => item.state)).toEqual([
    "unknown-or-identity-error",
    "unknown-or-identity-error",
  ]);
  expect(f.effects.stops).toHaveLength(before);
});

test("unconfirmed termination consumes a bounded poll budget and prevents second create", async () => {
  const f = await fixture();
  f.refuseTermination();
  await expect(execute(f.journal, f.connect, f.time)).rejects.toThrow("termination-unconfirmed");
  expect(f.time.now() - now).toBe(10000);
  expect(f.effects.creates).toEqual(["recovery"]);
  expect(await f.journal.get("recovery-terminated")).toBeNull();
});

test("lifetime proof requires absent-caller interval and provider timeout status, not generic termination", async () => {
  const f = await fixture();
  await execute(f.journal, f.connect, f.time);
  await expect(verifyLifetime(f.journal, f.connect, f.time)).rejects.toThrow(
    "lifetime-observation-too-early-or-missing",
  );
  await f.time.sleep(17000);
  await expect(verifyLifetime(f.journal, f.connect, f.time)).rejects.toThrow(
    "provider-timeout-not-observed",
  );
  const sandbox = f.sandboxes.get("sb-lifetime");

  if (!sandbox) {
    throw new Error("missing-fixture");
  }

  sandbox.terminal = 124;
  await verifyLifetime(f.journal, f.connect, f.time);
  expect((await f.journal.get("lifetime-passed"))?.code).toBe("timeout-124");
});

test("payload has hard CPU and memory requests, no secrets or volumes, and synthetic command bounds", () => {
  const first = payload(manifest, "recovery");
  expect(first).toEqual({
    ...manifest.resources,
    name: manifest.sandboxes[0].name,
    tags: tags(manifest, "recovery"),
    timeoutMs: 120000,
    command: ["bun", "-e", "await Bun.sleep(300000)"],
  });
  expect(payload(manifest, "lifetime").timeoutMs).toBe(15000);
  expect(manifest.bounds.strictAllocationCapVerified).toBe(false);
  const environment = workerEnvironment("/private/empty.toml", "explicit-env");
  expect(Object.keys(environment).sort()).toEqual([
    "LANG",
    "LOOPY_MODAL_PROBE_WORKER",
    "MODAL_CONFIG_PATH",
    "MODAL_ENVIRONMENT",
    "MODAL_SANDBOX_V2",
    "MODAL_SERVER_URL",
    "PATH",
  ]);
});

test("bounded output counts bytes and watchdog kills a stuck local child", async () => {
  const output = new ReadableStream<string>({
    start(controller) {
      controller.enqueue("éé");
      controller.close();
    },
  });

  await expect(boundedText(output, 3)).rejects.toThrow("process-output-limit");

  const child = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", "-e", "await Bun.sleep(10000)"],
    env: { PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });

  await expect(watchChild(child, 50)).rejects.toThrow("worker-watchdog-expired");
  expect(child.signalCode).toBe("SIGKILL");
});

test("synthetic fixture processes share files and exclusive effect survives a dropped handle locally", async () => {
  const directory = await root();

  const start = (command: keyof typeof commands) =>
    Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "-e",
        commands[command].replaceAll("/tmp/loopy-", `${directory}/loopy-`),
      ],
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });

  const writer = start("writer");
  const reader = start("reader");
  expect(await Promise.all([watchChild(writer, 8000), watchChild(reader, 8000)])).toEqual([
    "shared-ok",
    "shared-ok",
  ]);
  const effect = start("effect");
  const recovery = start("recover");
  expect(await watchChild(recovery, 8000)).toBe("recovered-once");
  expect(await effect.exited).toBe(0);
  await expect(watchChild(start("effect"), 8000)).rejects.toThrow("worker-failed-see-journal");
  expect(await readFile(join(directory, "loopy-effect"), "utf8")).toBe("once\n");
});

test("default CLI writes only an offline plan with current implementation hash and no credential input", async () => {
  const directory = await root();
  const script = resolve(import.meta.dir, "../../../apps/cloud/dev/modal-probe/index.ts");

  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      script,
      "--workspace",
      "pending-workspace",
      "--environment",
      "pending-environment",
    ],
    cwd: directory,
    env: {
      PATH: "/usr/bin:/bin",
      MODAL_CONFIG_PATH: "/must-not-be-read",
      MODAL_PROFILE: "must-not-be-read",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });

  const output: { mode: string; manifest: typeof manifest; manifestHash: string } = JSON.parse(
    await watchChild(child, 10000),
  );

  expect(output.mode).toBe("offline-plan");
  const saved = await Journal.load(directory, output.manifest.id);
  expect(saved.manifest.implementationHash).toBe(await implementationHash(resolve(script, "..")));
  expect(output.manifestHash).toBe(hash(saved.manifest));
  expect(await saved.get("execution-started")).toBeNull();
});

test("lost sandbox acknowledgement reconciles by exact live name and tags before terminating", async () => {
  const f = await fixture();
  f.loseAllocatedCreate();
  await expect(execute(f.journal, f.connect, f.time)).rejects.toThrow("lost-create-response");
  expect(await f.journal.get("recovery-created")).toBeNull();
  const report = await inventory(f.journal, f.connect, "inventory", f.time);
  expect(report.observations[0]?.state).toBe("running");
  expect(await f.journal.get("recovery-created")).toBeNull();
  await inventory(f.journal, f.connect, "stop", f.time);
  expect((await f.journal.get("recovery-created"))?.id).toBe("sb-recovery");
  expect((await f.journal.get("recovery-terminated"))?.id).toBe("sb-recovery");
  expect(f.effects.creates).toEqual(["recovery"]);
});

test("lost app acknowledgement retains app intent and never admits a sandbox", async () => {
  const f = await fixture();
  f.loseApp();
  await expect(execute(f.journal, f.connect, f.time)).rejects.toThrow("lost-app-response");
  const report = await inventory(f.journal, f.connect, "inventory", f.time);
  expect(report.appState).toBe("unknown-create-intent");
  expect(await f.journal.get("app-intent")).not.toBeNull();
  expect(await f.journal.get("app-created")).toBeNull();
  expect(f.effects.creates).toEqual([]);
});

test("existing app requires exact name and ID and an empty app", async () => {
  const f = await fixture();
  f.existingApp("ap-unowned", false);
  await expect(execute(f.journal, f.connect, f.time)).rejects.toThrow(
    "existing-or-populated-app-refused",
  );
  expect(f.effects.creates).toEqual([]);

  const exact = plan(
    manifest.id,
    { ...manifest.target, existingAppName: "loopy-cloud-probe", expectedAppId: "ap-existing" },
    manifest.implementationHash,
  );

  const populated = await fixture(exact);
  populated.existingApp("ap-existing", true);
  await expect(execute(populated.journal, populated.connect, populated.time)).rejects.toThrow(
    "existing-or-populated-app-refused",
  );
  const empty = await fixture(exact);
  empty.existingApp("ap-existing", false);
  await execute(empty.journal, empty.connect, empty.time);
  expect(await empty.journal.get("app-intent")).toBeNull();
  expect(empty.effects.creates).toEqual(["recovery", "lifetime"]);
});

test("changed app identity fences inventory and all termination", async () => {
  const f = await fixture();
  await execute(f.journal, f.connect, f.time);
  f.existingApp("ap-replacement", false);
  const before = f.effects.stops.length;
  await expect(inventory(f.journal, f.connect, "stop", f.time)).rejects.toThrow(
    "app-identity-mismatch",
  );
  expect(f.effects.stops).toHaveLength(before);
});

test("interrupted created-record write leaves name recovery available and never overwrites admission", async () => {
  const f = await fixture();
  f.loseAllocatedCreate();
  await expect(execute(f.journal, f.connect, f.time)).rejects.toThrow("lost-create-response");
  const journalModule = resolve(import.meta.dir, "../../../apps/cloud/dev/modal-probe/journal.ts");

  const source = `import {Journal} from ${JSON.stringify(journalModule)};
const journal=await Journal.load(${JSON.stringify(resolve(f.journal.directory, "../../.."))},${JSON.stringify(manifest.id)});
process.stdout.write('publication-started\\n');
await journal.put('recovery-created',{at:${now},id:'sb-recovery'});`;

  const child = Bun.spawn({
    cmd: [
      "/bin/sh",
      "-c",
      'ulimit -f 0; exec "$1" --no-env-file -e "$2"',
      "journal-interruption",
      process.execPath,
      source,
    ],
    env: { PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });

  const deadline = setTimeout(() => child.kill("SIGKILL"), 8000);

  try {
    const output = boundedText(child.stdout.pipeThrough(new TextDecoderStream()), 128);
    expect(await child.exited).not.toBe(0);
    expect(await output).toBe("publication-started\n");
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    await child.exited;
  }

  expect(await f.journal.get("recovery-created")).toBeNull();
  const report = await inventory(f.journal, f.connect, "stop", f.time);
  expect(report.observations[0]?.state).toBe("terminal");
  expect(f.effects.stops).toEqual(["sb-recovery"]);
  expect(f.effects.creates).toEqual(["recovery"]);
  const published = await f.journal.get("recovery-created");
  await expect(f.journal.put("recovery-created", { at: now, id: "sb-unowned" })).rejects.toThrow(
    "EEXIST",
  );
  expect(await f.journal.get("recovery-created")).toEqual(published);
});

test("actual gateway rejects an app containing V2 sandboxes and keeps name recovery on V1", async () => {
  const exact = plan(
    manifest.id,
    {
      ...manifest.target,
      existingAppName: "loopy-cloud-probe",
      expectedAppId: "ap-existing",
    },
    manifest.implementationHash,
  );

  const calls: string[] = [];

  const forbidden = async () => {
    calls.push("unexpected-mutation");
    throw new Error("unexpected-sdk-mutation");
  };

  const app = { appId: "ap-existing", info: async () => ({ functions: {}, servers: {} }) };

  const sandbox = {
    sandboxId: "sb-recovery",
    getTags: async () => tags(exact, "recovery"),
    poll: async () => null,
    terminate: forbidden,
    exec: forbidden,
    detach() {},
  };

  const sandboxes = {
    async *list() {
      calls.push("v1-list");
    },
    async *experimentalList(params: { appId?: string; environment?: string }) {
      expect(params).toEqual({ appId: "ap-existing", environment: exact.target.environment });
      calls.push("all-version-list");
      yield { sandboxId: "sb-active-v2" };
    },
    create: forbidden,
    fromName: async (
      appName: string,
      name: string,
      params?: { environment?: string; includeTerminated?: boolean },
    ) => {
      expect(appName).toBe(exact.appName);
      expect(name).toBe(exact.sandboxes[0].name);
      expect(params).toEqual({ environment: exact.target.environment });
      calls.push("v1-live-name");

      return sandbox;
    },
    fromId: async () => sandbox,
  };

  const sdk = {
    apps: {
      fromName: async (name: string, params?: { createIfMissing?: boolean }) => {
        expect(name).toBe(exact.appName);
        expect(params?.createIfMissing).toBe(false);

        return app;
      },
    },
    images: {
      fromRegistry: () => {
        throw new Error("unexpected-image-create");
      },
    },
    sandboxes,
    close() {},
  };

  const gateway = new ModalGateway(sdk, exact, () => false);
  const journal = await Journal.create(await root(), exact);
  await expect(execute(journal, async () => gateway)).rejects.toThrow(
    "existing-or-populated-app-refused",
  );
  expect(calls).toEqual(["all-version-list"]);
  expect(await journal.get("app-intent")).toBeNull();
  expect(await journal.get("recovery-intent")).toBeNull();
  const recovery = new ModalGateway(sdk, exact, () => false);
  expect((await recovery.lookup("recovery"))?.id).toBe("sb-recovery");
  expect(calls).toEqual(["all-version-list", "v1-live-name"]);
  expect(workerEnvironment("/private/empty.toml", exact.target.environment).MODAL_SANDBOX_V2).toBe(
    "false",
  );
});

test("fresh cleanup implementation approval retains original resource tags and cannot execute or verify", async () => {
  const f = await fixture();
  await execute(f.journal, f.connect, f.time);
  const originalHash = hash(f.journal.manifest);
  const currentHash = "c".repeat(64);

  const cleanup = approvalSchema.parse({
    ...approval(),
    actions: ["inventory", "stop"],
    cleanupImplementationHash: currentHash,
  });

  authorize(cleanup, f.journal.manifest, {
    action: "inventory",
    now,
    implementationHash: currentHash,
  });
  expect((await inventory(f.journal, f.connect, "inventory", f.time)).observations[1]?.state).toBe(
    "running",
  );
  authorize(cleanup, f.journal.manifest, { action: "stop", now, implementationHash: currentHash });
  const report = await inventory(f.journal, f.connect, "stop", f.time);
  expect(report.observations.map((item) => item.state)).toEqual(["terminal", "terminal"]);
  expect(hash(f.journal.manifest)).toBe(originalHash);
  expect(tags(f.journal.manifest, "lifetime")["loopy-manifest"]).toBe(originalHash);
  expect(f.effects.stops).toEqual(["sb-recovery", "sb-lifetime"]);
  expect(f.effects.creates).toEqual(["recovery", "lifetime"]);

  for (const action of ["execute", "verify"] as const) {
    for (const implementationHash of [currentHash, manifest.implementationHash]) {
      expect(() =>
        authorize(cleanup, f.journal.manifest, { action, now, implementationHash }),
      ).toThrow("approval-scope-or-expiry-mismatch");
    }
  }

  for (const action of ["execute", "stop"] as const) {
    expect(() =>
      authorize({ ...cleanup, actions: ["execute", "stop"] }, manifest, {
        action,
        now,
        implementationHash: currentHash,
      }),
    ).toThrow("cleanup-approval-must-exclude-execute");
  }

  expect(() =>
    authorize(approval(), manifest, {
      action: "verify",
      now: now + 3600000 - 30001,
      implementationHash: manifest.implementationHash,
    }),
  ).not.toThrow();

  for (const changed of [
    { ...cleanup, cleanupImplementationHash: "d".repeat(64) },
    { ...cleanup, cleanupImplementationHash: undefined },
  ]) {
    expect(() =>
      authorize(changed, manifest, { action: "stop", now, implementationHash: currentHash }),
    ).toThrow("implementation-hash-mismatch-fresh-approval-required");
  }
});

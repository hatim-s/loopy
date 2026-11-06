import type { Journal } from "./journal";
import { type Manifest, type Role, tags } from "./plan";

export type Command = "writer" | "reader" | "effect" | "recover";

export interface SandboxIdentity {
  id: string;
  tags: Record<string, string>;
}

export interface AppIdentity {
  id: string;
  populated: boolean;
}

export interface ProbeProcess {
  result(): Promise<string>;
}

export interface Gateway {
  app(): Promise<AppIdentity | null>;
  createApp(): Promise<string>;
  create(role: Role): Promise<string>;
  lookup(role: Role): Promise<SandboxIdentity | null>;
  byId(id: string): Promise<SandboxIdentity>;
  start(id: string, command: Command): Promise<ProbeProcess>;
  poll(id: string): Promise<number | null>;
  terminate(id: string): Promise<void>;
  close(): void;
}

export type Connect = () => Promise<Gateway>;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const clock: Clock = {
  now: Date.now,
  sleep: async (ms) => {
    await Bun.sleep(ms);
  },
};

function owned(manifest: Manifest, role: Role, sandbox: SandboxIdentity, id?: string): void {
  if (
    (id && sandbox.id !== id) ||
    Object.entries(tags(manifest, role)).some(([key, value]) => sandbox.tags[key] !== value)
  ) {
    throw new Error("sandbox-identity-mismatch");
  }
}

async function session<T>(connect: Connect, use: (gateway: Gateway) => Promise<T>): Promise<T> {
  const gateway = await connect();

  try {
    return await use(gateway);
  } finally {
    gateway.close();
  }
}

async function admitApp(journal: Journal, gateway: Gateway, time: Clock): Promise<void> {
  const existing = await gateway.app();
  const expected = journal.manifest.target.expectedAppId;

  if (existing) {
    if (!expected || existing.id !== expected || existing.populated) {
      throw new Error("existing-or-populated-app-refused");
    }

    await journal.put("app-created", { at: time.now(), id: existing.id });

    return;
  }

  if (expected) {
    throw new Error("expected-app-missing");
  }

  await journal.put("app-intent", { at: time.now() });
  const id = await gateway.createApp();
  await journal.put("app-created", { at: time.now(), id });
}

async function create(
  journal: Journal,
  gateway: Gateway,
  role: Role,
  time: Clock,
): Promise<string> {
  const app = await gateway.app();

  if (!app || app.populated || app.id !== (await journal.get("app-created"))?.id) {
    throw new Error("app-identity-mismatch");
  }

  if (await gateway.lookup(role)) {
    throw new Error("sandbox-name-already-present");
  }

  await journal.put(`${role}-intent`, { at: time.now() });
  const id = await gateway.create(role);
  await journal.put(`${role}-created`, { at: time.now(), id });
  owned(journal.manifest, role, await gateway.byId(id), id);

  return id;
}

async function waitTerminal(gateway: Gateway, id: string, time: Clock): Promise<number> {
  const deadline = time.now() + 10000;

  for (let count = 0; count < 20 && time.now() < deadline; count++) {
    const result = await gateway.poll(id);

    if (result !== null) {
      return result;
    }

    await time.sleep(500);
  }

  throw new Error("termination-unconfirmed");
}

async function stopOne(journal: Journal, gateway: Gateway, role: Role, id: string, time: Clock) {
  owned(journal.manifest, role, await gateway.byId(id), id);

  if (!(await journal.get(`${role}-created`))) {
    await journal.put(`${role}-created`, { at: time.now(), id });
  }

  if ((await gateway.poll(id)) === null) {
    await gateway.terminate(id);
  }

  await waitTerminal(gateway, id, time);

  if (!(await journal.get(`${role}-terminated`))) {
    await journal.put(`${role}-terminated`, { at: time.now(), id });
  }
}

export async function execute(
  journal: Journal,
  connect: Connect,
  time: Clock = clock,
): Promise<void> {
  // Exclusive durable admission makes every later execute attempt fail before connecting.
  await journal.put("execution-started", { at: time.now() });

  const first = await session(connect, async (gateway) => {
    await admitApp(journal, gateway, time);
    const id = await create(journal, gateway, "recovery", time);
    const writer = await gateway.start(id, "writer");
    const reader = await gateway.start(id, "reader");
    const results = await Promise.all([writer.result(), reader.result()]);

    if (results.some((result) => result !== "shared-ok")) {
      throw new Error("shared-filesystem-check-failed");
    }

    await journal.put("effect-intent", { at: time.now(), id });
    await gateway.start(id, "effect");

    return id;
  });

  await session(connect, async (gateway) => {
    const recovered = await gateway.lookup("recovery");

    if (!recovered) {
      throw new Error("recovery-lookup-unknown");
    }

    owned(journal.manifest, "recovery", recovered, first);

    if ((await (await gateway.start(first, "recover")).result()) !== "recovered-once") {
      throw new Error("effect-recovery-check-failed");
    }

    await journal.put("recovery-passed", { at: time.now(), id: first });
    await stopOne(journal, gateway, "recovery", first, time);
    await create(journal, gateway, "lifetime", time);
  });
  // The worker exits here. The supervisor waits with no SDK client process alive.
}

export async function verifyLifetime(journal: Journal, connect: Connect, time: Clock = clock) {
  const created = await journal.get("lifetime-created");

  if (!created?.id || time.now() < created.at + 17000) {
    throw new Error("lifetime-observation-too-early-or-missing");
  }

  const id = created.id;
  await session(connect, async (gateway) => {
    owned(journal.manifest, "lifetime", await gateway.byId(id), id);
    const code = await gateway.poll(id);

    if (code !== 124) {
      throw new Error("provider-timeout-not-observed");
    }

    await journal.put("lifetime-passed", { at: time.now(), id: created.id, code: "timeout-124" });
    await journal.put("lifetime-terminated", { at: time.now(), id: created.id });
  });
}

export async function inventory(
  journal: Journal,
  connect: Connect,
  action: "inventory" | "stop",
  time: Clock = clock,
) {
  const savedApp = await journal.get("app-created");

  const appState = savedApp
    ? "recorded"
    : (await journal.get("app-intent"))
      ? "unknown-create-intent"
      : "no-create-intent";

  return session(connect, async (gateway) => {
    const app = await gateway.app();

    if (app && savedApp?.id && app.id !== savedApp.id) {
      throw new Error("app-identity-mismatch");
    }

    const observations: {
      role: Role;
      state:
        | "no-create-intent"
        | "unknown-create-intent"
        | "unknown-or-identity-error"
        | "running"
        | "terminal";
      id?: string;
    }[] = [];

    for (const { role } of journal.manifest.sandboxes) {
      if (!(await journal.get(`${role}-intent`))) {
        observations.push({ role, state: "no-create-intent" });
        continue;
      }

      try {
        const created = await journal.get(`${role}-created`);

        const found = created?.id
          ? await gateway.byId(created.id)
          : app
            ? await gateway.lookup(role)
            : null;

        if (!found) {
          observations.push({ role, state: "unknown-create-intent" });
          continue;
        }

        owned(journal.manifest, role, found, created?.id);

        if (action === "stop") {
          await stopOne(journal, gateway, role, found.id, time);
        }

        const code = await gateway.poll(found.id);
        observations.push({ role, state: code === null ? "running" : "terminal", id: found.id });
      } catch {
        observations.push({ role, state: "unknown-or-identity-error" });
      }
    }

    return {
      app: app?.id ?? null,
      appState,
      observations,
    };
  });
}

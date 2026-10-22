import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { sandboxConfigSchema } from "../../apps/sandbox/src/config.js";
import { runCommand } from "../../apps/sandbox/src/process.js";
import { type StoredReceipt, storedReceiptSchema } from "../../apps/sandbox/src/receipts.js";
import { assert, equal } from "./journey-client.js";

export const root = resolve(import.meta.dir, "../..");

export const context = "colima-loopy-cloud-phase1";

export const image = "loopy-sandbox:bun-1.4.0";

export const environment = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? root,
  LANG: "C.UTF-8",
};

export async function command(argv: string[]) {
  return runCommand(argv, { env: environment, timeoutMs: 30_000, maxBytes: 128 * 1024 });
}

export async function docker(args: string[]) {
  const output = await command(["docker", "--context", context, ...args]);
  assert(output.exitCode === 0, "docker_command_failed", { operation: args[0] ?? "" });

  return output.stdout;
}

export async function fixture() {
  const base = resolve(root, ".loopy/cloud-transport");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(resolve(base, "run-"));
  const worktree = resolve(directory, "runtime-root");
  await mkdir(worktree, { mode: 0o700 });

  return sandboxConfigSchema.parse({
    worktree,
    stateRoot: resolve(worktree, ".loopy/cloud/sandbox"),
    token: "transport-test-fixture-token-32-characters",
    dockerContext: context,
    image,
    port: 0,
    maxTimeoutMs: 20_000,
  });
}

export type Config = Awaited<ReturnType<typeof fixture>>;

export const ownerOf = (config: Config) =>
  createHash("sha256").update(config.stateRoot).digest("hex");

export async function receipts(config: Config) {
  const directory = resolve(config.stateRoot, "receipts");
  const files = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));

  return Promise.all(
    files.map(async (name) =>
      storedReceiptSchema.parse(await Bun.file(resolve(directory, name)).json()),
    ),
  );
}

export async function oneReceipt(config: Config) {
  const values = await receipts(config);
  equal(values.length, 1, "receipt_count_changed");
  const value = values[0];
  assert(value, "receipt_missing");

  return value;
}

const containerSchema = z
  .array(
    z.object({
      Id: z.string(),
      Name: z.string(),
      Config: z.object({ Labels: z.record(z.string(), z.string()) }),
      State: z.object({ Running: z.boolean(), StartedAt: z.string(), FinishedAt: z.string() }),
      Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional() })),
    }),
  )
  .length(1);

export async function ownedContainer(
  config: Config,
  receipt: StoredReceipt,
  name = receipt.container,
) {
  const row = containerSchema.parse(JSON.parse(await docker(["container", "inspect", name])))[0];
  assert(row, "container_missing");
  equal(row.Name, `/${name}`, "container_name_mismatch");
  equal(row.Config.Labels["loopy.sandbox.owner"], ownerOf(config), "container_owner_mismatch");
  equal(row.Config.Labels["loopy.sandbox.request"], receipt.requestHash, "request_owner_mismatch");

  return row;
}

export async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const value = await read();

    if (accepts(value)) {
      return value;
    }

    await Bun.sleep(50);
  }

  throw new Error("Transport fixture observation timed out.");
}

export async function marker(receipt: StoredReceipt) {
  const output = await command([
    "docker",
    "--context",
    context,
    "exec",
    receipt.container,
    "cat",
    "/workspace/effect.txt",
  ]);

  return output.exitCode === 0 ? output.stdout : "";
}

export async function cleanup(config: Config) {
  const saved = await receipts(config);
  const removed: string[] = [];
  const volumes = new Set<string>();

  for (const receipt of saved) {
    volumes.add(receipt.inputVolume);
    volumes.add(receipt.volume);

    for (const name of [
      receipt.container,
      `${receipt.container}-input`,
      `loopy-artifact-${receipt.id}`,
    ]) {
      const listed = (
        await docker([
          "container",
          "ls",
          "--all",
          "--filter",
          `name=^/${name}$`,
          "--format",
          "{{.Names}}",
        ])
      ).trim();

      if (!listed) {
        continue;
      }

      equal(listed, name, "cleanup_container_identity_mismatch");
      const row = await ownedContainer(config, receipt, name);
      assert(
        row.Mounts.every((mount) => mount.Type !== "bind"),
        "unexpected_host_bind_mount",
      );

      for (const mount of row.Mounts) {
        if (mount.Type === "volume") {
          assert(mount.Name && volumes.has(mount.Name), "unrecorded_volume_mount");
        }
      }

      await docker(["rm", "--force", name]);
      removed.push(name);
    }
  }

  for (const volume of volumes) {
    const listed = (
      await docker(["volume", "ls", "--filter", `name=^${volume}$`, "--format", "{{.Name}}"])
    ).trim();

    if (listed) {
      equal(listed, volume, "cleanup_volume_identity_mismatch");
      await docker(["volume", "rm", volume]);
    }

    equal(
      (
        await docker(["volume", "ls", "--filter", `name=^${volume}$`, "--format", "{{.Name}}"])
      ).trim(),
      "",
      "owned_volume_remains",
    );
  }

  equal(
    (
      await docker([
        "container",
        "ls",
        "--all",
        "--filter",
        `label=loopy.sandbox.owner=${ownerOf(config)}`,
        "--format",
        "{{.Names}}",
      ])
    ).trim(),
    "",
    "owned_container_remains",
  );

  for (const name of ["service.lock", "service-start.lock"]) {
    let exists = true;
    await access(resolve(config.stateRoot, name)).catch((cause: unknown) => {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
        throw cause;
      }

      exists = false;
    });
    assert(!exists, "service_lock_remains");
  }

  return {
    containersRemoved: removed,
    volumesCheckedAbsent: [...volumes],
    ownedContainersRemaining: 0,
    ownedVolumesRemaining: 0,
  };
}

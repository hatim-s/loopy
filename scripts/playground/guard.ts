import { createHash } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { atomic, dockerContext, sandboxState, state } from "./config.js";

const owner = createHash("sha256").update(sandboxState).digest("hex");

async function docker(args: string[]) {
  const child = Bun.spawn(["docker", "--context", dockerContext, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });

  const timeout = setTimeout(() => child.kill(), 10_000);

  try {
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);

    if (code !== 0) {
      throw new Error(
        "Playground Docker pressure guard could not inspect runtime. Admission paused.",
      );
    }

    return text.trim();
  } finally {
    clearTimeout(timeout);
  }
}

const sampleSchema = z.strictObject({
  status: z.literal("passed"),
  at: z.string().datetime(),
  running: z.number().int().nonnegative().max(4),
  vmContainerMemoryPercent: z.number().nonnegative().lt(85),
  vmContainerMemoryBytes: z.number().nonnegative(),
  vmTotalMemoryBytes: z.number().positive(),
});

async function inspectPressure() {
  const running = (
    await docker(["ps", "--filter", `label=loopy.sandbox.owner=${owner}`, "--format", "{{.Names}}"])
  )
    .split("\n")
    .filter((name) => name.startsWith("loopy-attempt-"));

  const memory = await docker(["stats", "--no-stream", "--format", "{{.MemUsage}}"]);

  const total = z.coerce
    .number()
    .int()
    .positive()
    .parse(await docker(["info", "--format", "{{.MemTotal}}"]));

  const pressure = memoryPressure(memory.split("\n").filter(Boolean), total);

  return {
    running: running.length,
    vmContainerMemoryPercent: pressure.percent,
    vmContainerMemoryBytes: pressure.usedBytes,
    vmTotalMemoryBytes: total,
  };
}

async function assertNoAbort(directory: string) {
  if (await Bun.file(resolve(directory, "ABORT")).exists()) {
    throw new Error("Playground ABORT guard is set. Inspect it before admitting more runs.");
  }
}

async function waitOwner(lock: string) {
  const file = resolve(lock, "owner.json");

  let data: unknown;

  try {
    data = await Bun.file(file).json();
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return;
    }

    throw cause;
  }

  const owner = z.object({ pid: z.number().int().positive() }).parse(data);

  try {
    process.kill(owner.pid, 0);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") {
      throw new Error(
        `Pressure check owner ${owner.pid} is dead. Reconcile its lock explicitly before admission.`,
      );
    }

    throw cause;
  }
}

export async function guard(
  options: { directory?: string; inspect?: typeof inspectPressure } = {},
) {
  const directory = options.directory ?? state;
  const inspect = options.inspect ?? inspectPressure;
  const lock = resolve(directory, "pressure-check.lock");
  const deadline = Date.now() + 35_000;
  let acquired = false;

  try {
    while (!acquired) {
      await assertNoAbort(directory);

      try {
        await mkdir(lock);
        acquired = true;
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) {
          throw cause;
        }

        await waitOwner(lock);

        if (Date.now() >= deadline) {
          throw new Error("Pressure check did not finish within 35 seconds. Admission is closed.");
        }

        await Bun.sleep(100);
      }
    }

    await atomic(resolve(lock, "owner.json"), { pid: process.pid, at: new Date().toISOString() });
    await assertNoAbort(directory);
    const samplePath = resolve(directory, "pressure-last.json");
    const last = await stat(samplePath).catch(() => null);

    if (last && Date.now() - last.mtimeMs < 30_000) {
      const sample = sampleSchema.parse(await Bun.file(samplePath).json());
      const age = Date.now() - Date.parse(sample.at);

      if (age >= 0 && age < 30_000) {
        await assertNoAbort(directory);

        return;
      }
    }

    const sample = sampleSchema.parse({
      status: "passed",
      at: new Date().toISOString(),
      ...(await inspect()),
    });

    await atomic(samplePath, sample);
    await assertNoAbort(directory);
  } catch (cause) {
    await writeFile(
      resolve(directory, "ABORT"),
      "Runtime pressure guard failed. Inspect Docker ownership, memory and the pressure lock owner before recovery.\n",
    );
    throw cause;
  } finally {
    if (acquired) {
      await rm(lock, { recursive: true });
    }
  }
}

export function memoryPressure(usages: string[], totalBytes: number) {
  const units = new Map([
    ["B", 1],
    ["kB", 1000],
    ["KiB", 1024],
    ["MB", 1000 ** 2],
    ["MiB", 1024 ** 2],
    ["GB", 1000 ** 3],
    ["GiB", 1024 ** 3],
    ["TB", 1000 ** 4],
    ["TiB", 1024 ** 4],
  ]);

  const usedBytes = usages.reduce((sum, usage) => {
    const match = /^(\d+(?:\.\d+)?)\s*(B|kB|KiB|MB|MiB|GB|GiB|TB|TiB)$/.exec(
      usage.split("/")[0]?.trim() ?? "",
    );

    if (!match?.[1] || !match[2]) {
      throw new Error("Docker returned an unrecognized container memory usage.");
    }

    const unit = units.get(match[2]);

    if (unit === undefined) {
      throw new Error("Docker returned an unsupported memory unit.");
    }

    return sum + Number(match[1]) * unit;
  }, 0);

  return { usedBytes, percent: (usedBytes / totalBytes) * 100 };
}

import { resolve } from "node:path";
import { decodeBoundary, isoDateTime } from "@loopy/contract";
import { dockerAttemptPlanSchema } from "@loopy/contract/sandbox";
import { tryPidLock } from "@loopy/runtime/os";
import { Schema } from "effect";
import { ownerOf, SANDBOX_LABELS } from "../../../sandbox/src/docker/identity";
import { docker } from "../shared/process";
import { toolEnvironment } from "../stack/environment";
import { sandboxState, state } from "./config";
import { atomic } from "./files";
import { abortPath, writeAbort } from "./journal";
import { CONCURRENCY } from "./plan";

const owner = ownerOf(sandboxState);

const isAttemptContainer = Schema.is(dockerAttemptPlanSchema.fields.container);

const FRESH_MS = 30_000;

const nonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

const sampleSchema = Schema.Struct({
  status: Schema.Literal("passed"),
  at: isoDateTime,
  running: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: CONCURRENCY })),
  vmContainerMemoryPercent: nonNegative.check(Schema.isLessThan(85)),
  vmContainerMemoryBytes: nonNegative,
  vmTotalMemoryBytes: Schema.Number.check(Schema.isGreaterThan(0)),
});

const decodeSample = decodeBoundary(sampleSchema);

const totalSchema = Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0));

const units = {
  B: 1,
  kB: 1000,
  KiB: 1024,
  MB: 1000 ** 2,
  MiB: 1024 ** 2,
  GB: 1000 ** 3,
  GiB: 1024 ** 3,
  TB: 1000 ** 4,
  TiB: 1024 ** 4,
} as const satisfies Record<string, number>;

const usagePattern = /^(\d+(?:\.\d+)?)\s*(B|kB|KiB|MB|MiB|GB|GiB|TB|TiB)$/;

function isUnit(value: string): value is keyof typeof units {
  return value in units;
}

function memoryPressure(usages: string[], totalBytes: number) {
  const usedBytes = usages.reduce((sum, usage) => {
    const [, amount, unit] = usagePattern.exec(usage.split("/")[0]?.trim() ?? "") ?? [];

    if (amount === undefined || unit === undefined || !isUnit(unit)) {
      throw new Error("Docker returned an unrecognized container memory usage.");
    }

    return sum + Number(amount) * units[unit];
  }, 0);

  return { usedBytes, percent: (usedBytes / totalBytes) * 100 };
}

async function inspectPressure() {
  const run = (args: string[]) =>
    docker(args, { env: toolEnvironment(state), timeoutMs: 10_000 }).then((text) => text.trim());

  const running = (
    await run([
      "ps",
      "--filter",
      `label=${SANDBOX_LABELS.owner}=${owner}`,
      "--format",
      "{{.Names}}",
    ])
  )
    .split("\n")
    .filter(isAttemptContainer);

  const memory = await run(["stats", "--no-stream", "--format", "{{.MemUsage}}"]);
  const total = decodeBoundary(totalSchema)(await run(["info", "--format", "{{.MemTotal}}"]));
  const pressure = memoryPressure(memory.split("\n").filter(Boolean), total);

  return {
    running: running.length,
    vmContainerMemoryPercent: pressure.percent,
    vmContainerMemoryBytes: pressure.usedBytes,
    vmTotalMemoryBytes: total,
  };
}

async function assertNoAbort() {
  if (await Bun.file(abortPath(state)).exists()) {
    throw new Error("Playground ABORT guard is set. Inspect it before admitting more runs.");
  }
}

async function freshSample(path: string) {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return false;
  }

  const age = Date.now() - Date.parse(decodeSample(await file.json()).at);

  return age >= 0 && age < FRESH_MS;
}

export async function guard() {
  const lock = resolve(state, "pressure-check.lock");
  const deadline = Date.now() + 35_000;
  let release: (() => void) | null = null;

  try {
    while (release === null) {
      await assertNoAbort();
      const attempt = tryPidLock(lock);

      if (attempt.kind === "acquired") {
        release = attempt.release;
      } else if (Date.now() >= deadline) {
        throw new Error("Pressure check did not finish within 35 seconds. Admission is closed.");
      } else {
        await Bun.sleep(100);
      }
    }

    await assertNoAbort();
    const samplePath = resolve(state, "pressure-last.json");

    if (!(await freshSample(samplePath))) {
      const sample = decodeSample({
        status: "passed",
        at: new Date().toISOString(),
        ...(await inspectPressure()),
      });

      atomic(samplePath, sample);
    }

    await assertNoAbort();
  } catch (cause) {
    await writeAbort(
      state,
      "Runtime pressure guard failed. Inspect Docker ownership, memory and the pressure lock owner before recovery.",
    );
    throw cause;
  } finally {
    release?.();
  }
}

import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { z } from "zod";
import { playgroundConfigSchema } from "./config-schema.js";
import { playgroundProfile } from "./profile.js";

export const root = resolve(import.meta.dir, "../..");

export const profile = playgroundProfile(root, process.env.LOOPY_PLAYGROUND_PROFILE);

export const { state, runtime, sandboxState, api, dashboard, evidence } = profile;

export const evidenceDirectory = evidence;

export const dockerContext = "colima-loopy-cloud-phase1";

export const image = profile.image;

export const configPath = resolve(state, "config.json");

export const configSchema = playgroundConfigSchema(profile);

export type Config = z.infer<typeof configSchema>;

export async function atomic<T>(path: string, value: T) {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function config() {
  return configSchema.parse(await Bun.file(configPath).json());
}

export async function initialize() {
  await mkdir(state, { recursive: true, mode: 0o700 });

  if (!(await Bun.file(configPath).exists())) {
    const base = {
      batch: `${profile.batchPrefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      api,
      dashboard,
      workspace: "playground",
      token: crypto.randomUUID() + crypto.randomUUID(),
      otherToken: crypto.randomUUID() + crypto.randomUUID(),
      sandboxToken: crypto.randomUUID() + crypto.randomUUID(),
      apiConcurrency: 4,
      runtimeConcurrency: 4,
      createdAt: new Date().toISOString(),
    };

    const value = configSchema.parse(
      profile.name
        ? {
            ...base,
            receiptsToken: crypto.randomUUID() + crypto.randomUUID(),
            receiptMode: profile.receiptMode,
          }
        : base,
    );

    await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }

  return config();
}

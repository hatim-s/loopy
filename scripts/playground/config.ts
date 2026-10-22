import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const root = resolve(import.meta.dir, "../..");

export const state = resolve(root, ".loopy/playground");

export const runtime = resolve(state, "runtime-root");

export const sandboxState = resolve(runtime, ".loopy/cloud/sandbox");

export const api = "http://127.0.0.1:15070";

export const dashboard = "http://127.0.0.1:15072";

export const dockerContext = "colima-loopy-cloud-phase1";

export const image = "loopy-sandbox:bun-1.4.0";

export const configPath = resolve(state, "config.json");

export const configSchema = z.strictObject({
  batch: z.string(),
  api: z.literal(api),
  dashboard: z.literal(dashboard),
  workspace: z.literal("playground"),
  token: z.string().min(32),
  otherToken: z.string().min(32),
  sandboxToken: z.string().min(32),
  apiConcurrency: z.literal(4),
  runtimeConcurrency: z.literal(4),
  createdAt: z.string(),
});

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
    const value = configSchema.parse({
      batch: `playground-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      api,
      dashboard,
      workspace: "playground",
      token: crypto.randomUUID() + crypto.randomUUID(),
      otherToken: crypto.randomUUID() + crypto.randomUUID(),
      sandboxToken: crypto.randomUUID() + crypto.randomUUID(),
      apiConcurrency: 4,
      runtimeConcurrency: 4,
      createdAt: new Date().toISOString(),
    });

    await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }

  return config();
}

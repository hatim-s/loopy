import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary } from "@loopy/contract";
import { Schema } from "effect";
import { root } from "../stack/constants";
import { randomToken } from "../stack/credentials";
import { type PlaygroundProfile, playgroundProfile } from "./profile";

export { root };

export const profile = playgroundProfile(root, process.env.LOOPY_PLAYGROUND_PROFILE);

export const { state, runtime, sandboxState, api, dashboard, evidence } = profile;

const configPath = resolve(state, "config.json");

const token = Schema.String.check(Schema.isMinLength(32));

export function playgroundConfigSchema(selected: PlaygroundProfile) {
  const base = {
    batch: Schema.String,
    api: Schema.Literal(selected.api),
    dashboard: Schema.Literal(selected.dashboard),
    workspace: Schema.Literal("playground"),
    token,
    otherToken: token,
    sandboxToken: token,
    createdAt: Schema.String,
  };

  return Schema.Union([
    Schema.Struct(base),
    Schema.Struct({ ...base, receiptsToken: token }).check(
      Schema.makeFilter(
        (value) =>
          new Set([value.token, value.otherToken, value.sandboxToken, value.receiptsToken]).size ===
          4,
        { message: "Receipt, sandbox and user credentials must be distinct." },
      ),
    ),
  ]);
}

type StoredConfig = ReturnType<typeof playgroundConfigSchema>["Type"];

// The receipt mode comes from the selected profile; the file only holds the batch and secrets.
export function withReceiptMode(selected: PlaygroundProfile, value: StoredConfig) {
  if (selected.receiptMode === "filesystem") {
    if ("receiptsToken" in value) {
      throw new Error("The default playground profile must not hold a receipts credential.");
    }

    return { ...value, receiptMode: selected.receiptMode };
  }

  if (!("receiptsToken" in value)) {
    throw new Error("The architecture playground profile requires a receipts credential.");
  }

  return { ...value, receiptMode: selected.receiptMode };
}

export type Config = ReturnType<typeof withReceiptMode>;

export async function config() {
  return withReceiptMode(
    profile,
    decodeBoundary(playgroundConfigSchema(profile))(await Bun.file(configPath).json()),
  );
}

export async function initialize() {
  await mkdir(state, { recursive: true, mode: 0o700 });

  if (!(await Bun.file(configPath).exists())) {
    const base = {
      batch: `${profile.batchPrefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      api,
      dashboard,
      workspace: "playground",
      token: randomToken(),
      otherToken: randomToken(),
      sandboxToken: randomToken(),
      createdAt: new Date().toISOString(),
    };

    const value =
      profile.receiptMode === "durable-object" ? { ...base, receiptsToken: randomToken() } : base;

    withReceiptMode(profile, decodeBoundary(playgroundConfigSchema(profile))(value));
    await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }

  return config();
}

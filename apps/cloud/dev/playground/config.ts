import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary } from "@loopy/contract";
import { Effect, Schema } from "effect";
import { root } from "../stack/constants";
import { randomToken, tokenSchema } from "../stack/credentials";
import { type PlaygroundProfile, playgroundProfile } from "./profile";

export const profile = playgroundProfile(root, process.env.LOOPY_PLAYGROUND_PROFILE);

export const { state, runtime, sandboxState, api, dashboard, evidence } = profile;

const configPath = resolve(state, "config.json");

const receiptMode = <const M extends PlaygroundProfile["receiptMode"]>(mode: M) =>
  Schema.Literal(mode).pipe(Schema.withDecodingDefault(Effect.succeed(mode)));

// The stored file holds the batch and secrets. The selected profile alone picks the receipt
// mode, so the default profile rejects a receipts credential as an unknown field.
export function playgroundConfigSchema(selected: PlaygroundProfile) {
  const base = {
    batch: Schema.String,
    api: Schema.Literal(selected.api),
    dashboard: Schema.Literal(selected.dashboard),
    workspace: Schema.Literal("playground"),
    token: tokenSchema,
    otherToken: tokenSchema,
    sandboxToken: tokenSchema,
    createdAt: Schema.String,
  };

  if (selected.receiptMode === "filesystem") {
    return Schema.Struct({ ...base, receiptMode: receiptMode("filesystem") });
  }

  return Schema.Struct({
    ...base,
    receiptsToken: tokenSchema,
    receiptMode: receiptMode("durable-object"),
  }).check(
    Schema.makeFilter(
      (value) =>
        new Set([value.token, value.otherToken, value.sandboxToken, value.receiptsToken]).size ===
        4,
      { message: "Receipt, sandbox and user credentials must be distinct." },
    ),
  );
}

export type Config = ReturnType<typeof playgroundConfigSchema>["Type"];

export async function config() {
  return decodeBoundary(playgroundConfigSchema(profile))(await Bun.file(configPath).json());
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

    decodeBoundary(playgroundConfigSchema(profile))(value);
    await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }

  return config();
}

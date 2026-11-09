import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary } from "@loopy/contract";
import { Schema } from "effect";
import { root } from "./constants";

export const localState = resolve(root, ".loopy/cloud");

const credentialsPath = resolve(localState, "local.json");

export const tokenSchema = Schema.String.check(Schema.isMinLength(32));

const localCredentialsSchema = Schema.Struct({
  principals: Schema.Array(Schema.Struct({ workspace: Schema.String, token: tokenSchema })),
  sandboxToken: tokenSchema,
});

export type LocalCredentials = typeof localCredentialsSchema.Type;

export function randomToken() {
  return crypto.randomUUID() + crypto.randomUUID();
}

export async function readLocalCredentials() {
  return decodeBoundary(localCredentialsSchema)(await Bun.file(credentialsPath).json());
}

export async function ensureLocalCredentials() {
  await mkdir(localState, { recursive: true, mode: 0o700 });

  if (!(await Bun.file(credentialsPath).exists())) {
    await Bun.write(
      credentialsPath,
      JSON.stringify({
        principals: ["fixtures", "other"].map((workspace) => ({ workspace, token: randomToken() })),
        sandboxToken: randomToken(),
      }),
    );
    await chmod(credentialsPath, 0o600);
  }

  return readLocalCredentials();
}

export function principalToken(credentials: LocalCredentials, workspace: string) {
  const principal = credentials.principals.find((value) => value.workspace === workspace);

  if (!principal) {
    throw new Error(
      `Local credentials have no ${workspace} principal. Start the local cloud stack first.`,
    );
  }

  return principal.token;
}

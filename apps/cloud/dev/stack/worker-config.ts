import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary } from "@loopy/contract";
import { Schema } from "effect";
import { root } from "./constants";

const wranglerSchema = Schema.Record(Schema.String, Schema.Unknown);

const varsSchema = Schema.Record(Schema.String, Schema.String);

export async function writeWorkerConfig(options: {
  path: string;
  name: string;
  vars: Record<string, string>;
  apiPort: number;
  inspectorPort: number;
}) {
  const committed = decodeBoundary(wranglerSchema)(
    Bun.JSONC.parse(await Bun.file(resolve(root, "apps/cloud/wrangler.jsonc")).text()),
  );

  await Bun.write(
    options.path,
    `${JSON.stringify(
      {
        ...committed,
        name: options.name,
        main: resolve(root, "apps/cloud/src/worker.ts"),
        vars: { ...decodeBoundary(varsSchema)(committed.vars), ...options.vars },
        dev: { ip: "127.0.0.1", port: options.apiPort, inspector_port: options.inspectorPort },
      },
      null,
      2,
    )}\n`,
  );
}

export async function writeDevVars(
  path: string,
  secrets: {
    principals: readonly { workspace: string; token: string }[];
    sandboxToken: string;
    receiptsToken?: string;
  },
) {
  const lines = [
    `LOCAL_AUTH='${JSON.stringify(secrets.principals)}'`,
    `SANDBOX_TOKEN=${JSON.stringify(secrets.sandboxToken)}`,
    ...(secrets.receiptsToken === undefined
      ? []
      : [`RECEIPTS_TOKEN=${JSON.stringify(secrets.receiptsToken)}`]),
  ];

  await Bun.write(path, `${lines.join("\n")}\n`);
  await chmod(path, 0o600);
}

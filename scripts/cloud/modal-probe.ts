import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Journal } from "./modal-probe-journal.js";
import { hash, implementationHash, plan, targetSchema } from "./modal-probe-plan.js";
import { supervise } from "./modal-probe-supervisor.js";

export async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      workspace: { type: "string" },
      environment: { type: "string" },
      "expected-app-id": { type: "string" },
      "app-name": { type: "string" },
      id: { type: "string" },
      approval: { type: "string" },
      credentials: { type: "string" },
    },
  });

  const mode = positionals[0] ?? "plan";

  if (positionals.length > 1) {
    throw new Error("unexpected-positional-input");
  }

  if (mode === "plan") {
    if (values.id || values.approval || values.credentials) {
      throw new Error("plan-does-not-accept-live-inputs");
    }

    const target = targetSchema.parse({
      workspace: values.workspace,
      environment: values.environment,
      expectedAppId: values["expected-app-id"],
      existingAppName: values["app-name"],
    });

    const manifest = plan(
      randomBytes(12).toString("hex"),
      target,
      await implementationHash(import.meta.dir),
    );

    const journal = await Journal.create(process.cwd(), manifest);
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: "offline-plan",
          directory: journal.directory,
          manifestHash: hash(manifest),
          manifest,
        },
        null,
        2,
      )}\n`,
    );

    return;
  }

  if (mode !== "execute" && mode !== "inventory" && mode !== "stop") {
    throw new Error("expected-plan-execute-inventory-or-stop");
  }

  if (
    !values.id ||
    !values.approval ||
    !values.credentials ||
    values.workspace ||
    values.environment ||
    values["expected-app-id"] ||
    values["app-name"]
  ) {
    throw new Error("live-mode-needs-id-private-approval-and-private-credentials");
  }

  const journal = await Journal.load(process.cwd(), values.id);
  process.stdout.write(
    await supervise(journal, mode, resolve(values.approval), resolve(values.credentials)),
  );
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch {
    // Provider errors can contain credentials or request metadata. Keep stdout and stderr synthetic.
    process.stderr.write("modal-probe-failed: inspect the private journal and approval inputs.\n");
    process.exitCode = 1;
  }
}

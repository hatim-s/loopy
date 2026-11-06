import { join, resolve } from "node:path";
import { connectModal, credentialsSchema } from "./gateway";
import { Journal, readPrivate, readPrivateText } from "./journal";
import { approvalSchema, authorize, implementationHash } from "./plan";
import { execute, inventory, verifyLifetime } from "./run";
import { workerEnvironment } from "./supervisor";

async function work(): Promise<void> {
  const [mode, id, approvalFile, credentialsFile, extra] = process.argv.slice(2);

  if (
    !id ||
    !approvalFile ||
    !credentialsFile ||
    extra ||
    !["execute", "verify", "inventory", "stop"].includes(mode ?? "")
  ) {
    throw new Error("worker-input-invalid");
  }

  const journal = await Journal.load(process.cwd(), id);
  const config = join(journal.directory, "empty-modal-config.toml");
  const expected = workerEnvironment(config, journal.manifest.target.environment);

  if (
    Object.entries(expected).some(([key, value]) => process.env[key] !== value) ||
    Object.keys(process.env).some((key) => !(key in expected) && key.startsWith("MODAL_")) ||
    (await readPrivateText(config)) !== ""
  ) {
    throw new Error("worker-environment-not-sanitized");
  }

  const action = mode === "verify" ? "execute" : mode;

  if (action !== "execute" && action !== "inventory" && action !== "stop") {
    throw new Error("worker-mode-invalid");
  }

  // Verification retains execute authority, without another 240s startup reserve.
  authorize(await readPrivate(resolve(approvalFile), approvalSchema), journal.manifest, {
    action: mode === "verify" ? "verify" : action,
    now: Date.now(),
    implementationHash: await implementationHash(import.meta.dir),
  });

  const credentials = await readPrivate(resolve(credentialsFile), credentialsSchema);
  const connect = () => connectModal(journal.manifest, credentials);

  try {
    if (mode === "execute") {
      await execute(journal, connect);
    } else if (mode === "verify") {
      await verifyLifetime(journal, connect);
    } else {
      const report = await inventory(journal, connect, action === "stop" ? "stop" : "inventory");
      process.stdout.write(`${JSON.stringify(report)}\n`);

      if (
        mode === "stop" &&
        (report.appState === "unknown-create-intent" ||
          report.observations.some(
            (item) => item.state.startsWith("unknown") || item.state === "running",
          ))
      ) {
        process.exitCode = 1;
      }
    }
  } catch {
    if (!(await journal.get("worker-failed"))) {
      await journal.put("worker-failed", { at: Date.now(), code: "provider-operation-failed" });
    }

    throw new Error("provider-operation-failed-see-private-journal");
  }
}

if (import.meta.main) {
  try {
    await work();
    process.exit(process.exitCode ?? 0);
  } catch {
    process.stderr.write("modal-probe-worker-failed\n");
    process.exit(1);
  }
}

import { createControlHandler } from "../../../packages/loopy/src/cloud/api.js";
import { HostedControl } from "../../../packages/loopy/src/cloud/control.js";
import { dispatchPending } from "../../../packages/loopy/src/cloud/dispatch.js";
import { SqliteStore } from "../../../packages/loopy/src/storage/sqlite.js";
import { clerkAuthenticator } from "./auth.js";
import { CloudflareDriver } from "./driver.js";
import type { CloudEnv } from "./types.js";

export { RunCoordinator } from "./coordinator.js";

function checkBindings(env: CloudEnv): void {
  for (const key of [
    "DB",
    "COORDINATORS",
    "EXECUTOR",
    "RUNTIME_BUILD",
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_JWT_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_AUTHORIZED_PARTIES",
  ] as const)
    if (!env[key]) throw new Error(`Missing binding ${key}`);
}

export default {
  async fetch(request: Request, env: CloudEnv): Promise<Response> {
    try {
      checkBindings(env);
      const driver = new CloudflareDriver(env);
      const control = new HostedControl(
        (scope) => {
          const store = new SqliteStore(env.DB, scope);
          return { catalog: store, admission: store, runs: store, artifacts: store };
        },
        driver,
        {
          protocol: 1,
          runtime: { build: env.RUNTIME_BUILD, graphSchema: 1 },
          operations: ["read", "run", "cancel"],
          executors: ["service-binding"],
        },
      );
      return await createControlHandler(control, clerkAuthenticator(env))(request);
    } catch (error) {
      const message =
        error instanceof Error && error.message.startsWith("Missing binding ")
          ? error.message
          : "Configure Clerk verification and cloud bindings";
      return Response.json({ code: "unsupported", message }, { status: 503 });
    }
  },
  async scheduled(_controller: unknown, env: CloudEnv): Promise<void> {
    checkBindings(env);
    const driver = new CloudflareDriver(env);
    // Pagination bounds each SQL query while covering every tenant and active run.
    let cursor: string | undefined;
    do {
      const page = await SqliteStore.recoveryTenants(env.DB, cursor, 100);
      for (const tenantId of page.tenantIds) {
        const store = new SqliteStore(env.DB, { tenantId });
        await dispatchPending(store, driver);
        let runCursor: string | undefined;
        do {
          const runs = await store.recoveryRuns(runCursor, 100);
          for (const run of runs.runs)
            await driver.ensureStarted(store.scope, run.runId, run.runtime);
          runCursor = runs.cursor;
        } while (runCursor);
      }
      cursor = page.cursor;
    } while (cursor);
  },
};

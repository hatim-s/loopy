/**
 * Starts a throwaway Loopy daemon and fills it through the CLI with runs that cover the
 * dashboard's screens: a live run, a run pinned to an older revision, a run waiting on a hook,
 * a map in progress, a failed run and a schedule. Ctrl-C stops the daemon and deletes its state.
 *
 *   bun apps/dashboard/dev/demo.ts [--port <port>]  (default: a free port)
 */
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { decodeBoundary, type Json, routes } from "@loopy/contract";
import { Schema } from "effect";

// The same entry as the root `loopy` script.
const cli = resolve(import.meta.dir, "../../../packages/cli/src/index.ts");

const { values } = parseArgs({ options: { port: { type: "string", default: "0" } } });

const root = mkdtempSync(join(tmpdir(), "loopy-dashboard-demo-"));

const home = join(root, "home");

const workspace = join(root, "support");

mkdirSync(join(workspace, ".loopy", "loopies"), { recursive: true });

// A sanitized environment keeps the demo away from the developer's own Loopy state.
const env = {
  HOME: root,
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LOOPY_HOME: home,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
};

const globals = ["--no-env-file", cli, "--home", home, "--cwd", workspace];

async function loopy(...args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, ...globals, ...args], {
    cwd: workspace,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) {
    throw new Error(`loopy ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  }

  return stdout;
}

const daemonFile = Schema.Struct({ port: Schema.Number, token: Schema.String });

const runView = decodeBoundary(routes.startRun.response);

const runList = decodeBoundary(routes.runs.response);

async function start(slug: string, input: Json): Promise<string> {
  return runView(JSON.parse(await loopy("run", slug, "--input-json", JSON.stringify(input)))).id;
}

async function settled(slug: string, id: string): Promise<void> {
  for (let tries = 0; tries < 300; tries++) {
    const run = runList(JSON.parse(await loopy("runs", slug))).find((item) => item.id === id);

    if (run?.status === "succeeded" || run?.status === "failed") {
      return;
    }

    await Bun.sleep(200);
  }

  throw new Error(`Run ${id} did not settle. Inspect ${join(root, "daemon.log")}.`);
}

function source(file: string, text: string): string {
  const path = join(workspace, file);
  writeFileSync(path, text);

  return path;
}

const triage = (version: 1 | 2) => `import { log, loopy, sh } from "loopy/graph";

export default loopy("triage-inbox", {
  description: "Sort the support inbox and draft replies.",
  input: { mailbox: "string" },
  run: ({ input }) => {
    const unread = sh(["sh", "-c", "sleep ${version === 1 ? 1 : 20}; echo 12"]);
    log("Fetched unread mail", { mailbox: input.get("mailbox") });
    sh(["sh", "-c", "sleep ${version === 1 ? 1 : 40}; echo sorted"]);
${version === 2 ? '    sh(["sh", "-c", "sleep 60; echo drafted"]);\n' : ""}
    return unread.get("stdout");
  },
});
`;

const files = {
  triage: source("triage.loopy.ts", triage(1)),
  review: source(
    "review.loopy.ts",
    `import { log, loopy, map, sh } from "loopy/graph";

export default loopy("review-changes", {
  description: "Review each changed package.",
  input: { packages: "string[]" },
  run: ({ input }) =>
    map(
      input.get("packages"),
      (name) => {
        log("Reviewing", { name });
        return sh(["sh", "-c", "sleep 45; echo reviewed"]).get("stdout");
      },
      { concurrency: 2, onError: "collect" },
    ),
});
`,
  ),
  release: source(
    "release.loopy.ts",
    `import { loopy, sh, wait } from "loopy/graph";

export default loopy("release", {
  description: "Build, then wait for a person to approve the publish.",
  input: { version: "string" },
  run: ({ input }) => {
    sh(["sh", "-c", "echo built"]);
    const approval = wait("approve", {
      payload: { kind: "record", fields: { approved: "boolean" } },
      timeout: "24h",
    });
    sh(["sh", "-c", "echo published"]);
    return approval.get("approved");
  },
});
`,
  ),
  digest: source(
    "digest.loopy.ts",
    `import { log, loopy } from "loopy/graph";

export default loopy("daily-digest", {
  description: "Summarise yesterday's activity.",
  input: {},
  run: () => log("Digest sent"),
});
`,
  ),
  flaky: source(
    "flaky.loopy.ts",
    `import { loopy, sh } from "loopy/graph";

export default loopy("flaky-check", {
  description: "A check that always fails, so failure screens have data.",
  input: {},
  run: () => sh(["sh", "-c", "echo 'connection refused' >&2; exit 3"]),
});
`,
  ),
};

const daemon = Bun.spawn(
  [process.execPath, ...globals, "daemon", "run", "--port", values.port, "--concurrency", "6"],
  { cwd: workspace, env, stdin: "ignore", stdout: openSync(join(root, "daemon.log"), "a") },
);

async function stop(): Promise<void> {
  daemon.kill();
  await daemon.exited;
  rmSync(root, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stop().then(() => process.exit(0));
  });
}

try {
  let address: Schema.Schema.Type<typeof daemonFile> | null = null;

  while (address === null) {
    if (daemon.exitCode !== null) {
      throw new Error(`The daemon exited early. Inspect ${join(root, "daemon.log")}.`);
    }

    const status: unknown = JSON.parse(await loopy("daemon", "status"));
    address = Schema.is(daemonFile)(status) ? status : null;
    await Bun.sleep(100);
  }

  for (const file of Object.values(files)) {
    await loopy("save", file);
  }

  // The first triage run pins revision 1; saving again makes the next run use revision 2.
  await settled("triage-inbox", await start("triage-inbox", { mailbox: "support@acme.dev" }));
  writeFileSync(files.triage, triage(2));
  await loopy("save", files.triage);
  await start("triage-inbox", { mailbox: "support@acme.dev" });
  await start("review-changes", { packages: ["core", "runtime", "sdk", "cli", "dashboard"] });
  await start("release", { version: "1.4.0" });
  await settled("flaky-check", await start("flaky-check", {}));
  await loopy("schedule", "daily-digest", "--cron", "*/5 * * * *", "--tz", "UTC");

  const fragment = `#token=${address.token}`;
  process.stdout.write(`Seeded a demo daemon in ${root}.

Daemon dashboard:  http://127.0.0.1:${address.port}/${fragment}
Vite dev server:   LOOPY_API_ORIGIN=http://127.0.0.1:${address.port} bun run --cwd apps/dashboard dev
                   then open http://localhost:4173/${fragment}

Resolve the waiting release from the dashboard, or with:
  bun ${cli} --home ${home} hook <run-id> approve --payload '{"approved":true}'

Press Ctrl-C to stop the daemon and delete the demo state.
`);
  await daemon.exited;
} catch (error) {
  await stop();
  throw error;
}

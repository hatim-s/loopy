#!/usr/bin/env bun
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { WorkflowVersion } from "../application/ports.js";
import type { Json } from "../core/model.js";
import { generateCommand } from "../local/help.js";
import { localRunOptions } from "../local/process.js";
import { defaultHome, Registry } from "../local/registry.js";
import { createLocalRuntime } from "../local/runtime.js";
import { startServer } from "../local/server.js";
import { HostedPublisher } from "../publishing/client.js";
import type { PublishBundle } from "../publishing/manifest.js";
import { errorMessage } from "../runtime/errors.js";
import { parseCliArgs } from "./args.js";
import { prepareManifestFile } from "./publish.js";

const DEFAULT_PORT = 4310;

const usage = `loopy: TypeScript workflows for CLI tools

  loopy save <file.ts|directory>               Compile files and save by configured scope
  loopy publish <manifest.json> --out bundle.json  Prepare a declared portable bundle
  loopy publish <manifest.json> --origin https://host  Publish with LOOPY_PUBLISH_TOKEN
  loopy list                                   List saved loopies
  loopy graph <slug>                            Print the saved graph as JSON
  loopy run <slug> [--key value ...]            Run with string trigger inputs
  loopy run <slug> --args input.json            Run with a JSON input file
  loopy run <slug> --input JSON|@file           Run with JSON input
  loopy run <slug> --full                       Run with your full host permissions
  loopy resume <run-id> [--retry-uncertain]      Continue from saved checkpoints
  loopy recover <run-id> --force               Release a run owned by another host
  loopy runs [slug]                             List runs
  loopy inspect <run-id>                        Show inputs, attempts, outputs, and events
  loopy types <cli> [command...] --out file.ts   Generate a typed wrapper from CLI help
  loopy ui [--port ${DEFAULT_PORT}]                        Open a read-only graph and run viewer

  --home <directory>    Local definitions and run database. Default: ~/.loopy/v2
  --cwd <directory>     Workspace for a new run or the viewer. Default: current directory
  --replace            Transfer a saved slug from another source file
  --name <identifier>   Export name for a generated CLI wrapper

Run input: choose named flags, --args, or --input. Named values are strings.
Use --key=value for dash-prefixed values; use -- --key value for reserved names.

Saved TypeScript is trusted code executed during save. Saved graphs contain only data.
Sandbox runs deny network and restrict writes to the workspace. No host fallback.
Retrying an uncertain attempt can repeat a side effect from an interrupted command.
`;

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required. Run loopy --help for usage.`);
  return value;
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Port must be an integer from 0 to 65535.");
  return port;
}

async function readInput(value: string | undefined): Promise<Json> {
  if (value === undefined) return {};
  const text = value.startsWith("@") ? await Bun.file(resolve(value.slice(1))).text() : value;
  return JSON.parse(text) as Json;
}

/** Aborts the run on SIGINT/SIGTERM; the runtime then records where it stopped. */
function untilSignalled<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return work(controller.signal).finally(() => {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  });
}

export async function main(
  args = process.argv.slice(2),
  publishing?: { publish(bundle: PublishBundle): Promise<WorkflowVersion> },
) {
  const { values, positionals, triggerInput } = parseCliArgs(args);
  const [command, target, ...rest] = positionals;
  if (values.help || !command) {
    console.log(usage);
    return;
  }
  const home = resolve(values.home ?? defaultHome());
  const cwd = resolve(values.cwd ?? process.cwd());

  if (command === "types") {
    const destination = resolve(required(values.out, "--out"));
    const generated = await generateCommand(required(target, "CLI executable"), rest, {
      name: values.name,
    });
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, generated.source);
    for (const warning of generated.warnings) console.error(warning);
    print({ file: destination });
    return;
  }
  if (rest.length) throw new Error(`Unexpected arguments: ${rest.join(" ")}`);

  if (command === "publish") {
    if (values.out && values.origin) throw new Error("Choose --out or --origin for publishing");
    const publisher =
      publishing ??
      (values.origin
        ? new HostedPublisher({
            origin: values.origin,
            token: process.env.LOOPY_PUBLISH_TOKEN ?? "",
          })
        : undefined);
    if (!values.out && !publisher)
      throw new Error(
        "Publishing transport and isolated compiler are not configured. Use --out to prepare a bundle.",
      );
    const bundle = await prepareManifestFile(required(target, "Manifest JSON file"));
    if (values.out) {
      const file = resolve(values.out);
      await writeFile(file, JSON.stringify(bundle, null, 2));
      print({ file, sha256: bundle.sha256, bytes: bundle.bytes });
    } else if (publisher) print(await publisher.publish(bundle));
    return;
  }

  if (command === "ui") {
    const server = startServer({ home, cwd, port: parsePort(values.port) });
    console.log(server.url);
    // Both signals may arrive; stop() aborts running jobs and is safe to await twice.
    const stop = () => void server.stop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }

  let project = cwd;
  if (command === "save" && target && !values.cwd) {
    const source = resolve(target);
    const fromCwd = relative(cwd, source);
    if (fromCwd === ".." || fromCwd.startsWith("../"))
      project = (await stat(source)).isDirectory() ? source : dirname(source);
  }
  const registry = new Registry(home, project);
  switch (command) {
    case "save": {
      const source = required(target, "TypeScript file or directory");
      const options = { replace: values.replace };
      print(
        (await stat(source)).isDirectory()
          ? await registry.saveDirectory(source, options)
          : await registry.saveFile(source, options),
      );
      return;
    }
    case "list":
      print(registry.list());
      return;
    case "graph":
      print(registry.get(required(target, "Slug")).workflow);
      return;
    case "run":
    case "resume":
    case "recover":
    case "runs":
    case "inspect":
      break;
    default:
      throw new Error(`Unknown command '${command}'. Run loopy --help.`);
  }

  const local = createLocalRuntime({ home });
  const { runtime } = local;
  try {
    switch (command) {
      case "recover":
        if (!values.force)
          throw new Error(
            "Recovery requires --force. Stop the original host's runner first; it may still be executing a command.",
          );
        print(await local.recoverOwner(required(target, "Run ID")));
        return;
      case "runs":
        print(await runtime.listRuns(target));
        return;
      case "inspect": {
        const run = await runtime.getRun(required(target, "Run ID"));
        if (!run) throw new Error(`Unknown run '${target}'.`);
        print({
          run,
          attempts: await runtime.getAttempts(run.id),
          events: await runtime.getEvents(run.id),
        });
        return;
      }
    }
    let id: string;
    if (command === "run") {
      const workflow = registry.get(required(target, "Slug")).workflow;
      const options = localRunOptions(cwd, values.full ? "full" : "sandbox");
      id = (
        await runtime.createRun(
          workflow,
          values.args !== undefined
            ? await readInput(`@${values.args}`)
            : (triggerInput ?? (await readInput(values.input))),
          options,
        )
      ).id;
    } else {
      if (values.full || values.input || values.cwd)
        throw new Error("A resumed run keeps its original mode, input, and workspace.");
      id = required(target, "Run ID");
    }
    console.error(`Run ${id}`);
    const run = await untilSignalled((signal) =>
      runtime.execute(id, { retryUncertain: values["retry-uncertain"], signal }),
    );
    print(run);
    if (run.status !== "succeeded") process.exitCode = 1;
  } finally {
    local.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}

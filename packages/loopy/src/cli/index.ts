#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Json } from "../core/model.js";
import { generateCommand } from "../local/help.js";
import { localRunOptions } from "../local/process.js";
import { defaultHome, Registry } from "../local/registry.js";
import { createLocalRuntime } from "../local/runtime.js";
import { startServer } from "../local/server.js";

const usage = `loopy: TypeScript workflows for CLI tools

  loopy save <file.ts>                         Compile and save a default-exported workflow
  loopy list                                   List saved loopies
  loopy graph <slug>                            Print the saved graph as JSON
  loopy run <slug> [--input JSON|@file]          Run in a sandbox
  loopy run <slug> --full                       Run with your full host permissions
  loopy resume <run-id> [--retry-uncertain]      Continue from saved checkpoints
  loopy recover <run-id> --force               Release a run owned by another host
  loopy runs [slug]                             List runs
  loopy inspect <run-id>                        Show inputs, attempts, outputs, and events
  loopy types <cli> [command...] --out file.ts   Generate a typed wrapper from CLI help
  loopy ui [--port 4310]                        Open a read-only graph and run viewer

  --home <directory>    Local definitions and run database. Default: ~/.loopy/v2
  --cwd <directory>     Workspace for a new run or the viewer. Default: current directory
  --name <identifier>   Export name for a generated CLI wrapper

Saved TypeScript is trusted code executed during save. Saved graphs contain only data.
Sandbox runs deny network and restrict writes to the workspace. No host fallback.
Retrying an uncertain attempt can repeat a side effect from an interrupted command.
`;

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required. Run loopy --help for usage.`);
  return value;
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      home: { type: "string" },
      cwd: { type: "string" },
      input: { type: "string" },
      full: { type: "boolean" },
      out: { type: "string" },
      name: { type: "string" },
      port: { type: "string" },
      "retry-uncertain": { type: "boolean" },
      force: { type: "boolean" },
    },
  });
  if (values.help || !positionals[0]) {
    console.log(usage);
    return;
  }
  const [command, target, ...rest] = positionals;
  const home = resolve(values.home ?? defaultHome());
  const cwd = resolve(values.cwd ?? process.cwd());
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
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
  if (command === "ui") {
    const port = values.port === undefined ? 4310 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Port must be an integer from 0 to 65535.");
    const server = startServer({ home, cwd, port });
    console.log(server.url);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await server.stop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  const registry = new Registry(home);
  if (command === "save") {
    print(await registry.saveFile(required(target, "TypeScript file")));
    return;
  }
  if (command === "list") {
    print(registry.list());
    return;
  }
  if (command === "graph") {
    print(registry.get(required(target, "Slug")).workflow);
    return;
  }
  if (!["run", "resume", "recover", "runs", "inspect"].includes(command ?? ""))
    throw new Error(`Unknown command '${command}'. Run loopy --help.`);
  const local = createLocalRuntime({ home });
  const { runtime } = local;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    if (command === "recover") {
      if (!values.force)
        throw new Error(
          "Recovery requires --force. Stop the original host's runner first; it may still be executing a command.",
        );
      print(await local.recoverOwner(required(target, "Run ID")));
      return;
    }
    if (command === "runs") {
      print(await runtime.listRuns(target));
      return;
    }
    if (command === "inspect") {
      const run = await runtime.getRun(required(target, "Run ID"));
      if (!run) throw new Error(`Unknown run '${target}'.`);
      print({
        run,
        attempts: await runtime.getAttempts(run.id),
        events: await runtime.getEvents(run.id),
      });
      return;
    }
    let id: string;
    if (command === "run") {
      const inputText = values.input?.startsWith("@")
        ? await Bun.file(resolve(values.input.slice(1))).text()
        : values.input;
      const input = (inputText === undefined ? {} : JSON.parse(inputText)) as Json;
      const run = await runtime.createRun(
        registry.get(required(target, "Slug")).workflow,
        input,
        localRunOptions(cwd, values.full ? "full" : "sandbox"),
      );
      id = run.id;
    } else {
      if (values.full || values.input || values.cwd)
        throw new Error("A resumed run keeps its original mode, input, and workspace.");
      id = required(target, "Run ID");
    }
    console.error(`Run ${id}`);
    const run = await runtime.execute(id, {
      retryUncertain: values["retry-uncertain"],
      signal: controller.signal,
    });
    print(run);
    if (run.status !== "succeeded") process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    local.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

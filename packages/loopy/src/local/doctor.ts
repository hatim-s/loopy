import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { WorkflowNode } from "../core/model.js";
import { errorMessage } from "../runtime/errors.js";
import { packageDirectory, readBuildIdentity, runningBuildIdentity } from "./identity.js";
import { resolveProgram } from "./process.js";
import type { Registry } from "./registry.js";

type Finding = { level: "error" | "warning"; message: string; nodeId?: string };

/** Reads installed metadata and checks dependencies without importing workflow source. */
export async function doctor(registry: Registry, cwd: string, slug?: string) {
  const findings: Finding[] = [];
  const cli = { ...runningBuildIdentity(), packageDirectory };
  let authoring: (ReturnType<typeof readBuildIdentity> & { packageDirectory: string }) | undefined;
  try {
    let directory = dirname(realpathSync(Bun.resolveSync("loopy", cwd)));
    while (!existsSync(join(directory, "package.json"))) {
      const parent = dirname(directory);
      if (parent === directory) throw new Error("No package.json for the resolved loopy import");
      directory = parent;
    }
    authoring = { ...readBuildIdentity(directory), packageDirectory: directory };
    if (
      authoring.version !== cli.version ||
      (authoring.artifactSha256 &&
        cli.artifactSha256 &&
        authoring.artifactSha256 !== cli.artifactSha256)
    )
      findings.push({
        level: "warning",
        message:
          "The project's loopy package differs from this CLI build. Install the same package archive in the project and globally, then save the workflow again.",
      });
    else if (!authoring.artifactSha256 || !cli.artifactSha256)
      findings.push({
        level: "warning",
        message:
          "Build identity is unavailable for the CLI or authoring package. Rebuild or install a package with build-info.json to compare exact builds.",
      });
  } catch {
    findings.push({
      level: "warning",
      message:
        "This project cannot resolve the loopy authoring package. Run bun add <the archive printed by install:global> in the project, or bun add loopy for a published release. The global CLI does not provide project imports.",
    });
  }

  const registrations = registry.diagnose().filter((item) => !slug || item.slug === slug);
  for (const registration of registrations) {
    if (registration.error)
      findings.push({ level: "error", message: `${registration.file}: ${registration.error}` });
    if (registration.source && !existsSync(registration.source))
      findings.push({
        level: "warning",
        message: `Source no longer exists: ${registration.source}. The saved graph can still run; restore the source before editing or migrating it.`,
      });
  }
  const commands: {
    nodeId: string;
    conditional: boolean;
    program: string;
    resolvedProgram?: string;
  }[] = [];
  const walk = async (nodes: readonly WorkflowNode[], conditional = false): Promise<void> => {
    for (const node of nodes) {
      if (node.kind === "condition") {
        await walk(node.then, true);
        await walk(node.else, true);
        continue;
      }
      const command = node.command;
      const entry: (typeof commands)[number] = {
        nodeId: node.id,
        conditional,
        program: command.program,
      };
      commands.push(entry);
      const directory = resolve(cwd, command.cwd ?? ".");
      try {
        if (!statSync(directory).isDirectory())
          throw new Error(`Not a command directory: ${directory}`);
        const path = command.env?.PATH;
        if (path !== undefined && typeof path !== "string") {
          findings.push({
            level: "warning",
            nodeId: node.id,
            message:
              "Program lookup depends on a runtime PATH value. Check it with the actual run input.",
          });
        } else {
          entry.resolvedProgram = await resolveProgram(
            command.program,
            directory,
            path ?? process.env.PATH ?? "",
          );
        }
      } catch (error) {
        findings.push({
          level: conditional ? "warning" : "error",
          nodeId: node.id,
          message: `${errorMessage(error)}. Restore the directory or install the program, then rerun doctor.`,
        });
      }
      for (const arg of command.args) {
        const path =
          typeof arg === "string" && isAbsolute(arg)
            ? arg
            : arg && typeof arg === "object" && "$file" in arg
              ? resolve(directory, arg.$file)
              : undefined;
        if (path && !existsSync(path))
          findings.push({
            level: "warning",
            nodeId: node.id,
            message: `Argument path does not exist: ${path}. Restore it if the command reads it. A new output destination may legitimately be absent.`,
          });
      }
    }
  };
  if (slug) {
    try {
      await walk(registry.get(slug).workflow.nodes);
    } catch (error) {
      findings.push({ level: "error", message: errorMessage(error) });
    }
  }
  return {
    ok: !findings.some((item) => item.level === "error"),
    cli,
    authoring,
    home: registry.home,
    project: registry.project,
    workspace: cwd,
    registrations,
    commands,
    findings,
    coverage:
      "Doctor reads metadata and host paths without running commands. Conditional dependencies are advisory. It does not validate script contents, runtime inputs, or sandbox access.",
  };
}

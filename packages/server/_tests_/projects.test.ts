import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ShellNodeSchema, WorkflowDefinitionSchema } from "@loopy/contracts";
import { runningServer, serverRequest } from "../../cli/src/server";
import { createProjectCatalog } from "../src/projects";

test("project catalog canonicalizes aliases, persists entries, and forgets without deleting files", () => {
  const root = mkdtempSync(resolve(tmpdir(), "loopy-project-catalog-"));
  try {
    const project = resolve(root, "project");
    mkdirSync(project);
    const alias = resolve(root, "alias");
    symlinkSync(project, alias);
    const home = resolve(root, "catalog");
    const catalog = createProjectCatalog(home);
    const first = catalog.remember(project);
    expect(catalog.remember(alias).id).toBe(first.id);
    expect(createProjectCatalog(home).list()).toHaveLength(1);
    expect(() => catalog.remember("relative/path")).toThrow("absolute");
    catalog.forget(first.id);
    expect(catalog.list()).toHaveLength(0);
    expect(existsSync(project)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opening a second project preserves the first run and isolates workflow versions", async () => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "loopy-project-switch-")));
  const a = resolve(root, "project-a");
  const b = resolve(root, "project-b");
  for (const project of [a, b]) {
    mkdirSync(project);
    writeFileSync(resolve(project, "index.html"), "<html><head></head></html>");
  }
  const command = async (project: string, action: string) => {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../cli/src/index.ts"),
        "server",
        action,
        "--project",
        project,
        "--studio-dir",
        a,
      ],
      {
        env: { ...process.env, LOOPY_HOME: resolve(root, "catalog") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(stderr || stdout);
  };
  try {
    await command(a, "start");
    const first = await runningServer(a);
    if (!first) throw new Error("Missing first server");
    expect((await fetch(`${first.url}/api/v1/projects`)).status).toBe(401);
    const fixture = await Bun.file(
      new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url),
    ).json();
    const definition = WorkflowDefinitionSchema.parse(fixture);
    definition.name = "First project graph";
    definition.inputs = [];
    definition.edges = [];
    definition.nodes = [
      ShellNodeSchema.parse({
        id: crypto.randomUUID(),
        name: "Still running",
        kind: "shell",
        stages: ["sleep 1; printf retained"],
        execution: "host",
      }),
    ];
    definition.policies.workspace = {
      useGitWorktree: false,
      allowDirtyWorkspace: true,
      writableRoots: [a],
    };
    await serverRequest(first, "/workflows", { definition });
    const run = (await serverRequest(first, "/runs", { workflowId: definition.id })) as {
      id: string;
    };
    const opened = (await serverRequest(first, "/projects/open", { path: b })) as {
      url: string;
      project: { id: string };
    };
    const second = await runningServer(b);
    if (!second) throw new Error("Missing second server");
    expect(opened.url).toBe(second.url);
    expect(second.pid).not.toBe(first.pid);
    const list = (await serverRequest(second, "/projects")) as {
      projects: Array<{ path: string; running: boolean }>;
    };
    expect(list.projects.map((p) => p.path).sort()).toEqual([a, b]);
    expect(list.projects.every((p) => p.running)).toBe(true);
    expect(JSON.stringify(list)).not.toContain(first.token);
    expect(await serverRequest(second, "/workflows")).toEqual({ workflows: [] });
    await serverRequest(second, "/workflows", {
      definition: { ...definition, name: "Second project graph" },
    });
    const read = (await serverRequest(first, `/workflows/${definition.id}`)) as {
      versions: Array<{ definition: { name: string } }>;
    };
    expect(read.versions[0]?.definition.name).toBe("First project graph");
    let snapshot: { status: string; attempts: Array<{ output?: { stdout?: string } }> } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      snapshot = (await serverRequest(first, `/runs/${run.id}`)) as typeof snapshot;
      if (snapshot?.status === "succeeded") break;
      await Bun.sleep(30);
    }
    expect(snapshot?.status).toBe("succeeded");
    expect(snapshot?.attempts[0]?.output?.stdout).toBe("retained");
    await serverRequest(first, "/projects/forget", { id: opened.project.id });
    expect(await runningServer(b)).toBeDefined();
    expect(existsSync(resolve(b, ".loopy"))).toBe(true);
  } finally {
    await command(a, "stop");
    await command(b, "stop");
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

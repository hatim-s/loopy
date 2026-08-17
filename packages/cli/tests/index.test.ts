import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "@loopy/storage";
import { describe, expect, it, vi } from "vitest";
import { main, mainAsync } from "../src/index";

describe("loopy CLI shell", () => {
  it("prints a version without invoking an unimplemented command", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(main(["--version"])).toBe(0);
    expect(output).toHaveBeenCalledWith("0.1.0");

    output.mockRestore();
  });

  it("returns a non-zero status when run is missing its approved workflow", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await mainAsync(["run"])).toBe(1);
    expect(error).toHaveBeenCalledWith("loopy: run requires a workflow ID");

    error.mockRestore();
  });

  it("executes the package bin entry point directly", () => {
    const packageDirectory = resolve(fileURLToPath(import.meta.url), "../..");
    const packageJson = JSON.parse(
      readFileSync(resolve(packageDirectory, "package.json"), "utf8"),
    ) as { bin: { loopy: string } };
    if (!existsSync(resolve(packageDirectory, packageJson.bin.loopy)))
      spawnSync(process.execPath, ["run", "build"], { cwd: packageDirectory, encoding: "utf8" });
    const result = spawnSync(resolve(packageDirectory, packageJson.bin.loopy), ["--version"], {
      encoding: "utf8",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
  });

  it("runs an approved extracted workflow through the local fake runtime", async () => {
    const project = mkdtempSync(join(tmpdir(), "loopy-cli-flow-"));
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.map((value) => String(value)).join(" "));
    });
    const lastJson = <T>(): T => JSON.parse(output.at(-1) ?? "null") as T;
    try {
      const fixture = resolve("fixtures/sessions/successful.json");
      expect(
        await mainAsync(["import", fixture, "--provider", "codex", "--project", project, "--json"]),
      ).toBe(0);
      const imported = lastJson<{ id: string }>();

      expect(
        await mainAsync(["extract", "--import", imported.id, "--project", project, "--json"]),
      ).toBe(0);
      const extraction = lastJson<{ output: { proposal: { id: string } } }>();

      expect(
        await mainAsync([
          "review",
          "show",
          extraction.output.proposal.id,
          "--project",
          project,
          "--json",
        ]),
      ).toBe(0);
      const review = lastJson<{ proposal: { id: string; workflow: { id: string } } }>();
      expect(await mainAsync(["approve", review.proposal.id, "--project", project, "--json"])).toBe(
        0,
      );

      expect(
        await mainAsync([
          "run",
          review.proposal.workflow.id,
          "--project",
          project,
          "--local",
          "--input",
          JSON.stringify({ task: "replay" }),
          "--json",
        ]),
      ).toBe(0);
      const run = lastJson<{ run: { status: string }; attempts: unknown[] }>();
      expect(run.run.status).toBe("succeeded");
      expect(run.attempts.length).toBeGreaterThan(0);

      const persisted = new Storage({ projectDir: project });
      expect(persisted.runtime.listWorkflowVersions()).toHaveLength(1);
      expect(persisted.runtime.listRuns("succeeded")).toHaveLength(1);
      persisted.close();
    } finally {
      log.mockRestore();
    }
  });

  it("creates and inspects local schedules through JSON CLI commands", async () => {
    const project = mkdtempSync(join(tmpdir(), "loopy-cli-schedule-"));
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.map((value) => String(value)).join(" "));
    });
    try {
      expect(
        await mainAsync([
          "schedule",
          "create",
          "--id",
          "hourly",
          "--workflow",
          "workflow-1",
          "--cron",
          "0 * * * *",
          "--timezone",
          "UTC",
          "--project",
          project,
          "--json",
        ]),
      ).toBe(0);
      expect(JSON.parse(output.at(-1) ?? "null").id).toBe("hourly");
      expect(await mainAsync(["schedule", "list", "--project", project, "--json"])).toBe(0);
      expect(JSON.parse(output.at(-1) ?? "[]")).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("keeps UI tests listener-free and supports an injected launcher/server", async () => {
    const launched: string[] = [];
    let stopped = false;
    const code = await mainAsync(
      ["ui", "--no-open", "--project", mkdtempSync(join(tmpdir(), "loopy-ui-"))],
      {
        ui: {
          studioDir: tmpdir(),
          serverFactory: ({ config }) => ({
            url: `http://${config.host}:${config.port}/`,
            token: config.token,
            stop: () => {
              stopped = true;
            },
          }),
          launcher: (url) => {
            launched.push(url);
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(launched).toEqual([]);
    expect(stopped).toBe(false);
  });
});

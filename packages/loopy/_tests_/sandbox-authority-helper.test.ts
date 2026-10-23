import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { DockerArtifacts } from "../../../apps/sandbox/src/artifacts.js";
import type { CommandRunner } from "../../../apps/sandbox/src/process.js";
import { authorityFixture } from "./fixtures/sandbox-authority.js";

test("helper cleanup checks exact name and labels, then verifies absence after removal", async () => {
  const { config, plan, root } = await authorityFixture();
  const receipt = plan();
  const helper = `loopy-artifact-${receipt.id}`;
  let present = true;
  let wrongOwner = false;
  let removeWorks = false;
  let removals = 0;

  const runner: CommandRunner = async (argv) => {
    const command = argv.slice(3);
    let stdout = "";

    if (command[0] === "container" && command[1] === "ls") {
      expect(command).toContain(`name=^/${helper}$`);
      stdout = present ? helper : "";
    } else if (command[0] === "container" && command[1] === "inspect") {
      stdout = JSON.stringify([
        {
          Config: {
            Labels: {
              "loopy.sandbox.owner": wrongOwner
                ? "foreign"
                : createHash("sha256").update(config.stateRoot).digest("hex"),
              "loopy.sandbox.request": receipt.requestHash,
              "loopy.sandbox.role": "artifact",
            },
          },
        },
      ]);
    } else if (command[0] === "rm") {
      expect(command).toEqual(["rm", "--force", helper]);
      removals++;

      if (removeWorks) {
        present = false;
      }
    } else {
      throw new Error("Unexpected Docker call");
    }

    return { stdout, stderr: "", exitCode: 0, durationMs: 0 };
  };

  try {
    const reader = new DockerArtifacts(config, runner);
    await expect(reader.cleanup(receipt, `loopy-artifact-${"a".repeat(64)}`)).rejects.toThrow(
      "identity",
    );
    wrongOwner = true;
    await expect(reader.cleanup(receipt, helper)).rejects.toThrow("ownership");
    expect(removals).toBe(0);
    wrongOwner = false;
    await expect(reader.cleanup(receipt, helper)).rejects.toThrow("not yet confirmed");
    expect(removals).toBe(1);
    removeWorks = true;
    await reader.cleanup(receipt, helper);
    expect(present).toBe(false);
    await reader.cleanup(receipt, helper);
    expect(removals).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

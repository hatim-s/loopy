import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { artifactHelperName } from "@loopy/contract/sandbox";
import { Effect } from "effect";
import { DockerArtifacts } from "../src/artifacts";
import { DockerClient } from "../src/docker/client";
import { ownerOf } from "../src/docker/identity";
import type { CommandRunner } from "../src/process";
import { authorityFixture } from "./fixtures/authority";
import { run } from "./fixtures/run";

test("helper cleanup checks exact name and labels, then verifies absence after removal", async () => {
  const { config, plan, root } = await authorityFixture();
  const receipt = await plan();
  const helper = artifactHelperName(receipt.id);
  let present = true;
  let wrongOwner = false;
  let removeWorks = false;
  let removals = 0;

  const runner: CommandRunner = (argv) =>
    Effect.gen(function* () {
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
                "loopy.sandbox.owner": wrongOwner ? "foreign" : ownerOf(config.stateRoot),
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
        return yield* Effect.die(new Error("Unexpected Docker call"));
      }

      return { stdout, stderr: "", exitCode: 0, durationMs: 0 };
    });

  try {
    const reader = new DockerArtifacts(config, new DockerClient(config, runner));
    wrongOwner = true;
    await expect(run(reader.cleanup(receipt))).rejects.toThrow("ownership");
    expect(removals).toBe(0);
    wrongOwner = false;
    await expect(run(reader.cleanup(receipt))).rejects.toThrow("not yet confirmed");
    expect(removals).toBe(1);
    removeWorks = true;
    await run(reader.cleanup(receipt));
    expect(present).toBe(false);
    await run(reader.cleanup(receipt));
    expect(removals).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

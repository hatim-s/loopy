import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { artifactHelperName } from "@loopy/contract/sandbox";
import { Effect } from "effect";
import { DockerArtifacts } from "../src/artifacts";
import { DockerClient } from "../src/docker/client";
import { ownerOf, SANDBOX_LABELS } from "../src/docker/identity";
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
  const listings: string[][] = [];
  const removals: string[][] = [];

  const runner: CommandRunner = (argv) =>
    Effect.gen(function* () {
      const command = argv.slice(3);
      let stdout = "";

      if (command[0] === "container" && command[1] === "ls") {
        listings.push(command);
        stdout = present ? helper : "";
      } else if (command[0] === "container" && command[1] === "inspect") {
        stdout = JSON.stringify([
          {
            Config: {
              Labels: {
                [SANDBOX_LABELS.owner]: wrongOwner ? "foreign" : ownerOf(config.stateRoot),
                [SANDBOX_LABELS.request]: receipt.requestHash,
                [SANDBOX_LABELS.role]: "artifact",
              },
            },
          },
        ]);
      } else if (command[0] === "rm") {
        removals.push(command);

        if (removeWorks) {
          present = false;
        }
      } else {
        return yield* Effect.die(new Error("Unexpected Docker call"));
      }

      return { stdout, stderr: "", exitCode: 0 };
    });

  try {
    const reader = new DockerArtifacts(config, new DockerClient(config, runner));
    wrongOwner = true;
    await expect(run(reader.cleanup(receipt))).rejects.toThrow("ownership");
    expect(removals).toHaveLength(0);
    wrongOwner = false;
    await expect(run(reader.cleanup(receipt))).rejects.toThrow("not yet confirmed");
    expect(removals).toHaveLength(1);
    removeWorks = true;
    await run(reader.cleanup(receipt));
    expect(present).toBe(false);
    await run(reader.cleanup(receipt));
    expect(removals).toEqual([
      ["rm", "--force", helper],
      ["rm", "--force", helper],
    ]);
    expect(listings.length).toBeGreaterThan(0);

    for (const listing of listings) {
      expect(listing).toContain(`name=^/${helper}$`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import {
  artifactHelperName,
  dockerAttemptPlanSchema,
  inputHelperName,
} from "@loopy/contract/sandbox";
import { Schema } from "effect";
import { ownerOf, SANDBOX_LABELS } from "../../../sandbox/src/docker/identity";
import { filesystemReceipts } from "../filesystem-receipt";
import { assert, equal } from "../shared/assert";

type Docker = (args: string[]) => Promise<string>;

type Owner = { container: string; requestHash: string };

const decodeContainer = Schema.decodeUnknownSync(
  Schema.Tuple([
    Schema.Struct({
      Id: Schema.String,
      Name: Schema.String,
      Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
      State: Schema.Struct({
        Running: Schema.Boolean,
        StartedAt: Schema.String,
        FinishedAt: Schema.String,
      }),
      Mounts: Schema.Array(
        Schema.Struct({ Type: Schema.String, Name: Schema.optional(Schema.String) }),
      ),
    }),
  ]),
);

const isVolume = {
  input: Schema.is(dockerAttemptPlanSchema.fields.inputVolume),
  workspace: Schema.is(dockerAttemptPlanSchema.fields.volume),
};

/**
 * The Docker containers and volumes one sandbox state root owns. Receipts name every resource,
 * because the sandbox persists admission before it creates anything in Docker.
 */
export class OwnedResources {
  private readonly owner: string;

  constructor(
    private readonly stateRoot: string,
    private readonly docker: Docker,
  ) {
    this.owner = ownerOf(stateRoot);
  }

  receipts() {
    return filesystemReceipts(this.stateRoot);
  }

  async container(receipt: Owner, name = receipt.container) {
    const [row] = decodeContainer(JSON.parse(await this.docker(["container", "inspect", name])));
    equal(row.Name, `/${name}`, "container_name_mismatch");
    equal(row.Config.Labels[SANDBOX_LABELS.owner], this.owner, "container_owner_mismatch");
    equal(row.Config.Labels[SANDBOX_LABELS.request], receipt.requestHash, "request_owner_mismatch");

    return row;
  }

  async remove() {
    const removed: string[] = [];
    const volumes = new Set<string>();

    for (const receipt of await this.receipts()) {
      assert(isVolume.input(receipt.inputVolume), "cleanup_volume_identity_mismatch");
      assert(isVolume.workspace(receipt.volume), "cleanup_volume_identity_mismatch");
      volumes.add(receipt.inputVolume);
      volumes.add(receipt.volume);

      for (const name of [
        receipt.container,
        inputHelperName(receipt),
        artifactHelperName(receipt.id),
      ]) {
        const listed = await this.list(["container", "ls", "--all"], `name=^/${name}$`, "Names");

        if (!listed) {
          continue;
        }

        equal(listed, name, "cleanup_container_identity_mismatch");
        const row = await this.container(receipt, name);
        assert(
          row.Mounts.every((mount) => mount.Type !== "bind"),
          "unexpected_host_bind_mount",
        );

        for (const mount of row.Mounts) {
          if (mount.Type === "volume") {
            assert(mount.Name && volumes.has(mount.Name), "unrecorded_volume_mount");
          }
        }

        await this.docker(["rm", "--force", name]);
        removed.push(name);
      }
    }

    for (const volume of volumes) {
      const listed = await this.list(["volume", "ls"], `name=^${volume}$`, "Name");

      if (listed) {
        equal(listed, volume, "cleanup_volume_identity_mismatch");
        await this.docker(["volume", "rm", volume]);
      }

      equal(
        await this.list(["volume", "ls"], `name=^${volume}$`, "Name"),
        "",
        "owned_volume_remains",
      );
    }

    equal(
      await this.list(
        ["container", "ls", "--all"],
        `label=${SANDBOX_LABELS.owner}=${this.owner}`,
        "Names",
      ),
      "",
      "owned_container_remains",
    );

    return {
      containersRemoved: removed,
      volumesCheckedAbsent: [...volumes],
      ownedContainersRemaining: 0,
      ownedVolumesRemaining: 0,
    };
  }

  private async list(command: string[], filter: string, field: "Names" | "Name") {
    return (
      await this.docker([...command, "--filter", filter, "--format", `{{.${field}}}`])
    ).trim();
  }
}

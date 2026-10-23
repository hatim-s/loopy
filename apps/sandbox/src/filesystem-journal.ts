import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type AttemptRecord,
  AuthorityError,
  artifactHelperName,
  attemptRecordSchema,
  attemptResourceNames,
  type DockerAttemptPlan,
  type ExportRecord,
  exportRecordSchema,
  workspaceVolumeInput,
} from "../../../packages/loopy/src/contract/sandbox-journal.js";
import { attemptHash, attemptId } from "./admission.js";
import { readBytes } from "./journal-files.js";
import { storedReceiptSchema } from "./receipts.js";

export class FilesystemJournal {
  constructor(private readonly root: string) {}
  validPlan(plan: DockerAttemptPlan) {
    const names = attemptResourceNames(plan.id, attemptHash(workspaceVolumeInput(this.root, plan)));

    return (
      plan.id === attemptId(this.root, plan) &&
      plan.container === names.container &&
      plan.inputVolume === names.inputVolume &&
      plan.volume === names.volume
    );
  }

  async read(id: string): Promise<AttemptRecord | null> {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new AuthorityError("invalid_state");
    }

    const bytes = await readBytes(join(this.root, "receipts", `${id}.json`));

    if (!bytes) {
      return null;
    }

    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const parsed = attemptRecordSchema.safeParse(value);
    let record: AttemptRecord;

    if (parsed.success) {
      record = parsed.data;
    } else {
      const legacy = storedReceiptSchema.parse(value);
      const { kind, ...fields } = legacy;

      const plan = {
        id: fields.id,
        requestHash: fields.requestHash,
        workspace: fields.workspace,
        executionKey: fields.executionKey,
        attempt: fields.attempt,
        container: fields.container,
        inputVolume: fields.inputVolume,
        volume: fields.volume,
        deadline: fields.deadline,
      };

      const session = { epoch: 1, nonce: "legacy-filesystem-recovery" };
      record =
        kind === "started"
          ? { kind, plan, session }
          : { kind, plan, session, result: { kind: "inline", value: legacy.result } };
    }

    if (record.plan.id !== id || !this.validPlan(record.plan)) {
      throw new Error("Sandbox receipt identity does not match its configured root.");
    }

    return record;
  }

  async records() {
    const result: AttemptRecord[] = [];

    for (const name of await readdir(join(this.root, "receipts"))) {
      if (/^[a-f0-9]{64}\.json$/.test(name)) {
        const record = await this.read(name.slice(0, -5));

        if (record) {
          result.push(record);
        }
      }
    }

    return result;
  }

  releasedPath(token: string) {
    return join(
      this.root,
      "exports",
      `${createHash("sha256").update(token).digest("hex")}.released.json`,
    );
  }

  async released(token: string) {
    const bytes = await readBytes(this.releasedPath(token));

    if (!bytes) {
      return null;
    }

    const record = exportRecordSchema.parse(JSON.parse(bytes.toString("utf8")));

    if (record.token !== token) {
      throw new Error("Released export token does not match its path.");
    }

    return record;
  }

  async exportMetadata() {
    const result: ExportRecord[] = [];

    for (const name of await readdir(join(this.root, "exports"))) {
      if (/^[a-f0-9]{64}\.json$/.test(name)) {
        const bytes = await readBytes(join(this.root, "exports", name));

        if (bytes) {
          const record = exportRecordSchema.parse(JSON.parse(bytes.toString("utf8")));

          if (
            `${record.attemptId}.json` !== name ||
            record.helper !== artifactHelperName(record.attemptId)
          ) {
            throw new Error("Sandbox export guard identity does not match its path.");
          }

          result.push(record);
        }
      }
    }

    return result;
  }

  async guards() {
    const guards = await this.exportMetadata();

    for (const record of guards) {
      const attempt = await this.read(record.attemptId);

      if (!attempt || attempt.plan.volume !== record.volume) {
        throw new Error("Sandbox export guard does not match its admitted workspace.");
      }
    }

    return guards;
  }
}

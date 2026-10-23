import { expect, test } from "bun:test";
import { FilesystemAuthority } from "../../../apps/sandbox/src/filesystem-authority.js";
import type { SandboxExecutionResult } from "../src/contract/index.js";
import type { AuthorityInput } from "../src/contract/sandbox-journal-rpc.js";
import { artifactReader, successful, uncertain } from "./fixtures/sandbox-authority.js";
import { fixture, open } from "./fixtures/sandbox-authority-lifecycle.js";

class DelayedCommit extends FilesystemAuthority {
  private pending: AuthorityInput<"admit"> | null = null;
  override async admit(input: AuthorityInput<"admit">) {
    if (this.pending === null) {
      this.pending = input;
      throw new Error("Admit timed out before eventual commit");
    }

    return super.admit(input);
  }
  async commit() {
    if (!this.pending) {
      throw new Error("No delayed admission");
    }

    return super.admit(this.pending);
  }
}

for (const trigger of ["start", "lookup"] as const) {
  test(`delayed admission commit after absent resolving read starts once on later ${trigger}`, async () => {
    const { config, request, resultsFor } = await fixture();
    const authority = new DelayedCommit(config.stateRoot);
    const completed = Promise.withResolvers<SandboxExecutionResult>();
    let starts = 0;
    let recoveries = 0;

    const service = await open(config, {
      authority,
      resultsFor,
      artifactReader,
      backend: {
        start: async () => {
          starts++;

          return completed.promise;
        },
        recover: async () => {
          recoveries++;

          return uncertain;
        },
      },
    });

    await expect(service.start(request)).rejects.toThrow("timed out before eventual commit");
    expect(starts).toBe(0);
    expect(await service.lookup(request)).toEqual({ kind: "none" });
    expect((await authority.commit()).kind).toBe("created");
    expect(await service[trigger](request)).toEqual({ kind: "started" });
    await service.start(request);
    expect(starts).toBe(1);
    expect(recoveries).toBe(0);
    completed.resolve(successful);
    await service.drain();
    expect(await service.lookup(request)).toEqual({ kind: "finished", result: successful });
  });
}

import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { ModalClient, NotFoundError } from "modal";
import { ClientError, Status } from "nice-grpc";
import { ModalWorkspaceProvider, modalWorkspaceSchema } from "../src/providers/modal-workspace.js";

test("Modal workspace bindings are immutable, tenant-bound and never replaced after loss", async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-07-30",
    d1Databases: { DB: "modal-workspace" },
  });
  // Inject only the RPC boundary. fromId and poll execute the pinned SDK implementation.
  let result = { status: 0, exitcode: 0 };
  let failure: Error | undefined;
  const calls: { sandboxId: string; timeout: number }[] = [];
  const sandboxWait = async (request: { sandboxId: string; timeout: number }) => {
    calls.push(request);
    if (failure) throw failure;
    return { result };
  };
  const rpcCalls = { v1: 0, v2: 0 };
  const cpClient = {
    sandboxWait: async (request: { sandboxId: string; timeout: number }) => {
      rpcCalls.v1++;
      return await sandboxWait(request);
    },
    sandboxWaitV2: async (request: { sandboxId: string; timeout: number }) => {
      rpcCalls.v2++;
      return await sandboxWait(request);
    },
  } as unknown as ModalClient["cpClient"];
  const client = new ModalClient({ cpClient });
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of modalWorkspaceSchema) await db.prepare(sql).run();
    const scope = { tenantId: "tenant" };
    const provider = new ModalWorkspaceProvider(db, client, scope);
    const workspace = await provider.bind("run", "workspace", "sb-test");
    expect(await provider.provision(scope, "run", "workspace")).toEqual(workspace);
    expect(await provider.inspect(scope, workspace)).toBe("available");
    expect(calls).toEqual([{ sandboxId: "sb-test", timeout: 0 }]);
    result = { status: 1, exitcode: 1 };
    expect(await provider.inspect(scope, workspace)).toBe("lost");
    const restarted = new ModalWorkspaceProvider(db, client, scope);
    expect(await restarted.provision(scope, "run", "workspace")).toEqual(workspace);
    await expect(restarted.bind("run", "workspace", "sb-replacement")).rejects.toThrow("conflict");
    await expect(restarted.bind("another-run", "workspace", "sb-test")).rejects.toThrow();
    const foreign = new ModalWorkspaceProvider(db, client, { tenantId: "foreign" });
    expect(await foreign.inspect({ tenantId: "foreign" }, workspace)).toBe("lost");
    await expect(foreign.bind("run", "workspace", "sb-test")).rejects.toThrow();
    await expect(provider.provision({ tenantId: "foreign" }, "run", "workspace")).rejects.toThrow(
      "tenant mismatch",
    );
    expect(await provider.inspect(scope, { ...workspace, generation: "other" })).toBe("lost");
    failure = new NotFoundError("missing");
    expect(await provider.inspect(scope, workspace)).toBe("lost");
    failure = new ClientError("/modal.client.ModalClient/SandboxWait", Status.NOT_FOUND, "missing");
    expect(await provider.inspect(scope, workspace)).toBe("lost");
    const v1Workspace = await provider.bind("v1-run", "v1-workspace", `sb-${"a".repeat(22)}`);
    expect(await provider.inspect(scope, v1Workspace)).toBe("lost");
    expect(rpcCalls.v1).toBeGreaterThan(0);
    expect(rpcCalls.v2).toBeGreaterThan(0);
    for (const code of [
      Status.UNAUTHENTICATED,
      Status.PERMISSION_DENIED,
      Status.UNAVAILABLE,
      Status.DEADLINE_EXCEEDED,
    ]) {
      failure = new ClientError("/modal.client.ModalClient/SandboxWait", code, "rpc failed");
      await expect(provider.inspect(scope, workspace)).rejects.toBe(failure);
    }
    failure = new Error("temporary transport failure");
    await expect(provider.inspect(scope, workspace)).rejects.toBe(failure);
    await expect(provider.provision(scope, "unassigned", "workspace")).rejects.toThrow("assigned");
  } finally {
    await mf.dispose();
  }
}, 30000);

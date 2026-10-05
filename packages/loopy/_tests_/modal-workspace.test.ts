import { expect, spyOn, test } from "bun:test";
import { Miniflare } from "miniflare";
import { ModalClient, NotFoundError, Sandbox } from "modal";
import { ModalWorkspaceProvider, modalWorkspaceSchema } from "../src/providers/modal-workspace.js";

test("Modal workspace bindings are immutable, tenant-bound and never replaced after loss", async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-07-30",
    d1Databases: { DB: "modal-workspace" },
  });
  // Exercise the pinned SDK's public handle API; poll responses below are local test doubles.
  const client = new ModalClient({ tokenId: "test-placeholder", tokenSecret: "test-placeholder" });
  const poll = spyOn(Sandbox.prototype, "poll").mockResolvedValue(null);
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of modalWorkspaceSchema) await db.prepare(sql).run();
    const scope = { tenantId: "tenant" };
    const provider = new ModalWorkspaceProvider(db, client, scope);
    const workspace = await provider.bind("run", "workspace", "sb-test");
    expect(await provider.provision(scope, "run", "workspace")).toEqual(workspace);
    expect(await provider.inspect(scope, workspace)).toBe("available");
    poll.mockResolvedValue(1);
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
    poll.mockRejectedValue(new NotFoundError("missing"));
    expect(await provider.inspect(scope, workspace)).toBe("lost");
    poll.mockRejectedValue(new Error("temporary transport failure"));
    await expect(provider.inspect(scope, workspace)).rejects.toThrow("transport failure");
    await expect(provider.provision(scope, "unassigned", "workspace")).rejects.toThrow("assigned");
  } finally {
    poll.mockRestore();
    await mf.dispose();
  }
}, 30000);

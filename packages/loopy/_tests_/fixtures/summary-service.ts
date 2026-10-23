import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definitionSummary } from "../../src/contract/index.js";
import { type RunRecord, revision } from "../../src/core/index.js";
import { Registry } from "../../src/local/registry.js";
import { type ArtifactRegistry, LoopyService } from "../../src/service/index.js";
import { MemoryStore } from "../../src/store/index.js";
import { compiledBody } from "../compiled-fixture.js";

export class SummaryCountsStore extends MemoryStore {
  groupedReads = 0;

  override async runCountsByDefinition() {
    // Lists must group counts once instead of querying once per definition.
    this.groupedReads++;

    return super.runCountsByDefinition();
  }
}

export function summaryServiceFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "loopy-summary-service-")));
  const home = join(directory, "home");
  const a = join(directory, "a");
  const b = join(directory, "b");

  for (const path of [a, b]) {
    mkdirSync(join(path, ".loopy", "loopies"), { recursive: true });
  }

  const graphs: string[] = [];

  const calls = {
    lists: new Map<string, number>(),
    summaries: new Map<string, number>(),
    graphs,
  };

  const store = new SummaryCountsStore();

  const registry = (workspace: string) =>
    new Registry(home, workspace === "" || workspace === "alias" ? a : workspace);

  const adapter = (workspace: string): ArtifactRegistry => {
    const native = registry(workspace);

    return {
      workspace: async () => native.project,
      listSummaries: async () => {
        calls.lists.set(native.project, (calls.lists.get(native.project) ?? 0) + 1);

        return native.list().map(definitionSummary);
      },
      summary: async (slug) => {
        const key = JSON.stringify([native.project, slug]);
        calls.summaries.set(key, (calls.summaries.get(key) ?? 0) + 1);
        const saved = native.list().find((entry) => entry.slug === slug);

        return saved ? definitionSummary(saved) : null;
      },
      get: async (slug) => {
        calls.graphs.push(slug);

        if (slug === "missing") {
          return null;
        }

        if (slug === "corrupt") {
          throw new Error("Stored graph is corrupt.");
        }

        return native.get(slug);
      },
      save: async (body) => {
        native.save(body);
      },
      revisionGraph: (hash) => native.revisionGraph(hash),
      revisionSource: (slug, hash) => native.revisionSource(slug, hash),
    };
  };

  const service = new LoopyService({
    store,
    registry: adapter,
    clock: { now: () => Date.parse("2026-10-23T00:00:00.000Z") },
    canonicalWorkspace: async (workspace) => registry(workspace).project,
    secrets: { list: () => [], set: () => {}, remove: () => {} },
    generateTypes: async () => {
      throw new Error("Unused fixture operation.");
    },
  });

  const save = async (workspace: string, slug: string, scope: "global" | "project" = "project") => {
    const body = await compiledBody(slug, join(workspace, `${slug}.ts`), {
      workspace,
      scope,
      description: `${workspace}:${slug}`,
    });

    body.graph.inputValidation = { root: "json", minItems: {}, unknownKeys: "reject" };
    body.revision = await revision(body.graph);

    return registry(workspace).save(body);
  };

  const run = async (id: string, workspace: string, slug: string, status: RunRecord["status"]) => {
    const at = "2026-10-23T00:00:00.000Z";

    const record: RunRecord = {
      id,
      workspace,
      slug,
      status,
      revision: "a".repeat(64),
      input: {},
      createdAt: at,
      updatedAt: at,
    };

    if (status === "succeeded") {
      record.output = null;
    }

    if (status === "failed") {
      record.error = "controlled";
    }

    await store.createRun(record);

    return record;
  };

  return {
    a,
    b,
    store,
    service,
    calls,
    save,
    run,
    registry,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

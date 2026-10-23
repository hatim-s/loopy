import type { z } from "zod";
import { type routes, type SourceArtifact, serverEvent } from "../contract/index.js";
import { ServiceError } from "./error.js";
import type { ServiceOptions } from "./registry.js";
import type { ServiceRunViews } from "./run-views.js";
import { nodeDetailEvent } from "./views.js";

export class ServiceQueries {
  constructor(
    private readonly options: ServiceOptions,
    private readonly runViews: ServiceRunViews,
  ) {}

  private async readRunReference(id: string) {
    const run = await this.options.store.runReference(id);

    if (!run) {
      throw new ServiceError("not_found");
    }

    return run;
  }

  async overview(query: z.output<typeof routes.overview.query>) {
    return this.options.store.overview(query);
  }
  async executions(id: string, query: z.output<typeof routes.executions.query>) {
    await this.readRunReference(id);

    return this.options.store.nodePage(id, query);
  }
  async scopes(id: string, query: z.output<typeof routes.scopes.query>) {
    await this.readRunReference(id);

    return this.options.store.scopeCounts(id, query.parentScope);
  }
  async scopeItems(id: string, query: z.output<typeof routes.scopeItems.query>) {
    await this.readRunReference(id);

    return this.options.store.scopeItems(id, query);
  }
  async execution(id: string, query: z.output<typeof routes.execution.query>) {
    await this.readRunReference(id);
    const detail = await this.options.store.execution(id, query.key, query.attemptsAfter);

    if (!detail) {
      throw new ServiceError("not_found");
    }

    return detail;
  }
  async globalLogs(query: z.output<typeof routes.globalLogs.query>) {
    return this.options.store.logPage(query);
  }
  async log(id: number) {
    const log = await this.options.store.logDetail(id);

    if (!log) {
      throw new ServiceError("not_found");
    }

    return log;
  }
  async eventHistory(query: z.output<typeof routes.eventHistory.query>) {
    return this.options.store.eventPage(query);
  }
  async event(sequence: number) {
    const event = await this.options.store.eventDetail(sequence);

    if (!event) {
      throw new ServiceError("not_found");
    }

    if (event.entity === "node") {
      return nodeDetailEvent(event);
    }

    return serverEvent(
      event,
      await this.runViews.resolve(event.entity === "run" ? [event.record] : []),
    );
  }
  async runSource(id: string): Promise<SourceArtifact> {
    const run = await this.readRunReference(id);

    return this.options.registry(run.workspace).revisionSource(run.slug, run.revision);
  }
  async loopySource(slug: string, workspace: string): Promise<SourceArtifact> {
    const registry = this.options.registry(workspace);
    const saved = await registry.get(slug);

    return registry.revisionSource(slug, saved.revision);
  }
}

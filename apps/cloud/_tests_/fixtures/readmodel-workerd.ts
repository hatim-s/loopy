import type { DurableObjectState } from "@cloudflare/workers-types";
import { decodeBoundary, routes, type ScopeItemsQuery } from "@loopy/contract";
import { SqlRunStore } from "@loopy/runtime/store/portable";
import { Effect } from "effect";
import { countHistory } from "../../../../packages/runtime/_tests_/fixtures/readmodel-history";
import { seedScopes } from "../../../../packages/runtime/_tests_/fixtures/readmodel-scopes";
import { DurableSqlDriver } from "../../src/sql-driver";

export class ReadmodelProbe {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const store = new SqlRunStore(new DurableSqlDriver(this.ctx.storage), {
      owner: { identity: { pid: null, host: "readmodel-probe" }, isAlive: () => false },
    });

    const schema = () =>
      this.ctx.storage.sql.exec("SELECT type,name,sql FROM sqlite_schema ORDER BY name").toArray();

    if (url.pathname === "/counts") {
      const before = schema();
      const history = await countHistory(store);

      return Response.json({
        history,
        before,
        after: schema(),
        version: this.ctx.storage.sql
          .exec("SELECT value FROM meta WHERE key='schema_version'")
          .one(),
      });
    }

    if (url.pathname === "/reopen") {
      return Response.json({
        rows: await Effect.runPromise(store.runCountsByDefinition()),
        cursor: await Effect.runPromise(store.eventCursor()),
        version: this.ctx.storage.sql
          .exec("SELECT value FROM meta WHERE key='schema_version'")
          .one(),
      });
    }

    if (url.pathname === "/seed") {
      await seedScopes(store);

      return Response.json({ seeded: true });
    }

    const limit = Number(url.searchParams.get("limit"));

    if (url.pathname === "/scope") {
      const status = url.searchParams.get("status");
      const after = url.searchParams.get("after");

      const query: ScopeItemsQuery = { nodeId: "map", parentScope: "[]", limit };

      if (after !== null) {
        query.after = Number(after);
      }

      if (status !== null) {
        query.status = decodeBoundary(routes.scopeItems.query.fields.status)(status);
      }

      return Response.json(await Effect.runPromise(store.scopeItems("scope-run", query)));
    }

    return new Response("Unknown bounded query.", { status: 404 });
  }
}

export default {
  fetch(): Response {
    return new Response("Use the synthetic probe binding.", { status: 404 });
  },
};

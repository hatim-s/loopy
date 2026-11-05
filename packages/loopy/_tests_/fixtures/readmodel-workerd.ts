import type { DurableObjectState } from "@cloudflare/workers-types";
import { Effect } from "effect";
import { DurableSqlDriver } from "../../../../apps/cloud/src/sql-driver.js";
import { decodeBoundary, routes } from "../../src/contract/index.js";
import type { ScopeItemsQuery } from "../../src/core/index.js";
import { SqlRunStore } from "../../src/store/portable.js";
import { countHistory, readmodelAt } from "./readmodel-history.js";
import { seedScopes } from "./readmodel-scopes.js";

export class ReadmodelProbe {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const store = new SqlRunStore(new DurableSqlDriver(this.ctx.storage), {
      owner: { identity: { pid: null, host: "readmodel-probe" }, isAlive: () => false },
      now: () => Date.parse(readmodelAt),
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

    if (url.pathname === "/old") {
      try {
        const indices = Array.from(Array(limit).keys(), (index) => index * 2);
        this.ctx.storage.sql
          .exec(
            `SELECT item_index,status,count(*) AS count FROM node_scopes WHERE run_id=? AND map_node=? AND parent_scope=? AND item_index IN (${indices.map(() => "?").join(",")}) GROUP BY item_index,status ORDER BY item_index`,
            "scope-run",
            "map",
            "[]",
            ...indices,
          )
          .toArray();

        return Response.json({ error: null });
      } catch (cause) {
        if (!(cause instanceof Error)) {
          throw new Error("Unexpected SQL binding failure.", { cause });
        }

        return Response.json({ error: cause.message });
      }
    }

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

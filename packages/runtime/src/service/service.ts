import { makeServiceContext } from "./context";
import { makeDefinitionOperations } from "./definition";
import { makeRunOperations } from "./mutations";
import { makeRunQueries } from "./queries";
import type { ServiceOptions } from "./registry";
import { makeRunViews } from "./run-views";
import { makeScheduleOperations } from "./schedules";

export function makeService(options: ServiceOptions) {
  const context = makeServiceContext(options);
  const views = makeRunViews(context);

  return {
    listRuns: views.listRuns,
    listLoopies: views.listLoopies,
    runSnapshot: views.runSnapshot,
    events: views.events,
    cursor: views.cursor,
    ...makeDefinitionOperations(options),
    ...makeRunOperations(context, views),
    ...makeRunQueries(context, views),
    ...makeScheduleOperations(context),
  };
}

export type Service = ReturnType<typeof makeService>;

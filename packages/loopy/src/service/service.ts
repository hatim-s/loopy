import { makeDefinitionOperations } from "./definition.js";
import { makeRunOperations } from "./mutations.js";
import { makeRunQueries } from "./queries.js";
import type { ServiceOptions } from "./registry.js";
import { makeRunViews } from "./run-views.js";
import { makeScheduleOperations } from "./schedules.js";

export function makeService(options: ServiceOptions) {
  const { resolve, view, ...views } = makeRunViews(options);

  return {
    ...views,
    ...makeDefinitionOperations(options),
    ...makeRunOperations(options),
    ...makeRunQueries(options, { resolve, view, ...views }),
    ...makeScheduleOperations(options),
  };
}

export type Service = ReturnType<typeof makeService>;

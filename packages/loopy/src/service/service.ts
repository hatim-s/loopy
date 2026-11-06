import { makeDefinitionOperations } from "./definition";
import { makeRunOperations } from "./mutations";
import { makeRunQueries } from "./queries";
import type { ServiceOptions } from "./registry";
import { makeRunViews } from "./run-views";
import { makeScheduleOperations } from "./schedules";

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

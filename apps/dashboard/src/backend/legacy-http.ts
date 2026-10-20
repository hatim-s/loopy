import {
  loopyViewSchema,
  routes,
  runSnapshotViewSchema,
  scheduleSchema,
  scheduleViewSchema,
  serverEventSchema,
} from "loopy/contract";
import { z } from "zod";
import { BackendError, type LoopyBackend } from "./backend.ts";
import { httpTransport, type LocalHttpOptions, localHttpBackend } from "./local-http.ts";

// The installed step runtime uses an integer revision counter, not a graph revision hash.
const legacyScheduleSchema = scheduleSchema.omit({ version: true }).extend({
  revision: z.number().int(),
});

const legacyScheduleViewSchema = legacyScheduleSchema
  .extend({ lastFireKey: scheduleViewSchema.shape.lastFireKey })
  .transform(({ revision, ...record }) => ({ ...record, version: revision }));

// Reuse the unchanged event contracts and exclude graph node events from this backend.
const [runEvent, , stepEvent, logEvent, hookEvent, scheduleEvents] = serverEventSchema.options;

const [scheduleChanged, scheduleDeleted] = scheduleEvents.options;

const legacyEventSchema = z.discriminatedUnion("entity", [
  runEvent,
  stepEvent,
  logEvent,
  hookEvent,
  z.discriminatedUnion("kind", [
    scheduleChanged.extend({
      record: legacyScheduleSchema.transform(({ revision, ...record }) => ({
        ...record,
        version: revision,
      })),
    }),
    scheduleDeleted,
  ]),
]);

const emptyQuery = z.strictObject({});

const legacySchedules = {
  ...routes.schedules,
  query: emptyQuery,
  response: legacyScheduleViewSchema.array(),
};

const legacyPutSchedule = {
  ...routes.putSchedule,
  query: emptyQuery,
  response: legacyScheduleViewSchema,
};

const legacySetScheduleEnabled = {
  ...routes.setScheduleEnabled,
  query: emptyQuery,
  response: legacyScheduleViewSchema,
};

const legacyDeleteSchedule = { ...routes.deleteSchedule, query: emptyQuery };

const legacyRun = {
  ...routes.run,
  response: runSnapshotViewSchema.omit({ nodeRuns: true }).transform((snapshot) => ({
    ...snapshot,
    nodeRuns: [],
  })),
};

/** An explicit connection to the installed step runtime. It never opens a Loopy home. */
export function legacyHttpBackend(options: LocalHttpOptions & { workspace: string }): LoopyBackend {
  const { workspace } = options;
  const { send, events } = httpTransport(options, legacyEventSchema.array());

  const legacyLoopies = {
    ...routes.loopies,
    query: emptyQuery,
    response: loopyViewSchema
      .omit({ workspace: true })
      .array()
      .transform((loopies) => loopies.map((loopy) => ({ ...loopy, workspace }))),
  };

  const unavailable = async () => {
    throw new BackendError("legacy_unavailable");
  };

  return {
    ...localHttpBackend(options),
    graphSupport: "legacy_unavailable",
    loopies: () => send(legacyLoopies, { params: {}, query: {}, body: undefined }),
    run: (id, signal) => send(legacyRun, { params: { id }, query: {}, body: undefined }, signal),
    loopyGraph: unavailable,
    runGraph: unavailable,
    // Legacy rows have no execution directory. Every new run uses the explicit connection config.
    startRun: (slug, input) =>
      send(routes.startRun, { params: { slug }, query: {}, body: { input, workspace } }),
    schedules: () => send(legacySchedules, { params: {}, query: {}, body: undefined }),
    putSchedule: (slug, body) => send(legacyPutSchedule, { params: { slug }, query: {}, body }),
    setScheduleEnabled: (slug, enabled) =>
      send(legacySetScheduleEnabled, { params: { slug }, query: {}, body: { enabled } }),
    deleteSchedule: (slug) =>
      send(legacyDeleteSchedule, { params: { slug }, query: {}, body: undefined }),
    events,
  };
}

import type { ScheduleView, ServerEvent } from "@loopy/contract";
import type { QueryClient } from "@tanstack/react-query";
import { keys } from "../keys";

type ScheduleEvent = Extract<ServerEvent, { entity: "schedule" }>;

type ScheduleId = Pick<ScheduleView, "workspace" | "slug">;

function sameSchedule(a: ScheduleId, b: ScheduleId): boolean {
  return a.workspace === b.workspace && a.slug === b.slug;
}

function sameFailure(a: ScheduleView["failure"], b: ScheduleView["failure"]): boolean {
  return a?.error === b?.error && a?.retryAt === b?.retryAt;
}

// A fire keeps the version it fired, and a retried failure keeps both the version and the slot.
function isStale(current: ScheduleView, next: ScheduleView): boolean {
  if (current.version !== next.version) {
    return current.version > next.version;
  }

  if (current.nextFireAt !== next.nextFireAt) {
    return current.nextFireAt > next.nextFireAt;
  }

  return sameFailure(current.failure, next.failure);
}

function withSchedule(list: ScheduleView[], next: ScheduleView): ScheduleView[] {
  const current = list.find((item) => sameSchedule(item, next));

  if (current && isStale(current, next)) {
    return list;
  }

  return current
    ? list.map((item) => (item === current ? next : item))
    : [...list, next].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Patches the workspace list in place. Returns false for a schedule the list has never held,
 * which must refetch the list to keep the server's ordering.
 */
export function applyScheduleEvent(client: QueryClient, event: ScheduleEvent): boolean {
  const list = client.getQueryData<ScheduleView[]>(keys.schedules(event.record.workspace));

  if (list === undefined) {
    return true;
  }

  if (event.kind === "deleted") {
    client.setQueryData<ScheduleView[]>(keys.schedules(event.record.workspace), (current) =>
      current?.filter((item) => !sameSchedule(item, event.record)),
    );

    return true;
  }

  if (!list.some((item) => sameSchedule(item, event.record))) {
    return false;
  }

  const view = event.record;

  client.setQueryData<ScheduleView[]>(
    keys.schedules(view.workspace),
    (current) => current && withSchedule(current, view),
  );

  return true;
}

// A mutation's schedule belongs to the listed workspace, so unlike a stream event it may insert.
export function applyScheduleView(client: QueryClient, view: ScheduleView): void {
  client.setQueryData<ScheduleView[]>(
    keys.schedules(view.workspace),
    (current) => current && withSchedule(current, view),
  );
  void client.invalidateQueries({ queryKey: keys.loopies });
  void client.invalidateQueries({ queryKey: keys.scheduleOverview });
}

export function removeScheduleView(client: QueryClient, identity: ScheduleId): void {
  client.setQueryData<ScheduleView[]>(keys.schedules(identity.workspace), (current) =>
    current?.filter((item) => !sameSchedule(item, identity)),
  );
  void client.invalidateQueries({ queryKey: keys.loopies });
  void client.invalidateQueries({ queryKey: keys.scheduleOverview });
}

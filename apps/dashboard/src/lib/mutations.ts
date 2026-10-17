import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Json, PutScheduleBody, RunView, ScheduleView } from "loopy/contract";
import type { LoopyBackend } from "../backend/backend.ts";
import { useBackend } from "../router-context.ts";
import { keys } from "./keys.ts";
import { applyRunView, applyScheduleView, removeScheduleView } from "./stream.ts";

/** A mutation that returns a run. The returned run is shown at once; the stream follows. */
export function useRunMutation<Variables = void>(
  action: (backend: LoopyBackend, variables: Variables) => Promise<RunView>,
) {
  const backend = useBackend();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (variables: Variables) => action(backend, variables),
    onSuccess: (run) => applyRunView(client, run),
  });
}

export function useResolveHook(token: string) {
  return useRunMutation((backend, payload: Json) => backend.resolveHook(token, payload));
}

export function useSaveSchedule(slug: string) {
  const backend = useBackend();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: PutScheduleBody) => backend.putSchedule(slug, body),
    onSuccess: (schedule) => applyScheduleView(client, schedule),
  });
}

/** Identity guards keep a failed request from overwriting stream writes to the same row. */
export async function toggleSchedule(
  client: QueryClient,
  backend: LoopyBackend,
  change: { slug: string; enabled: boolean },
) {
  const { slug, enabled } = change;
  await client.cancelQueries({ queryKey: keys.schedules });

  const previous = client
    .getQueryData<ScheduleView[]>(keys.schedules)
    ?.find((item) => item.slug === slug);

  const optimistic = previous && { ...previous, enabled };
  client.setQueryData<ScheduleView[]>(keys.schedules, (current) =>
    current?.map((item) => (item === previous && optimistic ? optimistic : item)),
  );

  // React Query may structurally share an unchanged row, so keep the cached identity.
  const written = client
    .getQueryData<ScheduleView[]>(keys.schedules)
    ?.find((item) => item.slug === slug);

  try {
    return await backend.setScheduleEnabled(slug, enabled);
  } catch (error) {
    client.setQueryData<ScheduleView[]>(keys.schedules, (current) =>
      current?.map((item) => (item === written && previous ? previous : item)),
    );
    throw error;
  }
}

export function useToggleSchedule(slug: string) {
  const backend = useBackend();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (enabled: boolean) => toggleSchedule(client, backend, { slug, enabled }),
    onSuccess: (schedule) => applyScheduleView(client, schedule),
  });
}

export function useRemoveSchedule(slug: string) {
  const backend = useBackend();
  const client = useQueryClient();

  return useMutation({
    mutationFn: () => backend.deleteSchedule(slug),
    onSuccess: () => removeScheduleView(client, slug),
  });
}

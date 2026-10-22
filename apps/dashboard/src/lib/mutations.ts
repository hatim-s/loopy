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

export function useSaveSchedule(slug: string, workspace: string) {
  const backend = useBackend();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: PutScheduleBody) => backend.putSchedule(slug, workspace, body),
    onSuccess: (schedule) => applyScheduleView(client, schedule),
  });
}

/** Identity guards keep a failed request from overwriting stream writes to the same row. */
export async function toggleSchedule(
  client: QueryClient,
  backend: LoopyBackend,
  change: { slug: string; workspace: string; enabled: boolean },
) {
  const { slug, workspace, enabled } = change;
  await client.cancelQueries({ queryKey: keys.schedules(workspace) });

  const previous = client
    .getQueryData<ScheduleView[]>(keys.schedules(workspace))
    ?.find((item) => item.slug === slug && item.workspace === workspace);

  const optimistic = previous && { ...previous, enabled };
  client.setQueryData<ScheduleView[]>(keys.schedules(workspace), (current) =>
    current?.map((item) => (item === previous && optimistic ? optimistic : item)),
  );

  // React Query may structurally share an unchanged row, so keep the cached identity.
  const written = client
    .getQueryData<ScheduleView[]>(keys.schedules(workspace))
    ?.find((item) => item.slug === slug && item.workspace === workspace);

  try {
    return await backend.setScheduleEnabled(slug, workspace, enabled);
  } catch (error) {
    client.setQueryData<ScheduleView[]>(keys.schedules(workspace), (current) =>
      current?.map((item) => (item === written && previous ? previous : item)),
    );
    throw error;
  }
}

export function useToggleSchedule(slug: string, workspace: string) {
  const backend = useBackend();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (enabled: boolean) => toggleSchedule(client, backend, { slug, workspace, enabled }),
    onSuccess: (schedule) => applyScheduleView(client, schedule),
  });
}

export function useRemoveSchedule(slug: string, workspace: string) {
  const backend = useBackend();
  const client = useQueryClient();

  return useMutation({
    mutationFn: () => backend.deleteSchedule(slug, workspace),
    onSuccess: () => removeScheduleView(client, { slug, workspace }),
  });
}

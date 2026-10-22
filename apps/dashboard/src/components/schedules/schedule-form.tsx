import type { PutScheduleBody, ScheduleView } from "loopy/contract";
import { type ReactNode, useState } from "react";
import { BackendError } from "../../backend/backend.ts";
import { describeCron } from "../../lib/cron.ts";
import { parseJsonInput } from "../../lib/input-form.ts";
import { useSaveSchedule } from "../../lib/mutations.ts";
import { Button } from "../button.tsx";
import { ResolveError } from "../resolve-form.tsx";

export type ScheduleDraft = Pick<ScheduleView, "cron" | "tz" | "input" | "enabled">;

type Field = "cron" | "tz" | "input";

const CONTROL = "field field-mono block w-full";

function rejectedField(error: Error | null): Field | undefined {
  if (!(error instanceof BackendError)) {
    return undefined;
  }

  if (error.code === "invalid_cron") {
    return "cron";
  }

  return error.code === "invalid_timezone" ? "tz" : undefined;
}

function Labelled({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}

function FieldError({ error }: { error: Error | null }) {
  return error && <span className="block text-xs text-danger">{error.message}</span>;
}

/** Edits every field at once; PUT replaces the schedule and the daemon recomputes the next fire. */
export function ScheduleForm({
  slug,
  workspace,
  draft,
  onDone,
}: {
  slug: string;
  workspace: string;
  draft: ScheduleDraft;
  onDone: () => void;
}) {
  const save = useSaveSchedule(slug, workspace);
  const [cron, setCron] = useState(draft.cron);
  const [tz, setTz] = useState(draft.tz);
  const [inputText, setInputText] = useState(() => JSON.stringify(draft.input, null, 2));
  const [enabled, setEnabled] = useState(draft.enabled);
  const input = parseJsonInput(inputText);
  const reading = describeCron(cron);
  const field = rejectedField(save.error);
  const errorAt = (name: Field) => (field === name ? save.error : null);

  return (
    <form
      className="grid gap-x-4 gap-y-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();

        if (input.valid) {
          const body: PutScheduleBody = { cron, tz, input: input.value, enabled };
          save.mutate(body, { onSuccess: onDone });
        }
      }}
    >
      <Labelled label="Cron, five fields or an alias like @hourly">
        <input
          value={cron}
          onChange={(event) => setCron(event.target.value)}
          spellCheck={false}
          aria-invalid={field === "cron"}
          className={CONTROL}
        />
        <span className="block text-xs text-muted">{reading ?? " "}</span>
        <FieldError error={errorAt("cron")} />
      </Labelled>
      <Labelled label="Time zone, IANA name">
        <input
          value={tz}
          onChange={(event) => setTz(event.target.value)}
          spellCheck={false}
          aria-invalid={field === "tz"}
          className={CONTROL}
        />
        <FieldError error={errorAt("tz")} />
      </Labelled>
      <div className="sm:col-span-2">
        <Labelled label="Input, as JSON. Each fire starts a run with it.">
          <textarea
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            rows={3}
            spellCheck={false}
            aria-invalid={!input.valid || field === "input"}
            className="field"
          />
        </Labelled>
        {!input.valid && <span className="text-xs text-danger">The input is not valid JSON.</span>}
        <FieldError error={errorAt("input")} />
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="accent-[var(--lamp)]"
          />
          Enabled
        </label>
        <span className="flex-1" />
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!input.valid || save.isPending}>
          {save.isPending ? "Saving" : "Save schedule"}
        </Button>
      </div>
      {save.error && field === undefined && (
        <div className="sm:col-span-2">
          <ResolveError error={save.error} />
        </div>
      )}
    </form>
  );
}

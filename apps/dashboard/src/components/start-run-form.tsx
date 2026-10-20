import { useNavigate } from "@tanstack/react-router";
import type { Json, LoopyView } from "loopy/contract";
import { useState } from "react";
import {
  coerceInput,
  type FieldIssue,
  type InputField,
  initialValues,
  inputFields,
  parseJsonInput,
  type RecordSpec,
} from "../lib/input-form.ts";
import { useRunMutation } from "../lib/mutations.ts";
import { Button } from "./button.tsx";
import { ErrorBanner } from "./error-banner.tsx";

const CONTROL =
  "block h-7 w-full rounded-md border border-line bg-panel px-2 text-[13px] aria-invalid:border-danger";

function FieldControl({
  field,
  value,
  invalid,
  onChange,
}: {
  field: InputField;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  if (field.kind === "boolean") {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)} className={CONTROL}>
        {field.optional && <option value="">Not set</option>}
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  return (
    <input
      type="text"
      inputMode={field.kind === "number" ? "decimal" : undefined}
      value={value}
      aria-invalid={invalid}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      className={CONTROL}
    />
  );
}

/** One control per spec key. Issues show only after a submit attempt. */
function RecordFields({ spec, onSubmit }: { spec: RecordSpec; onSubmit: (input: Json) => void }) {
  const fields = inputFields(spec);
  const [values, setValues] = useState(() => initialValues(fields));
  const [issues, setIssues] = useState<FieldIssue[]>([]);

  return (
    <form
      id="start-run"
      noValidate
      className="grid gap-y-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        const coerced = coerceInput(fields, values);
        setIssues(coerced.valid ? [] : coerced.issues);

        if (coerced.valid) {
          onSubmit(coerced.value);
        }
      }}
    >
      {fields.map((field) => {
        const issue = issues.find((item) => item.key === field.key);

        return (
          <label key={field.key} className="block space-y-1">
            <span className="flex items-baseline gap-2 text-xs">
              <span className="font-mono">{field.key}</span>
              <span className="text-muted">
                {field.kind}
                {field.optional && ", optional"}
              </span>
            </span>
            <FieldControl
              field={field}
              value={values[field.key] ?? ""}
              invalid={issue !== undefined}
              onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
            />
            {issue && <span className="text-xs text-danger">{issue.message}</span>}
          </label>
        );
      })}
    </form>
  );
}

function JsonEditor({ onSubmit }: { onSubmit: (input: Json) => void }) {
  const [text, setText] = useState("{}");
  const parsed = parseJsonInput(text);

  return (
    <form
      id="start-run"
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault();

        if (parsed.valid) {
          onSubmit(parsed.value);
        }
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs text-muted">
          Input, as JSON. The loopy validates it against its schema.
        </span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          spellCheck={false}
          aria-invalid={!parsed.valid}
          className="block w-full resize-y rounded-md border border-line bg-panel p-2.5 font-mono text-xs aria-invalid:border-danger"
        />
      </label>
      {!parsed.valid && <p className="text-xs text-danger">The input is not valid JSON.</p>}
    </form>
  );
}

export function StartRunForm({ loopy }: { loopy: LoopyView }) {
  const navigate = useNavigate();

  const start = useRunMutation((backend, input: Json) =>
    backend.startRun(loopy.slug, input, loopy.workspace),
  );

  const submit = (input: Json) =>
    start.mutate(input, {
      onSuccess: (run) => void navigate({ to: "/runs/$runId", params: { runId: run.id } }),
    });

  const empty = loopy.input !== "schema" && Object.keys(loopy.input).length === 0;

  return (
    <section aria-labelledby="start-heading" className="space-y-2.5">
      <h2 id="start-heading" className="section-title">
        Start run
      </h2>
      {empty && <p className="text-xs text-muted">This loopy takes no input.</p>}
      {loopy.input === "schema" ? (
        <JsonEditor onSubmit={submit} />
      ) : (
        <RecordFields spec={loopy.input} onSubmit={submit} />
      )}
      <Button type="submit" form="start-run" variant="primary" disabled={start.isPending}>
        {start.isPending ? "Starting" : "Start run"}
      </Button>
      {start.error && <ErrorBanner error={start.error} />}
    </section>
  );
}

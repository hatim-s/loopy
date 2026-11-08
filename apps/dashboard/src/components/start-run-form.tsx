import { type Json, type LoopyView, type RecordField, recordFields } from "@loopy/contract";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { coerceInput, type FieldIssue, initialValues, type RecordSpec } from "../lib/input-form";
import { useRunMutation } from "../lib/mutations";
import { Button } from "./button";
import { ErrorBanner } from "./error-banner";
import { JsonField, useJsonText } from "./json-field";

const CONTROL = "field block w-full";

function FieldControl({
  field,
  value,
  invalid,
  onChange,
}: {
  field: RecordField;
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

// Issues show only after a submit attempt.
function RecordFields({ spec, onSubmit }: { spec: RecordSpec; onSubmit: (input: Json) => void }) {
  const fields = recordFields(spec);
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
  const input = useJsonText("{}");

  return (
    <form
      id="start-run"
      onSubmit={(event) => {
        event.preventDefault();

        if (input.parsed.valid) {
          onSubmit(input.parsed.value);
        }
      }}
    >
      <JsonField
        label="Input, as JSON. The loopy validates it against its schema."
        noun="input"
        json={input}
        rows={5}
      />
    </form>
  );
}

export function StartRunForm({ loopy }: { loopy: LoopyView }) {
  const navigate = useNavigate();

  const start = useRunMutation((backend, input: Json) =>
    backend.call("startRun", {
      params: { slug: loopy.slug },
      body: { input, workspace: loopy.workspace },
    }),
  );

  const submit = (input: Json) =>
    start.mutate(input, {
      onSuccess: (run) => void navigate({ to: "/runs/$runId", params: { runId: run.id } }),
    });

  const empty = loopy.input !== "schema" && Object.keys(loopy.input).length === 0;

  return (
    <section aria-label="Start run" className="space-y-2.5">
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

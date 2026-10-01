import type { Json } from "loopy";
import type { FormEvent } from "react";
import { useId, useState } from "react";
import type { Mode } from "./api.ts";

const modeHelp: Record<Mode, string> = {
  sandbox: "Workspace writes are allowed. Network access is blocked.",
  full: "Run with your local user permissions.",
};

export function RunForm({
  slug,
  onRun,
  busy,
}: {
  slug: string;
  onRun: (input: Json, mode: Mode) => Promise<void>;
  busy: boolean;
}) {
  const [input, setInput] = useState("{}");
  const [mode, setMode] = useState<Mode>("sandbox");
  const [inputError, setInputError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let value: Json;
    try {
      value = JSON.parse(input) as Json;
    } catch {
      setInputError("Input must be valid JSON.");
      return;
    }
    setInputError(null);
    await onRun(value, mode);
  }

  const modeOption = (value: Mode, label: string) => (
    <label className={mode === value ? "active" : ""}>
      <input
        type="radio"
        name="mode"
        value={value}
        checked={mode === value}
        onChange={() => setMode(value)}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <form className="run-form" onSubmit={submit}>
      <div className="section-heading">
        <h3>Run {slug}</h3>
        <span>Local execution</span>
      </div>
      <label htmlFor={inputId}>Input JSON</label>
      <textarea
        id={inputId}
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          setInputError(null);
        }}
        spellCheck={false}
        aria-invalid={!!inputError}
        aria-describedby={inputError ? errorId : undefined}
      />
      {inputError && (
        <p className="field-error" id={errorId}>
          {inputError}
        </p>
      )}
      <fieldset className="mode-choice">
        <legend>Permissions</legend>
        {modeOption("sandbox", "Sandbox")}
        {modeOption("full", "Full access")}
      </fieldset>
      <p className="permission-help">{modeHelp[mode]}</p>
      <button className="primary-button" type="submit" disabled={busy}>
        {busy ? "Starting..." : "Run workflow"}
      </button>
    </form>
  );
}

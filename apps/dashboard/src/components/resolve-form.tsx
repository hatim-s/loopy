import { useState } from "react";
import { BackendError } from "../backend/backend.ts";
import { parseJsonInput } from "../lib/input-form.ts";
import type { useResolveHook } from "../lib/mutations.ts";
import { Button } from "./button.tsx";

type Resolve = ReturnType<typeof useResolveHook>;

/** Server codes stay visible: not_found means someone or something resolved it first. */
export function ResolveError({ error }: { error: Error }) {
  return (
    <p role="alert" className="border-l-2 border-danger bg-danger/8 px-3 py-2 text-danger">
      {error instanceof BackendError && <code className="mr-2 font-mono">{error.code}</code>}
      {error.message}
    </p>
  );
}

export function PayloadEditor({ resolve }: { resolve: Resolve }) {
  const [text, setText] = useState("{}");
  const payload = parseJsonInput(text);

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();

        if (payload.valid) {
          resolve.mutate(payload.value);
        }
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs text-muted">
          Payload, as JSON. The run receives it as the hook result.
        </span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          spellCheck={false}
          aria-invalid={!payload.valid}
          className="block w-full resize-y rounded-md border border-line bg-panel p-2.5 font-mono text-xs aria-invalid:border-danger"
        />
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={!payload.valid || resolve.isPending}>
          {resolve.isPending ? "Resolving" : "Resolve hook"}
        </Button>
        {!payload.valid && (
          <span className="text-xs text-danger">The payload is not valid JSON.</span>
        )}
      </div>
    </form>
  );
}

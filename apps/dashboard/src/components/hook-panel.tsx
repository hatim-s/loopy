import { type HookRecord, type Json, jsonSchema, type RunView } from "loopy/contract";
import { useState } from "react";
import { timestamp } from "../lib/format.ts";
import { useRunMutation } from "../lib/mutations.ts";
import { Button } from "./button.tsx";
import { Countdown } from "./countdown.tsx";
import { ErrorBanner } from "./error-banner.tsx";

type Waiting = NonNullable<RunView["waitingOn"]>;

type Payload = { valid: true; value: Json } | { valid: false };

function parsePayload(text: string): Payload {
  try {
    return { valid: true, value: jsonSchema.parse(JSON.parse(text)) };
  } catch {
    return { valid: false };
  }
}

export function HookPanel({
  waiting,
  hook,
  now,
}: {
  waiting: Waiting;
  hook: HookRecord | undefined;
  now: number;
}) {
  const [text, setText] = useState("{}");
  const payload = parsePayload(text);

  const resolve = useRunMutation((backend, value: Json) =>
    backend.resolveHook(waiting.token, value),
  );

  return (
    <section
      aria-label="Waiting for a person"
      className="space-y-3 rounded-md border border-attention/40 bg-attention/6 p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-medium">
          Waiting on <span className="font-mono">{waiting.hook}</span>
        </h2>
        <p className="text-xs text-muted">
          {hook && (
            <>
              Opened <time dateTime={hook.createdAt}>{timestamp(hook.createdAt)}</time>.{" "}
            </>
          )}
          {waiting.expiresAt === null ? (
            "No expiry."
          ) : (
            <>
              Expires <Countdown at={waiting.expiresAt} now={now} />.
            </>
          )}
        </p>
      </header>
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
        {resolve.error && <ErrorBanner error={resolve.error} />}
      </form>
    </section>
  );
}

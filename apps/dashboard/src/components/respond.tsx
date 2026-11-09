import { type ReactNode, useState } from "react";
import { useResolveHook } from "../lib/mutations";
import type { WaitingRun } from "../lib/waiting";
import { Button } from "./button";
import { CodedError } from "./error-banner";
import { JsonField, useJsonText } from "./json-field";

function PayloadEditor({ resolve }: { resolve: ReturnType<typeof useResolveHook> }) {
  const payload = useJsonText("{}");

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();

        if (payload.parsed.valid) {
          resolve.mutate(payload.parsed.value);
        }
      }}
    >
      <JsonField
        label="Payload, as JSON. The run receives it as the hook result."
        noun="payload"
        json={payload}
        rows={4}
      />
      <Button type="submit" variant="primary" disabled={!payload.parsed.valid || resolve.isPending}>
        {resolve.isPending ? "Resolving" : "Resolve hook"}
      </Button>
    </form>
  );
}

/** A waiting run's summary line with a Respond button that opens the payload editor below it. */
export function RespondRow(props: {
  run: WaitingRun;
  rowClassName: string;
  formClassName: string;
  children: ReactNode;
}) {
  const { run, rowClassName, formClassName, children } = props;
  const resolve = useResolveHook(run.waitingOn.token);
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className={`flex flex-wrap items-center gap-y-1 ${rowClassName}`}>
        {children}
        <Button small className="ml-auto" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Close" : "Respond"}
        </Button>
      </div>
      {open && (
        <div className={`mt-3 ${formClassName}`}>
          <PayloadEditor resolve={resolve} />
          {resolve.error && <CodedError error={resolve.error} />}
        </div>
      )}
    </>
  );
}

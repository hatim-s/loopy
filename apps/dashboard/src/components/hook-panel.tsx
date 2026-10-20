import type { HookRecord, RunSnapshotView } from "loopy/contract";
import type { ReactNode } from "react";
import { timestamp } from "../lib/format.ts";
import type { WaitingRun } from "../lib/inbox.ts";
import { useResolveHook } from "../lib/mutations.ts";
import { Countdown } from "./countdown.tsx";
import { JsonPreview } from "./json-preview.tsx";
import { PayloadEditor, ResolveError } from "./resolve-form.tsx";

type Waiting = WaitingRun["waitingOn"];

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}

function WaitingHook({
  waiting,
  snapshot,
  now,
}: {
  waiting: Waiting;
  snapshot: RunSnapshotView;
  now: number;
}) {
  const resolve = useResolveHook(waiting.token);
  const hook = snapshot.hooks.find((item) => item.token === waiting.token);
  const step = snapshot.steps.find((item) => item.seq === waiting.seq);

  return (
    <section
      aria-label="Waiting for a person"
      className="space-y-4 rounded-md border border-attention/40 bg-attention/6 p-4"
    >
      <h2 className="font-medium">
        Waiting on <span className="font-mono">{waiting.hook}</span>
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs">
        <Fact label="Opened">
          {hook ? <time dateTime={hook.createdAt}>{timestamp(hook.createdAt)}</time> : "unknown"}
        </Fact>
        <Fact label="Expires">
          {waiting.expiresAt === null ? "never" : <Countdown at={waiting.expiresAt} now={now} />}
        </Fact>
        <Fact label="Step">
          <span className="font-mono text-xs">{step?.key ?? `#${waiting.seq}`}</span>
        </Fact>
      </dl>
      <PayloadEditor resolve={resolve} />
      {resolve.error && <ResolveError error={resolve.error} />}
    </section>
  );
}

function SettledHook({ hook }: { hook: HookRecord }) {
  const expired = hook.expiredAt !== undefined;
  const at = hook.resolvedAt ?? hook.expiredAt;

  return (
    <section
      aria-label="Hook outcome"
      className="space-y-2 rounded-md border border-line bg-panel p-4"
    >
      <h2 className="font-medium">
        <span className="font-mono">{hook.name}</span>{" "}
        <span className={expired ? "text-danger" : "text-success"}>
          {expired ? "expired" : "resolved"}
        </span>
        {at !== undefined && (
          <span className="ml-2 text-xs font-normal text-muted">
            <time dateTime={at}>{timestamp(at)}</time>
          </span>
        )}
      </h2>
      {hook.payload === undefined ? (
        <p className="text-xs text-muted">No payload recorded.</p>
      ) : (
        <JsonPreview label="Payload" value={hook.payload} />
      )}
    </section>
  );
}

/** Retained hook outcomes remain visible beside the pending hook's resolve form. */
export function HookPanel({ snapshot, now }: { snapshot: RunSnapshotView; now: number }) {
  const { waitingOn } = snapshot.run;

  const settled = snapshot.hooks.filter(
    (hook) => hook.resolvedAt !== undefined || hook.expiredAt !== undefined,
  );

  return (
    <>
      {waitingOn && (
        <WaitingHook key={waitingOn.token} waiting={waitingOn} snapshot={snapshot} now={now} />
      )}
      {settled.map((hook) => (
        <SettledHook key={hook.token} hook={hook} />
      ))}
    </>
  );
}

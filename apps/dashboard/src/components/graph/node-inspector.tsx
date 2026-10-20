import type { GraphView, LogRecord, NodeRunView, OutSchema, Value } from "loopy/contract";
import type { ReactNode } from "react";
import { clockTime, duration } from "../../lib/format.ts";
import { executionLogs, type GraphNodeModel, scopeText } from "../../lib/graph.ts";
import { predicateText, refText, valueText } from "../../lib/graph-text.ts";
import { Countdown } from "../countdown.tsx";
import { JsonPreview } from "../json-preview.tsx";
import { LogLines } from "../log-lines.tsx";
import { StatusBadge } from "../status-badge.tsx";
import { KindGlyph } from "./kind-glyph.tsx";

type GraphNode = GraphView["nodes"][number];

type Fact = [label: string, value: string];

function outText(out: OutSchema): string {
  return out.kind === "value"
    ? out.type
    : `{ ${Object.entries(out.fields)
        .map(([name, type]) => `${name}: ${type}`)
        .join(", ")} }`;
}

function entries(prefix: string, record: Record<string, Value>): Fact[] {
  return Object.entries(record).map(([key, value]) => [`${prefix}${key}`, valueText(value)]);
}

function optional(label: string, value: Value | null): Fact[] {
  return value === null ? [] : [[label, valueText(value)]];
}

function rateLimit(limit: Extract<GraphNode, { kind: "code" }>["rateLimit"]): Fact[] {
  return limit === null ? [] : [["rate limit", `${limit.limit} per ${limit.window}`]];
}

function targets(prefix: string, record: Record<string, string>): Fact[] {
  return Object.entries(record).map(([key, id]) => [`${prefix}${key}`, id]);
}

/** The compiled settings a reader needs to judge a node, as label and text pairs. */
function facts(node: GraphNode): Fact[] {
  switch (node.kind) {
    case "code": {
      return [
        ["module", node.module.name],
        ...entries("in.", node.in),
        ["out", outText(node.out)],
        ["retry", `${node.retry.attempts} attempts, ${node.retry.backoff}`],
        ["timeout", node.timeout === null ? "default" : String(node.timeout)],
        ...rateLimit(node.rateLimit),
      ];
    }

    case "command": {
      return [
        ["command", node.key],
        ["argv", node.argv.map(valueText).join(" ")],
        ...entries("flag.", node.flags),
        ...optional("stdin", node.options.stdin),
        ...optional("cwd", node.options.cwd),
        ...entries("env.", node.options.env),
        ["ok exit codes", node.okExitCodes.join(", ")],
        ["out", outText(node.out)],
        ["retry", `${node.retry.attempts} attempts, ${node.retry.backoff}`],
        ...rateLimit(node.rateLimit),
      ];
    }

    case "branch": {
      return [
        ["predicate", predicateText(node.predicate)],
        ["yes", node.arms.yes],
        ["no", node.arms.no],
      ];
    }

    case "switch": {
      return [
        ["on", refText(node.on)],
        ...targets("case.", node.cases),
        ["default", node.default ?? "none"],
      ];
    }

    case "map": {
      return [
        ["over", refText(node.over)],
        ["body", node.body],
        ["concurrency", String(node.concurrency)],
        ["on error", node.onError],
      ];
    }

    case "parallel": {
      return targets("branch.", node.branches);
    }

    case "wait": {
      return [
        ["timeout", node.timeout === null ? "none" : String(node.timeout)],
        ["payload", outText(node.payload)],
      ];
    }

    case "sleep": {
      return [["duration", String(node.duration)]];
    }

    case "finally": {
      return [
        ["body", node.body],
        ["cleanup", node.cleanup],
      ];
    }

    case "rescue": {
      return [
        ["body", node.body],
        ["handler", node.handler],
      ];
    }

    case "fail": {
      return [["message", valueText(node.message)]];
    }

    case "format": {
      return [["template", node.template], ...entries("value.", node.values)];
    }

    case "log": {
      return [["message", valueText(node.message)], ...optional("data", node.data)];
    }

    case "join": {
      return [["result", node.result.kind === "none" ? "none" : valueText(node.result.value)]];
    }

    default: {
      return [];
    }
  }
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 border-t border-line px-3 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ExecutionTiming({ execution, now }: { execution: NodeRunView; now: number }) {
  const end = "endedAt" in execution ? Date.parse(execution.endedAt) : now;

  return (
    <span className="text-muted tabular-nums" title={execution.startedAt}>
      {clockTime(execution.startedAt)}, {duration(execution.startedAt, end)}
    </span>
  );
}

/**
 * The record holds only the latest attempt, so logs from earlier attempts carry their attempt
 * number. Otherwise a retry's stderr reads as output of the attempt that succeeded.
 */
function ExecutionLogs({ execution, logs }: { execution: NodeRunView; logs: LogRecord[] }) {
  const groups = executionLogs(logs, execution);

  if (groups.every((group) => group.attempt === execution.attempt)) {
    return <LogLines logs={groups.flatMap((group) => group.logs)} />;
  }

  return groups.map((group) => (
    <div key={`${group.attempt}:${group.logs[0]?.seq}`} className="space-y-0.5">
      <p className="text-xs text-muted">Attempt {group.attempt}</p>
      <LogLines logs={group.logs} />
    </div>
  ));
}

function Execution(props: { execution: NodeRunView; logs: LogRecord[]; now: number }) {
  const { execution, logs, now } = props;
  const scope = scopeText(execution);

  return (
    <li className="space-y-1.5 rounded-sm border border-line bg-panel p-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <StatusBadge status={execution.status} />
        <span className="font-mono text-muted tabular-nums">
          attempt {execution.attempt}/{execution.maxAttempts}
        </span>
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 text-xs">
        <ExecutionTiming execution={execution} now={now} />
        <span className="font-mono text-faint" title="Receipt state for side-effect safety">
          receipt {execution.receipt}
        </span>
      </div>
      {scope !== null && <p className="font-mono text-xs text-muted">scope {scope}</p>}
      {"error" in execution && (
        <pre
          role="alert"
          className="max-h-48 overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-danger"
        >
          {execution.error.code}: {execution.error.message}
        </pre>
      )}
      {"nextRetryAt" in execution && (
        <p className="text-xs text-attention">
          Retries <Countdown at={execution.nextRetryAt} now={now} />
        </p>
      )}
      {"wakeAt" in execution && execution.wakeAt !== null && (
        <p className="text-xs text-attention">
          Wakes <Countdown at={execution.wakeAt} now={now} />
        </p>
      )}
      {execution.status === "succeeded" && <JsonPreview label="output" value={execution.output} />}
      <ExecutionLogs execution={execution} logs={logs} />
    </li>
  );
}

const IDLE_TEXT = {
  definition: "This is the saved definition. Start a run to record executions.",
  not_started: "No record yet. The run has not reached this node.",
  not_run: "No record. The run ended without executing this node.",
} as const;

export function NodeInspector(props: {
  model: GraphNodeModel;
  logs: LogRecord[];
  now: number;
  onClose: () => void;
}) {
  const { model, logs, now, onClose } = props;
  const { node, executions, state } = model;
  const rows = facts(node);

  return (
    <aside
      aria-label={`Node ${model.id}`}
      className="float absolute top-[calc(var(--bar-h)+var(--gap)*2)] right-(--gap) bottom-[calc(var(--gap)*2+2.25rem)] z-20 flex w-[min(var(--inspector-w),calc(100%-var(--gap)*2))] flex-col overflow-hidden max-md:top-auto max-md:h-[55%]"
    >
      <header className="flex items-start gap-2.5 px-3 pt-3 pb-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-raised">
          <KindGlyph kind={node.kind} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold" title={model.title}>
            {model.title}
          </h2>
          <p className="truncate text-xs text-muted" title={model.id}>
            {node.kind} <code className="font-mono">{model.id}</code>
            {node.scope !== null && (
              <span className="text-faint">
                {" "}
                in <code className="font-mono">{node.scope}</code>
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="icon-button -mt-0.5 -mr-1"
          aria-label="Close node details"
          title="Close (Esc)"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section
          title="Executions"
          aside={
            executions.length > 0 && (
              <span className="text-xs text-muted tabular-nums">{executions.length}</span>
            )
          }
        >
          {state.kind === "ran" ? (
            <ol className="space-y-2">
              {executions.map((execution) => (
                <Execution
                  key={execution.key.scope.map((part) => `${part.nodeId}:${part.index}`).join("/")}
                  execution={execution}
                  logs={logs}
                  now={now}
                />
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted">
              {IDLE_TEXT[state.kind === "idle" ? state.reason : "definition"]}
            </p>
          )}
        </Section>
        {rows.length > 0 && (
          <Section title="Definition">
            <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="truncate font-mono text-muted" title={label}>
                    {label}
                  </dt>
                  <dd className="font-mono break-words">{value}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}
        <details className="border-t border-line px-3 py-3">
          <summary className="cursor-pointer text-xs font-semibold text-muted">
            Compiled node
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-sm border border-line bg-page p-2 font-mono text-[11px]">
            {JSON.stringify(node, null, 2)}
          </pre>
        </details>
      </div>
    </aside>
  );
}

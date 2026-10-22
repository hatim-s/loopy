import type { HookRecord } from "loopy/contract";
import { timestamp } from "../../lib/format.ts";
import type { GraphModel } from "../../lib/graph.ts";
import type { NodeMark } from "../code/code-view.tsx";
import { KindGlyph } from "../graph/kind-glyph.tsx";
import { JsonPreview } from "../json-preview.tsx";
import { StatusGlyph } from "../ui/status.tsx";

/**
 * The side panel before a node is chosen: every node in graph order with what the run did
 * there, so a reader can jump to it. Junctions are left out; they carry no work.
 */
export function RunGuide(props: {
  model: GraphModel;
  marks: ReadonlyMap<string, NodeMark>;
  onSelect: (id: string) => void;
}) {
  const { model, marks, onSelect } = props;
  const nodes = model.nodes.filter((node) => node.role !== "junction" && node.role !== "end");

  return (
    <section aria-label="Nodes" className="px-2 py-3">
      <p className="px-2 pb-2 text-xs text-muted">
        Pick a node in the code or here to see its execution.
      </p>
      <ul>
        {nodes.map((node) => {
          const mark = marks.get(node.id);

          return (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => onSelect(node.id)}
                className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-control px-2 text-left hover:bg-hover ${mark?.skipped ? "opacity-50" : ""}`}
              >
                <span className="text-muted">
                  <KindGlyph kind={node.node.kind} />
                </span>
                <span className="min-w-0 flex-1 truncate">{node.title}</span>
                {mark?.note && <span className="text-xs text-muted tabular-nums">{mark.note}</span>}
                {mark?.status ? <StatusGlyph status={mark.status} /> : <span className="size-3" />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Hooks this run opened and how each ended. The pending one is answered from the header. The
 * snapshot holds at most 200 hooks; `truncated` says more exist.
 */
export function HookHistory({ hooks, truncated }: { hooks: HookRecord[]; truncated: boolean }) {
  const settled = hooks.filter(
    (hook) => hook.resolvedAt !== undefined || hook.expiredAt !== undefined,
  );

  if (settled.length === 0) {
    return null;
  }

  return (
    <section aria-label="Hooks" className="space-y-2 border-t border-line px-4 py-3">
      <h3 className="text-xs font-semibold text-muted">Hooks</h3>
      {truncated && (
        <p className="text-xs text-muted">Showing the first 200 hooks this run opened.</p>
      )}
      <ul className="grid gap-2">
        {settled.map((hook) => {
          const at = hook.resolvedAt ?? hook.expiredAt;

          return (
            <li key={hook.token} className="text-xs">
              <p>
                <code className="text-ink">{hook.name}</code>{" "}
                <span className={hook.expiredAt ? "text-danger" : "text-success"}>
                  {hook.expiredAt ? "expired" : "resolved"}
                </span>
                {at && <span className="ml-1.5 text-muted">{timestamp(at)}</span>}
              </p>
              {hook.payload !== undefined && <JsonPreview label="Payload" value={hook.payload} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

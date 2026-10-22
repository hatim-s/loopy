import type { GraphView } from "loopy/contract";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { OUTLINE_FILE, printOutline } from "../../lib/outline.ts";
import type { Loaded, SourceFile, SourceRange, SourceView } from "../../lib/view-models.ts";
import { CodeView, type NodeMark } from "./code-view.tsx";

const UNAVAILABLE = {
  not_captured: "Source was not captured when this revision was saved.",
  too_large: "Source for this revision was over the capture limit.",
  redacted: "Source for this revision held a stored secret value, so it was not kept.",
} satisfies Record<Extract<SourceView, { status: "unavailable" }>["reason"], string>;

type Listing = {
  files: SourceFile[];
  ranges: SourceRange[];
  /** Null for the author's source; otherwise why the listing is an outline. */
  outline: string | null;
};

function listing(source: Loaded<SourceView>, graph: GraphView): Listing | null {
  if (source.state === "loading") {
    return null;
  }

  if (source.state === "ready" && source.data.status === "available") {
    return { files: source.data.files, ranges: source.data.ranges, outline: null };
  }

  const outline = printOutline(graph);

  const reason =
    source.state === "ready" && source.data.status === "unavailable"
      ? UNAVAILABLE[source.data.reason]
      : `The daemon did not return source: ${source.state === "error" ? source.error.message : ""}`;

  return {
    files: [{ id: OUTLINE_FILE, path: "Compiled graph", content: outline.content }],
    ranges: outline.ranges,
    outline: reason,
  };
}

/**
 * The code half of a run or definition page: the pinned source with execution marks, or an
 * outline printed from the compiled graph when no source exists, labelled as such. Selecting
 * a node in another file switches to that file.
 */
export function SourcePane(props: {
  source: Loaded<SourceView>;
  graph: GraphView;
  marks: ReadonlyMap<string, NodeMark>;
  selected: string | null;
  onSelect: (id: string) => void;
  toolbar?: ReactNode;
}) {
  const { source, graph, marks, selected, onSelect, toolbar } = props;
  const list = useMemo(() => listing(source, graph), [source, graph]);
  const [fileId, setFileId] = useState<string | null>(null);

  const entryFile = list?.ranges.find((range) => range.nodeId === graph.entry)?.fileId;
  const selectedFile = list?.ranges.find((range) => range.nodeId === selected)?.fileId;

  useEffect(() => {
    if (selectedFile !== undefined) {
      setFileId(selectedFile);
    }
  }, [selectedFile]);

  if (list === null) {
    return <p className="p-4 text-muted">Loading the source this revision pinned.</p>;
  }

  const file =
    list.files.find((item) => item.id === fileId) ??
    list.files.find((item) => item.id === entryFile) ??
    list.files[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 items-center gap-1 border-b border-line px-2">
        <div
          role="tablist"
          aria-label="Files"
          className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto"
        >
          {list.files.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={item.id === file?.id}
              onClick={() => setFileId(item.id)}
              className="h-7 shrink-0 cursor-pointer rounded-control px-2.5 font-mono text-xs text-muted hover:bg-raised hover:text-ink aria-selected:bg-raised aria-selected:text-ink"
            >
              {item.path}
            </button>
          ))}
        </div>
        {toolbar}
      </div>
      {list.outline !== null && (
        <p className="border-b border-line bg-sunken px-4 py-2 text-xs text-muted">
          {list.outline} This is an outline printed from the compiled graph, not the author's file.
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {file && (
          <CodeView
            file={file}
            ranges={list.ranges}
            marks={marks}
            selected={selected}
            onSelect={onSelect}
          />
        )}
      </div>
    </div>
  );
}

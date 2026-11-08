import { type CSSProperties, memo, useEffect, useMemo, useRef } from "react";
import { lineOwners, type TokenKind, tokenize } from "../../lib/code-lines";
import type { NodeMark } from "../../lib/run-marks";
import { statusTone, statusWord, TONE_BG } from "../../lib/status";
import type { SourceFile, SourceRange } from "../../lib/view-models";
import { StatusGlyph } from "../ui/status";

const TOKEN_CLASS = {
  plain: "",
  keyword: "text-active",
  string: "text-success",
  number: "text-attention",
  comment: "text-faint italic",
  call: "font-medium",
} satisfies Record<TokenKind, string>;

function Chip(props: {
  nodeId: string;
  mark: NodeMark;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { nodeId, mark, selected, onSelect } = props;
  const label = [mark.title, mark.status ? statusWord(mark.status) : "no execution", mark.note];

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onSelect(nodeId);
      }}
      aria-pressed={selected}
      aria-label={label.filter((part) => part !== null).join(", ")}
      className={`inline-flex h-5 cursor-pointer items-center gap-1.5 rounded-full px-2 font-sans text-[11px] font-medium whitespace-nowrap ${mark.status ? `tone-${statusTone(mark.status)}` : "text-faint ring-1 ring-line ring-inset"} aria-pressed:ring-1 aria-pressed:ring-lamp`}
    >
      {mark.status && <StatusGlyph status={mark.status} size={11} />}
      <span className="@max-sm:hidden">{mark.title}</span>
      {mark.note && <span className="font-normal tabular-nums opacity-80">{mark.note}</span>}
    </button>
  );
}

function railClass(range: SourceRange | null, mark: NodeMark | null): string {
  if (mark?.status) {
    return TONE_BG[statusTone(mark.status)];
  }

  return range ? "bg-line" : "";
}

function Tokens({ text }: { text: string }) {
  if (text === "") {
    return " ";
  }

  return tokenize(text).map((token, index) => (
    <span key={index} className={TOKEN_CLASS[token.kind]}>
      {token.text}
    </span>
  ));
}

/*
 * Rows are as wide as the longest line, so anything that must stay in view sits in a sticky
 * cell: the gutter on the left, the chip on the right. Sticky cells need an opaque background
 * or the code scrolls through them. A selected row's tint is translucent, so it is laid over
 * the panel colour.
 */
const SELECTED_FILL: CSSProperties = {
  background: "linear-gradient(var(--selected), var(--selected)), var(--panel)",
};

function stickyFill(selected: boolean, hoverable: boolean) {
  if (selected) {
    return { className: "", style: SELECTED_FILL };
  }

  return { className: hoverable ? "bg-panel group-hover:bg-hover" : "bg-panel" };
}

const GUTTER = "grid-cols-[calc(3.25rem+4px)_minmax(0,1fr)_auto]";

function Gutter(props: {
  number: number | null;
  rail: string;
  selected: boolean;
  hoverable: boolean;
}) {
  const { number, rail, selected, hoverable } = props;
  const fill = stickyFill(selected, hoverable);

  return (
    <span
      className={`sticky left-0 z-[1] grid grid-cols-[3.25rem_4px] ${fill.className}`}
      style={fill.style}
    >
      <span className="pr-3 text-right text-faint select-none tabular-nums">{number}</span>
      <span aria-hidden="true" className={rail} />
    </span>
  );
}

// The note spans the visible width (the scroller is a size container), not the longest line.
function ErrorLine({ message }: { message: string }) {
  return (
    <div className="sticky left-0 grid w-[100cqw] grid-cols-[3.25rem_4px_minmax(0,1fr)]">
      <span />
      <span className="bg-danger" />
      <p
        role="note"
        className="my-0.5 mr-3 ml-4 rounded-control bg-danger-soft px-2.5 py-1 font-mono text-xs break-words whitespace-pre-wrap text-danger"
      >
        {message}
      </p>
    </div>
  );
}

const Line = memo(function Line(props: {
  number: number;
  text: string;
  range: SourceRange | null;
  mark: NodeMark | null;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { number, text, range, mark, selected, onSelect } = props;
  const first = range?.startLine === number;
  const last = range?.endLine === number;
  const ends = `${first ? "rounded-t-full" : ""} ${last ? "rounded-b-full" : ""}`;
  const ring = selected && range ? "shadow-[0_0_0_1px_var(--lamp)]" : "";
  const background = selected ? "bg-selected" : range ? "hover:bg-hover" : "";
  const chip = first && range && mark;
  const fill = stickyFill(selected, range !== null);

  return (
    <>
      <div
        data-line={number}
        className={`group grid ${GUTTER} items-stretch ${background} ${mark?.skipped ? "opacity-45" : ""}`}
        onClick={range ? () => onSelect(range.nodeId) : undefined}
      >
        <Gutter
          number={number}
          rail={`${railClass(range, mark)} ${ends} ${ring}`}
          selected={selected}
          hoverable={range !== null}
        />
        <code className={`min-w-0 pl-4 whitespace-pre ${range ? "cursor-pointer" : ""}`}>
          <Tokens text={text} />
        </code>
        {chip ? (
          <span
            className={`sticky right-0 z-[1] flex items-center pr-3 pl-3 shadow-[-14px_0_10px_-6px_var(--panel)] ${fill.className}`}
            style={fill.style}
          >
            <Chip nodeId={range.nodeId} mark={mark} selected={selected} onSelect={onSelect} />
          </span>
        ) : (
          <span className="pr-3" />
        )}
      </div>
      {last && mark?.error && <ErrorLine message={mark.error} />}
    </>
  );
});

// Lines no range covers stay plain: the view never guesses which node a line belongs to.
export function CodeView(props: {
  file: SourceFile;
  ranges: SourceRange[];
  marks: ReadonlyMap<string, NodeMark>;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { file, ranges, marks, selected, onSelect } = props;
  const lines = useMemo(() => file.content.split("\n"), [file.content]);

  const owners = useMemo(
    () =>
      lineOwners(
        lines.length,
        ranges.filter((range) => range.fileId === file.id),
      ),
    [lines.length, ranges, file.id],
  );

  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const range = ranges.find((item) => item.nodeId === selected && item.fileId === file.id);
    const target = range && scroller.current?.querySelector(`[data-line="${range.startLine}"]`);

    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: "nearest" });
    }
  }, [selected, ranges, file.id]);

  return (
    <div
      ref={scroller}
      className="@container min-h-0 flex-1 overflow-auto py-3 font-mono text-[13px] leading-[22px]"
    >
      <div className="min-w-max">
        {lines.map((text, index) => {
          const range = owners[index] ?? null;
          const number = index + 1;

          return (
            <Line
              key={number}
              number={number}
              text={text}
              range={range}
              mark={range ? (marks.get(range.nodeId) ?? null) : null}
              selected={range !== null && range.nodeId === selected}
              onSelect={onSelect}
            />
          );
        })}
      </div>
    </div>
  );
}

import { type Edge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { GraphEdgeModel } from "../../lib/graph.ts";

type Point = { x: number; y: number };

export type FlowEdge = Edge<
  { model: GraphEdgeModel; points: Point[]; label: Point | null; live: boolean },
  "track"
>;

const f = (value: number) => Math.round(value * 10) / 10;

/**
 * A uniform B-spline through dagre's route points, the same curve dagre-d3 draws. It starts and
 * ends on the first and last points, so the track meets each node where dagre put it.
 */
export function trackPath(points: Point[]): string {
  const [first, second] = points;
  const last = points.at(-1);

  if (first === undefined || second === undefined || last === undefined) {
    return "";
  }

  if (points.length === 2) {
    return `M${f(first.x)},${f(first.y)}L${f(last.x)},${f(last.y)}`;
  }

  let path = `M${f(first.x)},${f(first.y)}L${f((5 * first.x + second.x) / 6)},${f((5 * first.y + second.y) / 6)}`;
  let [a, b] = [first, second];

  for (const c of [...points.slice(2), last]) {
    path += `C${f((2 * a.x + b.x) / 3)},${f((2 * a.y + b.y) / 3)} ${f((a.x + 2 * b.x) / 3)},${f(
      (a.y + 2 * b.y) / 3,
    )} ${f((a.x + 4 * b.x + c.x) / 6)},${f((a.y + 4 * b.y + c.y) / 6)}`;
    [a, b] = [b, c];
  }

  return `${path}L${f(b.x)},${f(b.y)}`;
}

/** A small chevron at the end of the track, turned along its last segment. */
function arrowPath(points: Point[]): string {
  const end = points.at(-1);
  const before = points.at(-2);

  if (end === undefined || before === undefined) {
    return "";
  }

  const angle = Math.atan2(end.y - before.y, end.x - before.x);

  const wing = (turn: number) =>
    `${f(end.x - 6 * Math.cos(angle + turn))},${f(end.y - 6 * Math.sin(angle + turn))}`;

  return `M${wing(0.5)}L${f(end.x)},${f(end.y)}L${wing(-0.5)}`;
}

/** Tracks follow dagre's routes instead of XYFlow's handle-to-handle paths, so they avoid nodes. */
export function TrackEdge(props: EdgeProps<FlowEdge>) {
  const { data, id } = props;

  if (data === undefined) {
    return null;
  }

  const { model, points, label, live } = data;
  const path = trackPath(points);

  return (
    <g
      className={`loopy-track track-${model.kind}`}
      data-taken={model.taken || undefined}
      data-live={live || undefined}
    >
      <path id={id} d={path} className="track-line" fill="none" />
      {live && <path d={path} className="track-flow" fill="none" />}
      <path d={arrowPath(points)} className="track-arrow" fill="none" />
      {label !== null && model.label !== null && (
        <EdgeLabelRenderer>
          <span
            className={`track-label track-label-${model.kind}`}
            style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}
          >
            {model.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}

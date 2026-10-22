import { useEffect, useMemo, useRef, useState } from "react";
import { focusNodes, type GraphModel } from "../../lib/graph.ts";
import type { FitPadding, GraphLayout } from "../../lib/graph-layout.ts";
import { GraphCanvas } from "./graph-canvas.tsx";

const PADDING: FitPadding = { top: "24px", right: "24px", bottom: "64px", left: "24px" };

/**
 * The graph inside a page pane. It measures the pane before mounting the canvas, because the
 * first view depends on how much room there is. Selection belongs to the page, so the code view
 * and the graph always point at the same node.
 */
export function GraphPane(props: {
  model: GraphModel;
  layout: GraphLayout;
  entry: string;
  /** Remounts the canvas, which reframes it. Use the revision. */
  revision: string;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { model, layout, entry, revision, selected, onSelect } = props;
  const box = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const element = box.current;

    if (!element) {
      return;
    }

    const observer = new ResizeObserver(([entryBox]) => {
      const rect = entryBox?.contentRect;

      // Only the first size matters; later resizes keep the reader's pan and zoom.
      if (rect && rect.width > 0 && rect.height > 0) {
        setPane((current) => current ?? { width: rect.width, height: rect.height });
      }
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const focus = useMemo(() => focusNodes(model, entry), [model, entry]);

  return (
    <div ref={box} className="relative h-full min-h-[360px] w-full">
      {pane !== null && model.nodes.length > 0 && (
        <GraphCanvas
          key={revision}
          model={model}
          layout={layout}
          focus={focus}
          selected={selected}
          onSelect={onSelect}
          padding={PADDING}
          pane={pane}
          minimapAllowed
          readout={null}
        />
      )}
      {model.nodes.length === 0 && (
        <p className="grid h-full place-items-center text-muted">
          This revision has no nodes to draw.
        </p>
      )}
    </div>
  );
}

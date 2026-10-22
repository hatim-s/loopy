import type { ServerEvent } from "../contract/index.js";
import type { RuntimeEvent } from "../core/index.js";

type NodeEvent = Extract<RuntimeEvent, { entity: "node" }>;

type NodeEventView = Extract<ServerEvent, { entity: "node" }>;

export function nodeDetailEvent(event: NodeEvent): NodeEventView {
  const record = { ...event.record };
  delete record.inputView;

  return { ...event, record };
}

export function nodeEventPreview(event: NodeEvent): NodeEventView {
  const view = nodeDetailEvent(event);

  if (view.record.status !== "succeeded") {
    return view;
  }

  const bytes = new TextEncoder().encode(JSON.stringify(view.record.output)).byteLength;

  if (bytes <= 16_384) {
    return view;
  }

  return { ...view, truncatedOutputBytes: bytes, record: { ...view.record, output: null } };
}

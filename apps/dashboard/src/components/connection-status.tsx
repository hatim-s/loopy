import { type ConnectionState, useConnectionState } from "../lib/connection.ts";

const LABEL = {
  connecting: { text: "Connecting", tone: "text-muted", title: "Opening the event stream." },
  live: { text: "Live", tone: "text-success", title: "Changes appear as the run records them." },
  reconnecting: {
    text: "Reconnecting",
    tone: "text-attention",
    title: "The event stream dropped. Retrying, then catching up from the last event.",
  },
  stale: {
    text: "Stale",
    tone: "text-danger",
    title: "The event stream stopped. What you see may be out of date. Reload to reconnect.",
  },
} satisfies Record<Exclude<ConnectionState, "idle">, { text: string; tone: string; title: string }>;

export function ConnectionStatus() {
  const state = useConnectionState();

  if (state === "idle") {
    return null;
  }

  const { text, tone, title } = LABEL[state];

  return (
    <p
      role="status"
      title={title}
      className={`flex h-7 items-center gap-1.5 px-1 text-xs whitespace-nowrap ${tone}`}
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      <span className="max-sm:sr-only">{text}</span>
    </p>
  );
}

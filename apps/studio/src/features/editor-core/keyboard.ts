export type EditorCommandIntent =
  | "undo"
  | "redo"
  | "save"
  | "delete"
  | "duplicate"
  | "select_all"
  | "clear_selection"
  | "auto_layout";

export type KeyboardLikeEvent = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

/** Maps platform keyboard gestures to editor intents without touching the DOM. */
export function keyboardIntent(event: KeyboardLikeEvent): EditorCommandIntent | undefined {
  const key = event.key.toLowerCase();
  const primary = Boolean(event.metaKey || event.ctrlKey);
  if (primary && key === "z") return event.shiftKey ? "redo" : "undo";
  if (primary && key === "y") return "redo";
  if (primary && key === "s") return "save";
  if (primary && key === "a") return "select_all";
  if (primary && key === "d") return "duplicate";
  if (key === "delete" || key === "backspace") return "delete";
  if (key === "escape") return "clear_selection";
  if (key === "l" && !primary && !event.altKey) return "auto_layout";
  return undefined;
}

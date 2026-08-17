import { WarningCircle } from "@phosphor-icons/react";

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <output className="state-panel state-panel--loading" aria-live="polite">
      <span className="loading-bar" aria-hidden="true" />
      <span>{label}</span>
    </output>
  );
}
export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <output className="state-panel">
      <div>
        <div className="state-panel__title">{title}</div>
        <div className="state-panel__detail">{detail}</div>
      </div>
    </output>
  );
}
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-panel state-panel--error" role="alert">
      <WarningCircle size={18} aria-hidden="true" />
      <div>
        <div className="state-panel__title">Unable to load this view</div>
        <div className="state-panel__detail">{message}</div>
        {onRetry ? (
          <button className="text-button" onClick={onRetry} type="button">
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

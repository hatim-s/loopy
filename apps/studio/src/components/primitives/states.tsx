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
  const sessionExpired = message.includes("Studio session expired");
  return (
    <div className="state-panel state-panel--error" role="alert">
      <WarningCircle size={18} aria-hidden="true" />
      <div>
        <div className="state-panel__title">
          {sessionExpired ? "Reconnect to Studio" : "Something needs attention"}
        </div>
        <div className="state-panel__detail">{message}</div>
        {sessionExpired ? (
          <button type="button" onClick={() => window.location.reload()}>
            Reload Studio
          </button>
        ) : null}
        {onRetry ? (
          <button className="text-button" onClick={onRetry} type="button">
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

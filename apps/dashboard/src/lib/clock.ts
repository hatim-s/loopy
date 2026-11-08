import { useEffect, useState } from "react";

/** The current time, ticking every `intervalMs` while the tab is visible. */
export function useClock(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

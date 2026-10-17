import { useEffect, useState } from "react";

/** The current time, ticking once a second while the tab is visible. */
export function useClock(): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
      }
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  return now;
}

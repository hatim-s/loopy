import { useEffect, useState } from "react";

export function useClock() {
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

import { type RefObject, useEffect, useRef } from "react";

/** Adds the `in` class once, the first time the element enters the viewport. The timing lives in CSS. */
export function useReveal<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;

    if (!node) {
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) {
            continue;
          }

          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );

    io.observe(node);

    return () => io.disconnect();
  }, []);

  return ref;
}

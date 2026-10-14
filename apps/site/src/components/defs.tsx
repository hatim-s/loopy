const LOOP =
  "M6.5 7.5c-2.8 0-4.5 2-4.5 4.5s1.7 4.5 4.5 4.5c4 0 7-9 11-9 2.8 0 4.5 2 4.5 4.5s-1.7 4.5-4.5 4.5c-4 0-7-9-11-9Z";

export const LOOP_PATH = LOOP;

/** Shared gradients and the node glyphs the stage and the cards reference by id. */
export function Defs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="g0" />
          <stop offset="1" className="g1" />
        </linearGradient>
        <linearGradient id="wg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1200" y2="600">
          <stop offset="0" className="g0" />
          <stop offset="1" className="g1" />
        </linearGradient>
        <symbol id="g-agent" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="8" r="2" fill="currentColor" />
        </symbol>
        <symbol id="g-shell" viewBox="0 0 16 16">
          <path
            d="M3 4.5 6.5 8 3 11.5M8.5 12h5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </symbol>
        <symbol id="g-route" viewBox="0 0 16 16">
          <path
            d="M8 2.5 13.5 8 8 13.5 2.5 8Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </symbol>
        <symbol id="g-verify" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="m5.6 8.2 1.7 1.7 3.2-3.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </symbol>
        <symbol id="g-approval" viewBox="0 0 16 16">
          <path
            d="M4 13V3M12 13V3M4 7h8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </symbol>
        <symbol id="g-mark" viewBox="0 0 24 24">
          <path
            d={LOOP}
            fill="none"
            stroke="url(#brand)"
            strokeWidth="2.2"
            strokeLinejoin="round"
          />
        </symbol>
      </defs>
    </svg>
  );
}

export function Mark({ size = 24, label }: { size?: number; label?: string }) {
  return (
    <a className="mark" href="#top" aria-label={label}>
      <svg width={size} height={size} aria-hidden="true">
        <use href="#g-mark" />
      </svg>
      loopy
    </a>
  );
}

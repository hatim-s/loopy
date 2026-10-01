import { useId } from "react";

export function BrandMark() {
  const gradient = `brand-${useId().replaceAll(":", "")}`;
  return (
    <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradient} x1="4" y1="6" x2="36" y2="34" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8fa8ff" />
          <stop offset="1" stopColor="#6ee0d2" />
        </linearGradient>
      </defs>
      <path
        d="M20 20c-4.5-7-8-10-11.5-10C5.5 10 3 12.7 3 16.5v7C3 27.3 5.5 30 8.5 30 12 30 15.5 27 20 20Zm0 0c4.5 7 8 10 11.5 10 3 0 5.5-2.7 5.5-6.5v-7C37 12.7 34.5 10 31.5 10 28 10 24.5 13 20 20Z"
        stroke={`url(#${gradient})`}
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

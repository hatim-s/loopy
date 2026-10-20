import type { ButtonHTMLAttributes } from "react";

const VARIANT = {
  plain: "border-line-strong bg-panel text-ink hover:bg-raised",
  primary: "border-lamp bg-lamp text-on-lamp hover:border-lamp-strong hover:bg-lamp-strong",
} as const;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANT };

export function Button({ variant = "plain", className = "", ...props }: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-45 ${VARIANT[variant]} ${className}`}
    />
  );
}

import type { ButtonHTMLAttributes } from "react";

const VARIANT = {
  plain: "border-line bg-panel hover:bg-raised",
  primary: "border-ink bg-ink text-page hover:opacity-90",
} as const;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANT };

export function Button({ variant = "plain", className = "", ...props }: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex h-7 items-center rounded-md border px-2.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-45 ${VARIANT[variant]} ${className}`}
    />
  );
}

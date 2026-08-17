import type { ButtonHTMLAttributes, PropsWithChildren } from "react";

export function IconButton({
  children,
  className = "",
  ...props
}: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button className={`icon-button ${className}`.trim()} type="button" {...props}>
      {children}
    </button>
  );
}

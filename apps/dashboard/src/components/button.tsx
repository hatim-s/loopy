import type { ButtonHTMLAttributes } from "react";

const VARIANT = {
  plain: "",
  primary: "btn-primary",
  danger: "btn-danger",
} as const;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANT;
  small?: boolean;
};

export function Button({
  variant = "plain",
  small = false,
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`btn ${VARIANT[variant]} ${small ? "btn-sm" : ""} ${className}`}
    />
  );
}

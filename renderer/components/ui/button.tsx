import * as React from "react";
import { cn } from "@/lib/utils";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "secondary" | "danger" | "ghost";
}

const variantClass: Record<NonNullable<ButtonProps["variant"]>, string> = {
  default: "bg-primary text-white hover:bg-indigo-500",
  secondary: "bg-muted text-foreground hover:bg-zinc-700",
  danger: "bg-danger text-white hover:bg-red-500",
  ghost: "bg-transparent text-zinc-300 hover:bg-zinc-800"
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variantClass[variant],
        className
      )}
      {...props}
    />
  )
);

Button.displayName = "Button";

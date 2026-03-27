import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ScrollAreaProps {
  children: ReactNode;
  className?: string;
}

export const ScrollArea = ({ children, className }: ScrollAreaProps) => (
  <ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)}>
    <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.Scrollbar
      orientation="vertical"
      className="flex w-2.5 touch-none select-none bg-zinc-900 p-0.5"
    >
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-zinc-700" />
    </ScrollAreaPrimitive.Scrollbar>
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
);

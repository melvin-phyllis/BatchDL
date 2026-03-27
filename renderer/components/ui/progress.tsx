import { cn } from "@/lib/utils";

interface ProgressProps {
  value: number;
  className?: string;
}

export const Progress = ({ value, className }: ProgressProps) => {
  const width = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-2 w-full rounded-full bg-zinc-800", className)}>
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${width}%` }}
      />
    </div>
  );
};

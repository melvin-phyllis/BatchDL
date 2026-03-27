import { DownloadStatus } from "@shared/types";
import { cn } from "@/lib/utils";

interface BadgeProps {
  status: DownloadStatus;
}

const statusClass: Record<DownloadStatus, string> = {
  waiting: "bg-zinc-700 text-zinc-200",
  resolving: "bg-sky-600 text-white",
  pending: "bg-amber-600 text-white",
  downloading: "bg-indigo-600 text-white",
  paused: "bg-amber-600 text-white",
  done: "bg-green-600 text-white",
  error: "bg-red-600 text-white"
};

export const Badge = ({ status }: BadgeProps) => (
  <span className={cn("rounded-full px-2 py-1 text-xs font-semibold", statusClass[status])}>
    {status === "resolving" ? "Resolving..." : status === "pending" ? "Pending..." : status}
  </span>
);

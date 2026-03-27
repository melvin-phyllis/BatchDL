import { DownloadItemState } from "@/hooks/useDownloads";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatBytes, formatSpeed } from "@/lib/utils";

interface DownloadItemProps {
  item: DownloadItemState;
  onCancel: (url: string) => void;
  onRetry: (url: string) => void;
}

export const DownloadItem = ({ item, onCancel, onRetry }: DownloadItemProps) => {
  return (
    <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-100">{item.fileName}</p>
          <p className="truncate text-xs text-zinc-500">{item.url}</p>
        </div>
        <Badge status={item.status} />
      </div>
      {item.resumedFromPercent !== undefined && item.status === "downloading" && (
        <p className="text-xs font-medium text-emerald-400">
          Reprise à environ {item.resumedFromPercent}% (HTTP Range)
        </p>
      )}
      <Progress value={item.percent} />
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span>{item.percent.toFixed(1)}%</span>
        <span>
          {formatBytes(item.downloaded)} / {item.total > 0 ? formatBytes(item.total) : "Unknown"}
        </span>
        <span>{formatSpeed(item.speed)}</span>
      </div>
      {item.status === "pending" && (
        <p className="text-xs text-amber-300">⏳ Starts in {item.countdownRemaining ?? 0}s...</p>
      )}
      {item.error && <p className="text-xs text-red-400">{item.error}</p>}
      <div className="flex justify-end gap-2">
        {(item.status === "downloading" || item.status === "resolving" || item.status === "pending") && (
          <Button variant="danger" className="h-8" onClick={() => onCancel(item.url)}>
            Pause
          </Button>
        )}
        {(item.status === "error" || item.status === "paused") && (
          <Button variant="secondary" className="h-8" onClick={() => onRetry(item.url)}>
            {item.status === "paused" ? "Resume" : "Retry"}
          </Button>
        )}
      </div>
    </div>
  );
};

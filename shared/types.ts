export type DownloadStatus =
  | "waiting"
  | "resolving"
  | "pending"
  | "downloading"
  | "paused"
  | "done"
  | "error";

export interface StartDownloadsPayload {
  urls: string[];
  destinationFolder: string;
  concurrency: number;
  delayMs: number;
}

export interface DownloadProgressPayload {
  url: string;
  percent: number;
  speed: number;
  downloaded: number;
  total: number;
  fileName: string;
  /** Présent sur le premier événement après reprise HTTP Range. */
  resumedFromPercent?: number;
}

/** Ligne affichée dans la boîte de reprise au démarrage. */
export interface RestoreDownloadRow {
  url: string;
  filename: string;
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
  destFolder: string;
  destPath: string;
}

export interface DownloadDonePayload {
  url: string;
  filePath: string;
  fileName: string;
}

export interface DownloadErrorPayload {
  url: string;
  error: string;
  fileName: string;
}

export interface DownloadStatsPayload {
  total: number;
  done: number;
  failed: number;
  speed: number;
}

export interface DownloadStatusPayload {
  url: string;
  status: DownloadStatus;
  error?: string;
  fileName?: string;
}

export interface DownloadCountdownPayload {
  url: string;
  secondsRemaining: number;
}

/// <reference types="vite/client" />

import type {
  DownloadCountdownPayload,
  DownloadDonePayload,
  DownloadErrorPayload,
  DownloadProgressPayload,
  DownloadStatusPayload,
  DownloadStatsPayload,
  RestoreDownloadRow,
  StartDownloadsPayload
} from "../shared/types";

interface ElectronApi {
  chooseFolder: () => Promise<string | null>;
  startDownloads: (payload: StartDownloadsPayload) => Promise<{ accepted: number }>;
  cancelDownload: (url: string) => Promise<boolean>;
  retryDownload: (url: string) => Promise<boolean>;
  onDownloadProgress: (listener: (payload: DownloadProgressPayload) => void) => () => void;
  onDownloadDone: (listener: (payload: DownloadDonePayload) => void) => () => void;
  onDownloadError: (listener: (payload: DownloadErrorPayload) => void) => () => void;
  onDownloadStatus: (listener: (payload: DownloadStatusPayload) => void) => () => void;
  onDownloadCountdown: (listener: (payload: DownloadCountdownPayload) => void) => () => void;
  onDownloadStats: (listener: (payload: DownloadStatsPayload) => void) => () => void;
  getPendingRestore: () => Promise<RestoreDownloadRow[]>;
  confirmRestoreDownloads: (urls: string[]) => Promise<{ queued: number }>;
  discardRestoreDownloads: (urls: string[]) => Promise<{ removed: number }>;
}

declare global {
  interface Window {
    electronApi: ElectronApi;
  }
}

export {};

/// <reference types="vite/client" />

import type {
  DownloadCountdownPayload,
  DownloadDonePayload,
  DownloadErrorPayload,
  DownloadProgressPayload,
  DownloadStatusPayload,
  DownloadStatsPayload,
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
}

declare global {
  interface Window {
    electronApi: ElectronApi;
  }
}

export {};

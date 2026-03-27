import { contextBridge, ipcRenderer } from "electron";
import {
  DownloadCountdownPayload,
  DownloadDonePayload,
  DownloadErrorPayload,
  DownloadProgressPayload,
  DownloadStatusPayload,
  DownloadStatsPayload,
  RestoreDownloadRow,
  StartDownloadsPayload
} from "./shared/types";

type Unsubscribe = () => void;

const on = <T>(channel: string, listener: (payload: T) => void): Unsubscribe => {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

const electronApi = {
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke("choose-folder"),
  startDownloads: (payload: StartDownloadsPayload): Promise<{ accepted: number }> =>
    ipcRenderer.invoke("start-downloads", payload),
  cancelDownload: (url: string): Promise<boolean> => ipcRenderer.invoke("cancel-download", url),
  retryDownload: (url: string): Promise<boolean> => ipcRenderer.invoke("retry-download", url),
  onDownloadProgress: (listener: (payload: DownloadProgressPayload) => void): Unsubscribe =>
    on("download-progress", listener),
  onDownloadDone: (listener: (payload: DownloadDonePayload) => void): Unsubscribe =>
    on("download-done", listener),
  onDownloadError: (listener: (payload: DownloadErrorPayload) => void): Unsubscribe =>
    on("download-error", listener),
  onDownloadStatus: (listener: (payload: DownloadStatusPayload) => void): Unsubscribe =>
    on("download-status", listener),
  onDownloadCountdown: (listener: (payload: DownloadCountdownPayload) => void): Unsubscribe =>
    on("download-countdown", listener),
  onDownloadStats: (listener: (payload: DownloadStatsPayload) => void): Unsubscribe =>
    on("download-stats", listener),
  getPendingRestore: (): Promise<RestoreDownloadRow[]> => ipcRenderer.invoke("get-pending-restore"),
  confirmRestoreDownloads: (urls: string[]): Promise<{ queued: number }> =>
    ipcRenderer.invoke("confirm-restore-downloads", urls),
  discardRestoreDownloads: (urls: string[]): Promise<{ removed: number }> =>
    ipcRenderer.invoke("discard-restore-downloads", urls)
};

contextBridge.exposeInMainWorld("electronApi", electronApi);

import { useEffect, useMemo, useState } from "react";
import { DownloadStatus, StartDownloadsPayload } from "@shared/types";

export interface DownloadItemState {
  url: string;
  fileName: string;
  status: DownloadStatus;
  percent: number;
  speed: number;
  downloaded: number;
  total: number;
  filePath?: string;
  error?: string;
  countdownRemaining?: number;
}

interface StatsState {
  total: number;
  done: number;
  failed: number;
  speed: number;
}

const fileNameFromUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split("/").pop() || "download.bin");
  } catch {
    return "invalid-url";
  }
};

export const useDownloads = () => {
  const [items, setItems] = useState<DownloadItemState[]>([]);
  const [stats, setStats] = useState<StatsState>({ total: 0, done: 0, failed: 0, speed: 0 });
  const hasElectronApi = typeof window !== "undefined" && typeof window.electronApi !== "undefined";

  useEffect(() => {
    if (!hasElectronApi) {
      return;
    }

    const offProgress = window.electronApi.onDownloadProgress((payload) => {
      setItems((prev) =>
        prev.map((item) =>
          item.url === payload.url
            ? {
                ...item,
                status: "downloading",
                percent: payload.percent,
                speed: payload.speed,
                downloaded: payload.downloaded,
                total: payload.total,
                fileName: payload.fileName
              }
            : item
        )
      );
    });

    const offDone = window.electronApi.onDownloadDone((payload) => {
      setItems((prev) =>
        prev.map((item) =>
          item.url === payload.url
            ? {
                ...item,
                status: "done",
                percent: 100,
                speed: 0,
                filePath: payload.filePath,
                fileName: payload.fileName
              }
            : item
        )
      );
    });

    const offError = window.electronApi.onDownloadError((payload) => {
      setItems((prev) =>
        prev.map((item) =>
          item.url === payload.url
            ? { ...item, status: "error", error: payload.error, speed: 0 }
            : item
        )
      );
    });

    const offStatus = window.electronApi.onDownloadStatus((payload) => {
      setItems((prev) =>
        prev.map((item) =>
          item.url === payload.url
            ? {
                ...item,
                status: payload.status,
                fileName: payload.fileName ?? item.fileName,
                error: payload.error ?? (payload.status === "error" ? item.error : undefined),
                countdownRemaining:
                  payload.status === "pending" ? item.countdownRemaining : undefined
              }
            : item
        )
      );
    });

    const offCountdown = window.electronApi.onDownloadCountdown((payload) => {
      setItems((prev) =>
        prev.map((item) =>
          item.url === payload.url
            ? {
                ...item,
                status: payload.secondsRemaining > 0 ? "pending" : item.status,
                countdownRemaining: payload.secondsRemaining
              }
            : item
        )
      );
    });

    const offStats = window.electronApi.onDownloadStats((payload) => {
      setStats(payload);
    });

    return () => {
      offProgress();
      offDone();
      offError();
      offStatus();
      offCountdown();
      offStats();
    };
  }, [hasElectronApi]);

  const startDownloads = async (payload: StartDownloadsPayload): Promise<void> => {
    if (!hasElectronApi) {
      throw new Error("Electron API unavailable. Launch the app via Electron, not a browser tab.");
    }
    const normalizedUrls = payload.urls.map((entry) => entry.trim()).filter(Boolean);
    setItems(
      normalizedUrls.map((url) => ({
        url,
        fileName: fileNameFromUrl(url),
        status: "waiting",
        percent: 0,
        speed: 0,
        downloaded: 0,
        total: 0,
        countdownRemaining: undefined
      }))
    );
    await window.electronApi.startDownloads(payload);
  };

  const cancelDownload = async (url: string): Promise<void> => {
    if (!hasElectronApi) {
      return;
    }
    await window.electronApi.cancelDownload(url);
    setItems((prev) =>
      prev.map((item) => (item.url === url ? { ...item, status: "paused", speed: 0 } : item))
    );
  };

  const retryDownload = async (url: string): Promise<void> => {
    if (!hasElectronApi) {
      return;
    }
    await window.electronApi.retryDownload(url);
    setItems((prev) =>
      prev.map((item) =>
        item.url === url
          ? { ...item, status: "waiting", error: undefined, percent: 0, downloaded: 0, total: 0 }
          : item
      )
    );
  };

  const computed = useMemo(() => stats, [stats]);

  return {
    items,
    stats: computed,
    hasElectronApi,
    startDownloads,
    cancelDownload,
    retryDownload
  };
};

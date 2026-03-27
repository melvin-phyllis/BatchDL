import { app, BrowserWindow, dialog, ipcMain } from "electron";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DownloadCountdownPayload,
  DownloadDonePayload,
  DownloadErrorPayload,
  DownloadProgressPayload,
  DownloadStatusPayload,
  DownloadStatsPayload,
  StartDownloadsPayload
} from "./shared/types";
import { downloadWithRetry } from "./utils/downloader";
import { closeSharedDatanodesBrowser, resolveDatanodesDownload } from "./utils/datanodesPuppeteer";
import { initLogger, logError, logInfo, logWarn } from "./utils/logger";

type QueueStatus = "waiting" | "resolving" | "pending" | "downloading" | "paused" | "done" | "error";

interface QueueItem {
  url: string;
  destinationFolder: string;
  status: QueueStatus;
  resolvedFileName?: string;
  requestHeaders?: Record<string, string>;
}

interface ActiveDownload {
  controller: AbortController;
}

let mainWindow: BrowserWindow | null = null;
let queue: QueueItem[] = [];
let activeDownloads = new Map<string, ActiveDownload>();
let completed = 0;
let failed = 0;
let currentSpeedMap = new Map<string, number>();
let concurrency = 3;
let delayMs = 500;

const isDevelopment = process.env.NODE_ENV === "development";

const emit = (channel: string, payload: unknown): void => {
  mainWindow?.webContents.send(channel, payload);
};

const emitStats = (): void => {
  const speed = Array.from(currentSpeedMap.values()).reduce((acc, cur) => acc + cur, 0);
  const payload: DownloadStatsPayload = {
    total: queue.length,
    done: completed,
    failed,
    speed
  };
  emit("download-stats", payload);
};

const pickNextItem = (): QueueItem | undefined => {
  return queue.find((item) => item.status === "waiting");
};

const emitStatus = (url: string, status: QueueStatus, error?: string, fileName?: string): void => {
  const payload: DownloadStatusPayload = { url, status, error, fileName };
  emit("download-status", payload);
};

const emitCountdown = (url: string, secondsRemaining: number): void => {
  const payload: DownloadCountdownPayload = { url, secondsRemaining };
  emit("download-countdown", payload);
};

const normalizeUrlForCompare = (value: string): string => value.trim().toLowerCase();

const isFuckingfastHost = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.hostname === "fuckingfast.co" || parsed.hostname.endsWith(".fuckingfast.co");
  } catch {
    return false;
  }
};

const isDlUrl = (value: string): boolean => {
  try {
    return new URL(value).pathname.includes("/dl/");
  } catch {
    return value.includes("/dl/");
  }
};

const isDatanodesHost = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.hostname === "datanodes.to" || parsed.hostname.endsWith(".datanodes.to");
  } catch {
    return false;
  }
};

const isDlproxyHost = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.hostname === "tunnel1.dlproxy.uk" || parsed.hostname.endsWith(".dlproxy.uk");
  } catch {
    return false;
  }
};

const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Download canceled by user"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

const registerFuckingfastCount = async (pageUrl: string): Promise<void> => {
  const registerUrl = `${pageUrl.replace(/\/+$/, "")}/dl`;
  try {
    await axios.post(
      registerUrl,
      {},
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        timeout: 10000
      }
    );
    logInfo("fuckingfast register count success", { pageUrl, registerUrl });
  } catch {
    logWarn("fuckingfast register count failed", { pageUrl, registerUrl });
    // Registration failure should not block real download.
  }
};

const filenameFromContentDisposition = (headerValue?: string): string | null => {
  if (!headerValue) {
    return null;
  }
  const match = headerValue.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i);
  if (!match?.[1]) {
    return null;
  }
  try {
    return decodeURIComponent(match[1].trim());
  } catch {
    return match[1].trim();
  }
};

const resolveFilename = (
  pageUrl: string,
  pageHtml: string,
  dlUrl: string,
  responseHeaders: Record<string, string>
): string => {
  const cd = responseHeaders["content-disposition"];
  const headerName = filenameFromContentDisposition(cd);
  if (headerName) {
    return headerName;
  }

  try {
    const hash = new URL(pageUrl).hash.replace("#", "");
    if (hash && hash.includes(".")) {
      return decodeURIComponent(hash);
    }
  } catch {
    // no-op
  }

  const titleMatch = pageHtml.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch?.[1]) {
    const title = titleMatch[1].trim();
    if (title.includes(".")) {
      return title;
    }
  }

  try {
    const parsed = new URL(pageUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1] || path.basename(new URL(dlUrl).pathname) || "download";
  } catch {
    const segments = pageUrl.split("/").filter(Boolean);
    return segments[segments.length - 1] || "download";
  }
};

const resolveDownloadUrl = async (
  url: string,
  signal: AbortSignal,
  emitPendingCountdown: (secondsRemaining: number) => void
): Promise<{
  resolvedUrl: string;
  sourcePageUrl?: string;
  resolvedFileName?: string;
  requestHeaders?: Record<string, string>;
}> => {
  logInfo("resolve start", { url });
  if (isDlproxyHost(url) || isDlUrl(url)) {
    logInfo("resolve bypass direct download", { url });
    return {
      resolvedUrl: url,
      requestHeaders: isDlproxyHost(url)
        ? {
            Referer: "https://datanodes.to/",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "cross-site",
            "upgrade-insecure-requests": "1"
          }
        : undefined
    };
  }

  if (isDatanodesHost(url)) {
    const { resolvedUrl, resolvedFileName, selectedPageUrl } = await resolveDatanodesDownload(
      url,
      signal,
      emitPendingCountdown
    );
    return {
      resolvedUrl,
      resolvedFileName,
      requestHeaders: {
        Referer: selectedPageUrl,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
        "upgrade-insecure-requests": "1"
      }
    };
  }

  if (!isFuckingfastHost(url)) {
    logInfo("resolve bypass non-fuckingfast", { url });
    return { resolvedUrl: url };
  }

  const pageResponse = await axios.get<string>(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    timeout: 15000
  });

  const html = pageResponse.data;
  const match = html.match(/window\.open\("(https:\/\/fuckingfast\.co\/dl\/[^"]+)"/);
  if (!match?.[1]) {
    logWarn("resolve failed: link not found", { url });
    throw new Error("Link not found");
  }

  const resolvedUrl = match[1];
  let responseHeaders: Record<string, string> = {};
  try {
    const headResponse = await axios.head(resolvedUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      timeout: 10000
    });
    responseHeaders = Object.fromEntries(
      Object.entries(headResponse.headers).map(([key, value]) => [key.toLowerCase(), String(value ?? "")])
    );
  } catch {
    // If HEAD is blocked, fallback to HTML metadata only.
  }

  const resolvedFileName = resolveFilename(url, html, resolvedUrl, responseHeaders);
  logInfo("resolve success", { url, resolvedUrl, resolvedFileName });
  return { resolvedUrl, sourcePageUrl: url, resolvedFileName };
};

const maybeStartNext = async (): Promise<void> => {
  while (activeDownloads.size < concurrency) {
    const next = pickNextItem();
    if (!next) {
      return;
    }
    await startSingleDownload(next);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

const startSingleDownload = async (item: QueueItem): Promise<void> => {
  logInfo("download task start", { url: item.url });
  const controller = new AbortController();
  activeDownloads.set(item.url, { controller });
  currentSpeedMap.set(item.url, 0);

  try {
    item.status = "resolving";
    emitStatus(item.url, "resolving");
    const { resolvedUrl, sourcePageUrl, resolvedFileName, requestHeaders } = await resolveDownloadUrl(
      item.url,
      controller.signal,
      (secondsRemaining) => {
        item.status = "pending";
        emitStatus(item.url, "pending", undefined, item.resolvedFileName);
        emitCountdown(item.url, secondsRemaining);
      }
    );
    if (resolvedFileName) {
      item.resolvedFileName = resolvedFileName;
      logInfo("resolved filename", { url: item.url, fileName: resolvedFileName });
      emitStatus(item.url, item.status, undefined, resolvedFileName);
    }
    if (requestHeaders) {
      item.requestHeaders = requestHeaders;
    }
    if (sourcePageUrl) {
      await registerFuckingfastCount(sourcePageUrl);
    }

    item.status = "downloading";
    emitStatus(item.url, "downloading", undefined, item.resolvedFileName);
    const result = await downloadWithRetry(
      resolvedUrl,
      item.destinationFolder,
      {
        onProgress: (progress) => {
          currentSpeedMap.set(item.url, progress.speed);
          const payload: DownloadProgressPayload = {
            url: item.url,
            percent: progress.percent,
            speed: progress.speed,
            downloaded: progress.downloaded,
            total: progress.total,
            fileName: progress.fileName
          };
          emit("download-progress", payload);
          emitStats();
        }
      },
      controller.signal,
      { preferredFileName: item.resolvedFileName, requestHeaders: item.requestHeaders },
      3
    );

    item.status = "done";
    logInfo("download task done", {
      url: item.url,
      filePath: result.filePath,
      fileName: result.fileName
    });
    emitStatus(item.url, "done", undefined, result.fileName);
    completed += 1;
    currentSpeedMap.delete(item.url);
    const donePayload: DownloadDonePayload = {
      url: item.url,
      filePath: result.filePath,
      fileName: result.fileName
    };
    emit("download-done", donePayload);
  } catch (error) {
    if (item.status !== "paused") {
      item.status = "error";
      const err =
        error instanceof Error ? error.message : "Unknown error while downloading this file.";
      const normalizedErr = normalizeUrlForCompare(err).includes("link not found")
        ? "Link not found"
        : err;
      logError("download task failed", { url: item.url, error: normalizedErr });
      emitStatus(item.url, "error", normalizedErr);
      failed += 1;
      const errorPayload: DownloadErrorPayload = {
        url: item.url,
        error: normalizedErr,
        fileName: item.resolvedFileName ?? path.basename(item.url)
      };
      emit("download-error", errorPayload);
    }
    currentSpeedMap.delete(item.url);
  } finally {
    activeDownloads.delete(item.url);
    emitStats();
    void maybeStartNext();
  }
};

const resetQueue = (): void => {
  queue = [];
  activeDownloads.forEach((active) => active.controller.abort());
  activeDownloads.clear();
  currentSpeedMap.clear();
  completed = 0;
  failed = 0;
};

const normalizeUrls = (urls: string[]): string[] => {
  return urls
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry, index, arr) => arr.indexOf(entry) === index);
};

const isValidHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1150,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: "#09090b",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDevelopment) {
    void mainWindow.loadURL(process.env.ELECTRON_START_URL ?? "http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexPath = path.join(__dirname, "../dist/index.html");
    void mainWindow.loadURL(pathToFileURL(indexPath).toString());
  }
};

app.whenReady().then(() => {
  const logPath = initLogger(app.getPath("userData"));
  logInfo("logger initialized", { logPath });
  createWindow();

  ipcMain.handle("choose-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      logInfo("choose-folder canceled");
      return null;
    }
    logInfo("choose-folder selected", { folder: result.filePaths[0] });
    return result.filePaths[0];
  });

  ipcMain.handle("start-downloads", async (_, payload: StartDownloadsPayload) => {
    logInfo("start-downloads received", {
      totalUrls: payload.urls.length,
      destinationFolder: payload.destinationFolder,
      concurrency: payload.concurrency,
      delayMs: payload.delayMs
    });
    const urls = normalizeUrls(payload.urls);
    if (!payload.destinationFolder || !fs.existsSync(payload.destinationFolder)) {
      logError("start-downloads invalid destination folder", { destinationFolder: payload.destinationFolder });
      throw new Error("Destination folder does not exist.");
    }
    resetQueue();
    concurrency = Math.min(10, Math.max(1, payload.concurrency));
    delayMs = Math.max(0, payload.delayMs);

    queue = urls.map((url) => ({ url, destinationFolder: payload.destinationFolder, status: "waiting" }));
    for (const item of queue) {
      if (!isValidHttpUrl(item.url)) {
        item.status = "error";
        logWarn("invalid url rejected", { url: item.url });
        failed += 1;
        const errorPayload: DownloadErrorPayload = {
          url: item.url,
          error: "Invalid URL. Only HTTP/HTTPS URLs are supported.",
          fileName: path.basename(item.url) || "invalid-url"
        };
        emit("download-error", errorPayload);
      }
    }
    emitStats();
    void maybeStartNext();
    return { accepted: queue.length };
  });

  ipcMain.handle("cancel-download", async (_, url: string) => {
    logInfo("cancel-download requested", { url });
    const active = activeDownloads.get(url);
    if (!active) {
      const item = queue.find((entry) => entry.url === url);
      if (item && (item.status === "pending" || item.status === "resolving")) {
        item.status = "paused";
        emitStatus(item.url, "paused");
        return true;
      }
      return false;
    }
    const item = queue.find((entry) => entry.url === url);
    if (item) {
      item.status = "paused";
      logInfo("download paused", { url });
      emitStatus(item.url, "paused");
    }
    active.controller.abort();
    return true;
  });

  ipcMain.handle("retry-download", async (_, url: string) => {
    logInfo("retry-download requested", { url });
    const item = queue.find((entry) => entry.url === url);
    if (!item) {
      return false;
    }
    if (item.status === "error" || item.status === "paused") {
      if (item.status === "error") {
        failed = Math.max(0, failed - 1);
      }
      item.status = "waiting";
      logInfo("download re-queued", { url });
      emitStatus(item.url, "waiting");
      emitStats();
      void maybeStartNext();
      return true;
    }
    return false;
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  logInfo("window-all-closed");
  if (process.platform !== "darwin") {
    logInfo("app quit");
    app.quit();
  }
});

app.on("before-quit", () => {
  void closeSharedDatanodesBrowser();
});

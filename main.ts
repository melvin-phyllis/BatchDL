import { app, BrowserWindow, dialog, ipcMain, powerMonitor, powerSaveBlocker } from "electron";
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
  RestoreDownloadRow,
  StartDownloadsPayload
} from "./shared/types";
import { downloadWithRetry, safeFileName } from "./utils/downloader";
import { closeSharedDatanodesBrowser, resolveDatanodesDownload } from "./utils/datanodesPuppeteer";
import {
  getDownloadState,
  getIncompleteDownloads,
  loadState,
  removeDownload,
  upsertDownload
} from "./utils/downloadState";
import { initLogger, logError, logInfo, logWarn } from "./utils/logger";

type QueueStatus = "waiting" | "resolving" | "pending" | "downloading" | "paused" | "done" | "error";

interface QueueItem {
  url: string;
  destinationFolder: string;
  status: QueueStatus;
  resolvedFileName?: string;
  requestHeaders?: Record<string, string>;
  /** Reprise : chemin du fichier partiel existant. */
  resumeDestPath?: string;
}

interface ActiveDownload {
  controller: AbortController;
}

let mainWindow: BrowserWindow | null = null;
/** Mis à `true` après confirmation utilisateur pour autoriser la fermeture réelle. */
let allowQuit = false;
let queue: QueueItem[] = [];
let activeDownloads = new Map<string, ActiveDownload>();
let completed = 0;
let failed = 0;
let currentSpeedMap = new Map<string, number>();
let concurrency = 3;
let delayMs = 500;

/** Politique pour les fichiers cible déjà présents (réinitialisée à chaque nouveau lot). */
let duplicateFilePolicy: "ask" | "skip-all" | "overwrite-all" = "ask";

const resetDuplicateFilePolicy = (): void => {
  duplicateFilePolicy = "ask";
};

type DuplicateChoice = "skip" | "overwrite";

const askDuplicateFileAction = async (absolutePath: string, label: string): Promise<DuplicateChoice> => {
  if (duplicateFilePolicy === "skip-all") {
    return "skip";
  }
  if (duplicateFilePolicy === "overwrite-all") {
    return "overwrite";
  }
  const opts = {
    type: "question" as const,
    buttons: [
      "Passer (garder l'existant)",
      "Écraser",
      "Passer tous les doublons",
      "Écraser tous les doublons"
    ],
    defaultId: 0,
    cancelId: 0,
    title: "Fichier déjà présent",
    message: `Un fichier existe déjà sur le disque :\n\n${label}\n\nVoulez-vous le remplacer ou ignorer ce téléchargement ?`,
    detail: absolutePath
  };
  const parent = mainWindow ?? BrowserWindow.getFocusedWindow();
  const result = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  switch (result.response) {
    case 0:
      return "skip";
    case 1:
      return "overwrite";
    case 2:
      duplicateFilePolicy = "skip-all";
      return "skip";
    case 3:
      duplicateFilePolicy = "overwrite-all";
      return "overwrite";
    default:
      return "skip";
  }
};

/** Identifiant retourné par `powerSaveBlocker.start` — évite la mise en veille du PC pendant les téléchargements. */
let downloadPowerSaveBlockerId: number | null = null;

/** Téléchargements interrompus volontairement après reprise de veille système (à remettre en file). */
const urlsAbortedForSystemResume = new Set<string>();

const syncPowerSaveBlockerForDownloads = (): void => {
  const hasActiveWork = activeDownloads.size > 0;
  if (hasActiveWork && downloadPowerSaveBlockerId === null) {
    downloadPowerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    logInfo("power save: veille système bloquée pendant les téléchargements");
  } else if (!hasActiveWork && downloadPowerSaveBlockerId !== null) {
    powerSaveBlocker.stop(downloadPowerSaveBlockerId);
    downloadPowerSaveBlockerId = null;
    logInfo("power save: veille système autorisée à nouveau");
  }
};

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

/**
 * Après veille Windows, les flux HTTP/Chromium peuvent rester bloqués sans jamais se terminer.
 * On annule proprement les tâches actives et on les remet en `waiting` avec reprise sur fichier partiel.
 */
const handleSystemResume = (): void => {
  logInfo("powerMonitor: reprise système — réinitialisation des téléchargements actifs");
  if (activeDownloads.size === 0) {
    void maybeStartNext();
    return;
  }
  for (const url of [...activeDownloads.keys()]) {
    urlsAbortedForSystemResume.add(url);
    const item = queue.find((q) => q.url === url);
    if (item) {
      const st = getDownloadState(url);
      if (st?.destPath && fs.existsSync(st.destPath)) {
        item.resumeDestPath = st.destPath;
      }
    }
    activeDownloads.get(url)?.controller.abort();
  }
};

/**
 * Lance jusqu'à `concurrency` téléchargements en parallèle.
 * Important : ne pas `await startSingleDownload` — sinon un seul tour à la fois jusqu'à la fin du fichier.
 */
const maybeStartNext = async (): Promise<void> => {
  while (activeDownloads.size < concurrency) {
    const next = pickNextItem();
    if (!next) {
      return;
    }
    void startSingleDownload(next).catch((err) => {
      logError("download task unexpected failure", {
        error: err instanceof Error ? err.message : String(err)
      });
    });
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

const startSingleDownload = async (item: QueueItem): Promise<void> => {
  logInfo("download task start", { url: item.url });
  const controller = new AbortController();
  activeDownloads.set(item.url, { controller });
  syncPowerSaveBlockerForDownloads();
  currentSpeedMap.set(item.url, 0);

  const tentativeDestPath =
    item.resumeDestPath && fs.existsSync(item.resumeDestPath)
      ? item.resumeDestPath
      : path.join(
          item.destinationFolder,
          item.resolvedFileName ? safeFileName(item.resolvedFileName) : safeFileName(path.basename(item.url))
        );

  try {
    item.status = "resolving";
    emitStatus(item.url, "resolving");
    upsertDownload(item.url, {
      url: item.url,
      filename: item.resolvedFileName ?? path.basename(item.url),
      destFolder: item.destinationFolder,
      destPath: tentativeDestPath,
      bytesDownloaded:
        item.resumeDestPath && fs.existsSync(item.resumeDestPath)
          ? fs.statSync(item.resumeDestPath).size
          : 0,
      totalBytes: 0,
      percent: 0,
      status: "resolving",
      startedAt: getDownloadState(item.url)?.startedAt ?? new Date().toISOString()
    });

    const { resolvedUrl, sourcePageUrl, resolvedFileName, requestHeaders } = await resolveDownloadUrl(
      item.url,
      controller.signal,
      (secondsRemaining) => {
        item.status = "pending";
        upsertDownload(item.url, {
          url: item.url,
          filename: item.resolvedFileName ?? path.basename(item.url),
          destFolder: item.destinationFolder,
          destPath: tentativeDestPath,
          bytesDownloaded:
            item.resumeDestPath && fs.existsSync(item.resumeDestPath)
              ? fs.statSync(item.resumeDestPath).size
              : 0,
          totalBytes: 0,
          percent: 0,
          status: "pending"
        });
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

    const safeBaseName = safeFileName(item.resolvedFileName ?? path.basename(item.url));
    const candidatePath = path.join(item.destinationFolder, safeBaseName);

    if (fs.existsSync(candidatePath)) {
      try {
        if (fs.statSync(candidatePath).size === 0) {
          fs.unlinkSync(candidatePath);
        }
      } catch {
        // ignore
      }
    }

    const existingPath =
      item.resumeDestPath && fs.existsSync(item.resumeDestPath) ? item.resumeDestPath : undefined;

    const sameAsResume = Boolean(
      existingPath && path.normalize(existingPath) === path.normalize(candidatePath)
    );

    if (!sameAsResume && fs.existsSync(candidatePath) && fs.statSync(candidatePath).size > 0) {
      const choice = await askDuplicateFileAction(candidatePath, safeBaseName);
      if (choice === "skip") {
        removeDownload(item.url);
        item.status = "done";
        emitStatus(item.url, "done", undefined, safeBaseName);
        completed += 1;
        currentSpeedMap.delete(item.url);
        emit("download-done", {
          url: item.url,
          filePath: candidatePath,
          fileName: safeBaseName
        });
        return;
      }
      try {
        fs.unlinkSync(candidatePath);
      } catch (e) {
        logError("could not delete file for overwrite", { candidatePath });
        throw e;
      }
    }

    item.status = "downloading";
    emitStatus(item.url, "downloading", undefined, item.resolvedFileName);

    upsertDownload(item.url, {
      url: item.url,
      filename: item.resolvedFileName ?? path.basename(item.url),
      destFolder: item.destinationFolder,
      destPath: existingPath ?? candidatePath,
      bytesDownloaded: existingPath ? fs.statSync(existingPath).size : 0,
      totalBytes: 0,
      percent: 0,
      status: "downloading",
      dlUrl: resolvedUrl
    });

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
            fileName: progress.fileName,
            resumedFromPercent: progress.resumedFromPercent
          };
          emit("download-progress", payload);
          emitStats();
        }
      },
      controller.signal,
      {
        preferredFileName: item.resolvedFileName,
        requestHeaders: item.requestHeaders,
        originalUrl: item.url,
        existingFilePath: existingPath,
        ...(existingPath ? {} : { exactDestPath: candidatePath }),
        onCheckpoint: ({ downloaded, total, destPath: dest }) => {
          upsertDownload(item.url, {
            url: item.url,
            filename: path.basename(dest),
            destFolder: item.destinationFolder,
            destPath: dest,
            bytesDownloaded: downloaded,
            totalBytes: total,
            percent: total > 0 ? Math.round((downloaded / total) * 100) : 0,
            status: "downloading",
            dlUrl: resolvedUrl
          });
        }
      },
      3
    );

    removeDownload(item.url);
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
    if (urlsAbortedForSystemResume.has(item.url)) {
      urlsAbortedForSystemResume.delete(item.url);
      const st = getDownloadState(item.url);
      if (st?.destPath && fs.existsSync(st.destPath)) {
        const sz = fs.statSync(st.destPath).size;
        item.resumeDestPath = st.destPath;
        upsertDownload(item.url, {
          ...st,
          bytesDownloaded: sz,
          totalBytes: st.totalBytes,
          percent: st.totalBytes > 0 ? Math.round((sz / st.totalBytes) * 100) : st.percent,
          status: "pending"
        });
        emit("download-progress", {
          url: item.url,
          percent: st.totalBytes > 0 ? Math.round((sz / st.totalBytes) * 100) : st.percent,
          speed: 0,
          downloaded: sz,
          total: st.totalBytes,
          fileName: st.filename
        });
      }
      item.status = "waiting";
      emitStatus(item.url, "waiting", undefined, item.resolvedFileName ?? st?.filename);
      logInfo("reprise veille: fichier remis en file d'attente", { url: item.url });
      currentSpeedMap.delete(item.url);
    } else if (item.status !== "paused") {
      const st = getDownloadState(item.url);
      if (st?.destPath && fs.existsSync(st.destPath)) {
        const sz = fs.statSync(st.destPath).size;
        upsertDownload(item.url, {
          ...st,
          bytesDownloaded: sz,
          totalBytes: st.totalBytes,
          percent: st.totalBytes > 0 ? Math.round((sz / st.totalBytes) * 100) : 0,
          status: "pending"
        });
      }
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
      currentSpeedMap.delete(item.url);
    } else {
      currentSpeedMap.delete(item.url);
    }
  } finally {
    activeDownloads.delete(item.url);
    syncPowerSaveBlockerForDownloads();
    emitStats();
    void maybeStartNext();
  }
};

const resetQueue = (): void => {
  queue = [];
  activeDownloads.forEach((active) => active.controller.abort());
  activeDownloads.clear();
  syncPowerSaveBlockerForDownloads();
  currentSpeedMap.clear();
  completed = 0;
  failed = 0;
  resetDuplicateFilePolicy();
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

const showQuitConfirmDialog = (): Promise<boolean> => {
  const parent = mainWindow ?? BrowserWindow.getFocusedWindow();
  const opts = {
    type: "question" as const,
    buttons: ["Annuler", "Quitter"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "Quitter BatchDL ?",
    message: "Voulez-vous vraiment fermer l'application ?",
    detail:
      activeDownloads.size > 0
        ? "Des téléchargements sont en cours. Ils seront mis en pause et pourront être repris au prochain lancement."
        : undefined
  };
  const promise = parent
    ? dialog.showMessageBox(parent, opts)
    : dialog.showMessageBox(opts);
  return promise.then(({ response }) => response === 1);
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

  mainWindow.on("close", (e) => {
    if (allowQuit) {
      return;
    }
    e.preventDefault();
    void showQuitConfirmDialog().then((confirmed) => {
      if (confirmed) {
        allowQuit = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.close();
        }
      }
    });
  });
};

app.whenReady().then(() => {
  const logPath = initLogger(app.getPath("userData"));
  logInfo("logger initialized", { logPath });
  loadState();
  createWindow();

  powerMonitor.on("resume", handleSystemResume);

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
    const st = getDownloadState(url);
    if (st?.destPath && fs.existsSync(st.destPath)) {
      const sz = fs.statSync(st.destPath).size;
      upsertDownload(url, {
        ...st,
        bytesDownloaded: sz,
        percent: st.totalBytes > 0 ? Math.round((sz / st.totalBytes) * 100) : st.percent,
        status: "pending"
      });
    }
    active.controller.abort();
    return true;
  });

  ipcMain.handle("get-pending-restore", (): RestoreDownloadRow[] => {
    return getIncompleteDownloads().map((d) => ({
      url: d.url,
      filename: d.filename,
      percent: d.percent,
      bytesDownloaded: d.bytesDownloaded,
      totalBytes: d.totalBytes,
      destFolder: d.destFolder,
      destPath: d.destPath
    }));
  });

  ipcMain.handle("confirm-restore-downloads", async (_, urls: string[]) => {
    let n = 0;
    for (const url of urls) {
      const d = getDownloadState(url);
      if (!d) {
        continue;
      }
      if (queue.some((q) => q.url === url)) {
        continue;
      }
      queue.push({
        url: d.url,
        destinationFolder: d.destFolder,
        status: "waiting",
        resolvedFileName: d.filename,
        resumeDestPath: d.destPath && fs.existsSync(d.destPath) ? d.destPath : undefined
      });
      n += 1;
    }
    emitStats();
    void maybeStartNext();
    return { queued: n };
  });

  ipcMain.handle("discard-restore-downloads", async (_, urls: string[]) => {
    let n = 0;
    for (const url of urls) {
      const d = getDownloadState(url);
      if (d?.destPath && fs.existsSync(d.destPath)) {
        try {
          fs.unlinkSync(d.destPath);
        } catch {
          // ignore
        }
      }
      removeDownload(url);
      n += 1;
    }
    return { removed: n };
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
      const st = getDownloadState(url);
      if (st?.destPath && fs.existsSync(st.destPath)) {
        item.resumeDestPath = st.destPath;
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

app.on("before-quit", (e) => {
  if (!allowQuit) {
    e.preventDefault();
    void showQuitConfirmDialog().then((confirmed) => {
      if (confirmed) {
        allowQuit = true;
        app.quit();
      }
    });
    return;
  }
  if (downloadPowerSaveBlockerId !== null) {
    powerSaveBlocker.stop(downloadPowerSaveBlockerId);
    downloadPowerSaveBlockerId = null;
  }
  for (const [url] of activeDownloads) {
    const st = getDownloadState(url);
    if (st) {
      upsertDownload(url, { ...st, status: "pending" });
    }
  }
  void closeSharedDatanodesBrowser();
});

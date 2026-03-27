import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { URL } from "node:url";

export interface DownloadResult {
  filePath: string;
  fileName: string;
}

export interface DownloadCallbacks {
  onProgress: (progress: {
    percent: number;
    downloaded: number;
    total: number;
    speed: number;
    fileName: string;
    resumedFromPercent?: number;
  }) => void;
}

export interface DownloadOptions {
  preferredFileName?: string;
  requestHeaders?: Record<string, string>;
  /** Original queue URL (for checkpoint file). */
  originalUrl?: string;
  /** Resume writing to this path (partial file). */
  existingFilePath?: string;
  /** Optional explicit resume offset (defaults to file size). */
  resumeFromBytes?: number;
  /** Called every ~3s while downloading. */
  onCheckpoint?: (info: { downloaded: number; total: number; destPath: string }) => void;
  /**
   * Chemin de sortie exact (pas de suffixe « (1) »). Utilisé après accord utilisateur
   * ou lorsque le nom final est déjà connu côté main.
   */
  exactDestPath?: string;
}

export class NetworkTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkTimeoutError";
  }
}

export const safeFileName = (name: string): string => {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "download.bin";
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
    return safeFileName(decodeURIComponent(match[1].trim()));
  } catch {
    return safeFileName(match[1].trim());
  }
};

const fileNameFromUrl = (urlString: string): string => {
  try {
    const parsed = new URL(urlString);
    const base = path.basename(parsed.pathname) || "download.bin";
    return safeFileName(decodeURIComponent(base));
  } catch {
    return "download.bin";
  }
};

const ensureUniquePath = (filePath: string): string => {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  let index = 1;
  let next = `${base} (${index})${ext}`;
  while (fs.existsSync(next)) {
    index += 1;
    next = `${base} (${index})${ext}`;
  }
  return next;
};

const parseTotalFromContentRange = (contentRange?: string): number | null => {
  if (!contentRange) {
    return null;
  }
  const m = contentRange.match(/\/(\d+)\s*$/);
  if (!m?.[1]) {
    return null;
  }
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const downloadWithRetry = async (
  url: string,
  destinationFolder: string,
  callbacks: DownloadCallbacks,
  signal: AbortSignal,
  options: DownloadOptions = {},
  maxRetries = 3
): Promise<DownloadResult> => {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxRetries) {
    try {
      return await downloadSingle(url, destinationFolder, callbacks, signal, options);
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (signal.aborted) {
        throw new Error("Download canceled by user");
      }
      const isTimeout =
        axios.isAxiosError(error) &&
        (error.code === "ECONNABORTED" || (error.message?.toLowerCase().includes("timeout") ?? false));
      if (!isTimeout || attempt >= maxRetries) {
        throw error;
      }
      const backoff = 500 * 2 ** (attempt - 1);
      await sleep(backoff);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unknown download failure");
};

const downloadSingle = async (
  url: string,
  destinationFolder: string,
  callbacks: DownloadCallbacks,
  signal: AbortSignal,
  options: DownloadOptions
): Promise<DownloadResult> => {
  const preferredName = options.preferredFileName ? safeFileName(options.preferredFileName) : null;

  let filePath: string | undefined = options.existingFilePath;
  let startByte = 0;
  let emittedResumePercent: number | undefined;

  if (filePath && fs.existsSync(filePath)) {
    startByte =
      typeof options.resumeFromBytes === "number"
        ? Math.min(options.resumeFromBytes, fs.statSync(filePath).size)
        : fs.statSync(filePath).size;
  } else {
    filePath = undefined;
    startByte = 0;
  }

  const baseHeaders: Record<string, string> = { ...(options.requestHeaders ?? {}) };
  if (startByte > 0) {
    baseHeaders.Range = `bytes=${startByte}-`;
  }

  const response = await axios.get(url, {
    responseType: "stream",
    signal,
    timeout: 0,
    headers: baseHeaders,
    maxRedirects: 10,
    validateStatus: (status) => status === 200 || status === 206
  });

  if (startByte > 0 && response.status === 200) {
    if (options.existingFilePath && fs.existsSync(options.existingFilePath)) {
      try {
        fs.unlinkSync(options.existingFilePath);
      } catch {
        // ignore
      }
    }
    return downloadSingle(url, destinationFolder, callbacks, signal, {
      ...options,
      existingFilePath: undefined,
      resumeFromBytes: undefined
    });
  }

  const headerName = filenameFromContentDisposition(response.headers["content-disposition"]);
  const finalName = headerName ?? preferredName ?? fileNameFromUrl(url);

  if (!filePath) {
    if (options.exactDestPath) {
      filePath = options.exactDestPath;
    } else {
      filePath = ensureUniquePath(path.join(destinationFolder, finalName));
    }
  }

  const contentRange = response.headers["content-range"];
  const totalFromRange = parseTotalFromContentRange(
    typeof contentRange === "string" ? contentRange : undefined
  );
  const chunkLen = Number(response.headers["content-length"] ?? 0);
  let totalBytes =
    totalFromRange ??
    (response.status === 206 && startByte > 0 ? startByte + chunkLen : chunkLen) ??
    0;
  if (totalBytes === 0 && response.status === 200) {
    totalBytes = chunkLen;
  }

  let downloaded = startByte;
  const startedAt = Date.now();
  let firstChunk = true;

  let checkpointTimer: ReturnType<typeof setInterval> | undefined;
  if (options.originalUrl && options.onCheckpoint) {
    checkpointTimer = setInterval(() => {
      options.onCheckpoint?.({
        downloaded,
        total: totalBytes,
        destPath: filePath!
      });
    }, 3000);
  }

  const flags = startByte > 0 && response.status === 206 ? "a" : "w";
  const writer = fs.createWriteStream(filePath!, { flags });

  const tracker = new Transform({
    transform: (chunk: Buffer, _enc, cb) => {
      if (firstChunk && startByte > 0 && totalBytes > 0) {
        emittedResumePercent = Math.round((startByte / totalBytes) * 100);
        firstChunk = false;
      }
      downloaded += chunk.length;
      const elapsedSec = Math.max((Date.now() - startedAt) / 1000, 0.001);
      const speed = (downloaded - startByte) / elapsedSec;
      const percent = totalBytes > 0 ? (downloaded / totalBytes) * 100 : 0;
      callbacks.onProgress({
        percent: Math.min(100, Math.max(0, percent)),
        downloaded,
        total: totalBytes,
        speed,
        fileName: path.basename(filePath!),
        resumedFromPercent: emittedResumePercent
      });
      emittedResumePercent = undefined;
      cb(null, chunk);
    }
  });

  try {
    await pipeline(response.data, tracker, writer, { signal });
  } catch (error) {
    writer.destroy();
    if (fs.existsSync(filePath!) && downloaded === startByte && startByte === 0) {
      try {
        fs.unlinkSync(filePath!);
      } catch {
        // ignore
      }
    }
    if (signal.aborted) {
      throw new Error("Download canceled by user");
    }
    if (axios.isAxiosError(error) && (error.code === "ECONNABORTED" || error.message?.includes("timeout"))) {
      throw new NetworkTimeoutError(error.message);
    }
    throw error;
  } finally {
    if (checkpointTimer) {
      clearInterval(checkpointTimer);
    }
  }

  const fileName = path.basename(filePath!);
  callbacks.onProgress({
    percent: 100,
    downloaded: totalBytes > 0 ? totalBytes : downloaded,
    total: totalBytes,
    speed: 0,
    fileName
  });

  return { filePath: filePath!, fileName };
};

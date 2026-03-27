import axios from "axios";
import fs from "node:fs";
import path from "node:path";
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
  }) => void;
}

export interface DownloadOptions {
  preferredFileName?: string;
  requestHeaders?: Record<string, string>;
}

export class NetworkTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkTimeoutError";
  }
}

const safeFileName = (name: string): string => {
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
  const response = await axios.get(url, {
    responseType: "stream",
    signal,
    timeout: 20000,
    headers: options.requestHeaders,
    validateStatus: (status) => status >= 200 && status < 300
  });

  const headerName = filenameFromContentDisposition(response.headers["content-disposition"]);
  const preferredName = options.preferredFileName ? safeFileName(options.preferredFileName) : null;
  const finalName = headerName ?? preferredName ?? fileNameFromUrl(url);
  const filePath = ensureUniquePath(path.join(destinationFolder, finalName));

  const total = Number(response.headers["content-length"] ?? 0);
  const startedAt = Date.now();
  let downloaded = 0;
  const fileName = path.basename(filePath);

  response.data.on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    const elapsedSec = Math.max((Date.now() - startedAt) / 1000, 0.001);
    const speed = downloaded / elapsedSec;
    const percent = total > 0 ? (downloaded / total) * 100 : 0;
    callbacks.onProgress({
      percent: Math.min(100, Math.max(0, percent)),
      downloaded,
      total,
      speed,
      fileName
    });
  });

  const writer = fs.createWriteStream(filePath);
  try {
    await pipeline(response.data, writer, { signal });
  } catch (error) {
    writer.destroy();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    if (signal.aborted) {
      throw new Error("Download canceled by user");
    }
    if (axios.isAxiosError(error) && (error.code === "ECONNABORTED" || error.message?.includes("timeout"))) {
      throw new NetworkTimeoutError(error.message);
    }
    throw error;
  }

  callbacks.onProgress({
    percent: 100,
    downloaded,
    total,
    speed: 0,
    fileName
  });

  return { filePath, fileName };
};

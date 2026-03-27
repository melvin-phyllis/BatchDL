import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export type PersistedDownloadStatus = "resolving" | "pending" | "downloading";

export interface DownloadState {
  url: string;
  filename: string;
  destFolder: string;
  destPath: string;
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
  status: PersistedDownloadStatus;
  dlUrl?: string;
  startedAt: string;
  updatedAt: string;
}

export interface StateFile {
  version: 1;
  downloads: Record<string, DownloadState>;
}

const STATE_FILE = (): string => path.join(app.getPath("userData"), "downloads-state.json");

let appState: StateFile = { version: 1, downloads: {} };
let stateLoaded = false;

export function loadState(): StateFile {
  if (stateLoaded) {
    return appState;
  }
  try {
    const p = STATE_FILE();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as StateFile;
      if (parsed?.version === 1 && parsed.downloads && typeof parsed.downloads === "object") {
        appState = parsed;
      }
    }
  } catch {
    appState = { version: 1, downloads: {} };
  }
  stateLoaded = true;
  return appState;
}

export function saveState(state: StateFile = appState): void {
  try {
    appState = state;
    fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // ignore disk errors
  }
}

export function upsertDownload(url: string, update: Partial<DownloadState> & { url: string }): void {
  loadState();
  const prev = appState.downloads[url];
  const startedAt = prev?.startedAt ?? update.startedAt ?? new Date().toISOString();
  appState.downloads[url] = {
    ...prev,
    ...update,
    url,
    startedAt,
    updatedAt: new Date().toISOString()
  } as DownloadState;
  saveState();
}

export function removeDownload(url: string): void {
  loadState();
  delete appState.downloads[url];
  saveState();
}

export function clearAllDownloadState(): void {
  appState = { version: 1, downloads: {} };
  saveState();
}

export function getIncompleteDownloads(): DownloadState[] {
  loadState();
  return Object.values(appState.downloads).filter(
    (d) => d.status === "downloading" || d.status === "pending" || d.status === "resolving"
  );
}

export function getDownloadState(url: string): DownloadState | undefined {
  loadState();
  return appState.downloads[url];
}

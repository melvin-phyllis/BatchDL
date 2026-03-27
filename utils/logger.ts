import fs from "node:fs";
import path from "node:path";

type LogLevel = "INFO" | "WARN" | "ERROR";

let logFilePath = "";

const formatMessage = (level: LogLevel, message: string, meta?: Record<string, unknown>): string => {
  const ts = new Date().toISOString();
  const serializedMeta = meta ? ` ${JSON.stringify(meta)}` : "";
  return `[${ts}] [${level}] ${message}${serializedMeta}\n`;
};

export const initLogger = (baseDir: string): string => {
  const logsDir = path.join(baseDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  logFilePath = path.join(logsDir, "batchdl.log");
  fs.appendFileSync(logFilePath, `\n=== Session start ${new Date().toISOString()} ===\n`);
  return logFilePath;
};

const writeLog = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
  const line = formatMessage(level, message, meta);
  if (!logFilePath) {
    return;
  }
  try {
    fs.appendFileSync(logFilePath, line);
  } catch {
    // Avoid crashing app if logging fails.
  }
};

export const logInfo = (message: string, meta?: Record<string, unknown>): void => {
  writeLog("INFO", message, meta);
};

export const logWarn = (message: string, meta?: Record<string, unknown>): void => {
  writeLog("WARN", message, meta);
};

export const logError = (message: string, meta?: Record<string, unknown>): void => {
  writeLog("ERROR", message, meta);
};

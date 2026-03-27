import { app } from "electron";
import path from "node:path";
import type { Browser, HTTPRequest, HTTPResponse, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { logInfo, logWarn } from "./logger";

puppeteer.use(StealthPlugin());

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
  "--window-size=1280,800"
];

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

/** DevTools XPath for the download-countdown primary button (same node for 1st + 2nd click). */
const DOWNLOAD_BUTTON_XPATH =
  "/html/body/div[1]/div[3]/div[2]/div[1]/div[2]/div/div[3]/button[1]";

const DATANODES_ORIGIN = "https://datanodes.to";

let sharedBrowser: Browser | null = null;

export async function closeSharedDatanodesBrowser(): Promise<void> {
  if (sharedBrowser) {
    try {
      await sharedBrowser.close();
    } catch {
      // ignore
    }
    sharedBrowser = null;
  }
}

async function getSharedBrowser(): Promise<Browser> {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await puppeteer.launch({
      headless: true,
      args: LAUNCH_ARGS
    });
    logInfo("[datanodes puppeteer] shared browser launched");
  }
  return sharedBrowser;
}

export interface DatanodesResolveResult {
  resolvedUrl: string;
  resolvedFileName: string;
  /** Use as Referer for GET on tunnel (dlproxy). */
  selectedPageUrl: string;
}

function parseDatanodesPageUrl(pageUrl: string): {
  code: string;
  filename: string;
  navigateUrl: string;
  selectedPageUrl: string;
} {
  const parsed = new URL(pageUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  let code = "";
  let rest: string[] = [];
  if (segments[0] === "f" && segments[1]) {
    code = segments[1];
    rest = segments.slice(2);
  } else if (segments[0]) {
    code = segments[0];
    rest = segments.slice(1);
  }
  if (!code) {
    throw new Error("datanodes: could not parse file code from URL");
  }
  const pathPart = rest.join("/");
  let filename: string;
  if (pathPart) {
    try {
      filename = decodeURIComponent(pathPart);
    } catch {
      filename = pathPart;
    }
  } else {
    filename = code;
  }
  const navigateUrl = parsed.href;
  const selectedPageUrl = `${DATANODES_ORIGIN}/`;
  return { code, filename, navigateUrl, selectedPageUrl };
}

function extractTunnelUrlFromText(text: string): string | null {
  const m =
    text.match(/https?:\/\/[^\s"'\\<>]*(tunnel|dlproxy)[^\s"'\\<>]*/i) ??
    text.match(/https?:\/\/tunnel[^\s"'\\<>]+/i);
  if (!m?.[0]) {
    return null;
  }
  return m[0].replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
}

function looksLikeTunnelUrl(url: string): boolean {
  return url.includes("dlproxy") || /tunnel\d*\./i.test(url);
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
}

function getDatanodesDebugScreenshotPath(): string {
  try {
    return path.join(app.getPath("userData"), "datanodes-debug.png");
  } catch {
    return path.join(process.cwd(), "datanodes-debug.png");
  }
}

async function clickXPathOrContentWrapFallback(
  page: Page,
  which: "first" | "second"
): Promise<void> {
  const clicked = await page.evaluate((xp) => {
    const result = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const node = result.singleNodeValue;
    if (node instanceof HTMLElement) {
      node.scrollIntoView({ block: "center", inline: "center" });
      node.click();
      return true;
    }
    return false;
  }, DOWNLOAD_BUTTON_XPATH);

  if (clicked) {
    logInfo(`[datanodes puppeteer] ${which} click via XPath`);
    return;
  }

  await page.evaluate(() => {
    const area = document.querySelector(".contentWrap, [class*=\"contentWrap\"]");
    const btn = area?.querySelector("button");
    (btn as HTMLElement | undefined)?.click();
  });
  logInfo(`[datanodes puppeteer] ${which} click via .contentWrap fallback`);
}

/**
 * Vue flow: GET page (cookies) → 1st click → countdown → 2nd click → POST https://datanodes.to/download
 * (multipart op=download2, …) → response contains tunnel1.dlproxy.uk URL.
 */
export async function resolveDatanodesDownload(
  pageUrl: string,
  signal: AbortSignal,
  onCountdown: (secondsRemaining: number) => void
): Promise<DatanodesResolveResult> {
  if (signal.aborted) {
    throw new Error("Download canceled by user");
  }

  const { filename: filenameFromUrl, navigateUrl, selectedPageUrl } = parseDatanodesPageUrl(pageUrl);
  let resolvedFileName = filenameFromUrl;

  const browser = await getSharedBrowser();
  const page = await browser.newPage();

  const abortErr = new Error("Download canceled by user");
  const onAbort = (): void => {
    void page.close().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });

  let capturedDlUrl: string | null = null;

  const onRequest = (req: HTTPRequest): void => {
    const url = req.url();
    if (looksLikeTunnelUrl(url)) {
      capturedDlUrl = url;
      logInfo("[datanodes puppeteer] captured tunnel (request URL)", { preview: url.slice(0, 200) });
    }
    void req.continue();
  };

  const onResponse = async (res: HTTPResponse): Promise<void> => {
    if (capturedDlUrl) {
      return;
    }
    const url = res.url();

    let loc: string | undefined;
    try {
      const h = res.headers();
      loc = h["location"] ?? h["Location"];
    } catch {
      loc = undefined;
    }
    if (loc && looksLikeTunnelUrl(loc)) {
      try {
        capturedDlUrl = new URL(loc, DATANODES_ORIGIN).href;
      } catch {
        capturedDlUrl = loc.startsWith("http") ? loc : `https:${loc}`;
      }
      logInfo("[datanodes puppeteer] captured tunnel (Location)", { preview: capturedDlUrl.slice(0, 200) });
      return;
    }

    if (looksLikeTunnelUrl(url)) {
      capturedDlUrl = url;
      logInfo("[datanodes puppeteer] captured tunnel (response URL)", { preview: url.slice(0, 200) });
      return;
    }

    try {
      const u = new URL(url);
      const pathNorm = u.pathname.replace(/\/$/, "") || "/";
      const isDownloadResponse =
        u.hostname.endsWith("datanodes.to") &&
        (pathNorm === "/download" || u.pathname.startsWith("/download?"));
      if (!isDownloadResponse) {
        return;
      }

      const text = await res.text();
      const extracted = extractTunnelUrlFromText(text);
      if (extracted) {
        capturedDlUrl = extracted;
        logInfo("[datanodes puppeteer] captured tunnel (POST /download body)", {
          preview: extracted.slice(0, 200)
        });
      }
    } catch {
      // body not readable
    }
  };

  try {
    await page.setUserAgent(BROWSER_UA);
    await page.setViewport({ width: 1280, height: 800 });

    await page.setRequestInterception(true);
    page.on("request", onRequest);
    page.on("response", onResponse);

    logInfo("[datanodes puppeteer] navigating (full URL)", { navigateUrl });
    await page.goto(navigateUrl, { waitUntil: "networkidle2", timeout: 45000 });
    logInfo("[datanodes puppeteer] page loaded", { currentUrl: page.url() });

    if (signal.aborted) {
      throw abortErr;
    }

    await sleep(2000, signal);

    await page.waitForSelector("button", { timeout: 15000 });

    await clickXPathOrContentWrapFallback(page, "first");

    const countdownSec = await page.evaluate(() => {
      const html = document.body?.innerHTML ?? "";
      const m =
        html.match(/:countdown="(\d+)"/) ??
        html.match(/countdown["\s:=]+(\d+)/) ??
        html.match(/"countdown":\s*(\d+)/);
      const n = m ? Number.parseInt(m[1], 10) : 5;
      return Math.max(1, Math.min(120, Number.isFinite(n) ? n : 5));
    });

    for (let i = countdownSec; i > 0; i -= 1) {
      if (signal.aborted) {
        throw abortErr;
      }
      onCountdown(i);
      await sleep(1000, signal);
    }
    onCountdown(0);

    await clickXPathOrContentWrapFallback(page, "second");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (signal.aborted) {
        throw abortErr;
      }
      if (capturedDlUrl) {
        break;
      }
      logInfo("[datanodes puppeteer] waiting for tunnel URL", { attempt: attempt + 1 });
      await sleep(1000, signal);
    }

    if (!capturedDlUrl) {
      const debugPath = getDatanodesDebugScreenshotPath();
      try {
        await page.screenshot({ path: debugPath, fullPage: true });
        logWarn("[datanodes puppeteer] debug screenshot saved", { debugPath });
      } catch (e) {
        logWarn("[datanodes puppeteer] screenshot failed", {
          message: e instanceof Error ? e.message : String(e)
        });
      }
      const pageContent = await page.content();
      const fromHtml = extractTunnelUrlFromText(pageContent);
      if (fromHtml) {
        capturedDlUrl = fromHtml;
      }
    }

    if (!capturedDlUrl) {
      const debugPath = getDatanodesDebugScreenshotPath();
      throw new Error(
        `datanodes puppeteer: tunnel URL not captured after 2nd click — see ${debugPath}`
      );
    }

    const metaName = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      const title = document.querySelector("title");
      return (h1?.textContent ?? title?.textContent ?? "").trim();
    });
    if (metaName && metaName.includes(".")) {
      resolvedFileName = metaName;
    }

    logInfo("[datanodes puppeteer] resolved", { selectedPageUrl, fileName: resolvedFileName });

    return {
      resolvedUrl: capturedDlUrl,
      resolvedFileName,
      selectedPageUrl
    };
  } catch (err) {
    if (signal.aborted) {
      throw abortErr;
    }
    logWarn("[datanodes puppeteer] failure", {
      message: err instanceof Error ? err.message : String(err)
    });
    throw err;
  } finally {
    signal.removeEventListener("abort", onAbort);
    page.removeAllListeners("request");
    page.removeAllListeners("response");
    await page.close().catch(() => {});
  }
}

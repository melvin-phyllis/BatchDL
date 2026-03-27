import { ReactNode, useMemo, useState } from "react";
import { CheckCircle2, FolderOpen, Home, ListChecks } from "lucide-react";
import { DownloadItem } from "@/components/DownloadItem";
import { UrlInput } from "@/components/UrlInput";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { useDownloads } from "@/hooks/useDownloads";
import { formatSpeed } from "@/lib/utils";

type ViewMode = "home" | "active" | "completed";

const App = () => {
  const [view, setView] = useState<ViewMode>("home");
  const [urlText, setUrlText] = useState("");
  const [folder, setFolder] = useState("");
  const [concurrency, setConcurrency] = useState(3);
  const [delayMs, setDelayMs] = useState(500);
  const [errorMessage, setErrorMessage] = useState("");
  const {
    items,
    stats,
    hasElectronApi,
    startDownloads,
    cancelDownload,
    retryDownload,
    restorePrompt,
    confirmRestoreDownloads,
    discardRestoreDownloads
  } = useDownloads();

  const urls = useMemo(
    () =>
      urlText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    [urlText]
  );
  const activeItems = useMemo(
    () => items.filter((item) => item.status !== "done"),
    [items]
  );
  const completedItems = useMemo(
    () => items.filter((item) => item.status === "done"),
    [items]
  );

  const chooseFolder = async () => {
    if (!hasElectronApi) {
      setErrorMessage("Electron bridge unavailable. Start the app with `npm run dev`.");
      return;
    }
    const selected = await window.electronApi.chooseFolder();
    if (selected) {
      setFolder(selected);
      setErrorMessage("");
    }
  };

  const onStart = async () => {
    if (!folder) {
      setErrorMessage("Please choose a destination folder.");
      return;
    }
    if (urls.length === 0) {
      setErrorMessage("Please input at least one valid URL.");
      return;
    }

    try {
      setErrorMessage("");
      await startDownloads({
        urls,
        destinationFolder: folder,
        concurrency,
        delayMs
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to start downloads.");
    }
  };

  const navButton = (mode: ViewMode, label: string, icon: ReactNode) => (
    <button
      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
        view === mode
          ? "bg-zinc-800 text-indigo-300"
          : "text-zinc-300 hover:bg-zinc-800/70 hover:text-zinc-100"
      }`}
      onClick={() => setView(mode)}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="h-screen overflow-hidden bg-[#131313] text-foreground">
      {restorePrompt && restorePrompt.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-950 p-6 shadow-2xl">
            <h3 className="mb-2 text-lg font-bold text-zinc-100">Téléchargements interrompus</h3>
            <p className="mb-4 text-sm text-zinc-400">
              {restorePrompt.length} fichier(s) partiel(s) détecté(s). Reprendre là où vous vous êtes arrêté
              (HTTP Range), ou supprimer les fichiers partiels.
            </p>
            <ul className="mb-6 max-h-48 space-y-2 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-900/80 p-3 text-sm">
              {restorePrompt.map((row) => (
                <li key={row.url} className="truncate text-zinc-300">
                  <span className="font-medium text-zinc-100">{row.filename}</span>{" "}
                  <span className="text-zinc-500">— ~{row.percent}%</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button
                className="flex-1"
                onClick={() => {
                  const f = restorePrompt[0]?.destFolder;
                  if (f) {
                    setFolder(f);
                  }
                  void confirmRestoreDownloads(restorePrompt.map((r) => r.url));
                }}
              >
                Reprendre tout
              </Button>
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => void discardRestoreDownloads(restorePrompt.map((r) => r.url))}
              >
                Tout supprimer
              </Button>
            </div>
          </div>
        </div>
      )}
      <header className="fixed left-0 right-0 top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-black tracking-tight">BatchDL</h1>
            <span className="rounded bg-zinc-800 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-300">
              V2.0 Kinetic
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={chooseFolder} className="gap-2">
              <FolderOpen size={16} />
              Open folder
            </Button>
            <code className="max-w-[420px] truncate rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
              {folder || "C:/Downloads/BatchDL"}
            </code>
          </div>
        </div>
      </header>

      <aside className="fixed bottom-0 left-0 top-14 z-20 hidden w-64 border-r border-zinc-800 bg-[#1c1b1b] p-4 lg:flex lg:flex-col">
        <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
          <p className="text-sm font-bold">BatchDL</p>
          <p className="text-[10px] uppercase tracking-wider text-zinc-400">Control Center</p>
        </div>
        <nav className="space-y-1">
          {navButton("home", "Home", <Home size={16} />)}
          {navButton("active", "Active", <ListChecks size={16} />)}
          {navButton("completed", "Completed", <CheckCircle2 size={16} />)}
        </nav>
        <div className="mt-auto">
          <Button className="w-full">New Batch</Button>
        </div>
      </aside>

      <main className="h-full overflow-y-auto px-6 pb-6 pt-20 lg:ml-64">
        <div className="mx-auto flex max-w-7xl flex-col gap-4">
          <div className="flex items-end justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
            <div>
              <h2 className="text-xl font-bold">
                {view === "home" ? "Main Window" : view === "active" ? "Active Downloads" : "Completed Batch"}
              </h2>
              <p className="text-sm text-zinc-400">
                {view === "home" && "Pilotage de la queue et des paramètres de lot."}
                {view === "active" && "Suivi en temps réel des téléchargements en cours."}
                {view === "completed" && "Historique des fichiers terminés."}
              </p>
            </div>
            <div className="hidden items-center gap-3 md:flex">
              <Stat label="Total" value={String(stats.total)} />
              <Stat label="Done" value={String(stats.done)} />
              <Stat label="Failed" value={String(stats.failed)} />
              <Stat label="Speed" value={formatSpeed(stats.speed)} />
            </div>
          </div>

        {!hasElectronApi && (
          <p className="rounded-md border border-amber-700 bg-amber-950/50 p-3 text-sm text-amber-300">
            Bridge Electron indisponible. Lance l&apos;application via `npm run dev`.
          </p>
        )}

        {view === "home" && (
          <>
            <UrlInput value={urlText} onChange={setUrlText} />

            <section className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-card p-4 md:grid-cols-3">
              <div className="space-y-2">
                <p className="text-sm font-semibold text-zinc-200">Concurrence: {concurrency}</p>
                <Slider value={concurrency} min={1} max={10} step={1} onChange={setConcurrency} />
              </div>

              <div className="space-y-2">
                <label htmlFor="delay" className="text-sm font-semibold text-zinc-200">
                  Délai entre démarrages (ms)
                </label>
                <input
                  id="delay"
                  type="number"
                  min={0}
                  value={delayMs}
                  onChange={(event) => setDelayMs(Number(event.target.value) || 0)}
                  className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-end">
                <Button className="w-full" onClick={onStart}>
                  Start all downloads
                </Button>
              </div>
            </section>
          </>
        )}

        <section className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-4 md:hidden md:grid-cols-4">
          <Stat label="Total" value={String(stats.total)} />
          <Stat label="Done" value={String(stats.done)} />
          <Stat label="Failed" value={String(stats.failed)} />
          <Stat label="Speed" value={formatSpeed(stats.speed)} />
        </section>

        {errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}

        {view === "home" && (
          <ListSection
            title="Download Queue"
            items={items}
            emptyText="Aucun téléchargement. Colle des URLs puis lance la batch."
            cancelDownload={cancelDownload}
            retryDownload={retryDownload}
          />
        )}

        {view === "active" && (
          <ListSection
            title="Active Downloads"
            items={activeItems}
            emptyText="Aucun téléchargement actif."
            cancelDownload={cancelDownload}
            retryDownload={retryDownload}
          />
        )}

        {view === "completed" && (
          <section className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-200">Completed Batch</h2>
              <span className="text-xs text-zinc-400">{completedItems.length} fichier(s)</span>
            </div>
            <ScrollArea className="h-[420px] rounded-md border border-zinc-800 bg-zinc-900 p-3">
              <div className="space-y-2">
                {completedItems.length === 0 && (
                  <p className="text-sm text-zinc-500">Aucun fichier terminé pour le moment.</p>
                )}
                {completedItems.map((item) => (
                  <div
                    key={item.url}
                    className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950 p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-zinc-100">{item.fileName}</p>
                      <p className="truncate text-xs text-zinc-500">{item.filePath ?? item.url}</p>
                    </div>
                    <span className="rounded-full bg-green-600 px-2 py-1 text-xs font-bold text-white">
                      Done
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </section>
        )}
        </div>
      </main>
    </div>
  );
};

const ListSection = ({
  title,
  items,
  emptyText,
  cancelDownload,
  retryDownload
}: {
  title: string;
  items: ReturnType<typeof useDownloads>["items"];
  emptyText: string;
  cancelDownload: (url: string) => Promise<void>;
  retryDownload: (url: string) => Promise<void>;
}) => (
  <section className="rounded-lg border border-border bg-card p-4">
    <h2 className="mb-3 text-sm font-semibold text-zinc-200">{title}</h2>
    <ScrollArea className="h-[420px] rounded-md border border-zinc-800 bg-zinc-900 p-3">
      <div className="space-y-3">
        {items.length === 0 && <p className="text-sm text-zinc-500">{emptyText}</p>}
        {items.map((item) => (
          <DownloadItem
            key={item.url}
            item={item}
            onCancel={(url) => void cancelDownload(url)}
            onRetry={(url) => void retryDownload(url)}
          />
        ))}
      </div>
    </ScrollArea>
  </section>
);

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-md border border-zinc-800 bg-zinc-900 p-3">
    <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
    <p className="mt-1 text-lg font-semibold text-zinc-100">{value}</p>
  </div>
);

export default App;

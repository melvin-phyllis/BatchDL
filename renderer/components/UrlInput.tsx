import { useMemo } from "react";

interface UrlInputProps {
  value: string;
  onChange: (value: string) => void;
}

export const UrlInput = ({ value, onChange }: UrlInputProps) => {
  const lines = useMemo(
    () =>
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    [value]
  );

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-200">Download URLs</h2>
        <span className="text-xs text-zinc-400">{lines.length} line(s)</span>
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-52 w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-3 text-sm text-zinc-100 outline-none focus:border-indigo-500"
        placeholder="https://example.com/file1.zip&#10;https://example.com/file2.mp4"
      />
    </section>
  );
};

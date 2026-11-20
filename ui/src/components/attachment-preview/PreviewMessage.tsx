import { Download, LoaderCircle } from "lucide-react";
import type { EmbeddableFile } from "./types";

/** Centered status or error text inside a preview body, with a download fallback. */
export function PreviewMessage({ file, message, loading = false }: { file: EmbeddableFile; message: string; loading?: boolean }) {
  return (
    <div className="flex h-full min-h-24 flex-col items-center justify-center gap-2 px-4 py-6 text-center text-(length:--t-13) text-ink-3" role={loading ? "status" : "alert"}>
      {loading ? <LoaderCircle className="size-5 motion-safe:animate-spin" aria-hidden /> : null}
      <p className="max-w-prose text-pretty">{message}</p>
      {loading ? null : (
        <a
          href={file.downloadUrl}
          download={file.filename}
          rel="noreferrer"
          className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 font-medium text-ink-2 underline-offset-4 outline-hidden hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11"
        >
          <Download className="size-4" aria-hidden />
          Download {file.filename}
        </a>
      )}
    </div>
  );
}

import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Maximize2, Minimize2, ZoomIn, ZoomOut } from "lucide-react";
import { isMarkdownAttachmentContent } from "@tickernelz/wardmote-shared";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "@/components/MarkdownBody";
import { HtmlArtifactPreview } from "@/components/HtmlArtifactPreview";
import { fileKindForAttachment, formatFileSize } from "@/components/task-chat/task-chat-attachments";
import { attachmentPreview, PREVIEW_LIMITS, type AttachmentPreview } from "@/lib/attachment-preview";
import { readTextHead } from "@/lib/attachment-preview-readers";
import { cn } from "@/lib/utils";
import { useFullscreen, useNearViewport } from "./hooks";
import { PreviewMessage } from "./PreviewMessage";
import type { EmbeddableFile, ViewerProps } from "./types";

const PdfViewer = lazy(() => import("./PdfViewer"));
const TableViewer = lazy(() => import("./TableViewer"));
const DocxViewer = lazy(() => import("./DocxViewer"));
const PptxViewer = lazy(() => import("./PptxViewer"));

type Kind = AttachmentPreview["kind"];

const BODY_HEIGHT: Record<Kind, string> = {
  pdf: "h-120 sm:h-160",
  docx: "h-120 sm:h-160",
  pptx: "h-120 sm:h-160",
  html: "h-120 sm:h-160",
  csv: "h-104",
  spreadsheet: "h-112",
  image: "h-72 sm:h-96",
  svg: "h-72 sm:h-96",
  video: "aspect-video",
  audio: "min-h-16",
  text: "min-h-16 max-h-80",
  markdown: "min-h-16 max-h-96",
  none: "",
};

const FULLSCREEN_KINDS = new Set<Kind>(["pdf", "docx", "pptx", "html", "csv", "spreadsheet", "image", "svg", "video"]);

class ViewerBoundary extends Component<{ file: EmbeddableFile; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed
      ? <PreviewMessage file={this.props.file} message="The viewer for this file failed to load." />
      : this.props.children;
  }
}

function ImageView({ src, alt, zoomed, onToggleZoom }: { src: string; alt: string; zoomed: boolean; onToggleZoom: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <p role="alert" className="flex h-full items-center justify-center p-4 text-(length:--t-13) text-ink-3">This image could not be displayed. Download it to open.</p>;
  return (
    <div className={cn("h-full overflow-auto overscroll-contain bg-bg-3/40", zoomed ? "cursor-zoom-out" : "flex cursor-zoom-in items-center justify-center")} onClick={onToggleZoom}>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={zoomed ? "max-w-none" : "h-full w-full object-contain"}
      />
    </div>
  );
}

function SvgView({ file, zoomed, onToggleZoom }: ViewerProps & { zoomed: boolean; onToggleZoom: () => void }) {
  const query = useQuery({
    queryKey: ["public-share-preview", "svg", file.url],
    queryFn: ({ signal }) => readTextHead(file.url, PREVIEW_LIMITS.svgBytes, signal),
    staleTime: Infinity,
    retry: 1,
  });
  if (query.isError) return <PreviewMessage file={file} message={(query.error as Error).message} />;
  if (!query.data) return <PreviewMessage file={file} loading message="Loading image…" />;
  if (query.data.truncated) return <PreviewMessage file={file} message="This SVG is too large to preview. Download it to open." />;
  return <ImageView src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(query.data.text)}`} alt={file.filename} zoomed={zoomed} onToggleZoom={onToggleZoom} />;
}

function prettyJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function TextView({ file, kind }: ViewerProps & { kind: "text" | "markdown" | "html" }) {
  const query = useQuery({
    queryKey: ["public-share-preview", "text", file.url],
    queryFn: ({ signal }) => readTextHead(file.url, PREVIEW_LIMITS.textBytes, signal),
    staleTime: Infinity,
    retry: 1,
  });
  if (query.isError) return <PreviewMessage file={file} message={(query.error as Error).message} />;
  if (!query.data) return <PreviewMessage file={file} loading message="Loading text…" />;
  const { text, truncated } = query.data;
  if (kind === "html") {
    return truncated
      ? <PreviewMessage file={file} message="This HTML file is too large to preview. Download it to open." />
      : <HtmlArtifactPreview html={text} title={file.filename} />;
  }
  const json = !truncated && (/\.json$/i.test(file.filename) || /json/i.test(file.contentType));
  return (
    <div className="flex h-full max-h-[inherit] min-h-0 flex-col">
      {truncated ? (
        <p role="status" className="border-b border-line-soft px-3 py-1.5 text-(length:--t-12) text-ink-3">
          Showing the first {Math.round(PREVIEW_LIMITS.textBytes / 1024)} KB. Download the file to see everything.
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain" tabIndex={0} role="region" aria-label={`${file.filename} contents`}>
        {text.length === 0 ? (
          <p className="p-3 text-(length:--t-13) text-ink-3">This file is empty.</p>
        ) : kind === "markdown" ? (
          <div className="px-4 py-3"><MarkdownBody className="text-(length:--t-14)" mediaMode="reference" linkIssueReferences={false}>{text}</MarkdownBody></div>
        ) : (
          <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-(length:--t-12) leading-relaxed text-ink-2">{json ? prettyJson(text) : text}</pre>
        )}
      </div>
    </div>
  );
}

function PreviewBody({ file, preview, zoomed, onToggleZoom }: {
  file: EmbeddableFile;
  preview: AttachmentPreview;
  zoomed: boolean;
  onToggleZoom: () => void;
}) {
  switch (preview.kind) {
    case "image":
      return <ImageView src={file.url} alt={file.filename} zoomed={zoomed} onToggleZoom={onToggleZoom} />;
    case "svg":
      return <SvgView file={file} zoomed={zoomed} onToggleZoom={onToggleZoom} />;
    case "video":
      return (
        <video controls preload="metadata" playsInline width={1280} height={720} src={file.url} className="h-full w-full bg-black object-contain" aria-label={file.filename}>
          <a href={file.downloadUrl} download={file.filename}>Download {file.filename}</a>
        </video>
      );
    case "audio":
      return (
        <div className="flex h-full items-center px-3 py-2">
          <audio controls preload="metadata" src={file.url} className="w-full" aria-label={file.filename} />
        </div>
      );
    case "text":
    case "markdown":
    case "html":
      return <TextView file={file} kind={preview.kind} />;
    case "pdf":
      return <PdfViewer file={file} />;
    case "csv":
    case "spreadsheet":
      return <TableViewer file={file} kind={preview.kind} />;
    case "docx":
      return <DocxViewer file={file} />;
    case "pptx":
      return <PptxViewer file={file} />;
    case "none":
      return null;
  }
}

/** Download URL for a public content route: the server switches to `attachment` disposition on `?download=1`. */
export function contentDownloadUrl(url: string) {
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

/** A shared file shown inline, loaded only when it nears the viewport, with download as the fallback. */
export function AttachmentEmbed({ file }: { file: EmbeddableFile }) {
  const preview = useMemo(
    () => attachmentPreview({
      filename: file.filename,
      contentType: isMarkdownAttachmentContent({ contentType: file.contentType, originalFilename: file.filename }) ? "text/markdown" : file.contentType,
      byteSize: file.byteSize,
    }),
    [file.filename, file.contentType, file.byteSize],
  );
  const kind = fileKindForAttachment({ name: file.filename, url: file.url, contentType: file.contentType, byteSize: file.byteSize ?? undefined });
  const KindIcon = kind.icon;
  const size = formatFileSize(file.byteSize ?? undefined);
  const fullscreen = useFullscreen<HTMLElement>();
  const [setBodyNode, near] = useNearViewport<HTMLDivElement>();
  const [zoomed, setZoomed] = useState(false);
  const zoomable = preview.kind === "image" || preview.kind === "svg";
  const label = preview.kind === "none" ? kind.label : preview.label;
  return (
    <figure
      ref={fullscreen.ref}
      data-preview={preview.kind}
      className={cn(
        "m-0 flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-bg-2",
        fullscreen.active && "h-full w-full rounded-none border-0",
        fullscreen.overlay && "fixed inset-0 z-50 h-dvh",
      )}
    >
      <figcaption className="flex min-h-12 items-center gap-2 border-b border-line-soft py-1.5 pr-1.5 pl-3">
        <KindIcon className="size-4 shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-(length:--t-13) font-medium text-ink" title={file.filename}>{file.filename}</span>
          <span className="block truncate text-(length:--t-12) text-ink-3">{size ? `${label} · ${size}` : label}</span>
        </span>
        {zoomable && near ? (
          <Button variant="ghost" size="icon-sm" className="pointer-coarse:size-11" onClick={() => setZoomed((value) => !value)} aria-pressed={zoomed} aria-label={zoomed ? `Fit ${file.filename} to the frame` : `Show ${file.filename} at full size`} title={zoomed ? "Fit to frame" : "Full size"}>
            {zoomed ? <ZoomOut aria-hidden /> : <ZoomIn aria-hidden />}
          </Button>
        ) : null}
        {FULLSCREEN_KINDS.has(preview.kind) ? (
          <Button variant="ghost" size="icon-sm" className="pointer-coarse:size-11" onClick={fullscreen.toggle} aria-pressed={fullscreen.active} aria-label={fullscreen.active ? "Exit full screen" : `Show ${file.filename} full screen`} title={fullscreen.active ? "Exit full screen" : "Full screen"}>
            {fullscreen.active ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="icon-sm" className="pointer-coarse:size-11">
          <a href={file.downloadUrl} download={file.filename} rel="noreferrer" aria-label={`Download ${file.filename}`} title="Download">
            <Download aria-hidden />
          </a>
        </Button>
      </figcaption>
      {preview.kind === "none" ? (
        <p className="px-3 py-2.5 text-(length:--t-13) text-ink-3" data-testid="attachment-preview-unavailable">{preview.reason}</p>
      ) : (
        <div ref={setBodyNode} className={cn("relative min-h-0 w-full", fullscreen.active ? "flex-1" : BODY_HEIGHT[preview.kind])}>
          {near ? (
            <ViewerBoundary file={file}>
              <Suspense fallback={<PreviewMessage file={file} loading message="Loading viewer…" />}>
                <PreviewBody file={file} preview={preview} zoomed={zoomed} onToggleZoom={() => setZoomed((value) => !value)} />
              </Suspense>
            </ViewerBoundary>
          ) : null}
        </div>
      )}
    </figure>
  );
}

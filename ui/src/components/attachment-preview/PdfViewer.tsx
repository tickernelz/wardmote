import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Button } from "@/components/ui/button";
import { PreviewMessage } from "./PreviewMessage";
import type { ViewerProps } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const FIT_STEP = 2;
const PAGE_GAP = 12;

function PdfPage({ doc, pageNumber, width, aspect, scroller }: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  aspect: number;
  scroller: HTMLDivElement;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [pageAspect, setPageAspect] = useState(aspect);
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), {
      root: scroller,
      rootMargin: "100% 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller]);
  useEffect(() => {
    const target = canvas.current;
    if (!visible || !target || width <= 0) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    void doc.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      setPageAspect(base.height / base.width);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (width / base.width) * ratio });
      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      task = page.render({ canvas: target, viewport });
      task.promise.catch(() => undefined);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
      target.width = 0;
      target.height = 0;
    };
  }, [doc, pageNumber, visible, width]);
  return (
    <div ref={holder} className="mx-auto shrink-0 bg-white shadow-sm ring-1 ring-line-soft" style={{ width, height: Math.round(width * pageAspect) }}>
      <canvas ref={canvas} role="img" aria-label={`Page ${pageNumber} of ${doc.numPages}`} className="block h-full w-full" />
    </div>
  );
}

type LoadedPdf = { doc: PDFDocumentProxy; aspect: number; pageWidth: number };

export default function PdfViewer({ file }: ViewerProps) {
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(0);
  const [zoom, setZoom] = useState(FIT_STEP);
  useEffect(() => {
    setLoaded(null);
    setError(null);
    const task = pdfjs.getDocument({
      url: file.url,
      withCredentials: false,
      enableXfa: false,
      disableAutoFetch: true,
      rangeChunkSize: 256 * 1024,
    });
    let active = true;
    task.promise
      .then(async (doc) => {
        const viewport = (await doc.getPage(1)).getViewport({ scale: 1 });
        if (active) setLoaded({ doc, aspect: viewport.height / viewport.width, pageWidth: viewport.width });
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
      void task.destroy();
    };
  }, [file.url]);
  useEffect(() => {
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setAvailable(scroller.clientWidth));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);
  if (error) return <PreviewMessage file={file} message={`Could not open this PDF: ${error}`} />;
  if (!loaded) return <PreviewMessage file={file} loading message="Loading PDF…" />;
  const { doc, aspect, pageWidth } = loaded;
  const fitWidth = Math.max(0, Math.min(available - 24, pageWidth * 1.5));
  const width = Math.round(fitWidth * (ZOOM_STEPS[zoom]! / ZOOM_STEPS[FIT_STEP]!));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line-soft px-2 py-1 text-(length:--t-12) text-ink-3">
        <span className="mr-auto px-1">{doc.numPages} {doc.numPages === 1 ? "page" : "pages"}</span>
        <Button variant="ghost" size="icon-sm" className="pointer-coarse:size-11" onClick={() => setZoom((value) => Math.max(0, value - 1))} disabled={zoom === 0} aria-label="Zoom out" title="Zoom out">
          <Minus aria-hidden />
        </Button>
        <button type="button" onClick={() => setZoom(FIT_STEP)} className="min-h-9 min-w-14 rounded-md px-2 font-mono tabular-nums outline-hidden hover:bg-bg-3 focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11" aria-label={`Zoom ${Math.round((ZOOM_STEPS[zoom]! / ZOOM_STEPS[FIT_STEP]!) * 100)}%, reset to fit width`} title="Fit width">
          {Math.round((ZOOM_STEPS[zoom]! / ZOOM_STEPS[FIT_STEP]!) * 100)}%
        </button>
        <Button variant="ghost" size="icon-sm" className="pointer-coarse:size-11" onClick={() => setZoom((value) => Math.min(ZOOM_STEPS.length - 1, value + 1))} disabled={zoom === ZOOM_STEPS.length - 1} aria-label="Zoom in" title="Zoom in">
          <Plus aria-hidden />
        </Button>
      </div>
      <div ref={setScroller} className="min-h-0 flex-1 overflow-auto overscroll-contain bg-bg-3 p-3" tabIndex={0} role="region" aria-label={`${file.filename}, ${doc.numPages} pages`}>
        {scroller && width > 0 ? (
          <div className="flex w-max min-w-full flex-col" style={{ gap: PAGE_GAP }}>
            {Array.from({ length: doc.numPages }, (_, index) => (
              <PdfPage key={index} doc={doc} pageNumber={index + 1} width={width} aspect={aspect} scroller={scroller} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

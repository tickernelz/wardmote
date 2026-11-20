import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { strFromU8 } from "fflate";
import { PREVIEW_LIMITS } from "@/lib/attachment-preview";
import { readBytes } from "@/lib/attachment-preview-readers";
import { runOfficeJob } from "./office-jobs";
import { PreviewMessage } from "./PreviewMessage";
import type { ViewerProps } from "./types";

const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const RELATIONSHIP_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };

type SlideBlock =
  | { kind: "text"; title: boolean; paragraphs: Array<{ text: string; level: number }> }
  | { kind: "image"; bytes: Uint8Array; type: string; alt: string };

interface Slide {
  number: number;
  blocks: SlideBlock[];
}

function parseXml(bytes: Uint8Array | undefined) {
  return bytes ? new DOMParser().parseFromString(strFromU8(bytes), "application/xml") : null;
}

function resolvePath(base: string, target: string) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

function relationships(files: Record<string, Uint8Array>, partPath: string) {
  const slash = partPath.lastIndexOf("/");
  const doc = parseXml(files[`${partPath.slice(0, slash)}/_rels/${partPath.slice(slash + 1)}.rels`]);
  const map = new Map<string, string>();
  for (const rel of Array.from(doc?.getElementsByTagName("Relationship") ?? [])) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target && rel.getAttribute("TargetMode") !== "External") map.set(id, resolvePath(partPath, target));
  }
  return map;
}

function readSlide(files: Record<string, Uint8Array>, path: string, number: number): Slide {
  const doc = parseXml(files[path]);
  const rels = relationships(files, path);
  const blocks: SlideBlock[] = [];
  for (const node of Array.from(doc?.getElementsByTagNameNS("*", "*") ?? [])) {
    if (node.localName === "sp") {
      const placeholder = Array.from(node.getElementsByTagNameNS("*", "ph"))[0]?.getAttribute("type") ?? "";
      const paragraphs = Array.from(node.getElementsByTagNameNS(DRAWING_NS, "p"))
        .map((paragraph) => ({
          text: Array.from(paragraph.getElementsByTagNameNS(DRAWING_NS, "t")).map((run) => run.textContent ?? "").join(""),
          level: Number(paragraph.getElementsByTagNameNS(DRAWING_NS, "pPr")[0]?.getAttribute("lvl") ?? 0) || 0,
        }))
        .filter((paragraph) => paragraph.text.trim().length > 0);
      if (paragraphs.length) blocks.push({ kind: "text", title: placeholder === "title" || placeholder === "ctrTitle", paragraphs });
    } else if (node.localName === "pic") {
      const embed = node.getElementsByTagNameNS(DRAWING_NS, "blip")[0]?.getAttributeNS(RELATIONSHIP_NS, "embed");
      const target = embed ? rels.get(embed) : undefined;
      const extension = target?.split(".").pop()?.toLowerCase() ?? "";
      const bytes = target ? files[target] : undefined;
      const description = Array.from(node.getElementsByTagNameNS("*", "cNvPr"))[0]?.getAttribute("descr") ?? "";
      if (bytes && IMAGE_TYPES[extension]) blocks.push({ kind: "image", bytes, type: IMAGE_TYPES[extension]!, alt: description || `Picture on slide ${number}` });
    }
  }
  return { number, blocks };
}

/** Pulls slide text and raster pictures out of a .pptx, in presentation order. */
function readPresentation(files: Record<string, Uint8Array>): Slide[] {
  const presentation = parseXml(files["ppt/presentation.xml"]);
  if (!presentation) throw new Error("This file isn't a PowerPoint presentation.");
  const rels = relationships(files, "ppt/presentation.xml");
  const ids = Array.from(presentation.getElementsByTagNameNS("*", "sldId"))
    .map((slide) => rels.get(slide.getAttributeNS(RELATIONSHIP_NS, "id") ?? ""))
    .filter((path): path is string => Boolean(path && files[path]));
  return ids.map((path, index) => readSlide(files, path, index + 1));
}

function SlideImage({ block }: { block: Extract<SlideBlock, { kind: "image" }> }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([block.bytes.slice()], { type: block.type })), [block]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img src={url} alt={block.alt} loading="lazy" decoding="async" className="max-h-64 w-auto max-w-full rounded-sm object-contain" />;
}

export default function PptxViewer({ file }: ViewerProps) {
  const query = useQuery({
    queryKey: ["public-share-preview", "pptx", file.url],
    queryFn: async ({ signal }) => readPresentation((await runOfficeJob("pptx", await readBytes(file.url, PREVIEW_LIMITS.pptxBytes, signal), signal)).files),
    staleTime: Infinity,
    retry: 1,
    structuralSharing: false,
  });
  if (query.isError) return <PreviewMessage file={file} message={`Could not read this presentation: ${(query.error as Error).message}`} />;
  if (!query.data) return <PreviewMessage file={file} loading message="Loading presentation…" />;
  if (!query.data.length) return <PreviewMessage file={file} message="This presentation has no slides." />;
  return (
    <div className="h-full min-h-0 overflow-auto overscroll-contain bg-bg-3 p-3" tabIndex={0} role="region" aria-label={`${file.filename}, ${query.data.length} slides`}>
      <p className="mx-auto mb-3 max-w-3xl text-(length:--t-12) text-ink-3">Text and pictures from each slide. Layout, charts and animations are simplified; download the file for the full deck.</p>
      <ol className="mx-auto flex max-w-3xl flex-col gap-3">
        {query.data.map((slide) => (
          <li key={slide.number} className="rounded-lg border border-line bg-bg-2 p-4" aria-label={`Slide ${slide.number}`}>
            <p className="mb-2 font-mono text-(length:--t-12) text-ink-3">Slide {slide.number}</p>
            <div className="space-y-3 text-(length:--t-14) text-ink">
              {slide.blocks.length === 0 ? <p className="text-ink-3">No text on this slide.</p> : null}
              {slide.blocks.map((block, index) =>
                block.kind === "image" ? (
                  <SlideImage key={index} block={block} />
                ) : block.title ? (
                  <h4 key={index} className="text-(length:--t-16) font-semibold text-balance">{block.paragraphs.map((paragraph) => paragraph.text).join(" ")}</h4>
                ) : (
                  <ul key={index} className="space-y-1">
                    {block.paragraphs.map((paragraph, line) => (
                      <li key={line} className="break-words" style={{ paddingInlineStart: `${paragraph.level * 1.25}rem` }}>{paragraph.text}</li>
                    ))}
                  </ul>
                ),
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

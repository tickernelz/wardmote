import { useQuery } from "@tanstack/react-query";
import { HtmlArtifactPreview } from "@/components/HtmlArtifactPreview";
import { PREVIEW_LIMITS } from "@/lib/attachment-preview";
import { readBytes } from "@/lib/attachment-preview-readers";
import { runOfficeJob } from "./office-jobs";
import { PreviewMessage } from "./PreviewMessage";
import type { ViewerProps } from "./types";

const DOCUMENT_STYLE = `<style>
:root{color-scheme:light}
body{margin:0;background:color-mix(in srgb,CanvasText 8%,Canvas);color:CanvasText;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
main{box-sizing:border-box;max-width:48rem;min-height:100%;margin:16px auto;padding:40px 48px;background:Canvas;box-shadow:0 1px 3px color-mix(in srgb,CanvasText 15%,transparent);overflow-wrap:anywhere}
img{max-width:100%;height:auto}
table{border-collapse:collapse;margin:1em 0;max-width:100%}
td,th{border:1px solid color-mix(in srgb,CanvasText 25%,Canvas);padding:4px 8px;vertical-align:top}
h1,h2,h3{line-height:1.25}
@media (max-width:640px){main{margin:0;padding:20px 16px;box-shadow:none}}
</style>`;

export default function DocxViewer({ file }: ViewerProps) {
  const query = useQuery({
    queryKey: ["public-share-preview", "docx", file.url],
    queryFn: async ({ signal }) => (await runOfficeJob("docx", await readBytes(file.url, PREVIEW_LIMITS.docxBytes, signal), signal)).html,
    staleTime: Infinity,
    retry: 1,
  });
  if (query.isError) return <PreviewMessage file={file} message={`Could not read this document: ${(query.error as Error).message}`} />;
  if (query.data === undefined) return <PreviewMessage file={file} loading message="Loading document…" />;
  if (!query.data.trim()) return <PreviewMessage file={file} message="This document has no text to show." />;
  return <HtmlArtifactPreview html={`${DOCUMENT_STYLE}<main>${query.data}</main>`} title={file.filename} scripts={false} />;
}

export type AttachmentPreviewKind =
  | "pdf"
  | "image"
  | "svg"
  | "video"
  | "audio"
  | "csv"
  | "spreadsheet"
  | "docx"
  | "pptx"
  | "markdown"
  | "html"
  | "text"
  | "none";

export interface PreviewableFile {
  filename: string;
  contentType: string;
  byteSize: number | null;
}

export type AttachmentPreview =
  | { kind: Exclude<AttachmentPreviewKind, "none">; label: string }
  | { kind: "none"; label: string; reason: string };

const MB = 1024 * 1024;

export const PREVIEW_LIMITS = {
  textBytes: 512 * 1024,
  svgBytes: 2 * MB,
  csvScanBytes: 64 * MB,
  spreadsheetBytes: 25 * MB,
  docxBytes: 25 * MB,
  pptxBytes: 60 * MB,
  tableRows: 5_000,
  tableColumns: 100,
} as const;

const GENERIC_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-binary"]);

const BY_EXTENSION: Record<string, Exclude<AttachmentPreviewKind, "none">> = {
  pdf: "pdf",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", ico: "image",
  svg: "svg",
  mp4: "video", m4v: "video", webm: "video", mov: "video", ogv: "video",
  mp3: "audio", wav: "audio", ogg: "audio", oga: "audio", opus: "audio", m4a: "audio", aac: "audio", flac: "audio", weba: "audio",
  csv: "csv", tsv: "csv",
  xlsx: "spreadsheet", xlsm: "spreadsheet", xls: "spreadsheet", ods: "spreadsheet",
  docx: "docx",
  pptx: "pptx",
  md: "markdown", markdown: "markdown",
  html: "html", htm: "html",
  txt: "text", log: "text", json: "text", jsonl: "text", ndjson: "text", yaml: "text", yml: "text", toml: "text", ini: "text",
  xml: "text", sql: "text", sh: "text", py: "text", js: "text", mjs: "text", ts: "text", tsx: "text", jsx: "text", css: "text",
  go: "text", rs: "text", java: "text", rb: "text", php: "text", c: "text", h: "text", cpp: "text", diff: "text", patch: "text",
};

const UNSUPPORTED_REASONS: Record<string, string> = {
  doc: "Older Word files (.doc) can't be shown in the browser. Save it as .docx or download it.",
  ppt: "Older PowerPoint files (.ppt) can't be shown in the browser. Save it as .pptx or download it.",
  heic: "Browsers can't display HEIC photos yet. Download it to open.",
  heif: "Browsers can't display HEIF photos yet. Download it to open.",
  tif: "Browsers can't display TIFF images. Download it to open.",
  tiff: "Browsers can't display TIFF images. Download it to open.",
};

const LABELS: Record<Exclude<AttachmentPreviewKind, "none">, string> = {
  pdf: "PDF",
  image: "Image",
  svg: "SVG image",
  video: "Video",
  audio: "Audio",
  csv: "CSV",
  spreadsheet: "Spreadsheet",
  docx: "Word document",
  pptx: "Presentation",
  markdown: "Markdown",
  html: "HTML",
  text: "Text",
};

function extensionOf(filename: string) {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return match ? match[1]!.toLowerCase() : "";
}

function kindFromContentType(type: string): Exclude<AttachmentPreviewKind, "none"> | null {
  if (type === "application/pdf") return "pdf";
  if (type === "image/svg+xml") return "svg";
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/.test(type)) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "text/csv" || type === "application/csv" || type === "text/tab-separated-values") return "csv";
  if (
    type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || type === "application/vnd.ms-excel"
    || type === "application/vnd.ms-excel.sheet.macroenabled.12"
    || type === "application/vnd.oasis.opendocument.spreadsheet"
  ) return "spreadsheet";
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (type === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/x-ndjson") return "text";
  return null;
}

function formatMegabytes(bytes: number) {
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

function byteCap(kind: Exclude<AttachmentPreviewKind, "none">): number | null {
  if (kind === "svg") return PREVIEW_LIMITS.svgBytes;
  if (kind === "spreadsheet") return PREVIEW_LIMITS.spreadsheetBytes;
  if (kind === "docx") return PREVIEW_LIMITS.docxBytes;
  if (kind === "pptx") return PREVIEW_LIMITS.pptxBytes;
  if (kind === "html") return PREVIEW_LIMITS.textBytes;
  return null;
}

/** Decides how the browser can show a file inline, from its extension first and its declared type second. */
export function attachmentPreview(file: PreviewableFile): AttachmentPreview {
  const type = file.contentType.split(";", 1)[0]!.trim().toLowerCase();
  const extension = extensionOf(file.filename);
  const unsupported = UNSUPPORTED_REASONS[extension];
  if (unsupported) return { kind: "none", label: extension.toUpperCase(), reason: unsupported };
  const kind = BY_EXTENSION[extension] ?? kindFromContentType(type);
  if (!kind) {
    return {
      kind: "none",
      label: extension ? extension.toUpperCase() : GENERIC_TYPES.has(type) ? "File" : type,
      reason: "This file type can't be shown in the browser. Download it to open.",
    };
  }
  if (file.byteSize === 0) return { kind: "none", label: LABELS[kind], reason: "This file is empty." };
  const cap = byteCap(kind);
  if (cap !== null && file.byteSize !== null && file.byteSize > cap) {
    return {
      kind: "none",
      label: LABELS[kind],
      reason: `This file is too large to preview (${formatMegabytes(file.byteSize)}; the limit is ${formatMegabytes(cap)}). Download it to open.`,
    };
  }
  return { kind, label: LABELS[kind] };
}

export function csvDelimiterFor(filename: string, contentType: string) {
  return extensionOf(filename) === "tsv" || contentType.toLowerCase().startsWith("text/tab-separated-values") ? "\t" : ",";
}

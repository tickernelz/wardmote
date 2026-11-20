import { unzipSync } from "fflate";
import { PREVIEW_LIMITS } from "@/lib/attachment-preview";
import type { OfficeJob, OfficeResult, SheetData } from "./office-jobs";

const PPTX_ENTRY_BYTES = 40 * 1024 * 1024;
const PPTX_ENTRY_PATTERN = /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/(_rels\/)?slide\d+\.xml(\.rels)?|media\/[^/]+\.(png|jpe?g|gif|webp|bmp))$/i;

async function readWorkbook(bytes: ArrayBuffer): Promise<SheetData[]> {
  const xlsx = await import("xlsx");
  const workbook = xlsx.read(new Uint8Array(bytes), {
    type: "array",
    dense: true,
    sheetRows: PREVIEW_LIMITS.tableRows,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
  });
  const hidden = workbook.Workbook?.Sheets?.map((entry) => Boolean(entry.Hidden)) ?? [];
  return workbook.SheetNames.map((name, index) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) return { name, hidden: hidden[index] ?? false, header: [], rows: [], total: 0, columnCount: 0, firstRow: 1 };
    const rows = xlsx.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: true });
    const reference = sheet["!fullref"] ?? sheet["!ref"];
    const range = reference ? xlsx.utils.decode_range(reference) : null;
    const columnCount = range ? range.e.c - range.s.c + 1 : Math.max(0, ...rows.map((row) => row.length));
    const firstColumn = range?.s.c ?? 0;
    const header = Array.from({ length: Math.min(columnCount, PREVIEW_LIMITS.tableColumns) }, (_, column) => xlsx.utils.encode_col(firstColumn + column));
    return {
      name,
      hidden: hidden[index] ?? false,
      header,
      rows: rows.slice(0, PREVIEW_LIMITS.tableRows),
      total: range ? range.e.r - range.s.r + 1 : rows.length,
      columnCount,
      firstRow: (range?.s.r ?? 0) + 1,
    };
  });
}

async function convertDocument(bytes: ArrayBuffer): Promise<string> {
  const mammoth = await import("mammoth");
  return (await mammoth.convertToHtml({ arrayBuffer: bytes })).value;
}

function unzipPresentation(bytes: ArrayBuffer): Record<string, Uint8Array> {
  let total = 0;
  return unzipSync(new Uint8Array(bytes), {
    filter: (entry) => {
      if (!PPTX_ENTRY_PATTERN.test(entry.name) || entry.originalSize > PPTX_ENTRY_BYTES) return false;
      total += entry.originalSize;
      if (total > PREVIEW_LIMITS.pptxBytes * 4) throw new Error("This presentation expands to too much data to preview.");
      return true;
    },
  });
}

self.onmessage = async (event: MessageEvent<OfficeJob>) => {
  const job = event.data;
  try {
    if (job.op === "xlsx") {
      self.postMessage({ ok: true, op: "xlsx", sheets: await readWorkbook(job.bytes) } satisfies OfficeResult);
    } else if (job.op === "docx") {
      self.postMessage({ ok: true, op: "docx", html: await convertDocument(job.bytes) } satisfies OfficeResult);
    } else {
      const files = unzipPresentation(job.bytes);
      self.postMessage({ ok: true, op: "pptx", files } satisfies OfficeResult, { transfer: Object.values(files).map((file) => file.buffer) });
    }
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies OfficeResult);
  }
};

/** Incremental CSV parser that keeps the first `maxRows` records and counts every record it sees. */
export class CsvRecordCollector {
  readonly rows: string[][] = [];
  records = 0;
  incomplete = false;
  private row: string[] = [];
  private rowFields = 0;
  private field = "";
  private fieldEmpty = true;
  private quoted = false;
  private quotePending = false;
  private skipLf = false;
  private started = false;
  private sawContent = false;
  private endedWithNewline = false;

  constructor(private readonly maxRows: number, private readonly delimiter = ",") {}

  private get storing() {
    return this.rows.length < this.maxRows;
  }

  private endField() {
    if (this.storing) this.row.push(this.field);
    this.rowFields++;
    this.field = "";
    this.fieldEmpty = true;
  }

  private endRecord() {
    this.endField();
    if (this.storing) this.rows.push(this.row);
    this.row = [];
    this.rowFields = 0;
    this.records++;
  }

  push(chunk: string): void {
    const storing = this.storing;
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i]!;
      if (!this.started) {
        this.started = true;
        if (char === "\uFEFF") continue;
      }
      if (this.skipLf) {
        this.skipLf = false;
        if (char === "\n") continue;
      }
      this.sawContent = true;
      if (this.quotePending) {
        this.quotePending = false;
        if (char === '"') {
          if (storing) this.field += char;
          this.fieldEmpty = false;
          continue;
        }
        this.quoted = false;
      }
      this.endedWithNewline = false;
      if (char === '"') {
        if (this.quoted) this.quotePending = true;
        else if (this.fieldEmpty) this.quoted = true;
        else {
          if (storing) this.field += char;
        }
      } else if (!this.quoted && char === this.delimiter) {
        this.endField();
      } else if (!this.quoted && (char === "\n" || char === "\r")) {
        this.endRecord();
        this.endedWithNewline = true;
        if (char === "\r") this.skipLf = true;
        if (!this.storing && storing) return this.push(chunk.slice(i + 1));
      } else {
        if (storing) this.field += char;
        this.fieldEmpty = false;
      }
    }
  }

  finish() {
    if (this.quotePending) {
      this.quotePending = false;
      this.quoted = false;
    }
    if (this.quoted) this.incomplete = true;
    if (this.sawContent && (!this.fieldEmpty || this.rowFields > 0 || !this.endedWithNewline)) this.endRecord();
  }
}

export interface CsvPreviewResult {
  header: string[];
  rows: string[][];
  totalRows: number;
  exact: boolean;
  incomplete: boolean;
}

function responseError(response: Response) {
  return new Error(response.status === 404 ? "This file is no longer shared." : `Could not load the file (${response.status}).`);
}

/** Streams a CSV response, keeping the first rows and counting the rest up to `scanBytes`. */
export async function readCsvPreview(
  response: Response,
  options: { maxRows: number; delimiter: string; scanBytes: number },
): Promise<CsvPreviewResult> {
  if (!response.ok) throw responseError(response);
  if (!response.body) throw new Error("The file response is empty.");
  const collector = new CsvRecordCollector(options.maxRows + 1, options.delimiter);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;
  let exact = true;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      collector.push(decoder.decode(chunk.value, { stream: true }));
      if (bytes >= options.scanBytes) {
        exact = false;
        break;
      }
    }
    if (exact) {
      collector.push(decoder.decode());
      collector.finish();
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const [header = [], ...rows] = collector.rows;
  return {
    header,
    rows,
    totalRows: Math.max(0, collector.records - 1),
    exact,
    incomplete: exact && collector.incomplete,
  };
}

export interface TextHead {
  text: string;
  truncated: boolean;
}

/** Reads at most `maxBytes` of a text file through a Range request and rejects binary content. */
export async function readTextHead(url: string, maxBytes: number, signal?: AbortSignal): Promise<TextHead> {
  const response = await fetch(url, { credentials: "omit", headers: { Range: `bytes=0-${maxBytes - 1}` }, signal });
  if (!response.ok) throw responseError(response);
  if (!response.body) return { text: "", truncated: false };
  const total = Number(/\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "")?.[1] ?? response.headers.get("Content-Length") ?? 0);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let truncated = total > maxBytes;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = maxBytes - bytes;
      const part = chunk.value.byteLength > remaining ? chunk.value.subarray(0, remaining) : chunk.value;
      bytes += part.byteLength;
      text += decoder.decode(part, { stream: true });
      if (bytes >= maxBytes) {
        truncated = truncated || chunk.value.byteLength > remaining;
        break;
      }
    }
    if (!truncated) text += decoder.decode();
  } catch (error) {
    if (error instanceof TypeError && !signal?.aborted) throw new Error("This file isn't valid UTF-8 text. Download it to open.");
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (text.includes("\0")) throw new Error("This file contains binary data. Download it to open.");
  return { text, truncated };
}

/** Downloads a whole file into memory, refusing anything over `maxBytes`. */
export async function readBytes(url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { credentials: "omit", signal });
  if (!response.ok) throw responseError(response);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error("This file is too large to preview. Download it to open.");
      parts.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

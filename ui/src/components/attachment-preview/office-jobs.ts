export interface SheetData {
  name: string;
  hidden: boolean;
  header: string[];
  rows: string[][];
  total: number;
  columnCount: number;
  firstRow: number;
}

export type OfficeJob =
  | { op: "xlsx"; bytes: ArrayBuffer }
  | { op: "docx"; bytes: ArrayBuffer }
  | { op: "pptx"; bytes: ArrayBuffer };

export type OfficeResult =
  | { ok: true; op: "xlsx"; sheets: SheetData[] }
  | { ok: true; op: "docx"; html: string }
  | { ok: true; op: "pptx"; files: Record<string, Uint8Array> }
  | { ok: false; error: string };

type Success<Op extends OfficeJob["op"]> = Extract<OfficeResult, { ok: true; op: Op }>;

/** Parses an Office file in a dedicated worker so large files never block the page. */
export function runOfficeJob<Op extends OfficeJob["op"]>(op: Op, bytes: Uint8Array, signal?: AbortSignal): Promise<Success<Op>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./office.worker.ts", import.meta.url), { type: "module", name: `preview-${op}` });
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<OfficeResult>) => {
      finish();
      const result = event.data;
      if (result.ok && result.op === op) resolve(result as Success<Op>);
      else reject(new Error(result.ok ? "The preview worker answered the wrong job." : result.error));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The preview worker failed."));
    };
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.slice().buffer as ArrayBuffer);
    worker.postMessage({ op, bytes: buffer } as OfficeJob, [buffer]);
  });
}

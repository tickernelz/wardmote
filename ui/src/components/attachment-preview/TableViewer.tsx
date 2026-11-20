import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { WorkBook } from "xlsx";
import { csvDelimiterFor, PREVIEW_LIMITS } from "@/lib/attachment-preview";
import { readBytes, readCsvPreview } from "@/lib/attachment-preview-readers";
import { cn } from "@/lib/utils";
import { DataGrid } from "./DataGrid";
import { PreviewMessage } from "./PreviewMessage";
import type { ViewerProps } from "./types";

type XlsxModule = typeof import("xlsx");

function RowSummary({ shown, total, exact, columnsShown, columnCount, note }: {
  shown: number;
  total: number;
  exact: boolean;
  columnsShown: number;
  columnCount: number;
  note?: string;
}) {
  const parts: string[] = [];
  if (!exact) parts.push(`Showing the first ${shown.toLocaleString()} rows; the file is too large to count them all`);
  else if (shown < total) parts.push(`Showing ${shown.toLocaleString()} of ${total.toLocaleString()} rows`);
  else parts.push(`${total.toLocaleString()} ${total === 1 ? "row" : "rows"}`);
  if (columnsShown < columnCount) parts.push(`${columnsShown} of ${columnCount.toLocaleString()} columns`);
  const truncated = !exact || shown < total || columnsShown < columnCount;
  return (
    <p role="status" className="border-b border-line-soft px-3 py-1.5 text-(length:--t-12) text-ink-3">
      {parts.join(" · ")}
      {truncated ? ". Download the file to see everything." : null}
      {note ? ` ${note}` : null}
    </p>
  );
}

function CsvTable({ file }: ViewerProps) {
  const query = useQuery({
    queryKey: ["public-share-preview", "csv", file.url],
    queryFn: async ({ signal }) => readCsvPreview(await fetch(file.url, { credentials: "omit", signal }), {
      maxRows: PREVIEW_LIMITS.tableRows,
      delimiter: csvDelimiterFor(file.filename, file.contentType),
      scanBytes: PREVIEW_LIMITS.csvScanBytes,
    }),
    staleTime: Infinity,
    retry: 1,
  });
  if (query.isError) return <PreviewMessage file={file} message={(query.error as Error).message} />;
  if (!query.data) return <PreviewMessage file={file} loading message="Loading table…" />;
  const { header, rows, totalRows, exact, incomplete } = query.data;
  const columnCount = Math.max(header.length, ...rows.slice(0, 200).map((row) => row.length));
  const columnsShown = Math.min(columnCount, PREVIEW_LIMITS.tableColumns);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <RowSummary
        shown={rows.length}
        total={totalRows}
        exact={exact}
        columnsShown={columnsShown}
        columnCount={columnCount}
        note={incomplete ? "The last quoted value never closes, so the final row may be cut short." : undefined}
      />
      <DataGrid title={file.filename} header={header} rows={rows} columnCount={columnsShown} />
    </div>
  );
}

function readSheet(xlsx: XlsxModule, workbook: WorkBook, name: string) {
  const sheet = workbook.Sheets[name];
  if (!sheet) return { header: [], rows: [], total: 0, columnCount: 0 };
  const rows = xlsx.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: true });
  const reference = sheet["!fullref"] ?? sheet["!ref"];
  const range = reference ? xlsx.utils.decode_range(reference) : null;
  const columnCount = range ? range.e.c - range.s.c + 1 : Math.max(0, ...rows.map((row) => row.length));
  const firstColumn = range?.s.c ?? 0;
  const header = Array.from({ length: Math.min(columnCount, PREVIEW_LIMITS.tableColumns) }, (_, index) => xlsx.utils.encode_col(firstColumn + index));
  const total = range ? range.e.r - range.s.r + 1 : rows.length;
  return { header, rows: rows.slice(0, PREVIEW_LIMITS.tableRows), total, columnCount, firstRow: (range?.s.r ?? 0) + 1 };
}

function SpreadsheetTable({ file }: ViewerProps) {
  const query = useQuery({
    queryKey: ["public-share-preview", "spreadsheet", file.url],
    queryFn: async ({ signal }) => {
      const [xlsx, bytes] = await Promise.all([import("xlsx"), readBytes(file.url, PREVIEW_LIMITS.spreadsheetBytes, signal)]);
      const workbook = xlsx.read(bytes, {
        type: "array",
        dense: true,
        sheetRows: PREVIEW_LIMITS.tableRows,
        cellFormula: false,
        cellHTML: false,
        cellStyles: false,
      });
      return { xlsx, workbook };
    },
    staleTime: Infinity,
    retry: 1,
    structuralSharing: false,
  });
  const [selected, setSelected] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const sheetNames = query.data?.workbook.SheetNames ?? [];
  const sheetName = sheetNames[selected] ?? sheetNames[0];
  const sheet = useMemo(
    () => (query.data && sheetName ? readSheet(query.data.xlsx, query.data.workbook, sheetName) : null),
    [query.data, sheetName],
  );
  if (query.isError) return <PreviewMessage file={file} message={`Could not read this spreadsheet: ${(query.error as Error).message}`} />;
  if (!query.data || !sheet) return <PreviewMessage file={file} loading message="Loading spreadsheet…" />;
  const hidden = query.data.workbook.Workbook?.Sheets?.map((entry) => Boolean(entry.Hidden)) ?? [];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? sheetNames.length - 1 : (selected + step + sheetNames.length) % sheetNames.length;
    setSelected(next);
    tabs.current[next]?.focus();
  };
  const panelId = `${file.url}-sheet-panel`;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Sheets" onKeyDown={onKeyDown} className="flex shrink-0 gap-1 overflow-x-auto border-b border-line-soft px-2 py-1.5">
        {sheetNames.map((name, index) => (
          <button
            key={name}
            ref={(element) => { tabs.current[index] = element; }}
            type="button"
            role="tab"
            aria-selected={index === selected}
            aria-controls={panelId}
            tabIndex={index === selected ? 0 : -1}
            onClick={() => setSelected(index)}
            className={cn(
              "min-h-8 shrink-0 rounded-md px-3 text-(length:--t-12) font-medium outline-hidden focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11",
              index === selected ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-bg-3 hover:text-ink",
            )}
          >
            {name}{hidden[index] ? " (hidden)" : ""}
          </button>
        ))}
      </div>
      <div id={panelId} role="tabpanel" aria-label={sheetName} className="flex min-h-0 flex-1 flex-col">
        <RowSummary
          shown={sheet.rows.length}
          total={sheet.total}
          exact
          columnsShown={sheet.header.length}
          columnCount={sheet.columnCount}
        />
        {sheet.total === 0 ? (
          <p className="p-4 text-(length:--t-13) text-ink-3">This sheet is empty.</p>
        ) : (
          <DataGrid key={sheetName} title={`${file.filename}, sheet ${sheetName}`} header={sheet.header} rows={sheet.rows} columnCount={sheet.header.length} rowNumberOffset={sheet.firstRow} />
        )}
      </div>
    </div>
  );
}

export default function TableViewer(props: ViewerProps & { kind: "csv" | "spreadsheet" }) {
  return props.kind === "csv" ? <CsvTable file={props.file} /> : <SpreadsheetTable file={props.file} />;
}

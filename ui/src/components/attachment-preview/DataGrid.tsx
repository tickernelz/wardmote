import { useEffect, useMemo, useRef, useState } from "react";

const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const WIDTH_SAMPLE_ROWS = 200;

function columnWidths(header: string[], rows: string[][], columnCount: number) {
  return Array.from({ length: columnCount }, (_, column) => {
    let longest = (header[column] ?? "").length;
    for (let index = 0; index < Math.min(rows.length, WIDTH_SAMPLE_ROWS); index++) {
      longest = Math.max(longest, (rows[index]?.[column] ?? "").length);
    }
    return Math.min(40, Math.max(6, longest)) + 3;
  });
}

/** Table that renders only the rows near the scroll position. */
export function DataGrid({ title, header, rows, columnCount, rowNumberOffset = 1 }: {
  title: string;
  header: string[];
  rows: string[][];
  columnCount: number;
  rowNumberOffset?: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(480);
  const frame = useRef(0);
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const widths = useMemo(() => columnWidths(header, rows, columnCount), [header, rows, columnCount]);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const columns = widths.map((_, index) => index);
  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => setScrollTop(top));
      }}
      className="h-full min-h-0 overflow-auto overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      role="region"
      aria-label={`${title} table`}
      tabIndex={0}
    >
      <table
        className="table-fixed border-collapse text-(length:--t-13)"
        style={{ width: `calc(4.5rem + ${widths.reduce((sum, width) => sum + width, 0)}ch)` }}
        aria-rowcount={rows.length + 1}
      >
        <caption className="sr-only">{title}</caption>
        <colgroup>
          <col style={{ width: "4.5rem" }} />
          {widths.map((width, index) => <col key={index} style={{ width: `${width}ch` }} />)}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-bg-3">
          <tr aria-rowindex={1}>
            <th scope="col" className="border-b border-line px-3 py-2 text-right font-mono text-(length:--t-12) font-normal text-ink-3">
              <span className="sr-only">Row</span>#
            </th>
            {columns.map((column) => (
              <th key={column} scope="col" className="truncate border-b border-line px-3 py-2 text-left font-medium text-ink" title={header[column]}>
                {header[column] || `Column ${column + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {start > 0 ? <tr aria-hidden="true" style={{ height: start * ROW_HEIGHT }} /> : null}
          {rows.slice(start, end).map((row, offset) => {
            const index = start + offset;
            return (
              <tr key={index} aria-rowindex={index + 2} style={{ height: ROW_HEIGHT }} className="even:bg-bg-3/30">
                <th scope="row" className="border-b border-line-soft px-3 text-right font-mono text-(length:--t-12) font-normal text-ink-3">
                  {(index + rowNumberOffset).toLocaleString()}
                </th>
                {columns.map((column) => {
                  const value = row[column] ?? "";
                  return (
                    <td key={column} className="truncate whitespace-nowrap border-b border-line-soft px-3 text-ink-2" title={value.length > 24 ? value : undefined}>
                      {value}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {end < rows.length ? <tr aria-hidden="true" style={{ height: (rows.length - end) * ROW_HEIGHT }} /> : null}
        </tbody>
      </table>
    </div>
  );
}

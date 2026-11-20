import { describe, expect, it } from "vitest";
import { readCsvPreview } from "./attachment-preview-readers";

function streamed(text: string, chunkSize: number) {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
      controller.close();
    },
  });
  return new Response(stream);
}

describe("readCsvPreview", () => {
  it("keeps the first rows and counts every record across chunk boundaries", async () => {
    const lines = ["id,note"];
    for (let index = 1; index <= 1200; index++) lines.push(`${index},"line ${index}, with comma\nand newline"`);
    const result = await readCsvPreview(streamed(`\uFEFF${lines.join("\r\n")}\r\n`, 7), { maxRows: 100, delimiter: ",", scanBytes: 10 * 1024 * 1024 });
    expect(result.header).toEqual(["id", "note"]);
    expect(result.rows).toHaveLength(100);
    expect(result.rows[99]).toEqual(["100", "line 100, with comma\nand newline"]);
    expect(result).toMatchObject({ totalRows: 1200, exact: true, incomplete: false });
  });

  it("keeps escaped quotes, empty trailing fields and a last row without newline", async () => {
    const result = await readCsvPreview(streamed('a,b,c\n"say ""hi""",,\n1,2,3', 3), { maxRows: 10, delimiter: ",", scanBytes: 1024 });
    expect(result.rows).toEqual([['say "hi"', "", ""], ["1", "2", "3"]]);
    expect(result.totalRows).toBe(2);
  });

  it("reads tab-separated files and flags an unterminated quote", async () => {
    const result = await readCsvPreview(streamed('x\ty\n1\t"open', 4), { maxRows: 10, delimiter: "\t", scanBytes: 1024 });
    expect(result.rows).toEqual([["1", "open"]]);
    expect(result.incomplete).toBe(true);
  });

  it("stops counting at the scan limit and reports the total as inexact", async () => {
    const body = `h\n${"row\n".repeat(5000)}`;
    const result = await readCsvPreview(streamed(body, 64), { maxRows: 10, delimiter: ",", scanBytes: 1024 });
    expect(result.rows).toHaveLength(10);
    expect(result.exact).toBe(false);
  });

  it("rejects a link that no longer shares the file", async () => {
    await expect(readCsvPreview(new Response("", { status: 404 }), { maxRows: 10, delimiter: ",", scanBytes: 1024 })).rejects.toThrow("no longer shared");
  });
});

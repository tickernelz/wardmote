import { describe, expect, it } from "vitest";
import { attachmentPreview } from "./attachment-preview";

const file = (filename: string, contentType = "application/octet-stream", byteSize: number | null = 1024) => ({ filename, contentType, byteSize });

describe("attachmentPreview", () => {
  it("shows common formats inline even when uploads arrive as octet-stream", () => {
    const kinds = Object.fromEntries(
      ["report.pdf", "photo.JPG", "chart.png", "logo.svg", "demo.mp4", "clip.webm", "voice.m4a", "song.mp3", "rows.csv", "book.xlsx", "legacy.xls", "memo.docx", "deck.pptx", "notes.txt", "README.md", "data.json", "server.log", "page.html"]
        .map((name) => [name, attachmentPreview(file(name)).kind]),
    );
    expect(kinds).toEqual({
      "report.pdf": "pdf",
      "photo.JPG": "image",
      "chart.png": "image",
      "logo.svg": "svg",
      "demo.mp4": "video",
      "clip.webm": "video",
      "voice.m4a": "audio",
      "song.mp3": "audio",
      "rows.csv": "csv",
      "book.xlsx": "spreadsheet",
      "legacy.xls": "spreadsheet",
      "memo.docx": "docx",
      "deck.pptx": "pptx",
      "notes.txt": "text",
      "README.md": "markdown",
      "data.json": "text",
      "server.log": "text",
      "page.html": "html",
    });
  });

  it("falls back to the declared type when the name has no extension", () => {
    expect(attachmentPreview(file("scan", "application/pdf")).kind).toBe("pdf");
    expect(attachmentPreview(file("voice-note", "audio/ogg; codecs=opus")).kind).toBe("audio");
    expect(attachmentPreview(file("export", "text/csv")).kind).toBe("csv");
  });

  it("explains why unknown, legacy or oversized files only offer a download", () => {
    const unknown = attachmentPreview(file("blob.bin"));
    expect(unknown).toMatchObject({ kind: "none" });
    expect(unknown.kind === "none" && unknown.reason).toMatch(/can't be shown/);
    const legacy = attachmentPreview(file("old.doc", "application/msword"));
    expect(legacy.kind === "none" && legacy.reason).toMatch(/\.docx/);
    const huge = attachmentPreview(file("big.xlsx", "application/octet-stream", 80 * 1024 * 1024));
    expect(huge.kind === "none" && huge.reason).toMatch(/too large/);
    const empty = attachmentPreview(file("empty.pdf", "application/pdf", 0));
    expect(empty.kind === "none" && empty.reason).toMatch(/empty/);
  });

  it("streams large CSV and media without a size cap", () => {
    expect(attachmentPreview(file("huge.csv", "text/csv", 500 * 1024 * 1024)).kind).toBe("csv");
    expect(attachmentPreview(file("movie.mp4", "video/mp4", 2 * 1024 * 1024 * 1024)).kind).toBe("video");
  });
});

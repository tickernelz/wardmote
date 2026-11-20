export function isCsvFile(filename: string, contentType = "") {
  return /\.csv$/i.test(filename) || contentType.split(";")[0].trim().toLowerCase() === "text/csv";
}

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

/** Parse comma-separated records, preserving quoted newlines and escaped quotes. */
export function parseCsv(text: string): string[][] {
  const collector = new CsvRecordCollector(Number.POSITIVE_INFINITY);
  collector.push(text);
  collector.finish();
  if (collector.incomplete) throw new Error("A quoted field is incomplete. Switch to raw view to inspect the file.");
  return collector.rows;
}

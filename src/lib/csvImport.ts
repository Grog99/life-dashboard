import type { CurrencyCode, FinanceTransaction, Visibility } from "../advancedTypes";
import { parseMoneyToMinor } from "./money";

export interface CsvMapping {
  dateColumn: string;
  amountColumn: string;
  creditColumn?: string;
  titleColumn: string;
  merchantColumn?: string;
  categoryColumn?: string;
  dateFormat: "yyyy-MM-dd" | "dd.MM.yyyy" | "dd-MM-yyyy" | "dd/MM/yyyy";
}

export interface CsvPreview {
  headers: string[];
  rows: Record<string, string>[];
  delimiter: string;
  suggestedMapping: CsvMapping;
}

export interface CsvImportContext {
  accountId: string;
  currency: CurrencyCode;
  ownerId: string;
  visibility: Visibility;
}

export type CsvEncoding = "UTF-8" | "Windows-1250";

export interface CsvDecodeResult {
  text: string;
  encoding: CsvEncoding;
}

// Byte values 0x80-0xFF of Windows-1250 mapped to their Unicode code points. Used only as a
// fallback for runtimes without a built-in "windows-1250" TextDecoder label.
const WINDOWS_1250_HIGH_BYTES = [
  0x20ac, 0x0081, 0x201a, 0x0083, 0x201e, 0x2026, 0x2020, 0x2021, 0x0088, 0x2030, 0x0160, 0x2039,
  0x015a, 0x0164, 0x017d, 0x0179, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x0098, 0x2122, 0x0161, 0x203a, 0x015b, 0x0165, 0x017e, 0x017a, 0x00a0, 0x02c7, 0x02d8, 0x0141,
  0x00a4, 0x0104, 0x00a6, 0x00a7, 0x00a8, 0x00a9, 0x015e, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x017b,
  0x00b0, 0x00b1, 0x02db, 0x0142, 0x00b4, 0x00b5, 0x00b6, 0x00b7, 0x00b8, 0x0105, 0x015f, 0x00bb,
  0x013d, 0x02dd, 0x013e, 0x017c, 0x0154, 0x00c1, 0x00c2, 0x0102, 0x00c4, 0x0139, 0x0106, 0x00c7,
  0x010c, 0x00c9, 0x0118, 0x00cb, 0x011a, 0x00cd, 0x00ce, 0x010e, 0x0110, 0x0143, 0x0147, 0x00d3,
  0x00d4, 0x0150, 0x00d6, 0x00d7, 0x0158, 0x016e, 0x00da, 0x0170, 0x00dc, 0x00dd, 0x0162, 0x00df,
  0x0155, 0x00e1, 0x00e2, 0x0103, 0x00e4, 0x013a, 0x0107, 0x00e7, 0x010d, 0x00e9, 0x0119, 0x00eb,
  0x011b, 0x00ed, 0x00ee, 0x010f, 0x0111, 0x0144, 0x0148, 0x00f3, 0x00f4, 0x0151, 0x00f6, 0x00f7,
  0x0159, 0x016f, 0x00fa, 0x0171, 0x00fc, 0x00fd, 0x0163, 0x02d9,
];

function decodeWindows1250(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    result += String.fromCharCode(byte < 0x80 ? byte : WINDOWS_1250_HIGH_BYTES[byte - 0x80]);
  }
  return result;
}

/**
 * Polish bank exports are usually UTF-8, but many still export Windows-1250 (or the very
 * similar ISO-8859-2). We detect a UTF-8 BOM first, then try strict UTF-8 decoding, and only
 * fall back to Windows-1250 when the bytes aren't valid UTF-8.
 */
export function decodeCsvBytes(buffer: ArrayBuffer): CsvDecodeResult {
  const bytes = new Uint8Array(buffer);
  const hasUtf8Bom =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (hasUtf8Bom) {
    return { text: new TextDecoder("utf-8").decode(bytes), encoding: "UTF-8" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch {
    // Not valid UTF-8 - fall through to Windows-1250.
  }
  try {
    return { text: new TextDecoder("windows-1250").decode(bytes), encoding: "Windows-1250" };
  } catch {
    return { text: decodeWindows1250(bytes), encoding: "Windows-1250" };
  }
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      result.push(value.trim());
      value = "";
    } else {
      value += char;
    }
  }
  result.push(value.trim());
  return result;
}

export function detectDelimiter(headerLine: string): string {
  const candidates = [";", ",", "\t"];
  return candidates
    .map((delimiter) => ({ delimiter, count: splitCsvLine(headerLine, delimiter).length }))
    .sort((a, b) => b.count - a.count)[0].delimiter;
}

function findHeader(headers: string[], patterns: RegExp[], fallback = ""): string {
  return (
    headers.find((header) =>
      patterns.some((pattern) => pattern.test(header.toLocaleLowerCase("pl"))),
    ) ?? fallback
  );
}

export function previewCsv(text: string): CsvPreview {
  const clean = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const lines = clean.split("\n").filter((line) => line.trim());
  if (lines.length < 2) throw new Error("Plik musi zawierać nagłówek i co najmniej jeden wiersz");
  if (lines.length - 1 > 10_000)
    throw new Error("Jednorazowo można zaimportować do 10 000 operacji");
  const delimiter = detectDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter).map((header) =>
    header.replace(/^"|"$/g, "").trim(),
  );
  const rows = lines.slice(1).map((line) => {
    const values = splitCsvLine(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
  const creditPatterns = [/uznani/, /przychód/, /wpływ/];
  const dateColumn = findHeader(headers, [/data/, /date/], headers[0]);
  const amountColumn = findHeader(
    headers.filter(
      (header) => !creditPatterns.some((pattern) => pattern.test(header.toLocaleLowerCase("pl"))),
    ),
    [/kwota/, /amount/, /wartość/, /obciążenie/],
    headers[1] ?? headers[0],
  );
  const creditColumn = findHeader(headers, creditPatterns);
  const titleColumn = findHeader(
    headers,
    [/tytuł/, /opis/, /description/, /szczegóły/],
    headers[2] ?? headers[0],
  );
  const merchantColumn = findHeader(headers, [/kontrahent/, /odbiorca/, /nadawca/, /merchant/]);
  const categoryColumn = findHeader(headers, [/kategori/]);
  const sampleDate = rows[0]?.[dateColumn] ?? "";
  const dateFormat: CsvMapping["dateFormat"] = sampleDate.includes(".")
    ? "dd.MM.yyyy"
    : sampleDate.includes("/")
      ? "dd/MM/yyyy"
      : /^\d{2}-\d{2}-\d{4}/.test(sampleDate)
        ? "dd-MM-yyyy"
        : "yyyy-MM-dd";
  return {
    headers,
    rows,
    delimiter,
    suggestedMapping: {
      dateColumn,
      amountColumn,
      creditColumn: creditColumn || undefined,
      titleColumn,
      merchantColumn: merchantColumn || undefined,
      categoryColumn: categoryColumn || undefined,
      dateFormat,
    },
  };
}

function normalizeDate(value: string, format: CsvMapping["dateFormat"]): string {
  const source = value.trim().slice(0, 10);
  if (format === "yyyy-MM-dd") return source;
  const separator = format.includes(".") ? "." : format.includes("/") ? "/" : "-";
  const [day, month, year] = source.split(separator);
  return `${year}-${month?.padStart(2, "0")}-${day?.padStart(2, "0")}`;
}

export function fingerprintTransaction(parts: string[]): string {
  const source = parts.join("|").trim().toLocaleLowerCase("pl");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `csv-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function mapCsvRows(
  preview: CsvPreview,
  mapping: CsvMapping,
  context: CsvImportContext,
): Array<Omit<FinanceTransaction, "id" | "updatedAt">> {
  const occurrences = new Map<string, number>();
  return preview.rows
    .map((row) => {
      const bookedOn = normalizeDate(row[mapping.dateColumn] ?? "", mapping.dateFormat);
      const debitMinor = parseMoneyToMinor(row[mapping.amountColumn] ?? "");
      const creditMinor = mapping.creditColumn
        ? parseMoneyToMinor(row[mapping.creditColumn] ?? "")
        : 0;
      const amountMinor = !mapping.creditColumn
        ? debitMinor
        : creditMinor !== 0
          ? Math.abs(creditMinor)
          : -Math.abs(debitMinor);
      const title = (row[mapping.titleColumn] || "Importowana transakcja").trim();
      const merchant = (mapping.merchantColumn ? row[mapping.merchantColumn] : "")?.trim() || title;
      const category =
        (mapping.categoryColumn ? row[mapping.categoryColumn] : "")?.trim() || "Do przypisania";
      const rowContent = preview.headers.map((header) => row[header] ?? "").join("|");
      const baseFingerprint = fingerprintTransaction([
        context.accountId,
        bookedOn,
        String(amountMinor),
        merchant,
        title,
        rowContent,
      ]);
      const occurrence = occurrences.get(baseFingerprint) ?? 0;
      occurrences.set(baseFingerprint, occurrence + 1);
      return {
        accountId: context.accountId,
        bookedOn,
        amountMinor,
        currency: context.currency,
        merchant,
        title,
        category,
        source: "csv" as const,
        fingerprint: fingerprintTransaction([baseFingerprint, String(occurrence)]),
        ownerId: context.ownerId,
        visibility: context.visibility,
      };
    })
    .filter(
      (transaction) =>
        /^\d{4}-\d{2}-\d{2}$/.test(transaction.bookedOn) &&
        transaction.amountMinor !== 0 &&
        transaction.title.length > 0,
    );
}

import { describe, expect, it } from "vitest";
import { decodeCsvBytes, mapCsvRows, previewCsv } from "./csvImport";

function encodeWindows1250(text: string): Uint8Array {
  const reverse = new Map<string, number>();
  const decoder = new TextDecoder("windows-1250");
  for (let byte = 0; byte <= 0xff; byte += 1) {
    reverse.set(decoder.decode(new Uint8Array([byte])), byte);
  }
  return new Uint8Array(Array.from(text, (char) => reverse.get(char) ?? char.charCodeAt(0)));
}

describe("CSV finance import", () => {
  const csv = [
    "Data;Kwota;Kontrahent;Tytuł",
    '10.07.2026;-123,45;Sklep ABC;"Zakupy, dom"',
    "11.07.2026;2500,00;Pracodawca;Wynagrodzenie",
  ].join("\n");

  it("wykrywa separator i mapowanie polskich nagłówków", () => {
    const preview = previewCsv(csv);
    expect(preview.delimiter).toBe(";");
    expect(preview.suggestedMapping.dateColumn).toBe("Data");
    expect(preview.suggestedMapping.amountColumn).toBe("Kwota");
  });

  it("normalizuje kwoty, daty i tworzy stabilny fingerprint", () => {
    const preview = previewCsv(csv);
    const transactions = mapCsvRows(preview, preview.suggestedMapping, {
      accountId: "account-1",
      currency: "PLN",
      ownerId: "me",
      visibility: "private",
    });
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toMatchObject({
      bookedOn: "2026-07-10",
      amountMinor: -12345,
      merchant: "Sklep ABC",
    });
    expect(transactions[0].fingerprint).toBeTruthy();
  });

  it("keeps all rows for import while the UI can limit only its preview", () => {
    const rows = Array.from({ length: 75 }, (_, index) =>
      `2026-07-${String((index % 28) + 1).padStart(2, "0")};-${index + 1},00;Operacja ${index + 1}`,
    );
    const parsed = previewCsv(["Data;Kwota;Opis", ...rows].join("\n"));

    expect(parsed.rows).toHaveLength(75);
  });

  it("rozróżnia dwie identyczne płatności, ale zachowuje fingerprint przy ponownym imporcie", () => {
    const parsed = previewCsv(["Data;Kwota;Opis", "2026-07-10;-20,00;Bilet", "2026-07-10;-20,00;Bilet"].join("\n"));
    const context = { accountId: "account-1", currency: "PLN" as const, ownerId: "me", visibility: "private" as const };
    const first = mapCsvRows(parsed, parsed.suggestedMapping, context);
    const second = mapCsvRows(parsed, parsed.suggestedMapping, context);
    expect(first[0].fingerprint).not.toBe(first[1].fingerprint);
    expect(second.map((item) => item.fingerprint)).toEqual(first.map((item) => item.fingerprint));
  });

  it("wykrywa i dekoduje wyciąg zapisany w Windows-1250", () => {
    const csvText = ["Data;Kwota;Kontrahent;Tytuł", "10.07.2026;-12,50;Żabka;Zakupy spożywcze"].join("\n");
    const bytes = encodeWindows1250(csvText);
    const decoded = decodeCsvBytes(bytes.buffer as ArrayBuffer);

    expect(decoded.encoding).toBe("Windows-1250");
    expect(decoded.text).toBe(csvText);

    const preview = previewCsv(decoded.text);
    expect(preview.suggestedMapping.titleColumn).toBe("Tytuł");
    expect(preview.rows[0].Kontrahent).toBe("Żabka");
  });

  it("uzupełnia domyślny tytuł, gdy komórka tytułu jest pustym ciągiem (np. prowizja)", () => {
    const parsed = previewCsv(["Data;Kwota;Tytuł", "2026-07-10;-5,00;"].join("\n"));
    const transactions = mapCsvRows(parsed, parsed.suggestedMapping, {
      accountId: "account-1",
      currency: "PLN",
      ownerId: "me",
      visibility: "private",
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0].title).toBe("Importowana transakcja");
  });

  it("łączy oddzielne kolumny obciążenia i uznania w jedną podpisaną kwotę", () => {
    const parsed = previewCsv(
      [
        "Data;Opis;Kwota obciążenia;Kwota uznania",
        "2026-07-10;Zakupy;50,00;",
        "2026-07-11;Wypłata wynagrodzenia;;3000,00",
      ].join("\n"),
    );
    expect(parsed.suggestedMapping.amountColumn).toBe("Kwota obciążenia");
    expect(parsed.suggestedMapping.creditColumn).toBe("Kwota uznania");

    const transactions = mapCsvRows(parsed, parsed.suggestedMapping, {
      accountId: "account-1",
      currency: "PLN",
      ownerId: "me",
      visibility: "private",
    });
    expect(transactions).toHaveLength(2);
    expect(transactions[0].amountMinor).toBe(-5000);
    expect(transactions[1].amountMinor).toBe(300000);
  });
});

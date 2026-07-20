import { Check, CircleAlert, FileSpreadsheet, Landmark, ShieldCheck } from "lucide-react";
import type { CsvEncoding, CsvMapping, CsvPreview } from "../../../lib/csvImport";
import type { FinanceAccount, FinanceTransaction } from "../../../financeTypes";
import { formatMoney } from "../../../lib/money";
import { formatDate } from "../financeConstants";

type CsvRow = {
  transaction: Omit<FinanceTransaction, "id" | "updatedAt" | "version">;
  duplicate: boolean;
};

interface CsvImportReviewProps {
  csvPreview: CsvPreview;
  csvMapping: CsvMapping;
  csvFileName: string;
  csvEncoding: CsvEncoding | null;
  onResetCsvImport: () => void;
  onUpdateMapping: <Key extends keyof CsvMapping>(key: Key, value: CsvMapping[Key]) => void;
  csvNewCount: number;
  csvDuplicateCount: number;
  csvInvalidCount: number;
  selectedImportAccount: FinanceAccount | undefined;
  csvRowsWithStatus: CsvRow[];
  hideAmounts: boolean;
  onClose: () => void;
  onImport: () => void;
}

export function CsvImportReview({
  csvPreview,
  csvMapping,
  csvFileName,
  csvEncoding,
  onResetCsvImport,
  onUpdateMapping,
  csvNewCount,
  csvDuplicateCount,
  csvInvalidCount,
  selectedImportAccount,
  csvRowsWithStatus,
  hideAmounts,
  onClose,
  onImport,
}: CsvImportReviewProps) {
  return (
    <div className="finance-import-review">
      <div className="finance-import-filebar">
        <span className="finance-import-filebar__icon">
          <FileSpreadsheet size={19} />
        </span>
        <div>
          <strong>{csvFileName}</strong>
          <span>
            {csvPreview.rows.length} odczytanych wierszy · separator{" "}
            {csvPreview.delimiter === "\t" ? "tabulator" : `„${csvPreview.delimiter}”`} · kodowanie{" "}
            {csvEncoding ?? "UTF-8"}
          </span>
        </div>
        <button className="button button--ghost button--small" type="button" onClick={onResetCsvImport}>
          Zmień plik
        </button>
      </div>

      <div className="finance-import-mapping">
        <div className="finance-import-subheading">
          <div>
            <strong>Mapowanie kolumn</strong>
            <span>Sprawdź, czy pola zostały rozpoznane poprawnie.</span>
          </div>
          <span className="finance-auto-badge">
            <Check size={12} /> Wykryto automatycznie
          </span>
        </div>
        <div className="finance-mapping-grid">
          <label className="field">
            <span>Data</span>
            <select
              value={csvMapping.dateColumn}
              onChange={(event) => onUpdateMapping("dateColumn", event.target.value)}
            >
              {csvPreview.headers.map((header) => (
                <option key={header}>{header}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Format daty</span>
            <select
              value={csvMapping.dateFormat}
              onChange={(event) =>
                onUpdateMapping("dateFormat", event.target.value as CsvMapping["dateFormat"])
              }
            >
              <option value="yyyy-MM-dd">RRRR-MM-DD</option>
              <option value="dd.MM.yyyy">DD.MM.RRRR</option>
              <option value="dd-MM-yyyy">DD-MM-RRRR</option>
              <option value="dd/MM/yyyy">DD/MM/RRRR</option>
            </select>
          </label>
          <label className="field">
            <span>Kwota</span>
            <select
              value={csvMapping.amountColumn}
              onChange={(event) => onUpdateMapping("amountColumn", event.target.value)}
            >
              {csvPreview.headers.map((header) => (
                <option key={header}>{header}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Tytuł</span>
            <select
              value={csvMapping.titleColumn}
              onChange={(event) => onUpdateMapping("titleColumn", event.target.value)}
            >
              {csvPreview.headers.map((header) => (
                <option key={header}>{header}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Kontrahent</span>
            <select
              value={csvMapping.merchantColumn ?? ""}
              onChange={(event) => onUpdateMapping("merchantColumn", event.target.value || undefined)}
            >
              <option value="">Użyj tytułu</option>
              {csvPreview.headers.map((header) => (
                <option key={header}>{header}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Kategoria</span>
            <select
              value={csvMapping.categoryColumn ?? ""}
              onChange={(event) => onUpdateMapping("categoryColumn", event.target.value || undefined)}
            >
              <option value="">Do przypisania</option>
              {csvPreview.headers.map((header) => (
                <option key={header}>{header}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="finance-import-stats" aria-label="Wynik walidacji importu">
        <div className="is-new">
          <span>
            <Check size={15} />
          </span>
          <strong>{csvNewCount}</strong>
          <small>nowe</small>
        </div>
        <div className="is-duplicate">
          <span>
            <ShieldCheck size={15} />
          </span>
          <strong>{csvDuplicateCount}</strong>
          <small>duplikaty</small>
        </div>
        <div className="is-invalid">
          <span>
            <CircleAlert size={15} />
          </span>
          <strong>{csvInvalidCount}</strong>
          <small>pominięte</small>
        </div>
        <div>
          <span>
            <Landmark size={15} />
          </span>
          <strong>{selectedImportAccount?.name ?? "—"}</strong>
          <small>rachunek docelowy</small>
        </div>
      </div>

      {csvRowsWithStatus.length ? (
        <div className="finance-import-preview">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Data</th>
                <th>Transakcja</th>
                <th>Kategoria</th>
                <th>Kwota</th>
              </tr>
            </thead>
            <tbody>
              {csvRowsWithStatus.slice(0, 50).map(({ transaction, duplicate }, index) => (
                <tr
                  className={duplicate ? "is-duplicate" : ""}
                  key={`${transaction.fingerprint}-${index}`}
                >
                  <td>
                    <span className={`finance-import-status${duplicate ? " is-duplicate" : ""}`}>
                      {duplicate ? <ShieldCheck size={12} /> : <Check size={12} />}
                      {duplicate ? "Duplikat" : "Nowa"}
                    </span>
                  </td>
                  <td>{formatDate(transaction.bookedOn, true)}</td>
                  <td>
                    <strong>{transaction.title}</strong>
                    <small>{transaction.merchant}</small>
                  </td>
                  <td>{transaction.category}</td>
                  <td className={transaction.amountMinor > 0 ? "is-positive" : ""}>
                    {formatMoney(transaction.amountMinor, transaction.currency, hideAmounts)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {csvRowsWithStatus.length > 50 && (
            <p className="finance-form-hint">
              Podgląd pokazuje pierwsze 50 z {csvRowsWithStatus.length} poprawnych operacji. Import
              obejmie wszystkie.
            </p>
          )}
        </div>
      ) : (
        <div className="finance-import-error">
          <CircleAlert size={17} />
          <span>Mapowanie nie daje żadnych poprawnych transakcji. Sprawdź datę i kwotę.</span>
        </div>
      )}

      <div className="modal-actions finance-import-actions">
        <span className="finance-form-hint">
          <ShieldCheck size={14} /> Duplikaty zostaną automatycznie pominięte
        </span>
        <div>
          <button className="button button--ghost" type="button" onClick={onClose}>
            Anuluj
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={!csvNewCount}
            onClick={onImport}
          >
            Importuj {csvNewCount} {csvNewCount === 1 ? "transakcję" : "transakcji"}
          </button>
        </div>
      </div>
    </div>
  );
}

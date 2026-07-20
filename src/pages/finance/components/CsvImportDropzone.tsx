import type { ChangeEvent, DragEvent, RefObject } from "react";
import { Check, CircleAlert, FileSpreadsheet, ShieldCheck, Upload } from "lucide-react";
import type { FinanceAccount } from "../../../financeTypes";

interface CsvImportDropzoneProps {
  importAccountId: string;
  setImportAccountId: (value: string) => void;
  activeAccounts: FinanceAccount[];
  csvReading: boolean;
  csvError: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileInput: (event: ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: DragEvent<HTMLLabelElement>) => void;
}

export function CsvImportDropzone({
  importAccountId,
  setImportAccountId,
  activeAccounts,
  csvReading,
  csvError,
  fileInputRef,
  onFileInput,
  onDrop,
}: CsvImportDropzoneProps) {
  return (
    <div className="finance-import-start">
      <label className="field">
        <span>Rachunek docelowy</span>
        <select value={importAccountId} onChange={(event) => setImportAccountId(event.target.value)}>
          <option value="" disabled>
            Wybierz rachunek
          </option>
          {activeAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name} · {account.currency}
            </option>
          ))}
        </select>
      </label>
      <label
        className={`finance-dropzone${csvReading ? " is-reading" : ""}${!importAccountId ? " is-disabled" : ""}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          disabled={!importAccountId || csvReading}
          onChange={onFileInput}
        />
        <span className="finance-dropzone__icon">
          {csvReading ? <FileSpreadsheet size={25} /> : <Upload size={25} />}
        </span>
        <strong>{csvReading ? "Odczytuję plik…" : "Upuść plik CSV tutaj"}</strong>
        <span>albo kliknij, aby wybrać plik z banku</span>
        <small>UTF-8 / Windows-1250 · maks. 5 MB · do 10 000 operacji</small>
      </label>
      {csvError && (
        <div className="finance-import-error" role="alert">
          <CircleAlert size={17} />
          <span>{csvError}</span>
        </div>
      )}
      <div className="finance-import-assurances">
        <div>
          <ShieldCheck size={17} />
          <span>
            <strong>Bez logowania do banku</strong>
            <small>Wybierasz wyłącznie pobrany wyciąg.</small>
          </span>
        </div>
        <div>
          <Check size={17} />
          <span>
            <strong>Podgląd przed zapisem</strong>
            <small>Nic nie trafi do historii bez zatwierdzenia.</small>
          </span>
        </div>
        <div>
          <FileSpreadsheet size={17} />
          <span>
            <strong>Kontrola duplikatów</strong>
            <small>Ponowny import nie dubluje operacji.</small>
          </span>
        </div>
      </div>
    </div>
  );
}

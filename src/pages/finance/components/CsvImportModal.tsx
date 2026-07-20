import type { ChangeEvent, DragEvent, RefObject } from "react";
import { Modal } from "../../../components/Modal";
import type { CsvEncoding, CsvMapping, CsvPreview } from "../../../lib/csvImport";
import type { FinanceAccount, FinanceTransaction } from "../../../financeTypes";
import { CsvImportDropzone } from "./CsvImportDropzone";
import { CsvImportReview } from "./CsvImportReview";

type CsvRow = {
  transaction: Omit<FinanceTransaction, "id" | "updatedAt" | "version">;
  duplicate: boolean;
};

interface CsvImportModalProps {
  open: boolean;
  onClose: () => void;
  csvPreview: CsvPreview | null;
  csvMapping: CsvMapping | null;
  csvFileName: string;
  csvEncoding: CsvEncoding | null;
  csvError: string;
  csvReading: boolean;
  importAccountId: string;
  setImportAccountId: (value: string) => void;
  activeAccounts: FinanceAccount[];
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileInput: (event: ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: DragEvent<HTMLLabelElement>) => void;
  onResetCsvImport: () => void;
  onUpdateMapping: <Key extends keyof CsvMapping>(key: Key, value: CsvMapping[Key]) => void;
  csvRowsWithStatus: CsvRow[];
  csvNewCount: number;
  csvDuplicateCount: number;
  csvInvalidCount: number;
  selectedImportAccount: FinanceAccount | undefined;
  hideAmounts: boolean;
  onImport: () => void;
}

// Orkiestruje dwa etapy importu CSV (start vs review) — patrz docs/plans/podzial-duzych-stron.md
// "FinancePage" > CsvImportModal.
export function CsvImportModal({
  open,
  onClose,
  csvPreview,
  csvMapping,
  csvFileName,
  csvEncoding,
  csvError,
  csvReading,
  importAccountId,
  setImportAccountId,
  activeAccounts,
  fileInputRef,
  onFileInput,
  onDrop,
  onResetCsvImport,
  onUpdateMapping,
  csvRowsWithStatus,
  csvNewCount,
  csvDuplicateCount,
  csvInvalidCount,
  selectedImportAccount,
  hideAmounts,
  onImport,
}: CsvImportModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={csvPreview ? "Sprawdź import" : "Importuj wyciąg CSV"}
      eyebrow="Bezpieczny import"
      size="large"
    >
      {!csvPreview ? (
        <CsvImportDropzone
          importAccountId={importAccountId}
          setImportAccountId={setImportAccountId}
          activeAccounts={activeAccounts}
          csvReading={csvReading}
          csvError={csvError}
          fileInputRef={fileInputRef}
          onFileInput={onFileInput}
          onDrop={onDrop}
        />
      ) : csvMapping ? (
        <CsvImportReview
          csvPreview={csvPreview}
          csvMapping={csvMapping}
          csvFileName={csvFileName}
          csvEncoding={csvEncoding}
          onResetCsvImport={onResetCsvImport}
          onUpdateMapping={onUpdateMapping}
          csvNewCount={csvNewCount}
          csvDuplicateCount={csvDuplicateCount}
          csvInvalidCount={csvInvalidCount}
          selectedImportAccount={selectedImportAccount}
          csvRowsWithStatus={csvRowsWithStatus}
          hideAmounts={hideAmounts}
          onClose={onClose}
          onImport={onImport}
        />
      ) : null}
    </Modal>
  );
}

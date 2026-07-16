// Typy modułu Finanse. Od docs/plans/model-synchronizacji-danych.md dane finansowe nie są
// już częścią dokumentu JSONB (AdvancedData) — mają własne znormalizowane tabele SQL
// (server/migrations/006_finance_normalized.sql) z optymistyczną współbieżnością per rekord
// (pole `version`). Ten plik jest wspólnym źródłem prawdy dla backendu i frontendu Finansów.

export type Visibility = "private" | "household";
export type CurrencyCode = "PLN" | "EUR" | "USD" | "GBP";

export interface SharedMeta {
  ownerId: string;
  visibility: Visibility;
}

export interface FinanceAccount extends SharedMeta {
  id: string;
  name: string;
  type: "checking" | "savings" | "cash" | "credit";
  balanceMinor: number;
  currency: CurrencyCode;
  color: string;
  archived: boolean;
  version: number;
  updatedAt: string;
}

export interface FinanceTransaction extends SharedMeta {
  id: string;
  accountId: string;
  bookedOn: string;
  amountMinor: number;
  currency: CurrencyCode;
  merchant: string;
  title: string;
  category: string;
  source: "manual" | "csv" | "subscription" | "trip" | "car";
  fingerprint?: string;
  notes?: string;
  version: number;
  updatedAt: string;
}

// FinanceBudget nie ma SharedMeta — budżety są zawsze wspólne dla gospodarstwa.
export interface FinanceBudget {
  id: string;
  category: string;
  limitMinor: number;
  currency: CurrencyCode;
  color: string;
  version: number;
  updatedAt: string;
}

export interface SavingsGoal extends SharedMeta {
  id: string;
  name: string;
  targetMinor: number;
  savedMinor: number;
  currency: CurrencyCode;
  deadline?: string;
  version: number;
  updatedAt: string;
}

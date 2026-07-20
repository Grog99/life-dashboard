import {
  Bone,
  ReceiptText,
  Scissors,
  ShoppingBag,
  Syringe,
  type LucideIcon,
} from "lucide-react";
import { differenceInYears, parseISO } from "date-fns";
import type { FishStockEntry, PetExpense, PetKind, PetVisit, Visibility } from "../../advancedTypes";
import { dateKey } from "../../lib/date";

export type ExpenseFilter = "all" | PetExpense["type"];

export interface FishRow {
  id: string;
  species: string;
  count: string;
}

export interface PetDraft {
  name: string;
  kind: PetKind;
  species: string;
  birthDate: string;
  notes: string;
  color: string;
  visibility: Visibility;
  fishStock: FishRow[];
}

export interface ExpenseDraft {
  date: string;
  type: PetExpense["type"];
  title: string;
  amount: string;
  visibility: Visibility;
}

export interface VisitDraft {
  title: string;
  clinician: string;
  specialty: string;
  date: string;
  time: string;
  location: string;
  notes: string;
  visibility: Visibility;
  status: PetVisit["status"];
}

export const kindLabels: Record<PetKind, string> = {
  rabbit: "Królik",
  dog: "Pies",
  cat: "Kot",
  guinea_pig: "Świnka morska",
  aquarium: "Akwarium",
  other: "Inne",
};

export const expenseLabels: Record<PetExpense["type"], string> = {
  food: "Jedzenie",
  vet: "Weterynarz",
  accessories: "Akcesoria/zabawki",
  grooming: "Pielęgnacja",
  other: "Inne",
};

export const expenseIcons: Record<PetExpense["type"], LucideIcon> = {
  food: Bone,
  vet: Syringe,
  accessories: ShoppingBag,
  grooming: Scissors,
  other: ReceiptText,
};

export const emptyPetDraft = (): PetDraft => ({
  name: "",
  kind: "rabbit",
  species: "",
  birthDate: dateKey(),
  notes: "",
  color: "#b17a42",
  visibility: "household",
  fishStock: [],
});

export const emptyExpenseDraft = (): ExpenseDraft => ({
  date: dateKey(),
  type: "food",
  title: expenseLabels.food,
  amount: "",
  visibility: "household",
});

export const emptyVisitDraft = (): VisitDraft => ({
  title: "",
  clinician: "",
  specialty: "",
  date: dateKey(),
  time: "10:00",
  location: "",
  notes: "",
  visibility: "household",
  status: "scheduled",
});

export function petAgeLabel(birthDate?: string): string {
  if (!birthDate) return "Wiek nieznany";
  const years = differenceInYears(new Date(), parseISO(birthDate));
  if (years <= 0) return "Poniżej roku";
  return `${years} ${years === 1 ? "rok" : years < 5 ? "lata" : "lat"}`;
}

export function fishStockCount(fishStock?: FishStockEntry[]): number {
  return (fishStock ?? []).reduce((sum, entry) => sum + entry.count, 0);
}

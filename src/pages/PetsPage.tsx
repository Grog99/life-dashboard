import { PawPrint, Plus } from "lucide-react";
import { format } from "date-fns";
import { useMemo, useState, type FormEvent } from "react";
import type { Pet, PetExpense, PetVisit } from "../advancedTypes";
import { dateKey } from "../lib/date";
import { generateId } from "../lib/id";
import { parseMoneyToMinor } from "../lib/money";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { usePetsStore } from "../store/usePetsStore";
import { useServerAuth } from "../server/AuthGate";
import {
  emptyExpenseDraft,
  emptyPetDraft,
  emptyVisitDraft,
  expenseLabels,
  type ExpenseDraft,
  type ExpenseFilter,
  type FishRow,
  type PetDraft,
  type VisitDraft,
} from "./pets/petConstants";
import { PetStrip } from "./pets/components/PetStrip";
import { PetSummaryCards } from "./pets/components/PetSummaryCards";
import { PetExpensesPanel } from "./pets/components/PetExpensesPanel";
import { PetProfileCard } from "./pets/components/PetProfileCard";
import { PetVisitsPanel } from "./pets/components/PetVisitsPanel";
import { PetFormModal } from "./pets/components/PetFormModal";
import { PetExpenseFormModal } from "./pets/components/PetExpenseFormModal";
import { PetVisitFormModal } from "./pets/components/PetVisitFormModal";
import "../styles/modules.css";
import "../styles/pets.css";

interface PetsPageProps {
  onToast: (message: string) => void;
}

export function PetsPage({ onToast }: PetsPageProps) {
  const { snapshot } = useServerAuth();
  const currentOwnerId = snapshot?.user.id ?? "me";
  const pets = usePetsStore((state) => state.pets);
  const petExpenses = usePetsStore((state) => state.petExpenses);
  const petVisits = usePetsStore((state) => state.petVisits);
  const hideAmounts = useAdvancedStore((state) => state.hideAmounts);
  const addPet = usePetsStore((state) => state.addPet);
  const updatePet = usePetsStore((state) => state.updatePet);
  const deletePet = usePetsStore((state) => state.deletePet);
  const addPetExpense = usePetsStore((state) => state.addPetExpense);
  const deletePetExpense = usePetsStore((state) => state.deletePetExpense);
  const addPetVisit = usePetsStore((state) => state.addPetVisit);
  const updatePetVisit = usePetsStore((state) => state.updatePetVisit);
  const deletePetVisit = usePetsStore((state) => state.deletePetVisit);
  const togglePetVisitCompleted = usePetsStore((state) => state.togglePetVisitCompleted);

  const [selectedPetId, setSelectedPetId] = useState(pets[0]?.id ?? "");
  const [petModalOpen, setPetModalOpen] = useState(false);
  const [editingPet, setEditingPet] = useState<Pet | null>(null);
  const [petDraft, setPetDraft] = useState<PetDraft>(emptyPetDraft);
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [expenseDraft, setExpenseDraft] = useState<ExpenseDraft>(emptyExpenseDraft);
  const [expenseFilter, setExpenseFilter] = useState<ExpenseFilter>("all");
  const [visitModalOpen, setVisitModalOpen] = useState(false);
  const [visitDraft, setVisitDraft] = useState<VisitDraft>(emptyVisitDraft);
  const [editingVisit, setEditingVisit] = useState<PetVisit | null>(null);

  const selectedPet = pets.find((pet) => pet.id === selectedPetId) ?? pets[0];
  const isAquarium = selectedPet?.kind === "aquarium";

  const selectedExpenses = useMemo(
    () =>
      petExpenses
        .filter((expense) => expense.petId === selectedPet?.id)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [petExpenses, selectedPet?.id],
  );
  const visibleExpenses = selectedExpenses.filter(
    (expense) => expenseFilter === "all" || expense.type === expenseFilter,
  );
  const selectedVisits = useMemo(
    () =>
      petVisits
        .filter((visit) => visit.petId === selectedPet?.id)
        .sort((a, b) => {
          const statusOrder = { scheduled: 0, completed: 1, cancelled: 2 };
          return (
            statusOrder[a.status] - statusOrder[b.status] ||
            `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)
          );
        }),
    [petVisits, selectedPet?.id],
  );
  const nextVisit = selectedVisits.find((visit) => visit.status === "scheduled");

  const monthPrefix = format(new Date(), "yyyy-MM");
  const monthlyCost = selectedExpenses
    .filter((expense) => expense.date.startsWith(monthPrefix))
    .reduce((sum, expense) => sum + expense.amountMinor, 0);
  const monthCount = selectedExpenses.filter((expense) =>
    expense.date.startsWith(monthPrefix),
  ).length;

  const openPetCreate = () => {
    setEditingPet(null);
    setPetDraft(emptyPetDraft());
    setPetModalOpen(true);
  };

  const openPetEdit = (pet: Pet) => {
    setEditingPet(pet);
    setPetDraft({
      name: pet.name,
      kind: pet.kind,
      species: pet.species ?? "",
      birthDate: pet.birthDate ?? dateKey(),
      notes: pet.notes ?? "",
      color: pet.color,
      visibility: pet.visibility,
      fishStock: (pet.fishStock ?? []).map((entry) => ({
        id: entry.id,
        species: entry.species,
        count: String(entry.count),
      })),
    });
    setPetModalOpen(true);
  };

  const savePet = (event: FormEvent) => {
    event.preventDefault();
    if (!petDraft.name.trim()) {
      onToast("Podaj imię lub nazwę profilu");
      return;
    }
    const kindIsAquarium = petDraft.kind === "aquarium";
    const fishStock = kindIsAquarium
      ? petDraft.fishStock
          .filter((row) => row.species.trim())
          .map((row) => ({
            id: row.id,
            species: row.species.trim(),
            count: Math.max(0, Number.parseInt(row.count, 10) || 0),
          }))
      : undefined;
    const data = {
      name: petDraft.name.trim(),
      kind: petDraft.kind,
      color: petDraft.color,
      species: kindIsAquarium ? undefined : petDraft.species.trim() || undefined,
      birthDate: kindIsAquarium ? undefined : petDraft.birthDate || undefined,
      fishStock,
      notes: petDraft.notes.trim() || undefined,
      visibility: petDraft.visibility,
    };
    if (editingPet) {
      updatePet(editingPet.id, data);
      onToast("Profil zwierzęcia został zaktualizowany");
    } else {
      const id = addPet({ ...data, ownerId: currentOwnerId });
      setSelectedPetId(id);
      onToast("Profil zwierzęcia został dodany");
    }
    setPetModalOpen(false);
  };

  const removePet = (pet: Pet) => {
    if (!window.confirm(`Usunąć profil „${pet.name}” razem z jego wydatkami i wizytami?`)) return;
    deletePet(pet.id);
    if (selectedPetId === pet.id) setSelectedPetId("");
    onToast("Profil zwierzęcia został usunięty");
  };

  const addFishRow = () => {
    setPetDraft((prev) => ({
      ...prev,
      fishStock: [...prev.fishStock, { id: generateId(), species: "", count: "1" }],
    }));
  };

  const updateFishRow = (id: string, changes: Partial<FishRow>) => {
    setPetDraft((prev) => ({
      ...prev,
      fishStock: prev.fishStock.map((row) => (row.id === id ? { ...row, ...changes } : row)),
    }));
  };

  const removeFishRow = (id: string) => {
    setPetDraft((prev) => ({ ...prev, fishStock: prev.fishStock.filter((row) => row.id !== id) }));
  };

  const openExpenseCreate = (type: PetExpense["type"] = "food") => {
    if (!selectedPet) {
      openPetCreate();
      return;
    }
    setExpenseDraft({ ...emptyExpenseDraft(), type, title: expenseLabels[type] });
    setExpenseModalOpen(true);
  };

  const saveExpense = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPet) return;
    const amountMinor = parseMoneyToMinor(expenseDraft.amount);
    if (!expenseDraft.title.trim() || amountMinor <= 0) {
      onToast("Podaj opis i poprawną kwotę wydatku");
      return;
    }
    addPetExpense({
      petId: selectedPet.id,
      date: expenseDraft.date,
      type: expenseDraft.type,
      amountMinor,
      title: expenseDraft.title.trim(),
      ownerId: currentOwnerId,
      visibility: expenseDraft.visibility,
    });
    setExpenseModalOpen(false);
    onToast("Wydatek został zapisany");
  };

  const removeExpense = (expense: PetExpense) => {
    if (!window.confirm(`Usunąć wpis „${expense.title}”?`)) return;
    deletePetExpense(expense.id);
    onToast("Wydatek został usunięty");
  };

  const openVisitCreate = () => {
    if (!selectedPet) {
      openPetCreate();
      return;
    }
    setEditingVisit(null);
    setVisitDraft(emptyVisitDraft());
    setVisitModalOpen(true);
  };

  const openVisitEdit = (visit: PetVisit) => {
    setEditingVisit(visit);
    setVisitDraft({
      title: visit.title,
      clinician: visit.clinician,
      specialty: visit.specialty ?? "",
      date: visit.date,
      time: visit.time,
      location: visit.location ?? "",
      notes: visit.notes ?? "",
      visibility: visit.visibility,
      status: visit.status,
    });
    setVisitModalOpen(true);
  };

  const saveVisit = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPet) return;
    if (!visitDraft.title.trim() || !visitDraft.clinician.trim()) {
      onToast("Podaj nazwę wizyty i weterynarza lub placówkę");
      return;
    }
    const data = {
      title: visitDraft.title.trim(),
      clinician: visitDraft.clinician.trim(),
      specialty: visitDraft.specialty.trim() || undefined,
      date: visitDraft.date,
      time: visitDraft.time,
      location: visitDraft.location.trim() || undefined,
      status: visitDraft.status,
      notes: visitDraft.notes.trim() || undefined,
      visibility: visitDraft.visibility,
    };
    if (editingVisit) {
      updatePetVisit(editingVisit.id, data);
      onToast("Zmiany w wizycie zostały zapisane");
    } else {
      addPetVisit({ ...data, petId: selectedPet.id, ownerId: currentOwnerId });
      onToast("Wizyta została zapisana");
    }
    setVisitModalOpen(false);
  };

  const removeVisit = (visit: PetVisit) => {
    if (!window.confirm(`Usunąć wizytę „${visit.title}”?`)) return;
    deletePetVisit(visit.id);
    onToast("Wizyta została usunięta");
  };

  return (
    <div className="life-module-page page-enter">
      <header className="page-header life-module-header">
        <div>
          <span className="page-eyebrow">Zwierzęta pod jednym dachem</span>
          <h1>Zwierzęta</h1>
          <p>
            Profile, wydatki i wizyty u weterynarza — jedno miejsce zamiast rozproszonych notatek.
          </p>
        </div>
        <button
          className="button button--primary"
          type="button"
          onClick={() => openExpenseCreate("food")}
        >
          <Plus size={17} /> Dodaj wydatek
        </button>
      </header>

      <PetStrip
        pets={pets}
        selectedPetId={selectedPet?.id}
        onSelect={setSelectedPetId}
        onAddPet={openPetCreate}
      />

      {selectedPet ? (
        <>
          <PetSummaryCards
            selectedPet={selectedPet}
            isAquarium={isAquarium}
            monthlyCost={monthlyCost}
            monthCount={monthCount}
            nextVisit={nextVisit}
            hideAmounts={hideAmounts}
          />

          <div className="car-dashboard-grid">
            <div className="car-dashboard-main">
              <PetExpensesPanel
                visibleExpenses={visibleExpenses}
                expenseFilter={expenseFilter}
                onFilterChange={setExpenseFilter}
                hideAmounts={hideAmounts}
                onAddExpense={() => openExpenseCreate("other")}
                onRemoveExpense={removeExpense}
              />
            </div>

            <aside className="car-dashboard-side">
              <PetProfileCard
                selectedPet={selectedPet}
                isAquarium={isAquarium}
                onEdit={() => openPetEdit(selectedPet)}
                onRemove={() => removePet(selectedPet)}
              />

              <PetVisitsPanel
                selectedVisits={selectedVisits}
                onToggle={togglePetVisitCompleted}
                onEdit={openVisitEdit}
                onRemove={removeVisit}
                onAdd={openVisitCreate}
              />
            </aside>
          </div>
        </>
      ) : (
        <section className="panel module-panel module-empty module-empty--large">
          <PawPrint size={29} />
          <strong>Brak profili zwierząt</strong>
          <span>Dodaj pierwsze zwierzę albo akwarium, aby zacząć śledzić koszty i wizyty.</span>
          <button className="button button--primary" type="button" onClick={openPetCreate}>
            <Plus size={16} /> Dodaj zwierzę
          </button>
        </section>
      )}

      <PetFormModal
        open={petModalOpen}
        onClose={() => setPetModalOpen(false)}
        draft={petDraft}
        setDraft={setPetDraft}
        editingPet={editingPet}
        onSubmit={savePet}
        addFishRow={addFishRow}
        updateFishRow={updateFishRow}
        removeFishRow={removeFishRow}
      />

      <PetExpenseFormModal
        open={expenseModalOpen}
        onClose={() => setExpenseModalOpen(false)}
        draft={expenseDraft}
        setDraft={setExpenseDraft}
        selectedPet={selectedPet}
        onSubmit={saveExpense}
      />

      <PetVisitFormModal
        open={visitModalOpen}
        onClose={() => setVisitModalOpen(false)}
        draft={visitDraft}
        setDraft={setVisitDraft}
        editingVisit={editingVisit}
        selectedPet={selectedPet}
        onSubmit={saveVisit}
      />
    </div>
  );
}

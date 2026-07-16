import {
  Bone,
  Cake,
  CalendarClock,
  Check,
  CircleDollarSign,
  Fish,
  PawPrint,
  Pencil,
  Plus,
  ReceiptText,
  Scissors,
  ShoppingBag,
  Stethoscope,
  Syringe,
  Trash2,
} from "lucide-react";
import { differenceInYears, format, parseISO } from "date-fns";
import { useMemo, useState, type FormEvent } from "react";
import type {
  FishStockEntry,
  Pet,
  PetExpense,
  PetKind,
  PetVisit,
  Visibility,
} from "../advancedTypes";
import { Modal } from "../components/Modal";
import { dateKey, formatShortDate, relativeDay } from "../lib/date";
import { generateId } from "../lib/id";
import { formatMoney, parseMoneyToMinor } from "../lib/money";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { useServerAuth } from "../server/AuthGate";
import "../styles/modules.css";
import "../styles/pets.css";

interface PetsPageProps {
  onToast: (message: string) => void;
}

type ExpenseFilter = "all" | PetExpense["type"];

interface FishRow {
  id: string;
  species: string;
  count: string;
}

interface PetDraft {
  name: string;
  kind: PetKind;
  species: string;
  birthDate: string;
  notes: string;
  color: string;
  visibility: Visibility;
  fishStock: FishRow[];
}

interface ExpenseDraft {
  date: string;
  type: PetExpense["type"];
  title: string;
  amount: string;
  visibility: Visibility;
}

interface VisitDraft {
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

const kindLabels: Record<PetKind, string> = {
  rabbit: "Królik",
  dog: "Pies",
  cat: "Kot",
  guinea_pig: "Świnka morska",
  aquarium: "Akwarium",
  other: "Inne",
};

const expenseLabels: Record<PetExpense["type"], string> = {
  food: "Jedzenie",
  vet: "Weterynarz",
  accessories: "Akcesoria/zabawki",
  grooming: "Pielęgnacja",
  other: "Inne",
};

const expenseIcons: Record<PetExpense["type"], typeof Bone> = {
  food: Bone,
  vet: Syringe,
  accessories: ShoppingBag,
  grooming: Scissors,
  other: ReceiptText,
};

const emptyPetDraft = (): PetDraft => ({
  name: "",
  kind: "rabbit",
  species: "",
  birthDate: dateKey(),
  notes: "",
  color: "#b17a42",
  visibility: "household",
  fishStock: [],
});

const emptyExpenseDraft = (): ExpenseDraft => ({
  date: dateKey(),
  type: "food",
  title: expenseLabels.food,
  amount: "",
  visibility: "household",
});

const emptyVisitDraft = (): VisitDraft => ({
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

function petAgeLabel(birthDate?: string): string {
  if (!birthDate) return "Wiek nieznany";
  const years = differenceInYears(new Date(), parseISO(birthDate));
  if (years <= 0) return "Poniżej roku";
  return `${years} ${years === 1 ? "rok" : years < 5 ? "lata" : "lat"}`;
}

function fishStockCount(fishStock?: FishStockEntry[]): number {
  return (fishStock ?? []).reduce((sum, entry) => sum + entry.count, 0);
}

export function PetsPage({ onToast }: PetsPageProps) {
  const { snapshot } = useServerAuth();
  const currentOwnerId = snapshot?.user.id ?? "me";
  const pets = useAdvancedStore((state) => state.pets);
  const petExpenses = useAdvancedStore((state) => state.petExpenses);
  const petVisits = useAdvancedStore((state) => state.petVisits);
  const hideAmounts = useAdvancedStore((state) => state.hideAmounts);
  const addPet = useAdvancedStore((state) => state.addPet);
  const updatePet = useAdvancedStore((state) => state.updatePet);
  const deletePet = useAdvancedStore((state) => state.deletePet);
  const addPetExpense = useAdvancedStore((state) => state.addPetExpense);
  const deletePetExpense = useAdvancedStore((state) => state.deletePetExpense);
  const addPetVisit = useAdvancedStore((state) => state.addPetVisit);
  const updatePetVisit = useAdvancedStore((state) => state.updatePetVisit);
  const deletePetVisit = useAdvancedStore((state) => state.deletePetVisit);
  const togglePetVisitCompleted = useAdvancedStore((state) => state.togglePetVisitCompleted);

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
    () => petExpenses
      .filter((expense) => expense.petId === selectedPet?.id)
      .sort((a, b) => b.date.localeCompare(a.date)),
    [petExpenses, selectedPet?.id],
  );
  const visibleExpenses = selectedExpenses.filter(
    (expense) => expenseFilter === "all" || expense.type === expenseFilter,
  );
  const selectedVisits = useMemo(
    () => petVisits
      .filter((visit) => visit.petId === selectedPet?.id)
      .sort((a, b) => {
        const statusOrder = { scheduled: 0, completed: 1, cancelled: 2 };
        return statusOrder[a.status] - statusOrder[b.status] || `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`);
      }),
    [petVisits, selectedPet?.id],
  );
  const nextVisit = selectedVisits.find((visit) => visit.status === "scheduled");

  const monthPrefix = format(new Date(), "yyyy-MM");
  const monthlyCost = selectedExpenses
    .filter((expense) => expense.date.startsWith(monthPrefix))
    .reduce((sum, expense) => sum + expense.amountMinor, 0);

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
          <p>Profile, wydatki i wizyty u weterynarza — jedno miejsce zamiast rozproszonych notatek.</p>
        </div>
        <button className="button button--primary" type="button" onClick={() => openExpenseCreate("food")}>
          <Plus size={17} /> Dodaj wydatek
        </button>
      </header>

      <section className="pet-strip" aria-label="Twoje zwierzęta">
        {pets.map((pet) => {
          const KindIcon = pet.kind === "aquarium" ? Fish : PawPrint;
          return (
            <button
              className={selectedPet?.id === pet.id ? "pet-card pet-card--active" : "pet-card"}
              type="button"
              key={pet.id}
              onClick={() => setSelectedPetId(pet.id)}
              style={{ "--pet-color": pet.color } as React.CSSProperties}
            >
              <span className="pet-card__icon"><KindIcon size={22} /></span>
              <div>
                <strong>{pet.name}</strong>
                <span>{kindLabels[pet.kind]}</span>
                <small>{pet.kind === "aquarium" ? `${fishStockCount(pet.fishStock)} ryb` : petAgeLabel(pet.birthDate)}</small>
              </div>
            </button>
          );
        })}
        <button className="pet-add" type="button" onClick={openPetCreate}><Plus size={20} /><span>Dodaj zwierzę</span></button>
      </section>

      {selectedPet ? (
        <>
          <section className="module-stat-grid module-stat-grid--three" aria-label="Podsumowanie zwierzęcia">
            <article className="module-stat-card module-stat-card--accent">
              <span className="module-stat-card__icon">{isAquarium ? <Fish size={19} /> : <PawPrint size={19} />}</span>
              <div>
                <span>{isAquarium ? "Obsada akwarium" : "Wiek"}</span>
                <strong>{isAquarium ? `${fishStockCount(selectedPet.fishStock)} ryb` : petAgeLabel(selectedPet.birthDate)}</strong>
                <small>{isAquarium ? `${(selectedPet.fishStock ?? []).length} gatunków` : (selectedPet.species || kindLabels[selectedPet.kind])}</small>
              </div>
            </article>
            <article className="module-stat-card">
              <span className="module-stat-card__icon module-stat-card__icon--amber"><CircleDollarSign size={19} /></span>
              <div>
                <span>Koszty w tym miesiącu</span>
                <strong>{formatMoney(monthlyCost, "PLN", hideAmounts)}</strong>
                <small>{selectedExpenses.filter((expense) => expense.date.startsWith(monthPrefix)).length} wpisów</small>
              </div>
            </article>
            <article className="module-stat-card">
              <span className="module-stat-card__icon module-stat-card__icon--violet"><CalendarClock size={19} /></span>
              <div>
                <span>Najbliższa wizyta</span>
                <strong>{nextVisit ? relativeDay(nextVisit.date) : "Brak"}</strong>
                <small>{nextVisit ? `${nextVisit.title} · ${nextVisit.time}` : "Wszystko spokojnie"}</small>
              </div>
            </article>
          </section>

          <div className="car-dashboard-grid">
            <div className="car-dashboard-main">
              <section className="panel module-panel">
                <header className="module-panel__header">
                  <div><span className="section-kicker"><ReceiptText size={14} /> Historia</span><h2>Wydatki</h2></div>
                  <div className="module-toolbar-actions">
                    <div className="module-segmented">
                      <button className={expenseFilter === "all" ? "active" : ""} type="button" onClick={() => setExpenseFilter("all")}>Wszystkie</button>
                      <button className={expenseFilter === "food" ? "active" : ""} type="button" onClick={() => setExpenseFilter("food")}>Jedzenie</button>
                      <button className={expenseFilter === "vet" ? "active" : ""} type="button" onClick={() => setExpenseFilter("vet")}>Weterynarz</button>
                      <button className={expenseFilter === "accessories" ? "active" : ""} type="button" onClick={() => setExpenseFilter("accessories")}>Akcesoria</button>
                      <button className={expenseFilter === "grooming" ? "active" : ""} type="button" onClick={() => setExpenseFilter("grooming")}>Pielęgnacja</button>
                    </div>
                    <button className="button button--soft button--small" type="button" onClick={() => openExpenseCreate("other")}><Plus size={15} /> Dodaj koszt</button>
                  </div>
                </header>
                {visibleExpenses.length ? (
                  <div className="car-expense-list">
                    {visibleExpenses.map((expense) => {
                      const ExpenseIcon = expenseIcons[expense.type];
                      return (
                        <article className="car-expense-row" key={expense.id}>
                          <span className={`car-expense-icon car-expense-icon--${expense.type}`}><ExpenseIcon size={18} /></span>
                          <div className="car-expense-row__main"><strong>{expense.title}</strong><span>{expenseLabels[expense.type]} · {formatShortDate(expense.date)}</span></div>
                          <div className="car-expense-row__details" />
                          <strong className="car-expense-row__amount">{formatMoney(expense.amountMinor, "PLN", hideAmounts)}</strong>
                          <button className="icon-button module-danger-icon" type="button" onClick={() => removeExpense(expense)} aria-label={`Usuń wpis ${expense.title}`}><Trash2 size={15} /></button>
                        </article>
                      );
                    })}
                  </div>
                ) : <div className="module-empty"><ReceiptText size={24} /><strong>Brak wydatków w tym widoku</strong><span>Dodaj jedzenie, wizytę u weterynarza albo inny koszt.</span></div>}
              </section>
            </div>

            <aside className="car-dashboard-side">
              <section className="panel module-panel pet-overview-card">
                <header>
                  <span className="pet-overview-icon" style={{ background: selectedPet.color }}>{isAquarium ? <Fish size={24} /> : <PawPrint size={24} />}</span>
                  <div><span>{kindLabels[selectedPet.kind]}</span><h2>{selectedPet.name}</h2><p>{isAquarium ? `${fishStockCount(selectedPet.fishStock)} ryb w obsadzie` : (selectedPet.species || "Bez podanego gatunku")}</p></div>
                  <button className="icon-button" type="button" onClick={() => openPetEdit(selectedPet)} aria-label="Edytuj profil zwierzęcia"><Pencil size={17} /></button>
                </header>

                {isAquarium ? (
                  <div className="pet-fish-list">
                    {(selectedPet.fishStock ?? []).map((entry) => (
                      <div className="pet-fish-row" key={entry.id}><Fish size={14} /><span>{entry.species}</span><strong>{entry.count} szt.</strong></div>
                    ))}
                    {!(selectedPet.fishStock ?? []).length && <p className="pet-empty-note">Dodaj gatunki ryb w edycji profilu.</p>}
                  </div>
                ) : (
                  <div className="pet-date-grid">
                    <div><Cake size={16} /><span>Data urodzenia</span><strong>{selectedPet.birthDate ? formatShortDate(selectedPet.birthDate) : "Nieznana"}</strong></div>
                    <div><PawPrint size={16} /><span>Wiek</span><strong>{petAgeLabel(selectedPet.birthDate)}</strong></div>
                  </div>
                )}
                {selectedPet.notes && <p className="pet-notes">{selectedPet.notes}</p>}
                <button className="text-button pet-remove-link" type="button" onClick={() => removePet(selectedPet)}><Trash2 size={14} /> Usuń profil</button>
              </section>

              <section className="panel module-panel deadlines-panel">
                <header className="module-panel__header"><div><span className="section-kicker"><Stethoscope size={14} /> Opieka</span><h2>Wizyty u weterynarza</h2></div><button className="icon-button" type="button" onClick={openVisitCreate} aria-label="Dodaj wizytę"><Plus size={18} /></button></header>
                <div className="deadline-list">
                  {selectedVisits.map((visit) => (
                    <article className={`deadline-row ${visit.status !== "scheduled" ? "deadline-row--done" : ""}`} key={visit.id}>
                      <button type="button" onClick={() => togglePetVisitCompleted(visit.id)} aria-label={visit.status === "completed" ? `Przywróć ${visit.title}` : `Oznacz odbytą ${visit.title}`} aria-pressed={visit.status === "completed"}><Check size={13} /></button>
                      <div>
                        <strong>{visit.title}</strong>
                        <span>{relativeDay(visit.date)} · {visit.time} · {visit.clinician}{visit.location ? ` · ${visit.location}` : ""}</span>
                      </div>
                      <button className="icon-button" type="button" onClick={() => openVisitEdit(visit)} aria-label={`Edytuj wizytę ${visit.title}`}><Pencil size={13} /></button>
                      <button className="icon-button module-danger-icon" type="button" onClick={() => removeVisit(visit)} aria-label={`Usuń wizytę ${visit.title}`}><Trash2 size={14} /></button>
                    </article>
                  ))}
                  {!selectedVisits.length && <div className="module-mini-empty"><Check size={16} /><span>Brak zaplanowanych wizyt.</span></div>}
                </div>
              </section>
            </aside>
          </div>
        </>
      ) : (
        <section className="panel module-panel module-empty module-empty--large">
          <PawPrint size={29} />
          <strong>Brak profili zwierząt</strong>
          <span>Dodaj pierwsze zwierzę albo akwarium, aby zacząć śledzić koszty i wizyty.</span>
          <button className="button button--primary" type="button" onClick={openPetCreate}><Plus size={16} /> Dodaj zwierzę</button>
        </section>
      )}

      <Modal open={petModalOpen} onClose={() => setPetModalOpen(false)} title={editingPet ? "Edytuj profil" : "Nowe zwierzę"} eyebrow="Zwierzęta" size="large">
        <form className="form-grid" onSubmit={savePet}>
          <label className="field field--prominent"><span>Imię lub nazwa</span><input autoFocus required value={petDraft.name} onChange={(event) => setPetDraft({ ...petDraft, name: event.target.value })} placeholder="np. Fistaszek" /></label>
          <div className="form-grid form-grid--2">
            <label className="field"><span>Rodzaj profilu</span><select value={petDraft.kind} onChange={(event) => setPetDraft({ ...petDraft, kind: event.target.value as PetKind })}><option value="rabbit">Królik</option><option value="dog">Pies</option><option value="cat">Kot</option><option value="guinea_pig">Świnka morska</option><option value="aquarium">Akwarium</option><option value="other">Inne</option></select></label>
            <label className="field"><span>Kolor karty</span><input className="module-color-input" type="color" value={petDraft.color} onChange={(event) => setPetDraft({ ...petDraft, color: event.target.value })} /></label>
          </div>

          {petDraft.kind === "aquarium" ? (
            <div className="pet-fish-editor">
              <div className="module-choice-divider"><span>Obsada akwarium</span></div>
              {petDraft.fishStock.map((row) => (
                <div className="pet-fish-editor__row" key={row.id}>
                  <input value={row.species} onChange={(event) => updateFishRow(row.id, { species: event.target.value })} placeholder="Gatunek ryby, np. Neonek innesa" />
                  <input inputMode="numeric" value={row.count} onChange={(event) => updateFishRow(row.id, { count: event.target.value })} placeholder="Liczba" />
                  <button type="button" className="icon-button module-danger-icon" onClick={() => removeFishRow(row.id)} aria-label="Usuń gatunek"><Trash2 size={15} /></button>
                </div>
              ))}
              <button type="button" className="button button--soft button--small" onClick={addFishRow}><Plus size={14} /> Dodaj gatunek</button>
            </div>
          ) : (
            <div className="form-grid form-grid--2">
              <label className="field"><span>Gatunek / rasa</span><input value={petDraft.species} onChange={(event) => setPetDraft({ ...petDraft, species: event.target.value })} placeholder="np. Królik miniaturka" /></label>
              <label className="field"><span>Data urodzenia</span><input type="date" value={petDraft.birthDate} onChange={(event) => setPetDraft({ ...petDraft, birthDate: event.target.value })} /></label>
            </div>
          )}

          <label className="field"><span>Notatki</span><input value={petDraft.notes} onChange={(event) => setPetDraft({ ...petDraft, notes: event.target.value })} placeholder="Opcjonalne informacje" /></label>
          <label className="field"><span>Widoczność</span><select value={petDraft.visibility} onChange={(event) => setPetDraft({ ...petDraft, visibility: event.target.value as Visibility })}><option value="household">Domownicy</option><option value="private">Tylko ja</option></select></label>
          <div className="modal-actions"><button className="button button--ghost" type="button" onClick={() => setPetModalOpen(false)}>Anuluj</button><button className="button button--primary" type="submit">{editingPet ? "Zapisz zmiany" : "Dodaj zwierzę"}</button></div>
        </form>
      </Modal>

      <Modal open={expenseModalOpen} onClose={() => setExpenseModalOpen(false)} title="Dodaj wydatek" eyebrow={selectedPet?.name ?? "Zwierzęta"}>
        <form className="form-grid" onSubmit={saveExpense}>
          <div className="form-grid form-grid--2">
            <label className="field"><span>Kategoria</span><select value={expenseDraft.type} onChange={(event) => { const type = event.target.value as PetExpense["type"]; setExpenseDraft((prev) => { const isGenericTitle = !prev.title.trim() || prev.title === expenseLabels[prev.type]; return { ...prev, type, title: isGenericTitle ? expenseLabels[type] : prev.title }; }); }}><option value="food">Jedzenie</option><option value="vet">Weterynarz</option><option value="accessories">Akcesoria/zabawki</option><option value="grooming">Pielęgnacja</option><option value="other">Inne</option></select></label>
            <label className="field"><span>Data</span><input required type="date" value={expenseDraft.date} onChange={(event) => setExpenseDraft({ ...expenseDraft, date: event.target.value })} /></label>
          </div>
          <label className="field field--prominent"><span>Opis</span><input autoFocus required value={expenseDraft.title} onChange={(event) => setExpenseDraft({ ...expenseDraft, title: event.target.value })} placeholder="np. Siano i granulat" /></label>
          <label className="field"><span>Kwota (PLN)</span><input inputMode="decimal" required value={expenseDraft.amount} onChange={(event) => setExpenseDraft({ ...expenseDraft, amount: event.target.value })} placeholder="42,00" /></label>
          <label className="field"><span>Widoczność</span><select value={expenseDraft.visibility} onChange={(event) => setExpenseDraft({ ...expenseDraft, visibility: event.target.value as Visibility })}><option value="household">Domownicy</option><option value="private">Tylko ja</option></select></label>
          <div className="modal-actions"><button className="button button--ghost" type="button" onClick={() => setExpenseModalOpen(false)}>Anuluj</button><button className="button button--primary" type="submit">Zapisz wpis</button></div>
        </form>
      </Modal>

      <Modal open={visitModalOpen} onClose={() => setVisitModalOpen(false)} title={editingVisit ? "Edytuj wizytę" : "Nowa wizyta"} eyebrow={selectedPet?.name ?? "Zwierzęta"} size="large">
        <form className="form-grid" onSubmit={saveVisit}>
          <label className="field field--prominent"><span>Nazwa wizyty</span><input autoFocus required value={visitDraft.title} onChange={(event) => setVisitDraft({ ...visitDraft, title: event.target.value })} placeholder="np. Szczepienie" /></label>
          <div className="form-grid form-grid--2"><label className="field"><span>Weterynarz / placówka</span><input required value={visitDraft.clinician} onChange={(event) => setVisitDraft({ ...visitDraft, clinician: event.target.value })} placeholder="Nazwisko albo nazwa placówki" /></label><label className="field"><span>Specjalizacja</span><input value={visitDraft.specialty} onChange={(event) => setVisitDraft({ ...visitDraft, specialty: event.target.value })} placeholder="Opcjonalnie" /></label></div>
          <div className="form-grid form-grid--2"><label className="field"><span>Data</span><input required type="date" value={visitDraft.date} onChange={(event) => setVisitDraft({ ...visitDraft, date: event.target.value })} /></label><label className="field"><span>Godzina</span><input required type="time" value={visitDraft.time} onChange={(event) => setVisitDraft({ ...visitDraft, time: event.target.value })} /></label></div>
          <label className="field"><span>Miejsce</span><input value={visitDraft.location} onChange={(event) => setVisitDraft({ ...visitDraft, location: event.target.value })} placeholder="Adres lub nazwa gabinetu" /></label>
          {editingVisit && <label className="field"><span>Status</span><select value={visitDraft.status} onChange={(event) => setVisitDraft({ ...visitDraft, status: event.target.value as PetVisit["status"] })}><option value="scheduled">Zaplanowana</option><option value="completed">Odbyta</option><option value="cancelled">Anulowana</option></select></label>}
          <div className="form-grid form-grid--2"><label className="field"><span>Widoczność</span><select value={visitDraft.visibility} onChange={(event) => setVisitDraft({ ...visitDraft, visibility: event.target.value as Visibility })}><option value="household">Domownicy</option><option value="private">Tylko ja</option></select></label><label className="field"><span>Notatka</span><input value={visitDraft.notes} onChange={(event) => setVisitDraft({ ...visitDraft, notes: event.target.value })} placeholder="np. zabrać książeczkę zdrowia" /></label></div>
          <div className="modal-actions"><span /><div><button className="button button--ghost" type="button" onClick={() => setVisitModalOpen(false)}>Anuluj</button><button className="button button--primary" type="submit">{editingVisit ? "Zapisz zmiany" : "Zapisz wizytę"}</button></div></div>
        </form>
      </Modal>
    </div>
  );
}

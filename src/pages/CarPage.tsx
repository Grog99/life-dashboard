import {
  CalendarClock,
  Car,
  Check,
  CircleDollarSign,
  Fuel,
  Gauge,
  Pencil,
  Plus,
  ReceiptText,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  differenceInCalendarDays,
  format,
  isBefore,
  parseISO,
  startOfDay,
} from "date-fns";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  CarExpense,
  Vehicle,
  VehicleDeadline,
  Visibility,
} from "../advancedTypes";
import { Modal } from "../components/Modal";
import { dateKey, formatShortDate, relativeDay } from "../lib/date";
import { generateId } from "../lib/id";
import { formatMoney, parseMoneyToMinor } from "../lib/money";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { useServerAuth } from "../server/AuthGate";
import "../styles/modules.css";

interface CarPageProps {
  onToast: (message: string) => void;
}

type ExpenseFilter = "all" | CarExpense["type"];

interface VehicleDraft {
  name: string;
  make: string;
  model: string;
  year: string;
  plate: string;
  mileage: string;
  fuelType: Vehicle["fuelType"];
  inspectionDate: string;
  insuranceDate: string;
  color: string;
  visibility: Visibility;
}

interface ExpenseDraft {
  date: string;
  type: CarExpense["type"];
  title: string;
  amount: string;
  mileage: string;
  liters: string;
  visibility: Visibility;
}

interface DeadlineDraft {
  title: string;
  dueDate: string;
  dueMileage: string;
}

const fuelLabels: Record<Vehicle["fuelType"], string> = {
  petrol: "Benzyna",
  diesel: "Diesel",
  hybrid: "Hybryda",
  electric: "Elektryczny",
};

const expenseLabels: Record<CarExpense["type"], string> = {
  fuel: "Tankowanie",
  service: "Serwis",
  insurance: "Ubezpieczenie",
  parking: "Parking",
  other: "Inne",
};

const emptyVehicleDraft = (): VehicleDraft => ({
  name: "",
  make: "",
  model: "",
  year: String(new Date().getFullYear()),
  plate: "",
  mileage: "0",
  fuelType: "petrol",
  inspectionDate: dateKey(),
  insuranceDate: dateKey(),
  color: "#496f67",
  visibility: "household",
});

const emptyExpenseDraft = (mileage = 0): ExpenseDraft => ({
  date: dateKey(),
  type: "fuel",
  title: "Tankowanie",
  amount: "",
  mileage: String(mileage),
  liters: "",
  visibility: "household",
});

function deadlineIsDue(deadline: VehicleDeadline, vehicle: Vehicle): boolean {
  const dateDue = deadline.dueDate
    ? isBefore(parseISO(deadline.dueDate), startOfDay(new Date())) || deadline.dueDate === dateKey()
    : false;
  const mileageDue = deadline.dueMileage !== undefined && deadline.dueMileage <= vehicle.mileage;
  return !deadline.completed && (dateDue || mileageDue);
}

function deadlineOrder(deadline: VehicleDeadline, vehicle: Vehicle): number {
  if (deadline.completed) return Number.MAX_SAFE_INTEGER;
  if (deadline.dueDate) return differenceInCalendarDays(parseISO(deadline.dueDate), new Date());
  if (deadline.dueMileage !== undefined) return (deadline.dueMileage - vehicle.mileage) / 50;
  return Number.MAX_SAFE_INTEGER - 1;
}

export function CarPage({ onToast }: CarPageProps) {
  const { snapshot } = useServerAuth();
  const currentOwnerId = snapshot?.user.id ?? "me";
  const vehicles = useAdvancedStore((state) => state.vehicles);
  const carExpenses = useAdvancedStore((state) => state.carExpenses);
  const vehicleDeadlines = useAdvancedStore((state) => state.vehicleDeadlines);
  const hideAmounts = useAdvancedStore((state) => state.hideAmounts);
  const addVehicle = useAdvancedStore((state) => state.addVehicle);
  const updateVehicle = useAdvancedStore((state) => state.updateVehicle);
  const addCarExpense = useAdvancedStore((state) => state.addCarExpense);
  const toggleVehicleDeadline = useAdvancedStore((state) => state.toggleVehicleDeadline);

  const [selectedVehicleId, setSelectedVehicleId] = useState(vehicles[0]?.id ?? "");
  const [vehicleModalOpen, setVehicleModalOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [vehicleDraft, setVehicleDraft] = useState<VehicleDraft>(emptyVehicleDraft);
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [expenseDraft, setExpenseDraft] = useState<ExpenseDraft>(emptyExpenseDraft());
  const [deadlineModalOpen, setDeadlineModalOpen] = useState(false);
  const [deadlineDraft, setDeadlineDraft] = useState<DeadlineDraft>({ title: "", dueDate: "", dueMileage: "" });
  const [expenseFilter, setExpenseFilter] = useState<ExpenseFilter>("all");
  const [mileageInput, setMileageInput] = useState("");

  const selectedVehicle = vehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? vehicles[0];

  useEffect(() => {
    if (selectedVehicle) setMileageInput(String(selectedVehicle.mileage));
  }, [selectedVehicle]);

  const selectedExpenses = useMemo(
    () => carExpenses
      .filter((expense) => expense.vehicleId === selectedVehicle?.id)
      .sort((a, b) => b.date.localeCompare(a.date)),
    [carExpenses, selectedVehicle?.id],
  );
  const selectedDeadlines = useMemo(
    () => vehicleDeadlines
      .filter((deadline) => deadline.vehicleId === selectedVehicle?.id)
      .sort((a, b) => selectedVehicle ? deadlineOrder(a, selectedVehicle) - deadlineOrder(b, selectedVehicle) : 0),
    [selectedVehicle, vehicleDeadlines],
  );
  const visibleExpenses = selectedExpenses.filter(
    (expense) => expenseFilter === "all" || expense.type === expenseFilter,
  );
  const monthPrefix = format(new Date(), "yyyy-MM");
  const monthlyCost = selectedExpenses
    .filter((expense) => expense.date.startsWith(monthPrefix))
    .reduce((sum, expense) => sum + expense.amountMinor, 0);
  const fuelExpenses = selectedExpenses.filter((expense) => expense.type === "fuel" && expense.liters);
  const totalFuelLiters = fuelExpenses.reduce((sum, expense) => sum + (expense.liters ?? 0), 0);
  const totalFuelCost = fuelExpenses.reduce((sum, expense) => sum + expense.amountMinor, 0);
  const averageFuelPrice = totalFuelLiters ? totalFuelCost / totalFuelLiters : 0;
  const openDeadlines = selectedDeadlines.filter((deadline) => !deadline.completed);
  const urgentDeadlines = selectedVehicle
    ? openDeadlines.filter((deadline) => deadlineIsDue(deadline, selectedVehicle))
    : [];
  const nextDeadline = openDeadlines[0];

  const openVehicleCreate = () => {
    setEditingVehicle(null);
    setVehicleDraft(emptyVehicleDraft());
    setVehicleModalOpen(true);
  };

  const openVehicleEdit = (vehicle: Vehicle) => {
    setEditingVehicle(vehicle);
    setVehicleDraft({
      name: vehicle.name,
      make: vehicle.make,
      model: vehicle.model,
      year: String(vehicle.year),
      plate: vehicle.plate,
      mileage: String(vehicle.mileage),
      fuelType: vehicle.fuelType,
      inspectionDate: vehicle.inspectionDate,
      insuranceDate: vehicle.insuranceDate,
      color: vehicle.color,
      visibility: vehicle.visibility,
    });
    setVehicleModalOpen(true);
  };

  const saveVehicle = (event: FormEvent) => {
    event.preventDefault();
    if (!vehicleDraft.name.trim() || !vehicleDraft.make.trim() || !vehicleDraft.model.trim()) {
      onToast("Uzupełnij nazwę, markę i model pojazdu");
      return;
    }
    const data = {
      name: vehicleDraft.name.trim(),
      make: vehicleDraft.make.trim(),
      model: vehicleDraft.model.trim(),
      year: Number.parseInt(vehicleDraft.year, 10) || new Date().getFullYear(),
      plate: vehicleDraft.plate.trim().toLocaleUpperCase("pl"),
      mileage: Math.max(0, Number.parseInt(vehicleDraft.mileage, 10) || 0),
      fuelType: vehicleDraft.fuelType,
      inspectionDate: vehicleDraft.inspectionDate,
      insuranceDate: vehicleDraft.insuranceDate,
      color: vehicleDraft.color,
      visibility: vehicleDraft.visibility,
    };
    if (editingVehicle && data.mileage < editingVehicle.mileage) {
      onToast("Przebieg pojazdu nie może być mniejszy niż zapisany wcześniej");
      return;
    }
    if (editingVehicle) {
      updateVehicle(editingVehicle.id, data);
      const expected = [
        { title: "Badanie techniczne", dueDate: data.inspectionDate, changed: data.inspectionDate !== editingVehicle.inspectionDate },
        { title: "Odnowienie OC/AC", dueDate: data.insuranceDate, changed: data.insuranceDate !== editingVehicle.insuranceDate },
      ];
      useAdvancedStore.setState((state) => {
        const deadlines = [...state.vehicleDeadlines];
        for (const item of expected) {
          const index = deadlines.findIndex((deadline) => deadline.vehicleId === editingVehicle.id && deadline.title === item.title);
          if (index >= 0) {
            if (item.changed) deadlines[index] = { ...deadlines[index], dueDate: item.dueDate };
          } else {
            deadlines.push({ id: generateId(), vehicleId: editingVehicle.id, title: item.title, dueDate: item.dueDate, completed: false });
          }
        }
        return { vehicleDeadlines: deadlines };
      });
      onToast("Dane pojazdu zostały zaktualizowane");
    } else {
      const id = addVehicle({ ...data, ownerId: currentOwnerId });
      useAdvancedStore.setState((state) => ({
        vehicleDeadlines: [
          ...state.vehicleDeadlines,
          { id: generateId(), vehicleId: id, title: "Badanie techniczne", dueDate: data.inspectionDate, completed: false },
          { id: generateId(), vehicleId: id, title: "Odnowienie OC/AC", dueDate: data.insuranceDate, completed: false },
        ],
      }));
      setSelectedVehicleId(id);
      onToast("Pojazd został dodany do garażu");
    }
    setVehicleModalOpen(false);
  };

  const openExpenseCreate = (type: CarExpense["type"] = "fuel") => {
    if (!selectedVehicle) {
      openVehicleCreate();
      return;
    }
    setExpenseDraft({
      ...emptyExpenseDraft(selectedVehicle.mileage),
      type,
      title: type === "fuel" ? "Tankowanie" : type === "service" ? "Serwis" : expenseLabels[type],
    });
    setExpenseModalOpen(true);
  };

  const saveExpense = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedVehicle) return;
    const amountMinor = parseMoneyToMinor(expenseDraft.amount);
    if (!expenseDraft.title.trim() || amountMinor <= 0) {
      onToast("Podaj opis i poprawną kwotę kosztu");
      return;
    }
    const mileage = expenseDraft.mileage ? Number.parseInt(expenseDraft.mileage, 10) : undefined;
    const liters = expenseDraft.type === "fuel" && expenseDraft.liters
      ? Number.parseFloat(expenseDraft.liters.replace(",", "."))
      : undefined;
    addCarExpense({
      vehicleId: selectedVehicle.id,
      date: expenseDraft.date,
      type: expenseDraft.type,
      amountMinor,
      mileage: Number.isFinite(mileage) ? mileage : undefined,
      liters: Number.isFinite(liters) ? liters : undefined,
      title: expenseDraft.title.trim(),
      ownerId: currentOwnerId,
      visibility: expenseDraft.visibility,
    });
    setExpenseModalOpen(false);
    onToast(expenseDraft.type === "fuel" ? "Tankowanie zostało zapisane" : "Koszt został dodany");
  };

  const removeExpense = (expense: CarExpense) => {
    if (!window.confirm(`Usunąć wpis „${expense.title}”?`)) return;
    useAdvancedStore.setState((state) => ({
      carExpenses: state.carExpenses.filter((item) => item.id !== expense.id),
    }));
    onToast("Wpis kosztu został usunięty");
  };

  const saveMileage = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedVehicle) return;
    const mileage = Number.parseInt(mileageInput, 10);
    if (!Number.isFinite(mileage)) {
      onToast("Podaj poprawny przebieg");
      setMileageInput(String(selectedVehicle.mileage));
      return;
    }
    if (mileage < selectedVehicle.mileage) {
      onToast("Nowy przebieg nie może być niższy od obecnego");
      setMileageInput(String(selectedVehicle.mileage));
      return;
    }
    updateVehicle(selectedVehicle.id, { mileage });
    onToast("Przebieg został zaktualizowany");
  };

  const addDeadline = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedVehicle || !deadlineDraft.title.trim() || (!deadlineDraft.dueDate && !deadlineDraft.dueMileage)) {
      onToast("Podaj nazwę oraz datę albo przebieg terminu");
      return;
    }
    const dueMileage = deadlineDraft.dueMileage
      ? Number.parseInt(deadlineDraft.dueMileage, 10)
      : undefined;
    useAdvancedStore.setState((state) => ({
      vehicleDeadlines: [
        ...state.vehicleDeadlines,
        {
          id: generateId(),
          vehicleId: selectedVehicle.id,
          title: deadlineDraft.title.trim(),
          dueDate: deadlineDraft.dueDate || undefined,
          dueMileage: Number.isFinite(dueMileage) ? dueMileage : undefined,
          completed: false,
        },
      ],
    }));
    setDeadlineModalOpen(false);
    setDeadlineDraft({ title: "", dueDate: "", dueMileage: "" });
    onToast("Termin został dodany");
  };

  const removeDeadline = (deadline: VehicleDeadline) => {
    if (!window.confirm(`Usunąć termin „${deadline.title}”?`)) return;
    useAdvancedStore.setState((state) => ({
      vehicleDeadlines: state.vehicleDeadlines.filter((item) => item.id !== deadline.id),
    }));
    onToast("Termin został usunięty");
  };

  return (
    <div className="life-module-page page-enter">
      <header className="page-header life-module-header">
        <div>
          <span className="page-eyebrow">Garaż i koszty w jednym miejscu</span>
          <h1>Samochód</h1>
          <p>Przebieg, tankowania, serwis i ważne terminy bez szukania po dokumentach.</p>
        </div>
        <button className="button button--primary" type="button" onClick={() => openExpenseCreate("fuel")}>
          <Plus size={17} /> Dodaj tankowanie
        </button>
      </header>

      <section className="garage-strip" aria-label="Twój garaż">
        {vehicles.map((vehicle) => (
          <button
            className={selectedVehicle?.id === vehicle.id ? "garage-card garage-card--active" : "garage-card"}
            type="button"
            key={vehicle.id}
            onClick={() => setSelectedVehicleId(vehicle.id)}
            style={{ "--vehicle-color": vehicle.color } as React.CSSProperties}
          >
            <span className="garage-card__icon"><Car size={22} /></span>
            <div><strong>{vehicle.name}</strong><span>{vehicle.year} · {fuelLabels[vehicle.fuelType]}</span><small>{vehicle.plate || "Bez numeru"}</small></div>
            <span className="garage-card__mileage">{new Intl.NumberFormat("pl-PL").format(vehicle.mileage)} km</span>
          </button>
        ))}
        <button className="garage-add" type="button" onClick={openVehicleCreate}><Plus size={20} /><span>Dodaj pojazd</span></button>
      </section>

      {selectedVehicle ? (
        <>
          <section className="module-stat-grid" aria-label="Podsumowanie pojazdu">
            <article className="module-stat-card module-stat-card--accent"><span className="module-stat-card__icon"><Gauge size={19} /></span><div><span>Przebieg</span><strong>{new Intl.NumberFormat("pl-PL").format(selectedVehicle.mileage)} km</strong><small>{selectedVehicle.make} {selectedVehicle.model}</small></div></article>
            <article className="module-stat-card"><span className="module-stat-card__icon module-stat-card__icon--amber"><CircleDollarSign size={19} /></span><div><span>Koszty w tym miesiącu</span><strong>{formatMoney(monthlyCost, "PLN", hideAmounts)}</strong><small>{selectedExpenses.filter((expense) => expense.date.startsWith(monthPrefix)).length} wpisów</small></div></article>
            <article className="module-stat-card"><span className="module-stat-card__icon module-stat-card__icon--blue"><Fuel size={19} /></span><div><span>Średnia cena paliwa</span><strong>{averageFuelPrice ? `${formatMoney(Math.round(averageFuelPrice), "PLN", hideAmounts)} / l` : "Brak danych"}</strong><small>{totalFuelLiters ? `${totalFuelLiters.toFixed(1).replace(".", ",")} l w historii` : "Dodaj tankowanie z litrami"}</small></div></article>
            <article className={urgentDeadlines.length ? "module-stat-card module-stat-card--warning" : "module-stat-card"}><span className="module-stat-card__icon module-stat-card__icon--violet"><CalendarClock size={19} /></span><div><span>Najbliższy termin</span><strong>{nextDeadline?.dueDate ? relativeDay(nextDeadline.dueDate) : nextDeadline?.dueMileage ? `${new Intl.NumberFormat("pl-PL").format(nextDeadline.dueMileage)} km` : "Brak"}</strong><small>{nextDeadline?.title ?? "Wszystko dopilnowane"}</small></div></article>
          </section>

          <div className="car-dashboard-grid">
            <div className="car-dashboard-main">
              <section className="panel module-panel">
                <header className="module-panel__header">
                  <div><span className="section-kicker"><ReceiptText size={14} /> Historia</span><h2>Koszty i tankowania</h2></div>
                  <div className="module-toolbar-actions"><div className="module-segmented"><button className={expenseFilter === "all" ? "active" : ""} type="button" onClick={() => setExpenseFilter("all")}>Wszystkie</button><button className={expenseFilter === "fuel" ? "active" : ""} type="button" onClick={() => setExpenseFilter("fuel")}>Paliwo</button><button className={expenseFilter === "service" ? "active" : ""} type="button" onClick={() => setExpenseFilter("service")}>Serwis</button></div><button className="button button--soft button--small" type="button" onClick={() => openExpenseCreate("other")}><Plus size={15} /> Dodaj koszt</button></div>
                </header>
                {visibleExpenses.length ? (
                  <div className="car-expense-list">
                    {visibleExpenses.map((expense) => (
                      <article className="car-expense-row" key={expense.id}>
                        <span className={`car-expense-icon car-expense-icon--${expense.type}`}>{expense.type === "fuel" ? <Fuel size={18} /> : expense.type === "service" ? <Wrench size={18} /> : expense.type === "insurance" ? <ShieldCheck size={18} /> : <ReceiptText size={18} />}</span>
                        <div className="car-expense-row__main"><strong>{expense.title}</strong><span>{expenseLabels[expense.type]} · {formatShortDate(expense.date)}</span></div>
                        <div className="car-expense-row__details">{expense.mileage && <span><Gauge size={13} /> {new Intl.NumberFormat("pl-PL").format(expense.mileage)} km</span>}{expense.liters && <span><Fuel size={13} /> {expense.liters.toFixed(1).replace(".", ",")} l</span>}</div>
                        <strong className="car-expense-row__amount">{formatMoney(expense.amountMinor, "PLN", hideAmounts)}</strong>
                        <button className="icon-button module-danger-icon" type="button" onClick={() => removeExpense(expense)} aria-label={`Usuń wpis ${expense.title}`}><Trash2 size={15} /></button>
                      </article>
                    ))}
                  </div>
                ) : <div className="module-empty"><ReceiptText size={24} /><strong>Brak kosztów w tym widoku</strong><span>Dodaj tankowanie, serwis albo inny wydatek.</span></div>}
              </section>
            </div>

            <aside className="car-dashboard-side">
              <section className="panel module-panel vehicle-overview-card">
                <header><span className="vehicle-overview-icon" style={{ background: selectedVehicle.color }}><Car size={24} /></span><div><span>{selectedVehicle.plate || "Twój pojazd"}</span><h2>{selectedVehicle.name}</h2><p>{selectedVehicle.make} {selectedVehicle.model} · {selectedVehicle.year}</p></div><button className="icon-button" type="button" onClick={() => openVehicleEdit(selectedVehicle)} aria-label="Edytuj pojazd"><Pencil size={17} /></button></header>
                <div className="vehicle-date-grid"><div><ShieldCheck size={16} /><span>Ubezpieczenie</span><strong>{formatShortDate(selectedVehicle.insuranceDate)}</strong></div><div><Wrench size={16} /><span>Przegląd</span><strong>{formatShortDate(selectedVehicle.inspectionDate)}</strong></div></div>
                <form className="mileage-update" onSubmit={saveMileage}><label className="field"><span>Aktualny przebieg</span><div><input inputMode="numeric" value={mileageInput} onChange={(event) => setMileageInput(event.target.value)} /><span>km</span><button type="submit" aria-label="Zapisz przebieg"><Check size={16} /></button></div></label></form>
              </section>

              <section className="panel module-panel deadlines-panel">
                <header className="module-panel__header"><div><span className="section-kicker"><CalendarClock size={14} /> Nie przegap</span><h2>Terminy</h2></div><button className="icon-button" type="button" onClick={() => setDeadlineModalOpen(true)} aria-label="Dodaj termin"><Plus size={18} /></button></header>
                <div className="deadline-list">
                  {selectedDeadlines.map((deadline) => {
                    const due = deadlineIsDue(deadline, selectedVehicle);
                    return (
                      <article className={`${deadline.completed ? "deadline-row deadline-row--done" : "deadline-row"} ${due ? "deadline-row--due" : ""}`} key={deadline.id}>
                        <button type="button" onClick={() => toggleVehicleDeadline(deadline.id)} aria-label={deadline.completed ? `Przywróć ${deadline.title}` : `Ukończ ${deadline.title}`}><Check size={13} /></button>
                        <div><strong>{deadline.title}</strong><span>{deadline.dueDate ? `${relativeDay(deadline.dueDate)} · ${formatShortDate(deadline.dueDate)}` : deadline.dueMileage ? `przy ${new Intl.NumberFormat("pl-PL").format(deadline.dueMileage)} km` : "Bez terminu"}</span></div>
                        {due && <span className="deadline-badge">pilne</span>}
                        <button className="icon-button module-danger-icon" type="button" onClick={() => removeDeadline(deadline)} aria-label={`Usuń termin ${deadline.title}`}><Trash2 size={14} /></button>
                      </article>
                    );
                  })}
                  {!selectedDeadlines.length && <div className="module-mini-empty"><Check size={16} /><span>Brak nadchodzących terminów.</span></div>}
                </div>
              </section>
            </aside>
          </div>
        </>
      ) : (
        <section className="panel module-panel module-empty module-empty--large"><Car size={29} /><strong>Twój garaż jest pusty</strong><span>Dodaj pierwszy pojazd, aby prowadzić przebieg, koszty i terminy.</span><button className="button button--primary" type="button" onClick={openVehicleCreate}><Plus size={16} /> Dodaj pojazd</button></section>
      )}

      <Modal open={vehicleModalOpen} onClose={() => setVehicleModalOpen(false)} title={editingVehicle ? "Edytuj pojazd" : "Nowy pojazd"} eyebrow="Garaż" size="large">
        <form className="form-grid" onSubmit={saveVehicle}>
          <label className="field field--prominent"><span>Nazwa w dashboardzie</span><input autoFocus required value={vehicleDraft.name} onChange={(event) => setVehicleDraft({ ...vehicleDraft, name: event.target.value })} placeholder="np. Rodzinna Toyota" /></label>
          <div className="form-grid form-grid--3"><label className="field"><span>Marka</span><input required value={vehicleDraft.make} onChange={(event) => setVehicleDraft({ ...vehicleDraft, make: event.target.value })} /></label><label className="field"><span>Model</span><input required value={vehicleDraft.model} onChange={(event) => setVehicleDraft({ ...vehicleDraft, model: event.target.value })} /></label><label className="field"><span>Rok</span><input type="number" min="1950" max="2100" value={vehicleDraft.year} onChange={(event) => setVehicleDraft({ ...vehicleDraft, year: event.target.value })} /></label></div>
          <div className="form-grid form-grid--3"><label className="field"><span>Numer rejestracyjny</span><input value={vehicleDraft.plate} onChange={(event) => setVehicleDraft({ ...vehicleDraft, plate: event.target.value })} /></label><label className="field"><span>Przebieg (km)</span><input type="number" min="0" value={vehicleDraft.mileage} onChange={(event) => setVehicleDraft({ ...vehicleDraft, mileage: event.target.value })} /></label><label className="field"><span>Napęd</span><select value={vehicleDraft.fuelType} onChange={(event) => setVehicleDraft({ ...vehicleDraft, fuelType: event.target.value as Vehicle["fuelType"] })}><option value="petrol">Benzyna</option><option value="diesel">Diesel</option><option value="hybrid">Hybryda</option><option value="electric">Elektryczny</option></select></label></div>
          <div className="form-grid form-grid--2"><label className="field"><span>Ważność badania</span><input type="date" required value={vehicleDraft.inspectionDate} onChange={(event) => setVehicleDraft({ ...vehicleDraft, inspectionDate: event.target.value })} /></label><label className="field"><span>Ważność ubezpieczenia</span><input type="date" required value={vehicleDraft.insuranceDate} onChange={(event) => setVehicleDraft({ ...vehicleDraft, insuranceDate: event.target.value })} /></label></div>
          <div className="form-grid form-grid--2"><label className="field"><span>Widoczność</span><select value={vehicleDraft.visibility} onChange={(event) => setVehicleDraft({ ...vehicleDraft, visibility: event.target.value as Visibility })}><option value="household">Domownicy</option><option value="private">Tylko ja</option></select></label><label className="field"><span>Kolor</span><input className="module-color-input" type="color" value={vehicleDraft.color} onChange={(event) => setVehicleDraft({ ...vehicleDraft, color: event.target.value })} /></label></div>
          <div className="modal-actions"><button className="button button--ghost" type="button" onClick={() => setVehicleModalOpen(false)}>Anuluj</button><button className="button button--primary" type="submit">{editingVehicle ? "Zapisz zmiany" : "Dodaj pojazd"}</button></div>
        </form>
      </Modal>

      <Modal open={expenseModalOpen} onClose={() => setExpenseModalOpen(false)} title={expenseDraft.type === "fuel" ? "Dodaj tankowanie" : "Dodaj koszt"} eyebrow={selectedVehicle?.name ?? "Samochód"}>
        <form className="form-grid" onSubmit={saveExpense}>
          <div className="form-grid form-grid--2"><label className="field"><span>Rodzaj</span><select value={expenseDraft.type} onChange={(event) => { const type = event.target.value as CarExpense["type"]; setExpenseDraft((prev) => { const isGenericTitle = !prev.title.trim() || prev.title === expenseLabels[prev.type]; return { ...prev, type, title: isGenericTitle ? expenseLabels[type] : prev.title }; }); }}><option value="fuel">Tankowanie</option><option value="service">Serwis</option><option value="insurance">Ubezpieczenie</option><option value="parking">Parking</option><option value="other">Inne</option></select></label><label className="field"><span>Data</span><input required type="date" value={expenseDraft.date} onChange={(event) => setExpenseDraft({ ...expenseDraft, date: event.target.value })} /></label></div>
          <label className="field field--prominent"><span>Opis</span><input autoFocus required value={expenseDraft.title} onChange={(event) => setExpenseDraft({ ...expenseDraft, title: event.target.value })} placeholder="np. Tankowanie Orlen" /></label>
          <div className={expenseDraft.type === "fuel" ? "form-grid form-grid--3" : "form-grid form-grid--2"}><label className="field"><span>Kwota (PLN)</span><input inputMode="decimal" required value={expenseDraft.amount} onChange={(event) => setExpenseDraft({ ...expenseDraft, amount: event.target.value })} placeholder="250,00" /></label><label className="field"><span>Przebieg (km)</span><input type="number" min="0" value={expenseDraft.mileage} onChange={(event) => setExpenseDraft({ ...expenseDraft, mileage: event.target.value })} /></label>{expenseDraft.type === "fuel" && <label className="field"><span>Liczba litrów</span><input inputMode="decimal" value={expenseDraft.liters} onChange={(event) => setExpenseDraft({ ...expenseDraft, liters: event.target.value })} placeholder="42,1" /></label>}</div>
          <label className="field"><span>Widoczność</span><select value={expenseDraft.visibility} onChange={(event) => setExpenseDraft({ ...expenseDraft, visibility: event.target.value as Visibility })}><option value="household">Domownicy</option><option value="private">Tylko ja</option></select></label>
          <div className="modal-actions"><button className="button button--ghost" type="button" onClick={() => setExpenseModalOpen(false)}>Anuluj</button><button className="button button--primary" type="submit">Zapisz wpis</button></div>
        </form>
      </Modal>

      <Modal open={deadlineModalOpen} onClose={() => setDeadlineModalOpen(false)} title="Nowy termin" eyebrow={selectedVehicle?.name ?? "Samochód"} size="small">
        <form className="form-grid" onSubmit={addDeadline}>
          <label className="field field--prominent"><span>Co trzeba zrobić?</span><input autoFocus required value={deadlineDraft.title} onChange={(event) => setDeadlineDraft({ ...deadlineDraft, title: event.target.value })} placeholder="np. Wymiana opon" /></label>
          <div className="module-choice-divider"><span>Ustal datę, przebieg lub oba</span></div>
          <div className="form-grid form-grid--2"><label className="field"><span>Termin</span><input type="date" value={deadlineDraft.dueDate} onChange={(event) => setDeadlineDraft({ ...deadlineDraft, dueDate: event.target.value })} /></label><label className="field"><span>Przebieg (km)</span><input type="number" min="0" value={deadlineDraft.dueMileage} onChange={(event) => setDeadlineDraft({ ...deadlineDraft, dueMileage: event.target.value })} placeholder="75000" /></label></div>
          <div className="modal-actions"><button className="button button--ghost" type="button" onClick={() => setDeadlineModalOpen(false)}>Anuluj</button><button className="button button--primary" type="submit">Dodaj termin</button></div>
        </form>
      </Modal>
    </div>
  );
}

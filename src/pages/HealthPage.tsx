import {
  Activity,
  CalendarClock,
  Check,
  Clock3,
  HeartPulse,
  LockKeyhole,
  MapPin,
  Pencil,
  Pill,
  Plus,
  Power,
  Stethoscope,
  Trash2,
  Users,
} from "lucide-react";
import { addDays, format, parseISO } from "date-fns";
import { pl } from "date-fns/locale";
import { useMemo, useState, type FormEvent } from "react";
import type { Visibility } from "../advancedTypes";
import type {
  HealthAppointment,
  HealthMeasurement,
  HealthMeasurementType,
  Medication,
} from "../healthTypes";
import { Modal } from "../components/Modal";
import { dateKey, relativeDay } from "../lib/date";
import { useHealthStore } from "../store/useHealthStore";
import { useServerAuth } from "../server/AuthGate";
import "../styles/health.css";

interface HealthPageProps {
  onToast: (message: string) => void;
}

interface AppointmentDraft {
  title: string;
  clinician: string;
  specialty: string;
  date: string;
  time: string;
  location: string;
  notes: string;
  visibility: Visibility;
  status: HealthAppointment["status"];
}

interface MeasurementDraft {
  type: HealthMeasurementType;
  value: string;
  unit: string;
  date: string;
  time: string;
  notes: string;
  visibility: Visibility;
}

interface MedicationDraft {
  name: string;
  dosage: string;
  schedule: string;
  reminderTime: string;
  visibility: Visibility;
}

const measurementMeta: Record<HealthMeasurementType, { label: string; unit: string }> = {
  weight: { label: "Masa ciała", unit: "kg" },
  blood_pressure: { label: "Ciśnienie", unit: "mmHg" },
  glucose: { label: "Glukoza", unit: "mg/dl" },
  temperature: { label: "Temperatura", unit: "°C" },
  other: { label: "Inny pomiar", unit: "" },
};

const newAppointmentDraft = (): AppointmentDraft => ({
  title: "",
  clinician: "",
  specialty: "",
  date: format(addDays(new Date(), 7), "yyyy-MM-dd"),
  time: "10:00",
  location: "",
  notes: "",
  visibility: "private",
  status: "scheduled",
});

const newMeasurementDraft = (): MeasurementDraft => ({
  type: "weight",
  value: "",
  unit: measurementMeta.weight.unit,
  date: dateKey(),
  time: format(new Date(), "HH:mm"),
  notes: "",
  visibility: "private",
});

const newMedicationDraft = (): MedicationDraft => ({
  name: "",
  dosage: "",
  schedule: "Codziennie",
  reminderTime: "08:00",
  visibility: "private",
});

export function HealthPage({ onToast }: HealthPageProps) {
  const { snapshot } = useServerAuth();
  const currentOwnerId = snapshot?.user.id ?? "me";
  const healthAppointments = useHealthStore((state) => state.healthAppointments);
  const medications = useHealthStore((state) => state.medications);
  const healthMeasurements = useHealthStore((state) => state.healthMeasurements);
  const addHealthAppointment = useHealthStore((state) => state.addHealthAppointment);
  const updateHealthAppointment = useHealthStore((state) => state.updateHealthAppointment);
  const deleteHealthAppointment = useHealthStore((state) => state.deleteHealthAppointment);
  const addMedication = useHealthStore((state) => state.addMedication);
  const updateMedication = useHealthStore((state) => state.updateMedication);
  const deleteMedication = useHealthStore((state) => state.deleteMedication);
  const toggleMedicationTaken = useHealthStore((state) => state.toggleMedicationTaken);
  const toggleMedicationActive = useHealthStore((state) => state.toggleMedicationActive);
  const addHealthMeasurement = useHealthStore((state) => state.addHealthMeasurement);
  const updateHealthMeasurement = useHealthStore((state) => state.updateHealthMeasurement);
  const deleteHealthMeasurement = useHealthStore((state) => state.deleteHealthMeasurement);

  const [appointmentModalOpen, setAppointmentModalOpen] = useState(false);
  const [appointmentDraft, setAppointmentDraft] = useState<AppointmentDraft>(newAppointmentDraft);
  const [editingAppointment, setEditingAppointment] = useState<HealthAppointment | null>(null);
  const [measurementModalOpen, setMeasurementModalOpen] = useState(false);
  const [measurementDraft, setMeasurementDraft] = useState<MeasurementDraft>(newMeasurementDraft);
  const [editingMeasurement, setEditingMeasurement] = useState<HealthMeasurement | null>(null);
  const [medicationModalOpen, setMedicationModalOpen] = useState(false);
  const [medicationDraft, setMedicationDraft] = useState<MedicationDraft>(newMedicationDraft);
  const [editingMedication, setEditingMedication] = useState<Medication | null>(null);
  const today = dateKey();

  const appointments = useMemo(
    () =>
      [...healthAppointments].sort((a, b) => {
        const statusOrder = { scheduled: 0, completed: 1, cancelled: 2 };
        return (
          statusOrder[a.status] - statusOrder[b.status] ||
          `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)
        );
      }),
    [healthAppointments],
  );
  const nextAppointment = appointments.find(
    (appointment) => appointment.status === "scheduled" && appointment.date >= today,
  );
  const activeMedications = medications.filter((medication) => medication.active);
  const takenToday = activeMedications.filter(
    (medication) => medication.lastTakenOn === today,
  ).length;
  const measurements = useMemo(
    () => [...healthMeasurements].sort((a, b) => b.measuredAt.localeCompare(a.measuredAt)),
    [healthMeasurements],
  );

  const openAppointment = () => {
    setEditingAppointment(null);
    setAppointmentDraft(newAppointmentDraft());
    setAppointmentModalOpen(true);
  };

  const openAppointmentForEdit = (appointment: HealthAppointment) => {
    setEditingAppointment(appointment);
    setAppointmentDraft({
      title: appointment.title,
      clinician: appointment.clinician,
      specialty: appointment.specialty ?? "",
      date: appointment.date,
      time: appointment.time,
      location: appointment.location ?? "",
      notes: appointment.notes ?? "",
      visibility: appointment.visibility,
      status: appointment.status,
    });
    setAppointmentModalOpen(true);
  };

  const saveAppointment = (event: FormEvent) => {
    event.preventDefault();
    if (!appointmentDraft.title.trim() || !appointmentDraft.clinician.trim()) {
      onToast("Podaj nazwę wizyty i lekarza lub placówkę");
      return;
    }
    const data = {
      title: appointmentDraft.title.trim(),
      clinician: appointmentDraft.clinician.trim(),
      specialty: appointmentDraft.specialty.trim() || undefined,
      date: appointmentDraft.date,
      time: appointmentDraft.time,
      location: appointmentDraft.location.trim() || undefined,
      status: appointmentDraft.status,
      notes: appointmentDraft.notes.trim() || undefined,
      visibility: appointmentDraft.visibility,
    };
    if (editingAppointment) {
      updateHealthAppointment(editingAppointment.id, data);
      onToast("Zmiany w wizycie zostały zapisane");
    } else {
      addHealthAppointment({ ...data, ownerId: currentOwnerId });
      onToast("Wizyta została zapisana");
    }
    setAppointmentModalOpen(false);
  };

  const toggleAppointmentCompleted = (appointment: HealthAppointment) => {
    const completed = appointment.status !== "completed";
    updateHealthAppointment(appointment.id, { status: completed ? "completed" : "scheduled" });
    onToast(completed ? "Wizyta oznaczona jako odbyta" : "Wizyta wróciła do planu");
  };

  const openMedicationForEdit = (medication: Medication) => {
    setEditingMedication(medication);
    setMedicationDraft({
      name: medication.name,
      dosage: medication.dosage,
      schedule: medication.schedule,
      reminderTime: medication.reminderTime ?? "",
      visibility: medication.visibility,
    });
    setMedicationModalOpen(true);
  };

  const saveMedication = (event: FormEvent) => {
    event.preventDefault();
    if (!medicationDraft.name.trim() || !medicationDraft.dosage.trim()) {
      onToast("Podaj nazwę i dawkowanie");
      return;
    }
    const data = {
      name: medicationDraft.name.trim(),
      dosage: medicationDraft.dosage.trim(),
      schedule: medicationDraft.schedule.trim() || "Codziennie",
      reminderTime: medicationDraft.reminderTime || undefined,
      visibility: medicationDraft.visibility,
    };
    if (editingMedication) {
      updateMedication(editingMedication.id, data);
      onToast("Zmiany w leku zostały zapisane");
    } else {
      addMedication({ ...data, active: true, ownerId: currentOwnerId });
      onToast("Lek został dodany do rutyny");
    }
    setMedicationModalOpen(false);
  };

  const removeMedication = (medication: Medication) => {
    if (!window.confirm(`Usunąć „${medication.name}” z listy?`)) return;
    deleteMedication(medication.id);
    onToast("Lek został usunięty");
  };

  const removeAppointment = (appointment: HealthAppointment) => {
    if (!window.confirm(`Usunąć wizytę „${appointment.title}”?`)) return;
    deleteHealthAppointment(appointment.id);
    onToast("Wizyta została usunięta");
  };

  const openMeasurementForEdit = (measurement: HealthMeasurement) => {
    const [date, time] = measurement.measuredAt.split("T");
    setEditingMeasurement(measurement);
    setMeasurementDraft({
      type: measurement.type,
      value: measurement.value,
      unit: measurement.unit,
      date: date || dateKey(),
      time: time || format(new Date(), "HH:mm"),
      notes: measurement.notes ?? "",
      visibility: measurement.visibility,
    });
    setMeasurementModalOpen(true);
  };

  const saveMeasurement = (event: FormEvent) => {
    event.preventDefault();
    if (!measurementDraft.value.trim()) {
      onToast("Wpisz wartość pomiaru");
      return;
    }
    const data = {
      type: measurementDraft.type,
      value: measurementDraft.value.trim(),
      unit: measurementDraft.unit.trim(),
      measuredAt: `${measurementDraft.date}T${measurementDraft.time}`,
      notes: measurementDraft.notes.trim() || undefined,
      visibility: measurementDraft.visibility,
    };
    if (editingMeasurement) {
      updateHealthMeasurement(editingMeasurement.id, data);
      onToast("Zmiany w pomiarze zostały zapisane");
    } else {
      addHealthMeasurement({ ...data, ownerId: currentOwnerId });
      onToast("Pomiar został zapisany");
    }
    setMeasurementModalOpen(false);
  };

  const removeMeasurement = (measurementId: string) => {
    if (!window.confirm("Usunąć ten pomiar?")) return;
    deleteHealthMeasurement(measurementId);
    onToast("Pomiar został usunięty");
  };

  return (
    <div className="health-page page-enter">
      <header className="page-header health-header">
        <div>
          <span className="page-eyebrow">
            <HeartPulse size={14} /> Zdrowie — podstawy
          </span>
          <h1>Zdrowie</h1>
          <p>Wizyty, codzienne leki i najważniejsze pomiary w jednym prywatnym miejscu.</p>
        </div>
        <button className="button button--primary" type="button" onClick={openAppointment}>
          <Plus size={17} /> Dodaj wizytę
        </button>
      </header>

      <section className="health-summary" aria-label="Podsumowanie zdrowia">
        <article>
          <span className="health-summary__icon health-summary__icon--appointment">
            <CalendarClock size={19} />
          </span>
          <div>
            <small>Następna wizyta</small>
            <strong>{nextAppointment?.title ?? "Brak wizyt"}</strong>
            <span>
              {nextAppointment
                ? `${relativeDay(nextAppointment.date)} · ${nextAppointment.time}`
                : "Spokojny kalendarz"}
            </span>
          </div>
        </article>
        <article>
          <span className="health-summary__icon health-summary__icon--medication">
            <Pill size={19} />
          </span>
          <div>
            <small>Leki dzisiaj</small>
            <strong>
              {takenToday} z {activeMedications.length}
            </strong>
            <span>
              {activeMedications.length && takenToday === activeMedications.length
                ? "Wszystko przyjęte"
                : "Do sprawdzenia"}
            </span>
          </div>
        </article>
        <article>
          <span className="health-summary__icon health-summary__icon--measurement">
            <Activity size={19} />
          </span>
          <div>
            <small>Ostatni pomiar</small>
            <strong>
              {measurements[0]
                ? `${measurements[0].value} ${measurements[0].unit}`.trim()
                : "Brak danych"}
            </strong>
            <span>
              {measurements[0]
                ? measurementMeta[measurements[0].type].label
                : "Dodaj pierwszy pomiar"}
            </span>
          </div>
        </article>
      </section>

      <div className="health-grid">
        <section className="panel health-panel health-appointments">
          <header className="health-panel__header">
            <div>
              <span className="section-kicker">
                <Stethoscope size={14} /> Opieka
              </span>
              <h2>Wizyty i badania</h2>
            </div>
            <button
              className="button button--soft button--small"
              type="button"
              onClick={openAppointment}
            >
              <Plus size={15} /> Dodaj
            </button>
          </header>
          <div className="health-appointment-list">
            {appointments.map((appointment) => (
              <article
                className={`health-appointment health-appointment--${appointment.status}`}
                key={appointment.id}
              >
                <div className="health-date-badge">
                  <strong>{format(parseISO(appointment.date), "d")}</strong>
                  <span>{format(parseISO(appointment.date), "MMM", { locale: pl })}</span>
                </div>
                <div className="health-appointment__main">
                  <div>
                    <strong>{appointment.title}</strong>
                    <span className="health-visibility">
                      {appointment.visibility === "private" ? (
                        <LockKeyhole size={11} />
                      ) : (
                        <Users size={11} />
                      )}
                      {appointment.visibility === "private" ? "Tylko ja" : "Domownicy"}
                    </span>
                  </div>
                  <span>
                    {appointment.clinician}
                    {appointment.specialty ? ` · ${appointment.specialty}` : ""}
                  </span>
                  <small>
                    <Clock3 size={12} /> {appointment.time}
                    {appointment.location && (
                      <>
                        <MapPin size={12} /> {appointment.location}
                      </>
                    )}
                  </small>
                </div>
                <div className="health-appointment__actions">
                  <button
                    className={
                      appointment.status === "completed"
                        ? "health-complete active"
                        : "health-complete"
                    }
                    type="button"
                    onClick={() => toggleAppointmentCompleted(appointment)}
                    aria-pressed={appointment.status === "completed"}
                  >
                    <Check size={14} />{" "}
                    {appointment.status === "completed" ? "Odbyta" : "Oznacz odbytą"}
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() => openAppointmentForEdit(appointment)}
                    aria-label={`Edytuj wizytę ${appointment.title}`}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button module-danger-icon"
                    type="button"
                    onClick={() => removeAppointment(appointment)}
                    aria-label={`Usuń wizytę ${appointment.title}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            ))}
            {!appointments.length && (
              <div className="health-empty">
                <CalendarClock size={22} />
                <strong>Brak zaplanowanych wizyt</strong>
                <span>Dodaj termin, aby mieć go zawsze pod ręką.</span>
              </div>
            )}
          </div>
        </section>

        <section className="panel health-panel health-medications">
          <header className="health-panel__header">
            <div>
              <span className="section-kicker">
                <Pill size={14} /> Rutyna
              </span>
              <h2>Leki i suplementy</h2>
            </div>
            <button
              className="button button--soft button--small"
              type="button"
              onClick={() => {
                setEditingMedication(null);
                setMedicationDraft(newMedicationDraft());
                setMedicationModalOpen(true);
              }}
            >
              <Plus size={15} /> Dodaj
            </button>
          </header>
          <div className="health-medication-list">
            {medications.map((medication) => {
              const taken = medication.lastTakenOn === today;
              return (
                <article
                  className={
                    medication.active
                      ? "health-medication"
                      : "health-medication health-medication--inactive"
                  }
                  key={medication.id}
                >
                  <span className="health-medication__icon">
                    <Pill size={17} />
                  </span>
                  <div>
                    <div className="health-medication__title">
                      <strong>{medication.name}</strong>
                      <span className="health-visibility">
                        {medication.visibility === "private" ? (
                          <LockKeyhole size={11} />
                        ) : (
                          <Users size={11} />
                        )}
                        {medication.visibility === "private" ? "Tylko ja" : "Domownicy"}
                      </span>
                    </div>
                    <span>
                      {medication.dosage} · {medication.schedule}
                      {medication.reminderTime ? ` · ${medication.reminderTime}` : ""}
                    </span>
                  </div>
                  <button
                    className={taken ? "health-taken active" : "health-taken"}
                    type="button"
                    disabled={!medication.active}
                    onClick={() => toggleMedicationTaken(medication.id, today)}
                    aria-pressed={taken}
                  >
                    {taken ? <Check size={14} /> : <CircleMark />}
                    {taken ? "Przyjęte" : "Oznacz"}
                  </button>
                  <div className="health-medication__actions">
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => openMedicationForEdit(medication)}
                      aria-label={`Edytuj ${medication.name}`}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className={
                        medication.active
                          ? "icon-button health-active-toggle active"
                          : "icon-button health-active-toggle"
                      }
                      type="button"
                      onClick={() => toggleMedicationActive(medication.id)}
                      aria-label={
                        medication.active
                          ? `Wstrzymaj ${medication.name}`
                          : `Aktywuj ${medication.name}`
                      }
                      aria-pressed={medication.active}
                    >
                      <Power size={15} />
                    </button>
                    <button
                      className="icon-button module-danger-icon"
                      type="button"
                      onClick={() => removeMedication(medication)}
                      aria-label={`Usuń ${medication.name}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </article>
              );
            })}
            {!medications.length && (
              <div className="health-empty">
                <Pill size={22} />
                <strong>Brak leków</strong>
                <span>Lista codziennej rutyny jest pusta.</span>
              </div>
            )}
          </div>
          <p className="health-disclaimer">
            Puls pomaga pamiętać, ale nie zastępuje porady lekarza ani informacji na recepcie.
          </p>
        </section>

        <section className="panel health-panel health-measurements">
          <header className="health-panel__header">
            <div>
              <span className="section-kicker">
                <Activity size={14} /> Dziennik
              </span>
              <h2>Pomiary</h2>
            </div>
            <button
              className="button button--soft button--small"
              type="button"
              onClick={() => {
                setEditingMeasurement(null);
                setMeasurementDraft(newMeasurementDraft());
                setMeasurementModalOpen(true);
              }}
            >
              <Plus size={15} /> Nowy pomiar
            </button>
          </header>
          <div className="health-measurement-list">
            {measurements.slice(0, 8).map((measurement) => (
              <article className="health-measurement" key={measurement.id}>
                <span className="health-measurement__icon">
                  <Activity size={17} />
                </span>
                <div>
                  <small>{measurementMeta[measurement.type].label}</small>
                  <strong>
                    {measurement.value} <span>{measurement.unit}</span>
                  </strong>
                </div>
                <time>
                  {format(parseISO(measurement.measuredAt), "d MMM yyyy, HH:mm", { locale: pl })}
                </time>
                <span className="health-visibility">
                  {measurement.visibility === "private" ? (
                    <LockKeyhole size={11} />
                  ) : (
                    <Users size={11} />
                  )}
                  {measurement.visibility === "private" ? "Prywatny" : "Wspólny"}
                </span>
                <div className="health-measurement__actions">
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() => openMeasurementForEdit(measurement)}
                    aria-label={`Edytuj pomiar ${measurementMeta[measurement.type].label}`}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button module-danger-icon"
                    type="button"
                    onClick={() => removeMeasurement(measurement.id)}
                    aria-label={`Usuń pomiar ${measurementMeta[measurement.type].label}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            ))}
            {!measurements.length && (
              <div className="health-empty">
                <Activity size={22} />
                <strong>Brak pomiarów</strong>
                <span>Zapisz wartość, którą chcesz obserwować w czasie.</span>
              </div>
            )}
          </div>
        </section>
      </div>

      <Modal
        open={appointmentModalOpen}
        onClose={() => setAppointmentModalOpen(false)}
        title={editingAppointment ? "Edytuj wizytę" : "Nowa wizyta"}
        eyebrow="Zdrowie"
        size="large"
      >
        <form className="health-form" onSubmit={saveAppointment}>
          <label className="field field--prominent">
            <span>Nazwa wizyty lub badania</span>
            <input
              autoFocus
              required
              value={appointmentDraft.title}
              onChange={(event) =>
                setAppointmentDraft({ ...appointmentDraft, title: event.target.value })
              }
              placeholder="np. Kontrola u okulisty"
            />
          </label>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Lekarz lub placówka</span>
              <input
                required
                value={appointmentDraft.clinician}
                onChange={(event) =>
                  setAppointmentDraft({ ...appointmentDraft, clinician: event.target.value })
                }
                placeholder="Nazwisko albo nazwa placówki"
              />
            </label>
            <label className="field">
              <span>Specjalizacja</span>
              <input
                value={appointmentDraft.specialty}
                onChange={(event) =>
                  setAppointmentDraft({ ...appointmentDraft, specialty: event.target.value })
                }
                placeholder="Opcjonalnie"
              />
            </label>
          </div>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Data</span>
              <input
                required
                type="date"
                value={appointmentDraft.date}
                onChange={(event) =>
                  setAppointmentDraft({ ...appointmentDraft, date: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Godzina</span>
              <input
                required
                type="time"
                value={appointmentDraft.time}
                onChange={(event) =>
                  setAppointmentDraft({ ...appointmentDraft, time: event.target.value })
                }
              />
            </label>
          </div>
          <label className="field">
            <span>Miejsce</span>
            <input
              value={appointmentDraft.location}
              onChange={(event) =>
                setAppointmentDraft({ ...appointmentDraft, location: event.target.value })
              }
              placeholder="Adres lub nazwa gabinetu"
            />
          </label>
          {editingAppointment && (
            <label className="field">
              <span>Status</span>
              <select
                value={appointmentDraft.status}
                onChange={(event) =>
                  setAppointmentDraft({
                    ...appointmentDraft,
                    status: event.target.value as HealthAppointment["status"],
                  })
                }
              >
                <option value="scheduled">Zaplanowana</option>
                <option value="completed">Odbyta</option>
                <option value="cancelled">Anulowana</option>
              </select>
            </label>
          )}
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Widoczność</span>
              <select
                value={appointmentDraft.visibility}
                onChange={(event) =>
                  setAppointmentDraft({
                    ...appointmentDraft,
                    visibility: event.target.value as Visibility,
                  })
                }
              >
                <option value="private">Tylko ja</option>
                <option value="household">Domownicy</option>
              </select>
            </label>
            <label className="field">
              <span>Notatka</span>
              <input
                value={appointmentDraft.notes}
                onChange={(event) =>
                  setAppointmentDraft({ ...appointmentDraft, notes: event.target.value })
                }
                placeholder="np. przygotowanie do badania"
              />
            </label>
          </div>
          <div className="health-private-note">
            <LockKeyhole size={15} />
            <span>Nowe dane zdrowotne są domyślnie prywatne.</span>
          </div>
          <div className="modal-actions">
            <span />
            <div>
              <button
                className="button button--ghost"
                type="button"
                onClick={() => setAppointmentModalOpen(false)}
              >
                Anuluj
              </button>
              <button className="button button--primary" type="submit">
                {editingAppointment ? "Zapisz zmiany" : "Zapisz wizytę"}
              </button>
            </div>
          </div>
        </form>
      </Modal>

      <Modal
        open={measurementModalOpen}
        onClose={() => setMeasurementModalOpen(false)}
        title={editingMeasurement ? "Edytuj pomiar" : "Nowy pomiar"}
        eyebrow="Dziennik zdrowia"
      >
        <form className="health-form" onSubmit={saveMeasurement}>
          <label className="field">
            <span>Rodzaj</span>
            <select
              value={measurementDraft.type}
              onChange={(event) => {
                const type = event.target.value as HealthMeasurementType;
                setMeasurementDraft({
                  ...measurementDraft,
                  type,
                  unit: measurementMeta[type].unit,
                });
              }}
            >
              {Object.entries(measurementMeta).map(([value, meta]) => (
                <option value={value} key={value}>
                  {meta.label}
                </option>
              ))}
            </select>
          </label>
          <div className="form-grid form-grid--2">
            <label className="field field--prominent">
              <span>Wartość</span>
              <input
                autoFocus
                required
                inputMode="decimal"
                value={measurementDraft.value}
                onChange={(event) =>
                  setMeasurementDraft({ ...measurementDraft, value: event.target.value })
                }
                placeholder={measurementDraft.type === "blood_pressure" ? "120/80" : "0,0"}
              />
            </label>
            <label className="field">
              <span>Jednostka</span>
              <input
                value={measurementDraft.unit}
                onChange={(event) =>
                  setMeasurementDraft({ ...measurementDraft, unit: event.target.value })
                }
                placeholder={
                  measurementMeta[measurementDraft.type].unit
                    ? `np. ${measurementMeta[measurementDraft.type].unit}`
                    : "np. szt."
                }
              />
            </label>
          </div>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Data</span>
              <input
                required
                type="date"
                value={measurementDraft.date}
                onChange={(event) =>
                  setMeasurementDraft({ ...measurementDraft, date: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Godzina</span>
              <input
                required
                type="time"
                value={measurementDraft.time}
                onChange={(event) =>
                  setMeasurementDraft({ ...measurementDraft, time: event.target.value })
                }
              />
            </label>
          </div>
          <label className="field">
            <span>Notatka</span>
            <input
              value={measurementDraft.notes}
              onChange={(event) =>
                setMeasurementDraft({ ...measurementDraft, notes: event.target.value })
              }
              placeholder="Opcjonalny kontekst pomiaru"
            />
          </label>
          <label className="field">
            <span>Widoczność</span>
            <select
              value={measurementDraft.visibility}
              onChange={(event) =>
                setMeasurementDraft({
                  ...measurementDraft,
                  visibility: event.target.value as Visibility,
                })
              }
            >
              <option value="private">Tylko ja</option>
              <option value="household">Domownicy</option>
            </select>
          </label>
          <div className="modal-actions">
            <span />
            <div>
              <button
                className="button button--ghost"
                type="button"
                onClick={() => setMeasurementModalOpen(false)}
              >
                Anuluj
              </button>
              <button className="button button--primary" type="submit">
                {editingMeasurement ? "Zapisz zmiany" : "Zapisz pomiar"}
              </button>
            </div>
          </div>
        </form>
      </Modal>

      <Modal
        open={medicationModalOpen}
        onClose={() => setMedicationModalOpen(false)}
        title={editingMedication ? "Edytuj lek" : "Nowy lek lub suplement"}
        eyebrow="Codzienna rutyna"
      >
        <form className="health-form" onSubmit={saveMedication}>
          <label className="field field--prominent">
            <span>Nazwa</span>
            <input
              autoFocus
              required
              value={medicationDraft.name}
              onChange={(event) =>
                setMedicationDraft({ ...medicationDraft, name: event.target.value })
              }
              placeholder="np. Witamina D3"
            />
          </label>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Dawkowanie</span>
              <input
                required
                value={medicationDraft.dosage}
                onChange={(event) =>
                  setMedicationDraft({ ...medicationDraft, dosage: event.target.value })
                }
                placeholder="np. 1 tabletka"
              />
            </label>
            <label className="field">
              <span>Codzienne przypomnienie</span>
              <input
                type="time"
                value={medicationDraft.reminderTime}
                onChange={(event) =>
                  setMedicationDraft({ ...medicationDraft, reminderTime: event.target.value })
                }
              />
              <small>Jeśli ustawisz godzinę, Puls przypomni raz dziennie.</small>
            </label>
          </div>
          <label className="field">
            <span>Opis schematu</span>
            <input
              value={medicationDraft.schedule}
              onChange={(event) =>
                setMedicationDraft({ ...medicationDraft, schedule: event.target.value })
              }
              placeholder="np. codziennie po śniadaniu"
            />
            <small>To notatka informacyjna; nie zmienia częstotliwości powiadomienia.</small>
          </label>
          <label className="field">
            <span>Widoczność</span>
            <select
              value={medicationDraft.visibility}
              onChange={(event) =>
                setMedicationDraft({
                  ...medicationDraft,
                  visibility: event.target.value as Visibility,
                })
              }
            >
              <option value="private">Tylko ja</option>
              <option value="household">Domownicy</option>
            </select>
          </label>
          <div className="health-private-note">
            <LockKeyhole size={15} />
            <span>Informacje o lekach są domyślnie prywatne.</span>
          </div>
          <div className="modal-actions">
            <span />
            <div>
              <button
                className="button button--ghost"
                type="button"
                onClick={() => setMedicationModalOpen(false)}
              >
                Anuluj
              </button>
              <button className="button button--primary" type="submit">
                {editingMedication ? "Zapisz zmiany" : "Dodaj do rutyny"}
              </button>
            </div>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function CircleMark() {
  return <span className="health-circle-mark" aria-hidden="true" />;
}

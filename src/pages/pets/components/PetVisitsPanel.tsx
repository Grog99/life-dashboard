import { Check, Pencil, Plus, Stethoscope, Trash2 } from "lucide-react";
import type { PetVisit } from "../../../advancedTypes";
import { relativeDay } from "../../../lib/date";

interface PetVisitsPanelProps {
  selectedVisits: PetVisit[];
  onToggle: (visitId: string) => void;
  onEdit: (visit: PetVisit) => void;
  onRemove: (visit: PetVisit) => void;
  onAdd: () => void;
}

export function PetVisitsPanel({ selectedVisits, onToggle, onEdit, onRemove, onAdd }: PetVisitsPanelProps) {
  return (
    <section className="panel module-panel deadlines-panel">
      <header className="module-panel__header">
        <div>
          <span className="section-kicker">
            <Stethoscope size={14} /> Opieka
          </span>
          <h2>Wizyty u weterynarza</h2>
        </div>
        <button className="icon-button" type="button" onClick={onAdd} aria-label="Dodaj wizytę">
          <Plus size={18} />
        </button>
      </header>
      <div className="deadline-list">
        {selectedVisits.map((visit) => (
          <article
            className={`deadline-row ${visit.status !== "scheduled" ? "deadline-row--done" : ""}`}
            key={visit.id}
          >
            <button
              type="button"
              onClick={() => onToggle(visit.id)}
              aria-label={
                visit.status === "completed" ? `Przywróć ${visit.title}` : `Oznacz odbytą ${visit.title}`
              }
              aria-pressed={visit.status === "completed"}
            >
              <Check size={13} />
            </button>
            <div>
              <strong>{visit.title}</strong>
              <span>
                {relativeDay(visit.date)} · {visit.time} · {visit.clinician}
                {visit.location ? ` · ${visit.location}` : ""}
              </span>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={() => onEdit(visit)}
              aria-label={`Edytuj wizytę ${visit.title}`}
            >
              <Pencil size={13} />
            </button>
            <button
              className="icon-button module-danger-icon"
              type="button"
              onClick={() => onRemove(visit)}
              aria-label={`Usuń wizytę ${visit.title}`}
            >
              <Trash2 size={14} />
            </button>
          </article>
        ))}
        {!selectedVisits.length && (
          <div className="module-mini-empty">
            <Check size={16} />
            <span>Brak zaplanowanych wizyt.</span>
          </div>
        )}
      </div>
    </section>
  );
}

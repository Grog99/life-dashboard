import type { Dispatch, FormEvent, SetStateAction } from "react";
import { Modal } from "../../../components/Modal";
import type { Pet, PetVisit, Visibility } from "../../../advancedTypes";
import type { VisitDraft } from "../petConstants";

interface PetVisitFormModalProps {
  open: boolean;
  onClose: () => void;
  draft: VisitDraft;
  setDraft: Dispatch<SetStateAction<VisitDraft>>;
  editingVisit: PetVisit | null;
  selectedPet: Pet | undefined;
  onSubmit: (event: FormEvent) => void;
}

export function PetVisitFormModal({
  open,
  onClose,
  draft,
  setDraft,
  editingVisit,
  selectedPet,
  onSubmit,
}: PetVisitFormModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingVisit ? "Edytuj wizytę" : "Nowa wizyta"}
      eyebrow={selectedPet?.name ?? "Zwierzęta"}
      size="large"
    >
      <form className="form-grid" onSubmit={onSubmit}>
        <label className="field field--prominent">
          <span>Nazwa wizyty</span>
          <input
            autoFocus
            required
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder="np. Szczepienie"
          />
        </label>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Weterynarz / placówka</span>
            <input
              required
              value={draft.clinician}
              onChange={(event) => setDraft({ ...draft, clinician: event.target.value })}
              placeholder="Nazwisko albo nazwa placówki"
            />
          </label>
          <label className="field">
            <span>Specjalizacja</span>
            <input
              value={draft.specialty}
              onChange={(event) => setDraft({ ...draft, specialty: event.target.value })}
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
              value={draft.date}
              onChange={(event) => setDraft({ ...draft, date: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Godzina</span>
            <input
              required
              type="time"
              value={draft.time}
              onChange={(event) => setDraft({ ...draft, time: event.target.value })}
            />
          </label>
        </div>
        <label className="field">
          <span>Miejsce</span>
          <input
            value={draft.location}
            onChange={(event) => setDraft({ ...draft, location: event.target.value })}
            placeholder="Adres lub nazwa gabinetu"
          />
        </label>
        {editingVisit && (
          <label className="field">
            <span>Status</span>
            <select
              value={draft.status}
              onChange={(event) =>
                setDraft({ ...draft, status: event.target.value as PetVisit["status"] })
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
              value={draft.visibility}
              onChange={(event) =>
                setDraft({ ...draft, visibility: event.target.value as Visibility })
              }
            >
              <option value="household">Domownicy</option>
              <option value="private">Tylko ja</option>
            </select>
          </label>
          <label className="field">
            <span>Notatka</span>
            <input
              value={draft.notes}
              onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
              placeholder="np. zabrać książeczkę zdrowia"
            />
          </label>
        </div>
        <div className="modal-actions">
          <span />
          <div>
            <button className="button button--ghost" type="button" onClick={onClose}>
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              {editingVisit ? "Zapisz zmiany" : "Zapisz wizytę"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

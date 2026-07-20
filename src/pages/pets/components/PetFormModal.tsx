import type { Dispatch, FormEvent, SetStateAction } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "../../../components/Modal";
import type { Pet, PetKind, Visibility } from "../../../advancedTypes";
import type { FishRow, PetDraft } from "../petConstants";

interface PetFormModalProps {
  open: boolean;
  onClose: () => void;
  draft: PetDraft;
  setDraft: Dispatch<SetStateAction<PetDraft>>;
  editingPet: Pet | null;
  onSubmit: (event: FormEvent) => void;
  addFishRow: () => void;
  updateFishRow: (id: string, changes: Partial<FishRow>) => void;
  removeFishRow: (id: string) => void;
}

export function PetFormModal({
  open,
  onClose,
  draft,
  setDraft,
  editingPet,
  onSubmit,
  addFishRow,
  updateFishRow,
  removeFishRow,
}: PetFormModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingPet ? "Edytuj profil" : "Nowe zwierzę"}
      eyebrow="Zwierzęta"
      size="large"
    >
      <form className="form-grid" onSubmit={onSubmit}>
        <label className="field field--prominent">
          <span>Imię lub nazwa</span>
          <input
            autoFocus
            required
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="np. Fistaszek"
          />
        </label>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Rodzaj profilu</span>
            <select
              value={draft.kind}
              onChange={(event) => setDraft({ ...draft, kind: event.target.value as PetKind })}
            >
              <option value="rabbit">Królik</option>
              <option value="dog">Pies</option>
              <option value="cat">Kot</option>
              <option value="guinea_pig">Świnka morska</option>
              <option value="aquarium">Akwarium</option>
              <option value="other">Inne</option>
            </select>
          </label>
          <label className="field">
            <span>Kolor karty</span>
            <input
              className="module-color-input"
              type="color"
              value={draft.color}
              onChange={(event) => setDraft({ ...draft, color: event.target.value })}
            />
          </label>
        </div>

        {draft.kind === "aquarium" ? (
          <div className="pet-fish-editor">
            <div className="module-choice-divider">
              <span>Obsada akwarium</span>
            </div>
            {draft.fishStock.map((row) => (
              <div className="pet-fish-editor__row" key={row.id}>
                <input
                  value={row.species}
                  onChange={(event) => updateFishRow(row.id, { species: event.target.value })}
                  placeholder="Gatunek ryby, np. Neonek innesa"
                />
                <input
                  inputMode="numeric"
                  value={row.count}
                  onChange={(event) => updateFishRow(row.id, { count: event.target.value })}
                  placeholder="Liczba"
                />
                <button
                  type="button"
                  className="icon-button module-danger-icon"
                  onClick={() => removeFishRow(row.id)}
                  aria-label="Usuń gatunek"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button button--soft button--small"
              onClick={addFishRow}
            >
              <Plus size={14} /> Dodaj gatunek
            </button>
          </div>
        ) : (
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Gatunek / rasa</span>
              <input
                value={draft.species}
                onChange={(event) => setDraft({ ...draft, species: event.target.value })}
                placeholder="np. Królik miniaturka"
              />
            </label>
            <label className="field">
              <span>Data urodzenia</span>
              <input
                type="date"
                value={draft.birthDate}
                onChange={(event) => setDraft({ ...draft, birthDate: event.target.value })}
              />
            </label>
          </div>
        )}

        <label className="field">
          <span>Notatki</span>
          <input
            value={draft.notes}
            onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
            placeholder="Opcjonalne informacje"
          />
        </label>
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
        <div className="modal-actions">
          <button className="button button--ghost" type="button" onClick={onClose}>
            Anuluj
          </button>
          <button className="button button--primary" type="submit">
            {editingPet ? "Zapisz zmiany" : "Dodaj zwierzę"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

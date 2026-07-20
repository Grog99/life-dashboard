import { Cake, Fish, PawPrint, Pencil, Trash2 } from "lucide-react";
import type { Pet } from "../../../advancedTypes";
import { formatShortDate } from "../../../lib/date";
import { fishStockCount, kindLabels, petAgeLabel } from "../petConstants";

interface PetProfileCardProps {
  selectedPet: Pet;
  isAquarium: boolean;
  onEdit: () => void;
  onRemove: () => void;
}

export function PetProfileCard({ selectedPet, isAquarium, onEdit, onRemove }: PetProfileCardProps) {
  return (
    <section className="panel module-panel pet-overview-card">
      <header>
        <span className="pet-overview-icon" style={{ background: selectedPet.color }}>
          {isAquarium ? <Fish size={24} /> : <PawPrint size={24} />}
        </span>
        <div>
          <span>{kindLabels[selectedPet.kind]}</span>
          <h2>{selectedPet.name}</h2>
          <p>
            {isAquarium
              ? `${fishStockCount(selectedPet.fishStock)} ryb w obsadzie`
              : selectedPet.species || "Bez podanego gatunku"}
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onEdit}
          aria-label="Edytuj profil zwierzęcia"
        >
          <Pencil size={17} />
        </button>
      </header>

      {isAquarium ? (
        <div className="pet-fish-list">
          {(selectedPet.fishStock ?? []).map((entry) => (
            <div className="pet-fish-row" key={entry.id}>
              <Fish size={14} />
              <span>{entry.species}</span>
              <strong>{entry.count} szt.</strong>
            </div>
          ))}
          {!(selectedPet.fishStock ?? []).length && (
            <p className="pet-empty-note">Dodaj gatunki ryb w edycji profilu.</p>
          )}
        </div>
      ) : (
        <div className="pet-date-grid">
          <div>
            <Cake size={16} />
            <span>Data urodzenia</span>
            <strong>
              {selectedPet.birthDate ? formatShortDate(selectedPet.birthDate) : "Nieznana"}
            </strong>
          </div>
          <div>
            <PawPrint size={16} />
            <span>Wiek</span>
            <strong>{petAgeLabel(selectedPet.birthDate)}</strong>
          </div>
        </div>
      )}
      {selectedPet.notes && <p className="pet-notes">{selectedPet.notes}</p>}
      <button className="text-button pet-remove-link" type="button" onClick={onRemove}>
        <Trash2 size={14} /> Usuń profil
      </button>
    </section>
  );
}

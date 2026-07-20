import type { CSSProperties } from "react";
import { Fish, PawPrint, Plus } from "lucide-react";
import type { Pet } from "../../../advancedTypes";
import { fishStockCount, kindLabels, petAgeLabel } from "../petConstants";

interface PetStripProps {
  pets: Pet[];
  selectedPetId: string | undefined;
  onSelect: (petId: string) => void;
  onAddPet: () => void;
}

export function PetStrip({ pets, selectedPetId, onSelect, onAddPet }: PetStripProps) {
  return (
    <section className="pet-strip" aria-label="Twoje zwierzęta">
      {pets.map((pet) => {
        const KindIcon = pet.kind === "aquarium" ? Fish : PawPrint;
        return (
          <button
            className={selectedPetId === pet.id ? "pet-card pet-card--active" : "pet-card"}
            type="button"
            key={pet.id}
            onClick={() => onSelect(pet.id)}
            style={{ "--pet-color": pet.color } as CSSProperties}
          >
            <span className="pet-card__icon">
              <KindIcon size={22} />
            </span>
            <div>
              <strong>{pet.name}</strong>
              <span>{kindLabels[pet.kind]}</span>
              <small>
                {pet.kind === "aquarium"
                  ? `${fishStockCount(pet.fishStock)} ryb`
                  : petAgeLabel(pet.birthDate)}
              </small>
            </div>
          </button>
        );
      })}
      <button className="pet-add" type="button" onClick={onAddPet}>
        <Plus size={20} />
        <span>Dodaj zwierzę</span>
      </button>
    </section>
  );
}

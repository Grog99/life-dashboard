import { Globe2, Plane, Plus } from "lucide-react";
import type { Trip } from "../../../advancedTypes";
import { NewTripModal } from "./NewTripModal";

interface TripsEmptyStateProps {
  open: boolean;
  onOpenModal: () => void;
  onClose: () => void;
  onCreate: (trip: Omit<Trip, "id" | "updatedAt" | "version" | "progress">) => void;
}

// Ekran „brak podróży" (early return z TripsPage, gdy lista wyjazdów jest pusta).
export function TripsEmptyState({ open, onOpenModal, onClose, onCreate }: TripsEmptyStateProps) {
  return (
    <div className="trips-page page-enter">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">
            <Globe2 size={14} /> Podróże
          </span>
          <h1>Zaplanuj następny wyjazd</h1>
          <p>Zbierz plan, rezerwacje, budżet i listę rzeczy w jednym spokojnym miejscu.</p>
        </div>
        <button className="button button--primary" type="button" onClick={onOpenModal}>
          <Plus size={17} /> Nowa podróż
        </button>
      </header>
      <section className="panel trips-empty">
        <span>
          <Plane size={26} />
        </span>
        <h2>Dokąd jedziemy?</h2>
        <p>Dodaj pierwszy pomysł. Daty i budżet możesz później dopracować.</p>
        <button className="button button--primary" type="button" onClick={onOpenModal}>
          <Plus size={16} /> Utwórz podróż
        </button>
      </section>
      <NewTripModal open={open} onClose={onClose} onCreate={onCreate} />
    </div>
  );
}

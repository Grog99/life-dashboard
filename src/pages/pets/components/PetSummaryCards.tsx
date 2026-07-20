import { CalendarClock, CircleDollarSign, Fish, PawPrint } from "lucide-react";
import type { Pet, PetVisit } from "../../../advancedTypes";
import { StatCard } from "../../../components/StatCard";
import { formatMoney } from "../../../lib/money";
import { relativeDay } from "../../../lib/date";
import { fishStockCount, kindLabels, petAgeLabel } from "../petConstants";

interface PetSummaryCardsProps {
  selectedPet: Pet;
  isAquarium: boolean;
  monthlyCost: number;
  monthCount: number;
  nextVisit: PetVisit | undefined;
  hideAmounts: boolean;
}

export function PetSummaryCards({
  selectedPet,
  isAquarium,
  monthlyCost,
  monthCount,
  nextVisit,
  hideAmounts,
}: PetSummaryCardsProps) {
  return (
    <section className="module-stat-grid module-stat-grid--three" aria-label="Podsumowanie zwierzęcia">
      <StatCard
        accent
        icon={isAquarium ? Fish : PawPrint}
        label={isAquarium ? "Obsada akwarium" : "Wiek"}
        value={isAquarium ? `${fishStockCount(selectedPet.fishStock)} ryb` : petAgeLabel(selectedPet.birthDate)}
        sub={
          isAquarium
            ? `${(selectedPet.fishStock ?? []).length} gatunków`
            : selectedPet.species || kindLabels[selectedPet.kind]
        }
      />
      <StatCard
        icon={CircleDollarSign}
        iconTone="amber"
        label="Koszty w tym miesiącu"
        value={formatMoney(monthlyCost, "PLN", hideAmounts)}
        sub={`${monthCount} wpisów`}
      />
      <StatCard
        icon={CalendarClock}
        iconTone="violet"
        label="Najbliższa wizyta"
        value={nextVisit ? relativeDay(nextVisit.date) : "Brak"}
        sub={nextVisit ? `${nextVisit.title} · ${nextVisit.time}` : "Wszystko spokojnie"}
      />
    </section>
  );
}

import type { FormEvent } from "react";
import { BaggageClaim, Check, Circle, Luggage, Plus } from "lucide-react";
import type { PackingItem } from "../../../advancedTypes";
import { packingLabels } from "../tripConstants";

interface TripPackingViewProps {
  packing: PackingItem[];
  packingProgress: number;
  travelers: string[];
  packingName: string;
  setPackingName: (value: string) => void;
  packingCategory: PackingItem["category"];
  setPackingCategory: (value: PackingItem["category"]) => void;
  packingAssignee: string;
  setPackingAssignee: (value: string) => void;
  onAdd: (event: FormEvent<HTMLFormElement>) => void;
  onToggle: (itemId: string) => void;
}

export function TripPackingView({
  packing,
  packingProgress,
  travelers,
  packingName,
  setPackingName,
  packingCategory,
  setPackingCategory,
  packingAssignee,
  setPackingAssignee,
  onAdd,
  onToggle,
}: TripPackingViewProps) {
  return (
    <section className="panel trips-section trips-packing">
      <header className="trips-section__header">
        <div>
          <span className="section-kicker">
            <BaggageClaim size={14} /> Lista rzeczy
          </span>
          <h2>Pakowanie</h2>
          <p>Wspólna lista z jasnym podziałem, kto zabiera co.</p>
        </div>
        <div className="trips-packing__progress">
          <span>
            <i style={{ width: `${packingProgress}%` }} />
          </span>
          <strong>{packingProgress}%</strong>
        </div>
      </header>
      <form className="trips-packing-add" onSubmit={onAdd}>
        <label>
          <span className="sr-only">Nazwa rzeczy</span>
          <input
            value={packingName}
            onChange={(event) => setPackingName(event.target.value)}
            placeholder="Co trzeba spakować?"
          />
        </label>
        <label>
          <span className="sr-only">Kategoria</span>
          <select
            value={packingCategory}
            onChange={(event) => setPackingCategory(event.target.value as PackingItem["category"])}
          >
            {Object.entries(packingLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Osoba</span>
          <select
            value={packingAssignee}
            onChange={(event) => setPackingAssignee(event.target.value)}
          >
            <option value="">Bez przypisania</option>
            {travelers.map((traveler) => (
              <option value={traveler} key={traveler}>
                {traveler}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button button--primary button--small"
          type="submit"
          disabled={!packingName.trim()}
        >
          <Plus size={15} /> Dodaj
        </button>
      </form>
      <div className="trips-packing-groups">
        {(Object.keys(packingLabels) as PackingItem["category"][]).map((category) => {
          const items = packing.filter((item) => item.category === category);
          if (!items.length) return null;
          return (
            <section key={category}>
              <header>
                <strong>{packingLabels[category]}</strong>
                <span>
                  {items.filter((item) => item.packed).length}/{items.length}
                </span>
              </header>
              <div>
                {items.map((item) => (
                  <button
                    className={
                      item.packed ? "trips-pack-item trips-pack-item--done" : "trips-pack-item"
                    }
                    type="button"
                    key={item.id}
                    onClick={() => onToggle(item.id)}
                    aria-pressed={item.packed}
                  >
                    <span>{item.packed ? <Check size={15} /> : <Circle size={15} />}</span>
                    <strong>{item.name}</strong>
                    {item.assignedTo && (
                      <small>
                        <span>{item.assignedTo.charAt(0)}</span>
                        {item.assignedTo}
                      </small>
                    )}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {!packing.length && (
          <div className="trips-section-empty">
            <Luggage size={25} />
            <h3>Lista jest jeszcze pusta</h3>
            <p>Dodaj pierwszą rzecz powyżej. Współtowarzysze zobaczą ją od razu.</p>
          </div>
        )}
      </div>
    </section>
  );
}

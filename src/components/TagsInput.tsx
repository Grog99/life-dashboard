// Wejście na wolne tagi zadania (docs/plans/zadania-redefinicja.md "Input tagów"): chipy,
// przecinek/Enter zamienia bieżący tekst w tag, Backspace na pustym polu kasuje ostatni chip.
// Limit 20 tagów × 50 znaków (1:1 z walidacją `recipes.tags`/`server/src/life.mjs`
// `MAX_TASK_TAGS`/`MAX_TASK_TAG_LENGTH`) — pilnowany też tutaj, żeby UI nie pozwalał wysłać
// ładunku, który serwer i tak odrzuci kodem `INVALID_TAGS`. `suggestions` zasila `<datalist>`
// podpowiedziami z już użytych tagów (autouzupełnianie, redukcja literówek — decyzja z planu).
import { X } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;

interface TagsInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  id?: string;
  "aria-label"?: string;
}

export function TagsInput({
  value,
  onChange,
  suggestions = [],
  placeholder,
  id,
  "aria-label": ariaLabel,
}: TagsInputProps) {
  const [draft, setDraft] = useState("");
  const datalistId = useId();

  const commit = (raw: string) => {
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH);
    setDraft("");
    if (!tag || value.length >= MAX_TAGS) return;
    if (value.some((existing) => existing.toLocaleLowerCase("pl") === tag.toLocaleLowerCase("pl")))
      return;
    onChange([...value, tag]);
  };

  const removeAt = (index: number) => onChange(value.filter((_, i) => i !== index));

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && !draft && value.length) {
      removeAt(value.length - 1);
    }
  };

  return (
    <div className="tags-input">
      {value.map((tag, index) => (
        <span className="tag-chip tag-chip--removable" key={`${tag}-${index}`}>
          {tag}
          <button type="button" onClick={() => removeAt(index)} aria-label={`Usuń tag ${tag}`}>
            <X size={11} />
          </button>
        </span>
      ))}
      {value.length < MAX_TAGS && (
        <input
          id={id}
          className="tags-input__field"
          value={draft}
          list={datalistId}
          aria-label={ariaLabel ?? "Dodaj tag"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => commit(draft)}
          placeholder={value.length ? "Dodaj tag…" : placeholder}
        />
      )}
      {suggestions.length > 0 && (
        <datalist id={datalistId}>
          {suggestions.map((tag) => (
            <option value={tag} key={tag} />
          ))}
        </datalist>
      )}
    </div>
  );
}

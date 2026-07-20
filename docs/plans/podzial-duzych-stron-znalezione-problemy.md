# Podział dużych stron — znalezione problemy (log)

> Plik-załącznik do `docs/plans/podzial-duzych-stron.md`.
>
> **Cel:** ten refactor jest CZYSTO strukturalny — zero zmian zachowania / logiki / UI / API.
> Jeśli podczas dzielenia komponentów natrafisz na błąd, niespójność albo code smell, który
> **nie jest** częścią samego podziału na komponenty — **NIE naprawiaj go tutaj**. Dopisz go
> poniżej jako nowy wpis i idź dalej. Naprawy trafią do osobnego PR-a po zaakceptowaniu tej listy.
>
> **Kto prowadzi ten plik:** założony przez planera (z wpisami zaobserwowanymi podczas
> eksploracji). Implementer **dopisuje** kolejne wpisy w trakcie pracy — nie usuwa ani nie
> „załatwia" istniejących.
>
> **Format wpisu:** `- [ ] <plik:linia jeśli znana> — <opis> — <dlaczego to poza zakresem tego PR-a>`

## Wpisy zaobserwowane przy planowaniu (do weryfikacji / rozbudowy)

- [ ] Niespójny tekst widoczności „household" między stronami: `FinancePage` używa
  „Wszyscy domownicy", `PetsPage` „Domownicy", `QuickAddModal` „Cały dom" — ten sam sens,
  różne etykiety. Ujednolicenie zmieniłoby wyświetlany tekst (zmiana UI), więc poza zakresem.
  Uwaga dla implementera: przy ewentualnym wspólnym polu widoczności NIE ujednolicaj etykiet —
  zachowaj dokładnie obecny tekst per strona.
- [ ] `PetsPage` reużywa klasy CSS z modułu samochodu (`car-dashboard-grid`, `car-dashboard-main`,
  `car-dashboard-side`, `car-expense-list`, `car-expense-row*`, `deadline-row`) oraz wspólne
  `module-stat-card*`. Markup `module-stat-card` jest 1:1 identyczny z `CarPage`, `MealsPage`,
  `SubscriptionsPage` (duplikacja). Sam podział rozwiązuje to tylko częściowo (patrz `StatCard`
  w planie); pełne ujednolicenie klas/nazewnictwa Car↔Pets to osobny temat.
- [ ] Duplikacja „wiersza wydatku" między `CarPage` (`car-expense-row` z wypełnionym
  `car-expense-row__details`) a `PetsPage` (ten sam wiersz, ale `car-expense-row__details` pusty).
  Nie da się bezpiecznie wspólnie wyekstrahować bez ryzyka rozjazdu — `CarPage` jest poza zakresem
  tego PR-a. Zostawić `PetExpenseRow` lokalnie w Pets.
- [ ] Każda z trzech stron ma własny, „ręczny" markup pustego stanu (`finance-transactions-empty`,
  `finance-inline-empty`, `finance-mini-empty`, `trips-empty`, `trips-section-empty`,
  `module-empty`) zamiast wspólnego `src/components/EmptyState.tsx`. Podmiana na `EmptyState`
  zmieniłaby strukturę DOM i wygląd → zmiana UI, poza zakresem. Zostawić puste stany 1:1.
- [ ] `FinancePage` ma inline'ową polską odmianę liczebników („aktywny rachunek"/„aktywne rachunki",
  „transakcję"/„transakcji"), mimo że istnieje `src/lib/pluralize.ts` (`polishPlural`) — nieużywany
  w tym pliku. Podmiana jest neutralna tylko jeśli wynik jest identyczny; poza zakresem podziału.
- [ ] `FinancePage.removeTransaction` używa `globalThis.confirm(...)`, a pozostałe akcje w tym samym
  pliku `window.confirm(...)` — kosmetyczna niespójność. Przy przenoszeniu handlerów zachować 1:1.
- [ ] Modal edycji w `TripsPage` (`EditTripModal`) ma strażnika niezapisanych zmian
  (`confirmClose` / `hasUnsavedChanges`), którego modale edycji w `FinancePage` i `PetsPage`
  nie mają — niespójny UX (nie błąd). Nie dodawać go przy przenoszeniu modali.

## Wpisy dopisane w trakcie implementacji

<!-- Implementer: dopisuj tutaj kolejne obserwacje w formacie z nagłówka. -->

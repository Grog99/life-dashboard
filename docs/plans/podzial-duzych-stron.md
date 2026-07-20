# Podział największych stron na mniejsze komponenty

> Plan wygenerowany przez skill `/plan-feature`. Slug: `podzial-duzych-stron`. Branch: `claude/reduce-page-size-rtnd7t` (branch narzucony przez zadanie — bez tworzenia osobnego `feature/<slug>`).

## Kontekst / Problem

Trzy strony aplikacji urosły do rozmiarów, które utrudniają czytanie, przegląd w PR-ach
i wprowadzanie zmian:

- `src/pages/FinancePage.tsx` — **1892 linie** (jeden komponent + 5 wielkich modali w tym samym pliku),
- `src/pages/TripsPage.tsx` — **1657 linii** (komponent-orkiestrator + 4 modale + 5 widoków w jednym pliku),
- `src/pages/PetsPage.tsx` — **1095 linii** (komponent + 3 modale + panele w jednym pliku).

Każdy plik trzyma w jednym miejscu: orkiestrację stanu, obliczenia pochodne, layout, wiele paneli
prezentacyjnych oraz duże formularze modali. To jest okazja, żeby wydzielić logiczne sekcje do
osobnych plików i przy okazji zidentyfikować kod nadający się do reużycia.

Oczekiwany efekt: te same strony, identyczne zachowanie i wygląd, ale rozbite na małe, czytelne
komponenty; plik strony staje się cienkim orkiestratorem (stan + obliczenia + kompozycja layoutu).

### Decyzje użytkownika (WIĄŻĄCE)

1. **Zakres = tylko 3 strony**: `FinancePage`, `TripsPage`, `PetsPage`. Pozostałe duże strony
   (`CarPage`, `HealthPage`, `MealsPage`, `SettingsPage`, `TodayPage`) są **poza zakresem** (non-goal).
2. **Czysto strukturalny refactor** — zero zmian zachowania, logiki biznesowej, UI/UX, API.
   Napotkane przy okazji błędy / niespójności / code smells **NIE są naprawiane** — trafiają jako
   wpisy do `docs/plans/podzial-duzych-stron-znalezione-problemy.md`.
3. **Organizacja plików = hybrydowo**: komponent używany tylko przez jedną stronę → lokalny
   podfolder tej strony; komponent reużywalny w >1 miejscu (lub już zduplikowany między stronami)
   → wspólne `src/components/`.
4. **Store'y poza zakresem**: `useFinanceStore`, `useTripsStore`, `usePetsStore`,
   `useLifeRecordsStore`, `useAdvancedStore` itd. **nie są dotykane**. Refactor obejmuje wyłącznie
   pliki React (komponenty / strony `.tsx`), nie logikę store'ów/Zustand.

## Wymagania

- Każda z 3 stron zostaje podzielona na mniejsze komponenty; plik strony wyraźnie się kurczy
  (cel: z ~1100–1900 linii do ~300–450 linii — orkiestracja stanu + obliczenia + kompozycja layoutu).
- Każdy nowo wydzielony plik komponentu ma rozsądny rozmiar: **cel < 200 linii**, orientacyjny
  sufit ~300 linii. Liczba linii jest sygnałem ostrzegawczym, **nie twardą regułą** — o dalszym
  rozbiciu panelu na atomy (np. wiersz/kartę) decyduje przede wszystkim to, czy wydzielenie ma
  sens samo w sobie (realna reużywalność, samodzielna jednostka odpowiedzialności, powtarzający
  się wzorzec), a nie wyłącznie przekroczenie progu linii.
- Zero zmian obserwowalnego zachowania: identyczny DOM, klasy CSS, teksty, walidacje, kolejność
  akcji, komunikaty `onToast`, dialogi `confirm`. Pełna neutralność wizualna i funkcjonalna.
- Reużywane są **istniejące** komponenty i hooki tam, gdzie już pasują (przede wszystkim `Modal`),
  zamiast przepisywania ich od zera.
- Store'y, typy domenowe, biblioteki `src/lib/*` i backend pozostają nietknięte.
- `npm run build`, `npm run lint`, `npm test` i `npm run test:server` przechodzą bez nowych błędów.

## Zakres i Non-goals

**W zakresie:**

- Podział `FinancePage.tsx`, `TripsPage.tsx`, `PetsPage.tsx` na komponenty prezentacyjne,
  komponenty modali i pliki ze stałymi/helperami.
- Utworzenie lokalnych podfolderów: `src/pages/finance/`, `src/pages/trips/`, `src/pages/pets/`
  (nowa, spójna konwencja — dziś takich podfolderów nie ma).
- Jedna wspólna ekstrakcja do `src/components/`: `StatCard` (markup `module-stat-card` jest 1:1
  identyczny w Pets/Car/Meals/Subscriptions) — podpięty w tym PR-ze **tylko** w `PetsPage`.
- Utworzenie i zasianie pliku `docs/plans/podzial-duzych-stron-znalezione-problemy.md`.

**Non-goals (świadomie pomijamy):**

- Jakakolwiek zmiana zachowania, walidacji, logiki, tekstów, wyglądu, dostępności czy struktury DOM.
- Refactor pozostałych stron (`CarPage`, `HealthPage`, `MealsPage`, `SettingsPage`, `TodayPage`)
  — w tym podpinanie w nich nowego `StatCard` (mogą go przejąć w osobnym PR-ze).
- Zmiany w store'ach / Zustand, typach domenowych (`src/advancedTypes.ts`, `src/financeTypes.ts`,
  `src/types.ts`), bibliotekach `src/lib/*`, hookach synchronizacji (`src/hooks/*Sync.ts`).
- Zmiany w backendzie (`server/`), migracjach SQL, API, CSS (`src/styles/*`).
- Naprawa niespójności/błędów zauważonych przy okazji (→ log problemów, nie kod).
- Ujednolicanie pustych stanów do `EmptyState` czy widoczności do wspólnego pola (zmieniłoby UI/tekst).

## Podejście

**Zasada nadrzędna — „przenieś, nie przepisuj".** Każdy wydzielony komponent to wycięty 1:1
fragment JSX z pliku strony, opakowany w komponent z jawnymi propsami. Żaden fragment nie jest
pisany od nowa. Po podziale render jest bajt-w-bajt taki sam.

**Granularność atomów — decyzja o sensie, nie o liczbie linii.** Dalsze rozbicie panelu na
mniejsze atomy (np. `FinanceAccountCard`, `TransactionTable`, `PetExpenseRow`) robimy tam, gdzie
to ma realny sens: fragment jest reużywalny, stanowi samodzielną jednostkę odpowiedzialności albo
powtarza się jako wzorzec — a nie mechanicznie za każdym razem, gdy panel przekroczy próg linii.
Limit ~200–300 linii w tym planie to orientacyjny sygnał „warto się temu przyjrzeć", nie twarda
reguła podziału. Wszystkie „Opcjonalnie wydziel X, jeśli panel > 200 linii" w sekcjach poniżej
czytaj w tym duchu — oceń przypadek, nie tylko licznik linii.

**Podział odpowiedzialności (co zostaje w pliku strony):**
Plik strony pozostaje **orkiestratorem** i trzyma:
- wiązanie store'ów (`useFinanceStore`/`useTripsStore`/`usePetsStore`, `useAdvancedStore`, `useServerAuth`),
- cały lokalny stan (`useState`) — łącznie ze stanem formularzy modali,
- wszystkie obliczenia pochodne (`useMemo`, sumy, filtry, mapy),
- wszystkie handlery (submit, save, remove, import, dialogi `confirm`, `onToast`),
- kompozycję: składanie wydzielonych komponentów i przekazywanie im danych + callbacków.

**Modale = widoki prezentacyjne, stan zostaje w stronie.** Dla Finance i Pets modale są
kontrolowane (`useState` draftu w stronie). Wydzielamy **JSX formularza** do komponentu modala,
ale `draft`/`setDraft` i `onSubmit` **przekazujemy propsami z strony**. Dzięki temu zachowujemy
dokładną semantykę resetów i wstępnego wypełniania (np. `openTransactionModal` presetujące konto,
`openPetEdit` wypełniające draft) bez ryzyka rozjazdu zachowania. W `TripsPage` modale są już
niekontrolowane (`FormData`) i samowystarczalne — je przenosimy 1:1 jako gotowe komponenty.

**Konwencja plików (nowa, ustanawiana tym PR-em):**
- `src/pages/<feature>/<feature>Constants.ts` — stałe, mapy etykiet/ikon, helpery formatujące,
  fabryki draftów i interfejsy stanu formularzy (przeniesione z góry pliku strony).
- `src/pages/<feature>/components/<Nazwa>.tsx` — komponenty używane tylko przez tę stronę.
- Plik strony **zostaje pod dotychczasową ścieżką** (`src/pages/FinancePage.tsx` itd.) — `src/App.tsx`
  lazy-loaduje je po ścieżce (`import("./pages/FinancePage")`), więc nieprzenoszenie pliku strony =
  **zero zmian w routerze/`App.tsx`**. Dodajemy tylko nowy podfolder obok.
- Nazewnictwo plików: PascalCase dla komponentów (spójne z `src/components/`), `named export`
  (spójne z resztą repo — brak `default export` w komponentach).

**Reużycie istniejących bytów (NIE przepisywać):**
- `src/components/Modal.tsx` — już używany przez wszystkie 3 strony; pozostaje jedynym wspólnym
  „shellem" modala (obsługuje focus trap, Esc, `confirmClose`). Wszystkie wydzielone modale go używają.
- `src/lib/money.ts` (`formatMoney`, `parseMoneyToMinor`), `src/lib/date.ts`
  (`formatShortDate`, `relativeDay`, `dateKey`), `src/lib/csvImport.ts`, `src/lib/id.ts` — reużywane
  bez zmian (importy wędrują tam, gdzie trafi kod).
- **Odrzucone jako reużycie:** `EmptyState`, `Tabs`, `TagsInput`, `RecurrenceFields`, `QuickAddModal`
  — nie pasują do tych 3 stron bez zmiany DOM/UX. Puste stany stron mają własny markup/klasy
  (`finance-*`, `trips-*`, `module-empty`), a podmiana na `EmptyState`/`Tabs` zmieniłaby wygląd →
  poza zakresem. Zostają lokalne, 1:1.

**Jedyna wspólna ekstrakcja: `StatCard`.** Markup `module-stat-card` (ikona + label + wartość +
podpis) jest identyczny w `PetsPage`, `CarPage`, `MealsPage`, `SubscriptionsPage`. Kwalifikuje się
jako „reużywalny w >1 miejscu / już zduplikowany", więc idzie do `src/components/StatCard.tsx`.
W tym PR-ze podpinamy go **wyłącznie w `PetsPage`** (pozostałe strony to non-goal — zostają z
inline markup, przejmą `StatCard` osobno). Komponent musi renderować bajt-w-bajt tę samą strukturę
i klasy (prop `accent?` → `module-stat-card--accent`, prop tonu ikony → `module-stat-card__icon--amber`
/`--violet`).

## Pliki do zmiany

Grupowanie w trzy warstwy zgodnie z szablonem. To feature **czysto frontendowy** — warstwy danych
i backendu nie są dotykane.

### Baza (warstwa danych)

— brak — (bez migracji, bez zmian w `server/src/db.mjs`, bez zmian w typach `src/*Types.ts`/`src/types.ts`)

### Backend (warstwa backend)

— brak — (bez zmian w `server/src/server.mjs`, `server/src/worker.mjs`, `server/src/security.mjs`,
migracjach ani API. Refactor jest wyłącznie po stronie renderu React.)

### Frontend (warstwa frontend)

#### Wspólne (`src/components/`)

- `src/components/StatCard.tsx` — **nowy**, ~30–40 linii. Prezentacyjny odpowiednik `module-stat-card`.
  Props: `icon: LucideIcon`, `label`, `value`, `sub?`, `accent?: boolean`, `iconTone?: "amber" | "violet"`.
  Reużywa istniejącej struktury/klas CSS (`src/styles/modules.css`, bez zmian). Podpięty tylko w Pets.

#### Reużywane bez zmian (istniejące — NIE tworzyć od nowa)

- `src/components/Modal.tsx` — shell wszystkich modali (Finance/Trips/Pets).
- `src/lib/money.ts`, `src/lib/date.ts`, `src/lib/csvImport.ts`, `src/lib/id.ts` — helpery.

---

#### FinancePage — `src/pages/FinancePage.tsx` (1892 → cel ~350–420 linii)

**Zostaje w `FinancePage.tsx`:** wiązanie `useFinanceStore`/`useAdvancedStore`/`useServerAuth`,
cały `useState` (drafty modali, filtry, `visibleTransactions`, stan importu CSV), wszystkie `useMemo`
i obliczenia (`activeAccounts`, `primaryTransactions`, sumy salda/przepływów, `budgetProgress`,
`filteredTransactions`, `mappedCsvTransactions`, `csvRowsWithStatus`), wszystkie handlery
(`handleAddTransaction`, `handleAddAccount`, `openBudget`/`saveBudget`/`removeBudget`,
`openGoal`/`saveGoal`/`removeGoal`, `handleCsvFile`/`handleImport`/`resetCsvImport`, `removeTransaction`)
oraz kompozycja layoutu.

**Nowe pliki (lokalne, `src/pages/finance/`):**

- `finance/financeConstants.ts` (~120) — `currencyOptions`, `defaultCategories`, `accountTypeMeta`,
  `sourceLabels`; helpery `todayKey`, `formatDate`, `capitalize`, `normalizeCategoryName`; fabryki
  `initialTransactionForm`/`initialAccountForm`/`initialBudgetForm`/`initialGoalForm`; interfejsy
  `TransactionFormState`/`AccountFormState`/`BudgetFormState`/`GoalFormState` + typy
  `TransactionDirection`/`TransactionFilter`. (Przeniesione 1:1 z góry pliku.)
- `finance/components/FinanceSummaryCards.tsx` (~90) — sekcja `finance-summary-grid` (4 karty).
  Props: obliczone wartości (`totalBalance`, `monthIncome`, `monthExpenses`, `monthFlow`, liczby),
  `primaryCurrency`, `monthLabel`, `hideAmounts`, statystyki budżetu.
- `finance/components/FinanceAccountsPanel.tsx` (~110) — panel `finance-accounts-panel` (grid
  rachunków + inline-empty + „Nowy rachunek"). Props: `activeAccounts`, `accountFilter`, liczby
  operacji per rachunek (lub `financeTransactions`), `memberById`, `hideAmounts`, `onSelectAccount`,
  `onAddAccount`. Opcjonalnie wydziel `FinanceAccountCard.tsx` (~55), jeśli panel > 200 linii.
- `finance/components/FinanceBudgetsPanel.tsx` (~120) — panel `finance-budget-panel` (lista budżetów
  z paskami postępu + mini-empty). Props: `financeBudgets`, `financeTransactions`, `currentMonth`,
  `hideAmounts`, `onAdd`, `onEdit`, `onRemove`. Opcjonalnie `FinanceBudgetRow.tsx` (~70).
- `finance/components/FinanceGoalsPanel.tsx` (~95) — panel `finance-goals-panel` (cele + mini-empty).
  Props: `savingsGoals`, `hideAmounts`, `onAdd`, `onEdit`, `onRemove`.
- `finance/components/FinanceTransactionsPanel.tsx` (~190) — panel `finance-transactions-panel`
  (filtry: search/rachunek/rodzaj + tabela + „Pokaż więcej" + pusty stan). Props: `filteredTransactions`,
  `visibleTransactions`, `search`, `accountFilter`, `transactionFilter` + ich settery,
  `activeAccounts`, `accountById`, `memberById`, `hideAmounts`, `onRemoveTransaction`, `onAddTransaction`.
  Jeśli > sufitu → rozbij na `TransactionFilters.tsx` (~55) + `TransactionTable.tsx` (~120).
- `finance/components/TransactionFormModal.tsx` (~170) — JSX formularza nowej transakcji. Props:
  `open`, `onClose`, `form`, `setForm`, `onSubmit`, `activeAccounts`, `accountById`, `categories`,
  `primaryCurrency`.
- `finance/components/AccountFormModal.tsx` (~110) — formularz nowego rachunku. Props: `open`,
  `onClose`, `form`, `setForm`, `onSubmit`.
- `finance/components/BudgetFormModal.tsx` (~80) — formularz budżetu. Props: `open`, `onClose`,
  `form`, `setForm`, `onSubmit`, `editingBudget`.
- `finance/components/GoalFormModal.tsx` (~90) — formularz celu. Props: `open`, `onClose`, `form`,
  `setForm`, `onSubmit`, `editingGoal`.
- `finance/components/CsvImportModal.tsx` (~120) — orkiestruje dwa etapy importu (start vs review).
  Props: cały zestaw stanu/handlerów importu ze strony. Rozbity na dwa podkomponenty:
  - `finance/components/CsvImportDropzone.tsx` (~95) — etap wyboru pliku (`finance-import-start`).
  - `finance/components/CsvImportReview.tsx` (~180) — etap mapowania kolumn + statystyki + podgląd
    (`finance-import-review`). To najcięższy fragment obecnego pliku (~290 linii) — rozbicie na
    dropzone+review najbardziej redukuje rozmiar.

**Reużywa:** `Modal`, `formatMoney`, `parseMoneyToMinor`, `src/lib/csvImport.ts`.

---

#### TripsPage — `src/pages/TripsPage.tsx` (1657 → cel ~380–450 linii)

**Zostaje w `TripsPage.tsx`:** wiązanie `useTripsStore`/`useAdvancedStore`, stan
(`selectedTripId`, `view`, flagi modali, `itineraryDate`, `packing*`), obliczenia (`sortedTrips`,
`selectedTrip`, `itinerary`, `bookings`, `packing`, `tripDays`, cała matematyka budżetu,
`nextSteps`, `budgetBreakdown`), handlery (`switchTrip`, `openItineraryModal`, `addPacking`, oraz
callbacki `onCreate`/`onSave`/`onDelete` przekazywane do modali) i kompozycja (sidebar + detail).

**Nowe pliki (lokalne, `src/pages/trips/`):**

- `trips/tripConstants.ts` (~120) — `statusLabels`, `itineraryLabels`, `itineraryIcons`,
  `bookingLabels`, `bookingIcons`, `packingLabels`, `tripViews`, `TripView`; helpery `capitalize`,
  `safeDate`, `tripDateRange`, `bookingDate`. (Przeniesione 1:1.)
- `trips/components/TripsEmptyState.tsx` (~60) — ekran „brak podróży" (early return): nagłówek +
  `trips-empty` + osadzony `NewTripModal`. Props: `open`, `onOpenModal`, `onClose`, `onCreate`.
- `trips/components/TripsSidebar.tsx` (~75) — aside `trips-list` (nagłówek + karty podróży). Props:
  `sortedTrips`, `activeTripId`, `activeCount`, `onSwitch`, `onAdd`.
- `trips/components/TripHero.tsx` (~90) — sekcja `trips-hero` (badge statusu, edycja, licznik). Props:
  `trip`, `duration`, `untilStart`, `onStatusChange`, `onEdit`.
- `trips/components/TripTabsNav.tsx` (~45) — nav `trips-tabs`. Props: `view`, `onChange`,
  `bookingsCount`, `packedCount`, `packingCount`.
- `trips/components/TripOverview.tsx` (~150) — widok „overview": metryki + „następny krok" +
  „najbliżej" + notatki. Props: `trip`, wartości metryk, `nextSteps`, `itinerary` (3 pierwsze),
  `hideAmounts`, `onNavigate`, `onSaveNotes`. Opcjonalnie wydziel `TripMetrics.tsx` (~55).
- `trips/components/TripItineraryView.tsx` (~120) — widok „itinerary" (dni + wpisy planu). Props:
  `tripDays`, `itinerary`, `currency`, `hideAmounts`, `onAddItinerary`, `onDeleteItem`.
- `trips/components/TripBookingsView.tsx` (~110) — widok „bookings" (grid rezerwacji + pusty stan).
  Props: `bookings`, `currency`, `hideAmounts`, `confirmedCount`, `onTogglePaid`, `onDelete`, `onAdd`.
- `trips/components/TripBudgetView.tsx` (~95) — widok „budget" (karta + struktura kosztów). Props:
  obliczone wartości budżetu, `budgetBreakdown`, `currency`, `hideAmounts`, `onToggleHideAmounts`.
- `trips/components/TripPackingView.tsx` (~130) — widok „packing" (formularz dodawania + grupy +
  pusty stan). Props: `packing`, `packingProgress`, `packedCount`, `travelers`, stan pól dodawania +
  settery + `onAdd`, `onToggle`.
- `trips/components/NewTripModal.tsx` (~140) — **przeniesiony 1:1** istniejący `NewTripModal`.
- `trips/components/NewItineraryModal.tsx` (~100) — **przeniesiony 1:1** istniejący `NewItineraryModal`.
- `trips/components/NewBookingModal.tsx` (~100) — **przeniesiony 1:1** istniejący `NewBookingModal`.
- `trips/components/EditTripModal.tsx` (~165) — **przeniesiony 1:1** istniejący `EditTripModal`
  (zachować `confirmClose`/`hasUnsavedChanges`).

**Reużywa:** `Modal`, `formatMoney`, `parseMoneyToMinor`, `formatShortDate`, `date-fns`.
Uwaga: modale są już samowystarczalne (`FormData`) → przenoszone bez zmiany kontraktu.

---

#### PetsPage — `src/pages/PetsPage.tsx` (1095 → cel ~320–380 linii)

**Zostaje w `PetsPage.tsx`:** wiązanie `usePetsStore`/`useAdvancedStore`/`useServerAuth`, stan
(`selectedPetId`, drafty i flagi modali, `editingPet`/`editingVisit`, `expenseFilter`), obliczenia
(`selectedPet`, `selectedExpenses`, `visibleExpenses`, `selectedVisits`, `nextVisit`, `monthlyCost`),
handlery (`openPetCreate`/`openPetEdit`/`savePet`/`removePet`, `addFishRow`/`updateFishRow`/
`removeFishRow`, `openExpenseCreate`/`saveExpense`/`removeExpense`, `openVisitCreate`/`openVisitEdit`/
`saveVisit`/`removeVisit`) i kompozycja.

**Nowe pliki (lokalne, `src/pages/pets/`):**

- `pets/petConstants.ts` (~130) — `kindLabels`, `expenseLabels`, `expenseIcons`; helpery
  `petAgeLabel`, `fishStockCount`; fabryki `emptyPetDraft`/`emptyExpenseDraft`/`emptyVisitDraft`;
  interfejsy `PetDraft`/`ExpenseDraft`/`VisitDraft`/`FishRow` + typ `ExpenseFilter`. (Przeniesione 1:1.)
- `pets/components/PetStrip.tsx` (~50) — sekcja `pet-strip` (karty wyboru zwierzęcia + „Dodaj zwierzę").
  Props: `pets`, `selectedPetId`, `onSelect`, `onAddPet`.
- `pets/components/PetSummaryCards.tsx` (~60) — sekcja `module-stat-grid` (3 karty). **Reużywa wspólny
  `StatCard`.** Props: `selectedPet`, `isAquarium`, `monthlyCost`, `monthCount`, `nextVisit`, `hideAmounts`.
- `pets/components/PetExpensesPanel.tsx` (~120) — panel wydatków (segmented filter + lista + pusty
  stan). Props: `visibleExpenses`, `expenseFilter`, `onFilterChange`, `hideAmounts`, `onAddExpense`,
  `onRemoveExpense`. Opcjonalnie `PetExpenseRow.tsx` (~35) — **lokalnie** (duplikacja z Car nie jest
  bezpiecznie wspólna, patrz log problemów).
- `pets/components/PetProfileCard.tsx` (~95) — karta profilu (`pet-overview-card`): wariant akwarium
  (lista ryb) vs zwierzę (siatka dat/wiek) + notatki + „Usuń profil". Props: `selectedPet`,
  `isAquarium`, `onEdit`, `onRemove`.
- `pets/components/PetVisitsPanel.tsx` (~90) — panel wizyt (`deadlines-panel`: lista + pusty stan).
  Props: `selectedVisits`, `onToggle`, `onEdit`, `onRemove`, `onAdd`. Opcjonalnie `PetVisitRow.tsx` (~35).
- `pets/components/PetFormModal.tsx` (~170) — formularz profilu (create/edit) z edytorem obsady
  akwarium. Props: `open`, `onClose`, `draft`, `setDraft`, `editingPet`, `onSubmit`, `addFishRow`,
  `updateFishRow`, `removeFishRow`. Opcjonalnie `PetFishEditor.tsx` (~55).
- `pets/components/PetExpenseFormModal.tsx` (~90) — formularz wydatku. Props: `open`, `onClose`,
  `draft`, `setDraft`, `selectedPet`, `onSubmit`.
- `pets/components/PetVisitFormModal.tsx` (~120) — formularz wizyty. Props: `open`, `onClose`, `draft`,
  `setDraft`, `editingVisit`, `selectedPet`, `onSubmit`.

**Reużywa:** `Modal`, nowy `StatCard`, `formatMoney`, `parseMoneyToMinor`, `formatShortDate`,
`relativeDay`, `dateKey`, `generateId`.

## Kryteria akceptacji

- [ ] `FinancePage.tsx`, `TripsPage.tsx`, `PetsPage.tsx` skróciły się do ~300–450 linii każdy
      (orkiestracja stanu + obliczenia + kompozycja); logika prezentacji i modali jest w osobnych plikach.
- [ ] Każdy nowy plik komponentu ma < ~300 linii (cel < 200); panele przekraczające sufit rozbite na atomy.
- [ ] Powstały podfoldery `src/pages/finance/`, `src/pages/trips/`, `src/pages/pets/` z plikiem
      `<feature>Constants.*` i podfolderem `components/`.
- [ ] Powstał `src/components/StatCard.tsx`, podpięty wyłącznie w `PetsPage`; `CarPage`/`MealsPage`/
      `SubscriptionsPage` **niezmienione**.
- [ ] `src/App.tsx` i router **niezmienione** (ścieżki lazy-import stron bez zmian).
- [ ] Store'y, typy, `src/lib/*`, `src/styles/*` i cały `server/` **niezmienione** (diff = 0).
- [ ] Brak zmian obserwowalnego zachowania/UI: identyczny DOM, klasy CSS, teksty, walidacje, toasty,
      dialogi `confirm`. (Weryfikacja: klik-przez każdej strony w preview + wąski ekran PWA.)
- [ ] `npm run build`, `npm run lint`, `npm test` i `npm run test:server` przechodzą.
- [ ] Istnieje `docs/plans/podzial-duzych-stron-znalezione-problemy.md` z zasianymi wpisami;
      ewentualne nowe obserwacje z implementacji dopisane tam (nie naprawione w kodzie).

## Ryzyka

- **Rozjazd semantyki resetu/presetu formularzy (Finance/Pets).** Modale są kontrolowane; przy
  wydzielaniu JSX trzeba zostawić `draft`/`setDraft` w stronie i przekazać propsami, inaczej łatwo
  zgubić np. preset konta w `openTransactionModal` czy wypełnienie draftu w `openPetEdit`.
  Mitygacja: modale = czysto widoki, zero własnego `useState` na dane formularza.
- **Neutralność DOM/CSS.** Klasy CSS są globalne (`src/styles/*`, bez zmian). Każdy przeniesiony
  fragment musi zachować dokładnie te same klasy i zagnieżdżenie — inaczej „czysto strukturalny"
  refactor stanie się wizualny. Mitygacja: kopiuj JSX 1:1, nie „upiększaj".
- **`StatCard` – dokładne klasy.** Musi renderować `module-stat-card`, `--accent`, `module-stat-card__icon`,
  `--amber`/`--violet` identycznie jak dziś w Pets. Błędny prop tonu = wizualny regres.
- **Prop-drilling.** Panele dostaną sporo propsów (dane + callbacki). To akceptowalny koszt czysto
  strukturalnego podziału; nie wprowadzamy nowych store'ów ani kontekstów (poza zakresem).
- **Granica prywatne/wspólne danych** (`visibility`, właściciel z sesji) żyje w store'ach i handlerach,
  które **zostają w stronie** — refactor jej nie dotyka. Ryzyko tylko jeśli ktoś przeniósłby handlery
  do komponentów; nie robimy tego.
- **`react-refresh/only-export-components`** (lint). Pliki `*Constants.ts` eksportują nie-komponenty —
  trzymać stałe/helpery poza plikami `.tsx` komponentów, żeby nie wywołać ostrzeżeń (repo ma
  `--max-warnings 0`).

## Pytania do doprecyzowania

Brak otwartych pytań — obie kwestie rozstrzygnięte z użytkownikiem:

1. **`StatCard`** — tworzymy teraz w `src/components/StatCard.tsx`, podpięty wyłącznie w `PetsPage`
   (jak w rekomendacji planu). `CarPage`/`MealsPage`/`SubscriptionsPage` pozostają niezmienione.
2. **Granularność atomów** — o dalszym rozbiciu panelu na mniejsze pliki decyduje sens wydzielenia
   (realna reużywalność, samodzielna odpowiedzialność, powtarzający się wzorzec), nie mechaniczne
   przekroczenie progu linii. Limit ~200–300 linii to orientacyjny sygnał, nie twarda reguła —
   zapisane w sekcji „Podejście" powyżej.

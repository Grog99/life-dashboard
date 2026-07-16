# Zwierzęta: wydatki i wizyty u weterynarza

> Plan wygenerowany przez skill `/plan-feature`. Slug: `zwierzeta-wydatki-wet`. Branch: `claude/pet-expenses-vet-visits-i9w10y`.

## Kontekst / Problem

Użytkownik trzyma zwierzęta (króliki oraz akwarium) i chce w jednym miejscu śledzić wydatki na nie (jedzenie, akcesoria, pielęgnacja) oraz opcjonalne wizyty u weterynarza z przypomnieniami push. Dziś nie ma na to modułu — koszty rozpływają się w ogólnych finansach, a terminy wizyt trzeba pamiętać samodzielnie.

Akwarium ma te same potrzeby (wydatki, serwis/wizyty), ale zamiast rasy/wagi wymaga śledzenia obsady — gatunków ryb i liczby sztuk. Ma to być **jeden model profilu zwierzęcia** z polami wariantowymi, a nie osobna encja/zakładka.

Oczekiwany efekt: nowa zakładka „Zwierzęta" analogiczna do modułu Samochód — poziomy selektor profili zwierząt, historia kosztów per zwierzę i lista wizyt/terminów u weterynarza z powiadomieniami push.

## Wymagania

- Nowa zakładka „Zwierzęta" w bocznej nawigacji (nie w dolnym pasku mobilnym — ten zostaje: today/tasks/calendar/notes).
- Profile zwierząt (multi-entity) w poziomym selektorze, wzorowane na „garage-strip" z `CarPage`.
- Jeden model profilu obsługujący zwierzęta standardowe (pies/kot/królik/świnka: gatunek/rasa, imię, data urodzenia → wiek) oraz akwarium (lista `{gatunek ryby, liczba sztuk}` zamiast gatunku/daty urodzenia). Bez pola wagi i bez parametrów wody w MVP.
- Kafelek skrótu „Zwierzęta" na dashboardzie „Dzisiaj" (obok Samochodu/Zdrowia) pokazujący najbliższą wizytę u weterynarza.
- Wydatki per zwierzę z kategoriami od startu: **jedzenie, weterynarz, akcesoria/zabawki, pielęgnacja, inne**; kwoty w groszach (`amountMinor`), filtrowalne jak `CarExpense`.
- Wizyty u weterynarza (data, godzina, placówka/lekarz, status scheduled/completed/cancelled) — wzorowane na `HealthAppointment`.
- Wizyty wysyłają przypomnienia push (24 h wcześniej), reużywając mechanizmu workera dla `healthAppointments`.
- Domyślna widoczność **household** (wspólne dla gospodarstwa), z możliwością oznaczenia pojedynczego wpisu jako `private` — analogicznie do modułu Samochód.
- Identyfikatory pól/tras po angielsku (konwencja repo: `carExpenses`, `vehicleId`, `fuelType`), etykiety UI po polsku.
- Niefunkcjonalne: dane w dokumentowym stanie (JSONB), zgodność wsteczna przy odczycie dla gospodarstw bez tej kolekcji, poprawny podział prywatne/wspólne po `id`.

## Zakres i Non-goals

**W zakresie:**
- Model danych `Pet` (+ zagnieżdżona obsada ryb), `PetExpense`, `PetVisit` w warstwie dokumentowej.
- Rejestracja kolekcji w `server/src/workspace.mjs` (split prywatne/wspólne + materializacja kluczy przy odczycie).
- Derived reminder dla wizyt weterynaryjnych w `server/src/worker.mjs`.
- Strona `PetsPage.tsx`, akcje CRUD w store, walidacja Zod, seed, wpięcie w nawigację/routing/command palette.
- Kafelek skrótu na `TodayPage.tsx` z najbliższą wizytą u weterynarza.

**Non-goals (świadomie pomijamy):**
- Osobna zakładka dla akwarium (akwarium = profil w tej samej zakładce).
- Osobne tabele SQL / mutacje domenowe dla zwierząt (pozostajemy przy modelu dokumentowym — patrz Podejście).
- Waga zwierzęcia — brak pola w MVP (decyzja z rundy doprecyzowującej: tylko podstawy).
- Parametry wody akwarium (temperatura, pH) i dziennik pomiarów zdrowotnych (odpowiednik `HealthMeasurement`) — poza zakresem MVP; serwis/podmianę wody można zapisać jako `petVisit`.
- Powtarzalność wizyt (cykliczne odrobaczanie/szczepienia) — pojedyncze wizyty wystarczą w MVP; mechanizm `Recurrence` z zadań/wydarzeń można podpiąć później bez zmiany reszty modelu.
- Automatyczne księgowanie wydatków na zwierzę do modułu Finanse (jak `source: "car"` w transakcjach) — poza zakresem MVP.

## Podejście

**Kluczowe ustalenie architektoniczne: warstwa „Baza" NIE jest migracją SQL.** W tym repo moduły (Samochód, Zdrowie, Finanse…) nie mają osobnych tabel — cały stan to wersjonowany dokument JSONB w `workspace_states.data` (wspólne) i `user_workspace_states.data` (prywatne), o kształcie `{ schemaVersion: 2, life: {...}, advanced: {...} }`. Kolekcje żyją jako tablice w `advanced` (np. `advanced.vehicles`, `advanced.carExpenses`). Serwer NIE waliduje ich schematem Zod — używa ręcznego `workspaceDocumentIsValid` (`server/src/workspace.mjs`), a podział prywatne/wspólne robią rejestry `META_COLLECTIONS` / `CHILD_RELATIONS` / `ADVANCED_COLLECTIONS` w tym samym pliku. Worker push czyta kolekcje wprost z JSONB.

Dlatego „warstwa danych" tego featurea = **typy TS (`advancedTypes.ts`) + schematy Zod (`lib/schema.ts`) + rejestry kolekcji w `workspace.mjs` + seed**. Żadnego pliku `server/migrations/00X_*.sql`.

**Reużywamy wzorzec Samochodu (najbliższy analog), z detalem wizyt ze Zdrowia:**
- `pets` ≈ `vehicles` (profil z własną widocznością i kolorem karty; META_COLLECTION).
- `petExpenses` ≈ `carExpenses` (SharedMeta + dziecko profilu; własna widoczność + dziedziczenie prywatności po `petId`).
- `petVisits` ≈ hybryda `HealthAppointment` (pola: clinician/date/time/status/location → reużycie logiki push -24 h) + `carExpenses` w kwestii przynależności do profilu (dziecko `petId`).

Akwarium NIE jest osobną encją: `Pet.kind === "aquarium"` włącza pole wariantowe `fishStock: {species, count}[]` (zagnieżdżone w rekordzie zwierzęcia — jak `Trip.travelers`, wędruje atomowo z rekordem, bez potrzeby osobnej kolekcji ani wpisu w `CHILD_RELATIONS`), a wyłącza pola rasa/waga/data urodzenia. Wydatki i wizyty działają identycznie dla wszystkich `kind`.

**Widoczność:** `Pet`, `PetExpense`, `PetVisit` rozszerzają `SharedMeta` (`ownerId` + `visibility`), a formularze domyślnie ustawiają `visibility: "household"` (jak `emptyVehicleDraft` w `CarPage.tsx:99`), z selektorem „Domownicy / Tylko ja". Rejestracja w `workspace.mjs` gwarantuje, że prywatne wpisy trafią do `user_workspace_states`, a dzieci prywatnego profilu odziedziczą tę granicę.

Alternatywa odrzucona: znormalizowane tabele SQL per zwierzę — niezgodne z obecnym modelem dokumentowym i nadmiarowe dla skali gospodarstwa domowego (to dopiero „Dalsza ewolucja" w `docs/ARCHITECTURE.md`).

## Pliki do zmiany

Konwencja nazewnictwa: **kolekcje/pola/trasy po angielsku** (`pets`, `petExpenses`, `petVisits`, `petId`, `fishStock`), **etykiety UI po polsku** — zgodnie z `carExpenses`/`vehicleId`/`fuelType` w istniejącym kodzie.

### Baza (warstwa danych)

Migracje SQL: **— brak —** (uzasadnienie w sekcji Podejście).

- `src/advancedTypes.ts` — dodać interfejsy i wpiąć kolekcje do `AdvancedData` (obok `vehicles`/`carExpenses`/`vehicleDeadlines`, linie 152–184, 232–254). Proponowany kształt:

  ```ts
  export type PetKind = "rabbit" | "dog" | "cat" | "guinea_pig" | "aquarium" | "other";

  export interface FishStockEntry {
    id: string;
    species: string;   // gatunek ryby, np. "Neonek innesa"
    count: number;     // liczba sztuk
  }

  export interface Pet extends SharedMeta {   // ownerId + visibility
    id: string;
    name: string;                 // imię, np. "Fistaszek"
    kind: PetKind;                // typ profilu (steruje wariantem pól)
    color: string;                // kolor karty w selektorze (jak Vehicle.color)
    // Pola zwierzęcia standardowego (kind !== "aquarium"):
    species?: string;             // gatunek/rasa, np. "Królik miniaturka"
    birthDate?: string;           // isoDate — wiek liczony w UI
    // Pole wariantowe akwarium (kind === "aquarium"):
    fishStock?: FishStockEntry[]; // obsada: lista {gatunek, liczba}
    notes?: string;
  }

  export interface PetExpense extends SharedMeta {   // ≈ CarExpense
    id: string;
    petId: string;
    date: string;                 // isoDate
    type: "food" | "vet" | "accessories" | "grooming" | "other";
    amountMinor: number;
    title: string;
    notes?: string;
  }

  export interface PetVisit extends SharedMeta {     // ≈ HealthAppointment (+ push)
    id: string;
    petId: string;
    title: string;                // np. "Szczepienie", "Serwis filtra"
    clinician: string;            // weterynarz / placówka / serwis
    specialty?: string;
    date: string;                 // isoDate
    time: string;                 // clockTime — potrzebne dla push -24 h
    location?: string;
    status: "scheduled" | "completed" | "cancelled";
    notes?: string;
  }
  ```
  Dodać do `AdvancedData`: `pets: Pet[]; petExpenses: PetExpense[]; petVisits: PetVisit[];`.

- `src/lib/schema.ts` — dodać `petSchema`, `petExpenseSchema`, `petVisitSchema` reużywając istniejących helperów (`sharedMetaSchema`, `idSchema`, `isoDate`, `clockTime`, `safeMoney`, `nonEmptyText`) — wzór: `carExpenseSchema` (201), `vehicleSchema` (196–200), `healthAppointmentSchema` (203–207). `fishStock` jako `z.array(z.object({ id: idSchema, species: nonEmptyText, count: z.number().int().nonnegative() })).max(500).optional()`. Wpiąć trzy nowe schematy do `advancedDataSchema` (220–230).

- `src/data/advancedData.ts` — dodać seed: min. dwa profile (`kind: "rabbit"` z gatunkiem/datą urodzenia oraz `kind: "aquarium"` z `fishStock`), po kilka `petExpenses` (różne `type`) i przynajmniej jedna zaplanowana `petVisits`. Wzór: `vehicles` (81–83), `carExpenses` (84–87), `healthAppointments` (93–96). Ustawić `visibility: "household"`, `ownerId: "me"`.

### Backend (warstwa backend)

Route handlery `PUT/GET /api/v1/workspace` (`server/src/server.mjs:495–559`) są generyczne — **bez zmian**. Cała logika po stronie serwera to rejestry kolekcji i worker.

- `server/src/workspace.mjs` — trzy edycje rejestrów (to one, nie route handlery, decydują o prywatności i o zgodności wstecznej odczytu):
  - `META_COLLECTIONS` (1–13): dodać `"pets"`, `"petExpenses"`, `"petVisits"` (kolekcje niosące własną `visibility`/`ownerId`).
  - `CHILD_RELATIONS` (15–24): dodać `petExpenses: ["petId", "pets"]` i `petVisits: ["petId", "pets"]` (dziedziczenie prywatności po profilu — jak `carExpenses`/`vehicleDeadlines` po `vehicles`).
  - `ADVANCED_COLLECTIONS` (28–33): dodać `"pets"`, `"petExpenses"`, `"petVisits"` (rozpoznanie tablic w `workspaceDocumentIsValid`).
  - **Ważne dla zgodności wstecznej:** dodanie do `META_COLLECTIONS`/`CHILD_RELATIONS` sprawia, że `mergeWorkspaceData` (166–176, przez `collectionKeys`) zawsze zmaterializuje te klucze jako `[]` przy odczycie — również dla gospodarstw, które nigdy nie zapisały zwierząt. Dzięki temu `advancedDataSchema.parse` po stronie klienta (`WorkspaceSync.tsx:92`) nie wywróci się na braku kluczy. `fishStock` jest zagnieżdżone w rekordzie `pets`, więc NIE wymaga wpisu w żadnym rejestrze.

- `server/src/worker.mjs` — w `derivedReminders` (120–163) dodać pętlę dla `advanced.petVisits`, sklonowaną z pętli `healthAppointments` (150–155): próg `-24 * 60`, `status === "scheduled"`, `withinDeliveryWindow(dueKey, nowKey, 2)`, `id: pet-visit:${visit.id}`, tytuł np. `Wizyta u weterynarza: ${visit.title}`. Prefiks `pet-visit:` zapewnia dedup w `notification_deliveries`. Podział prywatne/wspólne push działa automatycznie: worker iteruje osobno `workspace_states` (dostawa do całego gospodarstwa) i `user_workspace_states` (tylko do właściciela), a split już rozdzielił wpisy po `visibility`.

### Frontend (warstwa frontend)

- `src/pages/PetsPage.tsx` — **NOWA** strona, struktura skopiowana z `src/pages/CarPage.tsx`:
  - Selektor profili „pet-strip" (jak `garage-strip`, 380–395) z ikoną `PawPrint`/`Fish` i kolorem karty.
  - Panel wydatków z filtrem po `type` (jak `car-expense-list`, 413–426) + statystyki (koszt w tym miesiącu jak 172–174).
  - Panel wizyt/terminów u weterynarza (jak `deadlines-panel`, 436–452) — pozycje z `status`, „oznacz odbytą", data/godzina; formularz jak `saveAppointment` z `HealthPage.tsx:173–198`.
  - Modal profilu z polami wariantowymi: dla `kind === "aquarium"` edytor `fishStock` (dodawanie wierszy `{species, count}`) zamiast gatunku/rasy i daty urodzenia.
  - Reużyć: `Modal` (`src/components/Modal.tsx`), `formatMoney`/`parseMoneyToMinor` (`src/lib/money.ts`), `dateKey`/`formatShortDate`/`relativeDay` (`src/lib/date.ts`), `generateId` (`src/lib/id.ts`), `useServerAuth` dla `currentOwnerId` (jak `CarPage.tsx:128–129`).
  - Styl: reużyć generyczne klasy `module-*` z `src/styles/modules.css` (już importowane w CarPage); ewentualne aliasy `pet-strip`/`pet-card` dodać w nowym `src/styles/pets.css` lub dopisać do `modules.css`.

- `src/store/useAdvancedStore.ts` — dodać (wzór: akcje `addVehicle`/`updateVehicle`/`addCarExpense`/`toggleVehicleDeadline`, 318–348 oraz akcje health 349–415):
  - Akcje w `AdvancedActions` (73–123) i w implementacji: `addPet`/`updatePet`/`deletePet`, `addPetExpense`/`deletePetExpense`, `addPetVisit`/`updatePetVisit`/`deletePetVisit`/`togglePetVisitCompleted`.
  - Import typów (30–50), import schematów (7–29).
  - `parseArrayField` w `merge` (435–493), `partialize` (495–517), `exportAdvancedData` (522–547), oraz domyślne `[]` w `replaceAdvancedData` (416–421).

- `src/types.ts` — dodać `"pets"` do unii `ViewId` (3–15).

- `src/components/Layout.tsx` — dodać wpis do tablicy `navigation` (37–53), np. `{ id: "pets", label: "Zwierzęta", icon: PawPrint }` (import ikony z `lucide-react`), oraz klucz w `titles` (55–68): `pets: "Zwierzęta"`. **NIE zmieniać** filtra dolnego paska mobilnego (285: `["today","tasks","calendar","notes"]`).

- `src/App.tsx` — `lazy` import `PetsPage` (wzór 22–23), dodać `"pets"` do `viewIds` (25), dodać render `{view === "pets" && <PetsPage onToast={showToast} />}` (obok 171–172).

- `src/components/CommandPalette.tsx` — dodać wpis nawigacyjny do `destinations` (32–44) i wyniki wyszukiwania dla zwierząt (wzór `vehicles`/health, 112–113) oraz selektor `state.pets` i zależność w `useMemo` (118).

- `src/server/WorkspaceSync.tsx` — dopisać `pets: [], petExpenses: [], petVisits: []` do `replaceWithEmptyWorkspace` (`replaceAdvancedData`, 41–49).

- `src/pages/SettingsPage.tsx` — dopisać `pets: [], petExpenses: [], petVisits: []` do enumeracji „wyczyść wszystkie dane" (`replaceAdvancedData`, 169–191).

- `src/pages/TodayPage.tsx` — kafelek skrótu „Zwierzęta" w sekcji life-modules obok Samochodu/Zdrowia (354–355), pokazujący najbliższą wizytę weterynaryjną.

### Testy

- `server/test/workspace.node.mjs` — dodać przypadki: prywatny `Pet` przenosi swoje `petExpenses`/`petVisits` do części prywatnej; wpis prywatny „pojedynczo" mimo profilu household; materializacja pustych kluczy przy odczycie starego dokumentu (wzór istniejących testów dla vehicles/carExpenses).
- `src/store/useAdvancedStore.test.ts` — testy CRUD dla `addPet`/`addPetExpense`/`addPetVisit`/`togglePetVisitCompleted` (wzór testów health, ~22).
- `src/lib/schema.test.ts` — walidacja `petSchema` (w tym `fishStock`) i odrzucanie złych rekordów.

## Kryteria akceptacji

- [ ] Zakładka „Zwierzęta" widoczna w bocznej nawigacji (i w palecie poleceń), brak zmian w dolnym pasku mobilnym.
- [ ] Można dodać profil zwierzęcia standardowego (imię, gatunek/rasa, data urodzenia) i profil `aquarium` z listą `{gatunek, liczba}` — jeden formularz z polami wariantowymi wg `kind`.
- [ ] Kafelek „Zwierzęta" na dashboardzie „Dzisiaj" pokazuje najbliższą zaplanowaną wizytę u weterynarza (lub stan pusty, gdy brak).
- [ ] Można dodać wydatek per zwierzę z kategorią (jedzenie/weterynarz/akcesoria/pielęgnacja/inne), kwotą w PLN; lista filtruje się po kategorii; koszt miesięczny się zgadza.
- [ ] Można dodać wizytę u weterynarza (data/godzina/placówka/status) i oznaczyć ją jako odbytą.
- [ ] Nowe wpisy domyślnie `household`; ustawienie „Tylko ja" na profilu przenosi jego wydatki i wizyty do części prywatnej (widoczne tylko dla właściciela) — sprawdzalne w `workspace.node.mjs`.
- [ ] Zaplanowana wizyta weterynaryjna z godziną generuje przypomnienie push ~24 h wcześniej (weryfikacja logiki `derivedReminders` w `worker.mjs`; prywatna wizyta idzie tylko do subskrypcji właściciela).
- [ ] Odczyt workspace dla gospodarstwa bez danych zwierząt zwraca puste tablice `pets`/`petExpenses`/`petVisits` i nie wywraca `advancedDataSchema.parse`.
- [ ] `npm run build`, `npm test` i `npm run test:server` przechodzą.
- [ ] Aplikacja odpala się i feature działa w preview (w tym na wąskim ekranie — to PWA).

## Ryzyka

- **Rejestry `workspace.mjs` to źródło prawdy dla prywatności i zgodności wstecznej.** Pominięcie `pets` w `META_COLLECTIONS` lub `petExpenses`/`petVisits` w `CHILD_RELATIONS` spowoduje wyciek prywatnych wpisów do części wspólnej albo brak materializacji kluczy przy odczycie (i wywrócenie `advancedDataSchema.parse` na kliencie). Zmieniać wszystkie trzy rejestry razem.
- **`ownerId`/`visibility` z sesji, nie z klienta.** Split (`withOwner`, `workspace.mjs:54–62`) wymusza `ownerId = userId` i `visibility = "private"` dla wpisów prywatnych — nie polegać na wartościach z klienta. Zachować to zachowanie; nie dodawać zaufania do pól z body.
- **Rollout PWA / stale service worker.** `workspaceDocumentIsValid` wymaga obecności każdego klucza z `ADVANCED_COLLECTIONS`. Klient ze starym, zcache'owanym bundlem może wysłać dokument bez `pets*` → `PUT` zwróci 400 do czasu odświeżenia PWA. Ryzyko przejściowe; rozważyć czy potraktować nowe klucze w walidatorze jako opcjonalne na czas wdrożenia (kosztem słabszej walidacji kształtu id).
- **Konflikty rewizji** przy równoległej edycji dwóch urządzeń — obsłużone przez istniejący mechanizm `409`/trójstronny merge; nowe kolekcje wpinają się w ten sam schemat scalania po `id` (nic dodatkowego, ale warto sprawdzić merge zagnieżdżonego `fishStock`: scalanie jest po `id` rekordu `Pet`, więc równoległa edycja obsady tego samego akwarium rozstrzyga się „last write wins" na całym rekordzie — akceptowalne dla MVP).
- **Dedup i prefiks reminderów** — `pet-visit:${id}` musi być stabilny i różny od `health-appointment:`/`vehicle:`, inaczej kolizja w `notification_deliveries`.
- **Enumeracje kolekcji rozsiane po kodzie** (`useAdvancedStore` merge/partialize/export, `WorkspaceSync`, `SettingsPage`) — pominięcie którejś zostawi kolekcję nietrwałą/nieczyszczoną. Lista miejsc w sekcji „Pliki do zmiany" jest kompletna wg `grep` po `carExpenses`/`healthAppointments`.

## Pytania do doprecyzowania

Brak otwartych pytań blokujących implementację — wszystkie decyzje podjęto w drugiej rundzie doprecyzowującej:

- Nazwa zakładki: **„Zwierzęta"**.
- Kafelek na `TodayPage`: **tak**, w zakresie (patrz Wymagania/Zakres/Kryteria akceptacji).
- Pola profilu: **bez wagi zwierzęcia i bez parametrów wody akwarium** w MVP (patrz Non-goals, kształt `Pet` w „Pliki do zmiany").
- Powtarzalność wizyt: **poza zakresem MVP** — pojedyncze `petVisits` wystarczą; mechanizm `Recurrence` (`src/types.ts`) można podpiąć później bez zmiany reszty modelu.

Świadomie odłożone na przyszłość (nie blokują tej iteracji):
- Lista `PetKind` (`rabbit | dog | cat | guinea_pig | aquarium | other`) — `other` pokrywa na razie ptaki/gady/chomiki; rozszerzenie listy to kwestia jednej linii, gdy się przyda.
- Automatyczne księgowanie wydatków na zwierzę do modułu Finanse (jak `source: "car"`) — pozostaje non-goal do czasu osobnej decyzji.

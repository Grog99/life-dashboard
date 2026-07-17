# Migracja modułu Lista zakupów (Meals) na znormalizowany model SQL

> Plan wygenerowany przez skill `/plan-feature`. Slug: `lista-zakupow-meals`. Branch: `claude/data-model-migration-plan-7thtmy` (istniejący branch zadania — NIE `feature/lista-zakupow-meals`).
>
> Kontynuacja serii migracji z `docs/DATA_MODEL_MIGRATION.md` (moduł #2, priorytet średni).
> **Wzorce referencyjne — dwie już zmergowane migracje wg tego samego wzorca:**
> - Finanse (PR #11, pilot): `docs/plans/model-synchronizacji-danych.md`, `server/src/finance.mjs`,
>   `server/migrations/006_finance_normalized.sql`, `src/store/useFinanceStore.ts`,
>   `src/hooks/useFinanceSync.ts`, `src/server/FinanceSync.tsx`.
> - Podróże (PR #13, najświeższy precedens, strukturalnie najbliższy — rodzic + kolekcje potomne):
>   `docs/plans/podroze-trips.md`, `server/src/trips.mjs`, `server/migrations/007_trips_normalized.sql`,
>   `src/store/useTripsStore.ts`, `src/hooks/useTripsSync.ts`, `src/server/TripsSync.tsx`.
>
> Ten plan świadomie kopiuje kształt Podróży (rodzic `recipes` + dzieci `mealSlots`/`shoppingItems`)
> i wskazuje różnice specyficzne dla Meals. Non-goals dopasowane do modułu — **nie** kopiujemy dosłownie
> Non-goals Finansów.

## Kontekst / Problem

Moduł Posiłki (Meals) to dziś fragment dokumentu JSONB (`workspace_states` / `user_workspace_states`),
synchronizowany generycznym mechanizmem `PUT /api/v1/workspace` (globalna rewizja + 3-way merge po
`id`, patrz `server/src/workspace.mjs`, `src/server/WorkspaceSync.tsx`). Kolekcje: `recipes` (rodzic)
oraz `mealSlots` (dziecko przez `recipeId`) i `shoppingItems` (dziecko przez **opcjonalne**
`sourceRecipeId` — lista zakupów działa też jako ogólna, wspólna lista niezwiązana z żadnym przepisem,
więc `sourceRecipeId` może być NULL). Patrz `CHILD_RELATIONS` w `server/src/workspace.mjs:14-21`.

Uzasadnienie migracji (`docs/DATA_MODEL_MIGRATION.md`, „Uzasadnienie priorytetów" → punkt 2):

- **Dowód (b) — częsta współbieżna edycja tej samej listy.** W odróżnieniu od Finansów/Podróży moduł
  **nie ma pola agregującego** (brak dowodu (a) — nie ma `balanceMinor`/`progress`). Ma za to realną,
  częstą kolizję UX: kilka osób jednocześnie odznacza/dodaje pozycje na wspólnej liście zakupów stojąc
  razem w sklepie. To dokładnie scenariusz, w którym per-dokumentowy globalny `409` + 3-way merge całego
  dokumentu odczuwalnie przeszkadza (dużo drobnych, jednoczesnych zmian tej samej kolekcji `shoppingItems`
  w krótkim oknie czasu — odznaczenie `checked`, dołożenie pozycji).
- `recipes`/`mealSlots` mają niższe ryzyko kolizji same w sobie, ale są tym samym bounded context
  (powiązane przez `recipeId`/`sourceRecipeId`), więc migrują się **razem** z listą zakupów (zasada #2
  serii: kolekcje potomne migrują z rodzicem, nigdy osobno).

Efekt docelowy: Posiłki przestają być częścią dokumentu JSONB. Dostają znormalizowane tabele SQL,
mutacje domenowe z kluczami idempotencji generowanymi po stronie klienta, optymistyczną kontrolę
współbieżności per rekord (kolumna `version`). Konflikt staje się per-rekordowy: odznaczenie jednej
pozycji przez jedną osobę i dołożenie innej pozycji przez drugą **nie** wpadają już w jeden globalny
`409`. UI/UX pozostaje ten sam poza zmianami wymuszonymi modelem (patrz Non-goals).

## Wymagania

Funkcjonalne:

- Dane posiłków (`recipes`, `mealSlots`, `shoppingItems`) w znormalizowanych tabelach SQL, nie w JSONB.
- Każda mutacja domenowa (dodanie/edycja/usunięcie przepisu, ustawienie/edycja/usunięcie slotu posiłku,
  dodanie/edycja/odznaczenie/usunięcie pozycji zakupowej, generowanie pozycji z przepisu) niesie **klucz
  idempotencji (UUID) generowany przez klienta**; serwer deduplikuje po kluczu (tabela `meal_mutations`,
  retencja 30 dni).
- **Optymistyczna współbieżność per rekord** (`version`); konflikt zwracany tylko dla konkretnego
  rekordu, reszta batcha przechodzi.
- **Kasowanie przepisu odpina powiązania, nie kasuje dzieci** (decyzja użytkownika): usunięcie `recipe`
  ustawia `mealSlots.recipeId = NULL` i `shoppingItems.sourceRecipeId = NULL`, a same rekordy dzieci
  **zostają**. Realizowane deklaratywnie FK-em `ON DELETE SET NULL` (nie kaskada, nie blokada).
- Jednorazowa migracja SQL przenosi istniejące dane posiłków z JSONB (wspólne z `workspace_states`,
  historyczne prywatne z `user_workspace_states`) do nowych tabel z zachowaniem `id`/znaczników czasu,
  po czym **całkowicie usuwa** kolekcje meals z dokumentu JSONB i z generycznego sync (bez fallbacku).

Niefunkcjonalne:

- **Offline-first zachowany** — mutacje kolejkują się bez sieci i bezpiecznie odtwarzają (idempotencja),
  optymistyczny UI natychmiast pokazuje zmianę lokalnie.
- Widok Posiłków wygląda i działa tak samo, także na wąskim ekranie (PWA).
- Reużycie istniejących wzorców backendu i frontendu z Finansów/Podróży (patrz „Pliki do zmiany").

## Zakres i Non-goals

**W zakresie:**

- Moduł Posiłki jako bounded context: `recipes`, `meal_slots`, `shopping_items` + tabela idempotencji
  `meal_mutations`.
- Nowe endpointy REST `/api/v1/meals` (snapshot), `/api/v1/meals/mutations` (batch), `/api/v1/meals/reset`.
- Nowy store frontendu (`useMealsStore`) + silnik synchronizacji (`useMealsSync` / `MealsSync`).
- **Migracja danych historycznych** z JSONB (wspólne + prywatne) do nowych tabel, wycięcie meals z JSONB.
- Wycięcie meals z `workspace.mjs` (`META_COLLECTIONS`/`CHILD_RELATIONS`/`ADVANCED_COLLECTIONS`),
  `useAdvancedStore`, `WorkspaceSync.tsx`, `advancedDataSchema`, `advancedData.ts`.
- Prune retencji `meal_mutations` w workerze (obok istniejącego dla finance/trips).

**Non-goals (świadomie pomijamy — dopasowane do Meals, nie kopia Finansów):**

- **Żaden inny moduł nie jest ruszany** (Finanse i Podróże już zmigrowane; Car/Pets/Health/
  Subscriptions/Life zostają na JSONB — patrz `docs/DATA_MODEL_MIGRATION.md`). Nie budujemy generycznej
  „platformy sync" na wyrost (YAGNI); kod idempotencji/wersjonowania piszemy w kontekście Meals, każdy
  moduł ma **własną** tabelę idempotencji (`meal_mutations`, nie reużywamy `finance_mutations`/`trip_mutations`).
- **Bez redesignu UI Posiłków.** Ten sam layout, te same modale, zakładki i komunikaty. Zmienia się tylko
  warstwa danych i to, co wymusza nowy model: (1) **znika selektor „widoczność" z modalu przepisu**
  (`MealsPage.tsx:848-859`) — przepisy są zawsze wspólne (patrz niżej); (2) „Usuń z planu" w modalu
  posiłku przestaje zostawiać pusty slot i staje się realnym `meal.delete` (patrz Podejście → „Slot
  posiłku").
- **Brak koncepcji prywatności w module** — wszystkie trzy kolekcje są ZAWSZE wspólne dla gospodarstwa
  (decyzja użytkownika), analogicznie do Finansów/Podróży. Tabele meals **nie mają** kolumn
  `owner_id`/`visibility` (model jak `finance_budgets`/`trips`). To **różnica względem dzisiejszego stanu**:
  `Recipe` dziś rozszerza `SharedMeta` i modal przepisu ma aktywny selektor prywatności — po migracji
  przepisy tracą tę własność (jak `Trip` stracił). Historyczne prywatne przepisy migrują jako wspólne
  (ujawnienie zaakceptowane, patrz Ryzyka).
- **Bez nowych funkcji Posiłków** — endpointy modelują dokładnie dzisiejszy zestaw mutacji UI
  (`MealsPage.tsx`). Miejsce na rozszerzenie zostawiamy w projekcie, ale go nie implementujemy.
- **Brak pola agregującego / serwerowego przeliczania** (w odróżnieniu od `progress` w Podróżach czy
  `balanceMinor` w Finansach) — Meals nie ma takiego pola, więc nie ma odpowiednika `computeTripProgress`.
  Postęp listy zakupów (`shoppingProgress` w `MealsPage.tsx:110`) jest liczony w UI z `checked` i taki
  zostaje. To upraszcza moduł względem Podróży.
- **Worker nietknięty w części odczytowej** — w odróżnieniu od Podróży (worker czytał `advanced.trips`),
  worker **nie** czyta posiłków (`grep` po `worker.mjs` — brak `recipe`/`meal`/`shopping`). Dotykamy go
  wyłącznie o jedną linię prune retencji `meal_mutations`.

## Podejście

### Decyzje ustalone z góry (twarde wymagania planu)

Sesja planowania jest non-interactive; poniższe podjęto na podstawie ustaleń z użytkownikiem, parytetu
z Finansami/Podróżami i YAGNI:

1. **Zakres: cały bounded context Meals naraz** (jeden plan, jedna migracja SQL, jeden PR): `recipes`
   (rodzic) + `mealSlots` (dziecko przez `recipeId`) + `shoppingItems` (dziecko przez opcjonalne,
   NULL-owalne `sourceRecipeId`).
2. **Migracja: pełna migracja SQL + całkowite zastąpienie** (po migracji meals znika z JSONB, brak shimów).
3. **Idempotency keys: klient generuje UUID per mutacja**, osobna tabela `meal_mutations` (jak
   `trip_mutations`/`finance_mutations`).
4. **Konflikty: optimistic concurrency per rekord** przez `version`.
5. **Wszystkie trzy kolekcje zawsze wspólne** — brak kolumn `owner_id`/`visibility`.
6. **Kasowanie przepisu = odpięcie powiązań (SET NULL), nie kaskada, nie blokada.**

### Model tabel (Postgres) — `server/migrations/008_meals_normalized.sql`

`id` typu `text` (zachowanie legacy `id` 1:1, jak w Finansach/Podróżach — `idSchema` dopuszcza stringi do
200 znaków). `updated_by uuid REFERENCES users(id)` jako lekki audyt. **Brak `owner_id`/`visibility`** —
meals są zawsze household-wide (model jak `trips`), więc snapshot filtruje wyłącznie po `household_id`.
Mapowanie typów jak w `trips.mjs`: `date` przez `::text AS …` (uniknięcie lokalno-strefowego parsowania
przez node-postgres), `tags`/`ingredients` jako `jsonb` (proste `string[]`, nietabelaryczne, wzór
`trips.travelers`), `timestamptz` przez `.toISOString()`.

- **`recipes`**: `id text PK`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `name text NOT NULL`, `minutes integer NOT NULL CHECK (minutes > 0)`,
  `servings integer NOT NULL CHECK (servings > 0)`, `tags jsonb NOT NULL DEFAULT '[]'`,
  `ingredients jsonb NOT NULL DEFAULT '[]'`, `favorite boolean NOT NULL DEFAULT false`,
  `version integer NOT NULL DEFAULT 1`, `created_at timestamptz NOT NULL DEFAULT now()`,
  `updated_at timestamptz NOT NULL DEFAULT now()`, `updated_by uuid REFERENCES users(id)`.
  Indeks: `(household_id)`. **Bez `owner_id`/`visibility`** (różnica względem dziś — patrz Non-goals).
- **`meal_slots`**: `id text PK`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `recipe_id text REFERENCES recipes(id) ON DELETE SET NULL` (**nullable**, realizuje decyzję #6 —
  usunięcie przepisu odpina slot, nie kasuje), `date date NOT NULL`,
  `type text NOT NULL CHECK (type IN ('breakfast','lunch','dinner'))`, `title text NOT NULL`,
  `servings integer NOT NULL CHECK (servings > 0)`, `version integer NOT NULL DEFAULT 1`,
  `created_at`, `updated_at`, `updated_by`. Indeksy: `(household_id)`, `(recipe_id)`.
- **`shopping_items`**: `id text PK`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `source_recipe_id text REFERENCES recipes(id) ON DELETE SET NULL` (**nullable** — lista działa też jako
  ogólna, realizuje decyzję #6), `name text NOT NULL`, `quantity text NOT NULL DEFAULT ''`,
  `category text NOT NULL`, `checked boolean NOT NULL DEFAULT false`, `assigned_to text`,
  `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
  Indeksy: `(household_id)`, `(source_recipe_id)`.
- **`meal_mutations`** (idempotencja + lekki audyt, 1:1 jak `trip_mutations`):
  `idempotency_key uuid PRIMARY KEY`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `user_id uuid NOT NULL REFERENCES users`, `op text NOT NULL`, `result jsonb NOT NULL`,
  `created_at timestamptz NOT NULL DEFAULT now()`. Indeks `(created_at)` do retencji.

**Uwaga o `ON DELETE SET NULL` vs `CASCADE` (kluczowa różnica względem Podróży):** Podróże używały FK
`ON DELETE CASCADE` (usunięcie podróży kasowało dzieci). Tu decyzja #6 wymaga **`SET NULL`** — usunięcie
przepisu odpina `mealSlots`/`shoppingItems`, nie kasuje ich. Konsekwencja dla `reset`: `resetMealsForHousehold`
**nie może** polegać na kaskadzie z `recipes` (bo jej nie ma) — musi jawnie `DELETE` z wszystkich trzech
tabel (`shopping_items`, `meal_slots`, `recipes`), patrz niżej.

### Ops mutacji (mapowanie 1:1 na dzisiejsze akcje UI z `MealsPage.tsx`)

Modelujemy dokładnie obecny zestaw akcji. Analiza `MealsPage.tsx` + `useAdvancedStore.ts`:

**Przepisy (`recipes`):**
- `recipe.create` — dziś `addRecipe(...)` (`MealsPage.tsx:241`). Payload: `name`, `minutes`, `servings`,
  `tags[]`, `ingredients[]`, `favorite:false`. **Bez `ownerId`/`visibility`** (usuwane).
- `recipe.update` — dziś dwie ścieżki `useAdvancedStore.setState`: (a) edycja przepisu
  (`MealsPage.tsx:229-238`, pola `name`/`minutes`/`servings`/`tags`/`ingredients`), (b) `toggleFavorite`
  (`:247-253`, pole `favorite`). `RECIPE_UPDATE_KEYS = {name, minutes, servings, tags, ingredients, favorite}`.
- `recipe.delete` — dziś `removeRecipe` (`:255-264`). Serwer: `DELETE FROM recipes` — FK `SET NULL` odpina
  dzieci automatycznie. **Kaskada rename tytułu slotu** (patrz niżej) obsługiwana osobno przy edycji.

**Sloty posiłków (`mealSlots`):**
- `meal.create` / `meal.update` — dziś `setMealSlot` (`:129-141`) robi upsert: znajduje istniejący slot po
  `id` **lub** po `(date, type)` i aktualizuje, inaczej tworzy nowy. Store zachowa tę logikę lokalnie i
  wyemituje `meal.create` albo `meal.update` w zależności od tego, czy slot dla `(date,type)` już istnieje.
  Pola: `date`, `type`, `recipeId?`, `title`, `servings`. `MEAL_UPDATE_KEYS = {recipeId, title, servings, date, type}`.
- `meal.delete` — dziś `clearMeal` (`:173-185`) ustawiał `title:""` (pusty slot, filtrowany w UI jako „brak
  posiłku"). **Zmiana wymuszona modelem:** `mealSlotSchema` wymaga `nonEmptyText` tytułu, więc nie da się
  persystować pustego slotu → „Usuń z planu" staje się realnym `meal.delete`. To sprzątnięcie (znikają
  fantomowe puste sloty), nie regresja. Patrz Pytania.

**Lista zakupów (`shoppingItems`):**
- `shopping.create` — dziś `addShoppingItem` (`:285-297`, ręczne dodanie). Pola: `name`, `quantity`,
  `category`, `checked:false`, `assignedTo?`, `sourceRecipeId?`.
- `shopping.update` — dziś `toggleShoppingItem` (`:147-152`, pole `checked`). `SHOPPING_UPDATE_KEYS =
  {checked, name, quantity, category, assignedTo}` (domykamy do pełnego zestawu edytowalnych pól, parytet
  z tym, jak `booking.update` w Podróżach wystawia więcej niż UI dziś rusza).
- `shopping.delete` — dziś `removeShoppingItem` (`:299-303`) oraz `clearChecked` (`:305-315`, usunięcie
  wszystkich `checked` pozycji naraz → **seria** `shopping.delete`, jedna per pozycja).

**Generowanie pozycji z przepisu (funkcja istnieje — sprawdzone):**
- `addRecipeIngredientsToShopping(recipeId)` (`useAdvancedStore.ts:155-183`, wywoływana z
  `putRecipeOnList` `:266-269` „Na listę" i `addWeekToShopping` `:271-283` „Składniki z planu tygodnia").
  Parsuje składniki przepisu na `{name, quantity}`, **deduplikuje po znormalizowanej nazwie** względem
  bieżącej listy, ustawia `category:"Z przepisu"`, `sourceRecipeId:recipeId`, zwraca liczbę dodanych.
  Modelowanie: logika parsowania + dedup **zostaje po stronie klienta** (parytet), a wynik to **seria**
  `shopping.create` (po jednej mutacji na dodaną pozycję), analogicznie do serii `packing.update` przy
  zbiorczym rename `assignedTo` w Podróżach. Dedup pozostaje best-effort klientowy (patrz Ryzyka/Pytania).

**Kaskada rename tytułu slotu przy edycji przepisu** (`MealsPage.tsx:233-237`): dziś edycja przepisu
aktualizuje `title` tych slotów, których `recipeId === recipe.id` **i** `title === staraNazwa`. Model:
seria `meal.update` z `changes: { title }` emitowana przez store obok `recipe.update` (parytet z serią
`packing.update` przy rename podróżnika w Podróżach). Heurystyka „tylko sloty z tytułem == stara nazwa"
zachowana. Patrz Pytania.

**Zestaw op:**
```
recipe.create, recipe.update, recipe.delete
meal.create,   meal.update,   meal.delete
shopping.create, shopping.update, shopping.delete
```

Wersjonowanie (OCC) jak w Podróżach: `*.update`/`*.delete` niosą `baseVersion`; `UPDATE … SET …,
version = version + 1 WHERE id=$ AND household_id=$ AND version=$baseVersion`; `rowCount=0` → zwróć
aktualny rekord + `currentVersion` jako `status:"conflict"`. Usuwanie idempotentne (brak rekordu =
`applied`, wzór `resolveConflictOrGone` z `trips.mjs`). **Brak pola agregującego** → żadna mutacja
dziecka nie przelicza rodzica (prościej niż Podróże — nie ma `recomputeTripProgress`, `recipe.update`/
`meal.*`/`shopping.*` są niezależne).

**`meal.create`/`shopping.create` a walidacja `recipeId`/`sourceRecipeId`:** oba są opcjonalne. Gdy
podane, walidator sprawdza kształt `isId`, a SQL — jak w `trip_itinerary` z `trip_id`, ale odwrotnie:
tu FK jest NULL-owalny, więc jeśli `recipe_id` wskazuje nieistniejący przepis, `INSERT` poleci `23503`
(foreign_key_violation). Obsłużyć: przy `recipeId`/`sourceRecipeId` niepustym najpierw sprawdzić istnienie
przepisu w gospodarstwie (jak `tripCheck` w `execItineraryCreate`) i zwrócić `status:"error"`
(`RECIPE_NOT_FOUND`) zamiast rzucać 23503; przy NULL — pominąć sprawdzenie.

### Endpointy REST (wzorzec 1:1 z Podróży — `server/src/server.mjs:712-756`)

- **`GET /api/v1/meals`** → `{ recipes[], mealSlots[], shoppingItems[], serverAt }`, każdy rekord z
  `version`. Filtr: `WHERE household_id = $1` (bez filtra widoczności — wszystko wspólne). Wzór:
  `readTripsSnapshot` + `GET /api/v1/trips`.
- **`POST /api/v1/meals/mutations`** → body `{ mutations: Mutation[] }`,
  `Mutation = { idempotencyKey: uuid, op, payload, baseVersion? }`. Serwer: walidacja kształtu całego
  batcha z góry (`assertMealMutationShape`, wzór `assertTripMutationShape`), potem sekwencyjnie każda
  mutacja w `transaction()`: claim klucza (`INSERT … ON CONFLICT (idempotency_key) DO NOTHING` → retry
  zwraca zapisany `result`), walidacja payloadu, SQL (create / update-z-OCC / delete-z-OCC), zapis
  `result`. Odpowiedź `200` z `{ results: [{ idempotencyKey, status: "applied"|"duplicate"|"conflict"|"error",
  record?, currentVersion?, error?, code? }], serverAt }`. Globalne `400/413` tylko dla błędów całego
  żądania (zły kształt, przekroczony cap `MAX_MEAL_MUTATIONS` / bajtów). Wzór 1:1: blok trips w server.mjs.
- **`POST /api/v1/meals/reset`** → `resetMealsForHousehold(client, householdId)`:
  `DELETE FROM shopping_items WHERE household_id=$1; DELETE FROM meal_slots WHERE household_id=$1;
  DELETE FROM recipes WHERE household_id=$1;` (kolejność: dzieci przed rodzicem, bo FK `SET NULL` **nie**
  kaskaduje — to różnica względem `resetTripsForHousehold`, które kasowało tylko `trips` licząc na kaskadę).
  Potrzebne, bo „Wyczyść dane aplikacji" (`SettingsPage.tsx:176-177`) po normalizacji nie ma już czym
  nadpisać meals w JSONB. Zakres prosty jak w Podróżach: brak rekordów prywatnych, czyścimy całe
  gospodarstwo bezwarunkowo (nie per-user jak w Finansach).

Reużycie (wszystko już istnieje w `server.mjs` po Finansach/Podróżach): `requireHousehold`, `transaction()`,
handler `23505 → 409`, `httpError`, cap batcha (`MAX_MEAL_MUTATIONS_PER_BATCH`/`_BYTES` na wzór
`MAX_TRIP_MUTATIONS_*`), sekwencyjne przetwarzanie mutacji.

### Backend — `server/src/meals.mjs` (wzór 1:1 z `server/src/trips.mjs`)

Czyste, testowalne funkcje (walidatory payloadów per `op`, `resolveVersionConflict`, mapery wiersz→DTO)
oraz funkcje wykonujące SQL na przekazanym `client`. **Bez importu z `src/`** (parytet z `trips.mjs`/
`finance.mjs` — serwer nie ma builda TS/zod; walidatory ręczne odzwierciedlają `recipeSchema`/
`mealSlotSchema`/`shoppingItemSchema`). Eksporty: `readMealsSnapshot(client, householdId)`,
`applyMealMutation(client, ctx, mutation)`, `resetMealsForHousehold(client, householdId)`,
`SUPPORTED_MEAL_OPS`, `assertMealMutationShape`, `MAX_MEAL_MUTATIONS_*`, walidatory + mapery
(`recipeRowToDto`/`mealSlotRowToDto`/`shoppingItemRowToDto`), `resolveVersionConflict`. Reużywa
`resolveConflictOrError`/`resolveConflictOrGone` (skopiowane z `trips.mjs`). `recipe.delete` = zwykły
`DELETE` z opcjonalnym OCC; FK `SET NULL` załatwia odpięcie dzieci (patrz Ryzyka o wersji dzieci).

### Frontend — dedykowany store + silnik sync (offline-first)

- **`src/store/useMealsStore.ts` (nowy)** — wzór 1:1 z `src/store/useTripsStore.ts`: Zustand + `persist`
  (klucz `puls-meals`), `safeLocalStorage`, `parseArrayField`, `merge` z guardem
  `persistedState === undefined` (unikamy fałszywego „niezgodny format" na czystej instalacji — luka #3
  ze „Status po wdrożeniu" Finansów, już poprawiona w `useTripsStore.ts:675-687`). Trzyma
  `recipes/mealSlots/shoppingItems` (każdy z `version`) + `pendingMutations[]` + `serverAt`/`hydrated`.
  Akcje **zachowują nazwy i sygnatury** dzisiejszych akcji z `useAdvancedStore`, żeby diff w `MealsPage`
  był minimalny: `addRecipe`, `setMealSlot`, `addShoppingItem`, `toggleShoppingItem`,
  `addRecipeIngredientsToShopping` — **oraz nowe** akcje przenoszące dzisiejsze `useAdvancedStore.setState`
  z `MealsPage`: `updateRecipe` (edycja pól + kaskada tytułów slotów jako seria `meal.update`),
  `toggleRecipeFavorite`, `deleteRecipe` (optymistycznie: usuń przepis lokalnie **i** odepnij lokalnie
  `recipeId`/`sourceRecipeId` dzieci — odbicie serwerowego `SET NULL`, wzór `deleteTrip` w
  `useTripsStore.ts:375-388` kaskadującego lokalnie), `deleteMealSlot`, `updateShoppingItem`,
  `removeShoppingItem`, `clearCheckedShoppingItems` (seria `shopping.delete`), `hydrateFromSnapshot`,
  `applyMutationResults`, `resetMealsData`. Każda akcja: optymistyczna zmiana lokalna → `idempotencyKey`
  → dołożenie mutacji do `pendingMutations` z `baseVersion`. Reużyj `upsertById`/`removeById`/
  `reconcileTerminal`/`upsertByUpdateOp`/`isUpdateOp` 1:1 z `useTripsStore.ts` (bez wariantu `trip`
  w wyniku — Meals nie ma pola agregującego, więc `result.trip` nie istnieje; `reconcileTerminal` jest
  prostszy).
- **`src/hooks/useMealsSync.ts` + `src/server/MealsSync.tsx` (nowe)** — wzór 1:1 z `useTripsSync.ts` /
  `TripsSync.tsx`: montaż → `GET /api/v1/meals` (hydratacja) → drenaż kolejki przez
  `POST /api/v1/meals/mutations`; obsługa `applied`/`duplicate`/`conflict`/`error`; `MAX_FLUSH_ROUNDS`;
  nasłuch `online`/`focus`/`visibilitychange`; nieblokujący provider z własnym `sync-indicator`
  (`sync-indicator--meals`, etykiety „Zapisuję posiłki" / „Posiłki czekają na sieć" / „Posiłki
  zsynchronizowane"). Reużywa `apiRequest`/`ApiError` z `src/server/api.ts`.
- **Montaż**: w `src/server/AuthGate.tsx` zagnieżdżony wewnątrz `TripsSync` (ten sam `key`/`onSessionExpired`):
  `<WorkspaceSync><FinanceSync><TripsSync><MealsSync …>{children}</MealsSync></TripsSync></FinanceSync></WorkspaceSync>`.
  Dorzuć `useMealsStore` do `bindLocalStorageTo`/`clearLocalUserData` (reset + `safeRemoveStorageItem("puls-meals")`)
  i do `hasUnsyncedChanges` (`useMealsStore.getState().pendingMutations.length > 0`), analogicznie do trips
  (`AuthGate.tsx:60-102,329-335`).

### Odróżnianie prywatne/wspólne

Nie dotyczy po migracji — wszystkie kolekcje meals zawsze wspólne. Snapshot i wszystkie mutacje scope'ują
wyłącznie po `household_id` (z sesji, nigdy z payloadu). Znika selektor „widoczność" z modalu przepisu
(`MealsPage.tsx:848-859`), pole `visibility` z `RecipeDraft` (`:50,65,226`), `ownerId: currentOwnerId`
z `addRecipe` (`:241`) i sam `currentOwnerId` (`:70`). `Recipe` przestaje rozszerzać `SharedMeta`
(patrz `src/mealsTypes.ts`).

### Migracja danych historycznych (`008_meals_normalized.sql`)

Wzór 1:1 z `007_trips_normalized.sql` (defensywność wobec `NULL`/nieobecnych kolekcji, `ON CONFLICT (id)
DO NOTHING`, idempotentne przez `schema_migrations`), z uproszczeniem (brak `owner_id`/`visibility`):

1. `CREATE TABLE IF NOT EXISTS` dla czterech tabel + indeksy.
2. **Przepisy wspólne**: `jsonb_array_elements(ws.data->'advanced'->'recipes')` → `recipes`
   (`household_id = ws.household_id`, `tags`/`ingredients` jako `COALESCE(rec->'tags','[]'::jsonb)` itd.,
   `minutes`/`servings` z clampem `GREATEST(1, …)`).
3. **Przepisy prywatne (historyczne)**: `jsonb_array_elements(uws.data->'advanced'->'recipes')` → `recipes`
   z `household_id = uws.household_id`, **jako household** (przepisy nie mają już widoczności). Migrujemy
   jako wspólne (zero utraty danych; ujawnienie całemu gospodarstwu jest akceptowaną konsekwencją decyzji
   „zawsze wspólne", patrz Ryzyka) — dokładnie jak podróże w `007`.
4. **Dzieci** (`mealSlots`/`shoppingItems`) z `workspace_states` **i** `user_workspace_states`:
   - `meal_slots`: `recipe_id = NULLIF(rec->>'recipeId','')` z guardem `LEFT JOIN`/`CASE` — wpisz `recipe_id`
     **tylko** gdy istnieje zmigrowany przepis w tym samym gospodarstwie, inaczej `NULL` (slot bez przepisu
     jest legalny). `date`/`type`/`title`/`servings` z clampami jak w `007`.
   - `shopping_items`: `source_recipe_id` analogicznie NULL-owalny z guardem (pozycja bez przepisu legalna).
     `checked`/`quantity`/`category`/`assigned_to` z `COALESCE`/`NULLIF`.
   - **Różnica względem `007`:** tam dzieci bez zmigrowanego rodzica były **pomijane** (`WHERE EXISTS …`).
     Tu `mealSlots`/`shoppingItems` **migrują zawsze** (rodzic opcjonalny) — brakujący/nieznany rodzic daje
     `NULL` w FK, a nie pominięcie rekordu.
5. **Wycięcie z JSONB**: `UPDATE workspace_states SET data = data #- '{advanced,recipes}' #- '{advanced,mealSlots}'
   #- '{advanced,shoppingItems}', revision = revision + 1 WHERE data->'advanced' ?| array['recipes','mealSlots','shoppingItems']`
   oraz analogicznie `user_workspace_states` (`updated_at = now()`). Bump `revision` wymusza czysty refetch
   u klientów (wzór `007:339-355`).

## Pliki do zmiany

### Baza (warstwa danych)

- `server/migrations/008_meals_normalized.sql` (**nowy**) — kolejny numer po `007_trips_normalized.sql`.
  `CREATE TABLE` czterech tabel + indeksy + migracja danych (wspólne + prywatne) + wycięcie z JSONB (opis
  wyżej). Wzorzec: `server/migrations/007_trips_normalized.sql`.
- `src/mealsTypes.ts` (**nowy**) — przenieś `Recipe`, `MealSlot`, `ShoppingItem` z `src/advancedTypes.ts`;
  **dodaj `version: number` i `updatedAt: string`** do każdego; `Recipe` **przestaje rozszerzać
  `SharedMeta`** (usuń `ownerId`/`visibility`). Wspólne źródło prawdy backend/frontend (jak
  `src/tripsTypes.ts` / `src/financeTypes.ts`).
- `src/advancedTypes.ts` — usuń `recipes`/`mealSlots`/`shoppingItems` z interfejsu `AdvancedData`
  (`:180-183`) i definicje przeniesionych typów (`:30-57`); dodaj re-eksport
  `export type { Recipe, MealSlot, ShoppingItem } from "./mealsTypes"` (wzór linii `:13` dla trips).
- `src/lib/schema.ts` — usuń `recipes`/`mealSlots`/`shoppingItems` z `advancedDataSchema` (`:423-425`);
  przebuduj `recipeSchema` (**usuń `sharedMetaSchema`**, dodaj `version: recordVersion` + `updatedAt: timestamp`),
  `mealSlotSchema`/`shoppingItemSchema` (dodaj `version` + `updatedAt`) do walidacji snapshotu i persystencji
  nowego store'u (wzór: `tripSchema`/`tripItinerarySchema` z `version`, `:222-275`). Zaktualizuj import
  typów (dodaj `Recipe`/`MealSlot`/`ShoppingItem` z `./mealsTypes`, jak trips `:9`).

### Backend (warstwa backend)

- `server/src/meals.mjs` (**nowy**) — analogicznie do `server/src/trips.mjs`: walidatory payloadów per `op`
  (`validateRecipeCreatePayload`, `validateRecipeUpdatePayload`, `validateMealCreatePayload`,
  `validateMealUpdatePayload`, `validateShoppingCreatePayload`, `validateShoppingUpdatePayload`,
  `validateDeleteIdPayload`), `resolveVersionConflict`, mapery wiersz→DTO, `readMealsSnapshot`,
  `applyMealMutation`, `resetMealsForHousehold`, `SUPPORTED_MEAL_OPS`, `assertMealMutationShape`,
  `MAX_MEAL_MUTATIONS_*`. Reużywa wzorca `resolveConflictOrError`/`resolveConflictOrGone` z `trips.mjs`.
  Sprawdzenie istnienia przepisu przy niepustym `recipeId`/`sourceRecipeId` (wzór `tripCheck`
  w `execItineraryCreate`, `trips.mjs:937-947`). **Bez `computeTripProgress`-odpowiednika** (brak pola
  agregującego). Reużywa `query`/`transaction` z `db.mjs`.
- `server/src/server.mjs` — dodaj `GET /api/v1/meals`, `POST /api/v1/meals/mutations`,
  `POST /api/v1/meals/reset` (kopiuj strukturę bloków trips `:712-756`; te same reużycia
  `requireHousehold`/`transaction`/`httpError`/cap batcha). Dodaj importy z `./meals.mjs` obok
  `./trips.mjs` (`:24-26`).
- `server/src/workspace.mjs` — usuń `"recipes"` z `META_COLLECTIONS` (`:2`); usuń `mealSlots`/`shoppingItems`
  z `CHILD_RELATIONS` (`:15-16`); usuń `recipes`/`mealSlots`/`shoppingItems` z `ADVANCED_COLLECTIONS`
  (`:27-29`) — to automatycznie wyłącza je z `splitWorkspaceData`/`mergeWorkspaceData` i z
  `workspaceDocumentIsValid`.
- `server/src/worker.mjs` — dodaj prune retencji `meal_mutations` obok istniejących finance/trips
  (`:284-285`): `query("DELETE FROM meal_mutations WHERE created_at < now() - interval '30 days'")`.
  **Poza tym worker nietknięty** — nie czyta posiłków.

### Frontend (warstwa frontend)

- `src/store/useMealsStore.ts` (**nowy**) — dedykowany store z optymistycznymi mutacjami, kolejką
  `pendingMutations`, `version` per rekord (opis w „Podejście"). Wzór: `src/store/useTripsStore.ts`.
- `src/hooks/useMealsSync.ts` + `src/server/MealsSync.tsx` (**nowe**) — silnik sync + nieblokujący provider.
  Wzór: `src/hooks/useTripsSync.ts`, `src/server/TripsSync.tsx` (+ `src/server/api.ts` `apiRequest`/`ApiError`).
- `src/store/useAdvancedStore.ts` — usuń stan `recipes/mealSlots/shoppingItems` (import typów `:35-37`,
  schematów `:14-21`), akcje (`setMealSlot`, `addRecipe`, `toggleShoppingItem`, `addShoppingItem`,
  `addRecipeIngredientsToShopping` — `:72-76,129-183`), z `partialize` (`:433-435`), `merge` (`:353-355,415-417`)
  i `exportAdvancedData` (`:457-459`). Interfejs `AdvancedActions` (`:72-76`) — usuń pięć sygnatur.
- `src/pages/MealsPage.tsx` — podmień importy akcji z `useAdvancedStore` na `useMealsStore` (nazwy bez
  zmian → diff minimalny). Przenieś dzisiejsze `useAdvancedStore.setState` na akcje store'u:
  edycja przepisu (`:229-238`) → `updateRecipe`; `toggleFavorite` (`:247-253`) → `toggleRecipeFavorite`;
  `removeRecipe` (`:257-262`) → `deleteRecipe`; `removeShoppingItem` (`:300-302`) → `removeShoppingItem`;
  `clearChecked` (`:311-313`) → `clearCheckedShoppingItems`; `clearMeal` (`:173-185`) → `deleteMealSlot`.
  **Usuń selektor widoczności** z modalu przepisu (`:848-859`), pole `visibility` z `RecipeDraft`
  (`:50,65,201,226`), `ownerId`/`currentOwnerId` (`:70,241`), import `Visibility` (`:21`).
- `src/server/WorkspaceSync.tsx` — usuń `recipes`/`mealSlots`/`shoppingItems` z `replaceWithEmptyWorkspace`
  (`:49-51`).
- `src/server/AuthGate.tsx` — zamontuj `<MealsSync>` wewnątrz `<TripsSync>` (`:329-335`); dodaj
  `useMealsStore` import (`:19`), reset w `bindLocalStorageTo`/`clearLocalUserData` (`:64-88`) +
  `safeRemoveStorageItem("puls-meals")`, oraz `useMealsStore().pendingMutations` w `hasUnsyncedChanges`
  (`:98-101`).
- `src/pages/SettingsPage.tsx` — w „Wyczyść dane aplikacji" dodaj
  `await apiRequest("/api/v1/meals/reset", { method: "POST", json: {} })` obok trips/finance (`:176-177`)
  i `resetMealsData()` obok `resetTripsData()` (`:218`); usuń `recipes`/`mealSlots`/`shoppingItems`
  z lokalnego `replaceAdvancedData` (`:204-206`).
- `src/data/advancedData.ts` — usuń seed `recipes`/`mealSlots`/`shoppingItems` z `createAdvancedData()`
  (`:92-180`); serwer jest źródłem prawdy (domyślny stan offline = pusty), analogicznie do wycięcia
  seedu trips/finance.

### Testy (aktualizacja + nowe)

- Aktualizacja: `src/store/useAdvancedStore.test.ts` (bez meals), `src/server/workspaceMerge.test.ts`,
  `src/lib/schema.test.ts` (jeśli waliduje advancedData z meals), `src/server/WorkspaceSync.test.tsx`,
  `src/App.test.tsx`, `server/test/workspace.node.mjs` (bez recipes/mealSlots/shoppingItems w split/merge
  i `workspaceDocumentIsValid`).
- Nowe: `src/store/useMealsStore.test.ts` (optymistyczne mutacje, `setMealSlot` upsert po `(date,type)`,
  wersje, kolejka, dedup generowania z przepisu, lokalne odpięcie dzieci przy `deleteRecipe`);
  `server/test/meals.node.mjs` (walidatory, `resolveVersionConflict`, `recipe.delete` → `SET NULL`
  dzieci, `RECIPE_NOT_FOUND` przy nieistniejącym `recipeId`, idempotencja retry, konflikt per rekord,
  reset kasujący wszystkie trzy tabele).

## Kryteria akceptacji

- [ ] `npm run build` (`tsc -b && vite build`) przechodzi — brak martwych referencji do meals w
      `AdvancedData`/`advancedDataSchema`/`useAdvancedStore`/`WorkspaceSync`.
- [ ] `npm test` (Vitest) przechodzi — zaktualizowane testy generyczne bez meals; nowy
      `useMealsStore.test.ts` (optymistyczne mutacje, upsert slotu po `(date,type)`, wersje, kolejka,
      dedup generowania z przepisu, odpięcie dzieci przy `deleteRecipe`); idempotencja (retry z tym samym
      kluczem nie dubluje; `conflict` per rekord).
- [ ] `npm run test:server` (`node --test`) przechodzi — zaktualizowany `workspace.node.mjs` (bez meals
      w split/merge i `workspaceDocumentIsValid`); nowy `server/test/meals.node.mjs`: walidatory,
      `resolveVersionConflict`, kształt wyniku idempotencji, `recipe.delete` odpina (nie kasuje)
      `meal_slots`/`shopping_items`, `RECIPE_NOT_FOUND` przy nieistniejącym `recipeId`, reset kasuje
      wszystkie trzy tabele.
- [ ] Migracja `008` na bazie z istniejącymi posiłkami w JSONB (w tym prywatnymi przepisami): rekordy
      trafiają do tabel z zachowanym `id`/znacznikami czasu, sloty/pozycje bez rodzica migrują z `NULL`
      w FK, `data->'advanced'` nie zawiera już kolekcji meals, dwukrotne uruchomienie nie duplikuje.
- [ ] `npm run preview` (także wąski ekran, PWA): dodanie/edycja/usunięcie przepisu, „ulubione",
      zaplanowanie posiłku (nowy + edycja istniejącego przez ten sam `(date,type)`), „Usuń z planu",
      dodanie/odznaczenie/usunięcie pozycji zakupowej, „Usuń kupione", „Na listę" i „Składniki z planu
      tygodnia" (generowanie z dedup), usunięcie przepisu odpina jego sloty/pozycje (nie kasuje) — działają
      jak przed zmianą; modal przepisu nie ma już selektora widoczności.
- [ ] Offline → online: mutacje bez sieci kolejkują się i zapisują po powrocie; retry tej samej kolejki
      nie tworzy duplikatów.
- [ ] Dwa „urządzenia": równoległe odznaczanie różnych pozycji listy zakupów przechodzi bez konfliktu;
      równoległa edycja **tego samego** rekordu ze starą wersją zwraca konflikt tylko dla niego, reszta
      batcha przechodzi.

## Ryzyka

- **Ujawnienie historycznie prywatnych przepisów.** Przepisy z `user_workspace_states` (dziś widoczne
  tylko właścicielowi, `Recipe` ma dziś aktywny selektor prywatności) migrują jako household → stają się
  widoczne całemu gospodarstwu. To konsekwencja decyzji „zawsze wspólne", świadomie zaakceptowana (zero
  utraty danych przeważa nad ujawnieniem) — odnotować w opisie PR. Silniejsze niż w Podróżach, bo tam
  selektor widoczności był mniej eksponowany; tu użytkownik mógł realnie oznaczać przepisy jako prywatne.
- **`ON DELETE SET NULL` nie bumpuje `version` dzieci.** Usunięcie przepisu odpina `meal_slots`/
  `shopping_items` przez FK, ale akcja FK **nie** podnosi `version` tych wierszy. Klient trzyma starą
  `version` dziecka; kolejna edycja slotu z `baseVersion=stara` nadal przejdzie (kolumna `version` się nie
  zmieniła), a `recipe_id`/`source_recipe_id` nie jest wysyłane w tej edycji, więc pozostaje `NULL` (SQL
  `COALESCE`). Brak realnego problemu poprawnościowego, ale odnotować. Alternatywa (jawny `UPDATE … SET
  recipe_id=NULL, version=version+1 … RETURNING` w tej samej transakcji + zwrot odpiętych dzieci do
  klienta) rozważona i odrzucona jako niepotrzebnie złożona — patrz Pytania.
- **`reset` musi kasować trzy tabele.** Bo FK jest `SET NULL`, nie `CASCADE` — `DELETE FROM recipes`
  **nie** usuwa slotów/pozycji. `resetMealsForHousehold` kasuje `shopping_items` → `meal_slots` →
  `recipes` (kolejność dzieci-przed-rodzicem). Łatwe do przeoczenia przy kopiowaniu z `resetTripsForHousehold`.
- **Semantyka „Usuń z planu".** Dziś zostawiała pusty slot; nowy model wymaga `meal.delete` (schemat
  zabrania pustego tytułu). Zamierzone sprzątnięcie, potwierdzić w PR (patrz Pytania).
- **Dedup generowania z przepisu jest best-effort klientowy.** Przy offline/współbieżności dwie osoby
  mogą dodać ten sam składnik (dedup patrzy tylko na lokalną listę). Parytet z dziś (dedup też był
  klientowy); brak DB-owej unikalności `shopping_items` (patrz Pytania). Świadomie akceptowane.
- **Duży blast radius wycięcia meals** (`workspace.mjs`, `advancedTypes.ts`, `schema.ts`,
  `useAdvancedStore.ts`, `WorkspaceSync.tsx`, `advancedData.ts`, `AuthGate.tsx`, `SettingsPage.tsx` +
  testy) — łapane przez `tsc` (strict) i testy; robić atomowo dane → backend → frontend (`implement-layered`).
- **Spójność sync z resztą modułów.** Usunięcie meals z `ADVANCED_COLLECTIONS`/`workspaceDocumentIsValid`
  musi być zsynchronizowane z klientem (schemat + `replaceWithEmptyWorkspace`), inaczej `PUT /api/v1/workspace`
  zwróci `400 INVALID_WORKSPACE_SCHEMA`. Bump `revision` w migracji wymusza czysty refetch. Reszta modułów
  (Car/Pets/Health/Subscriptions/Life) zostaje nietknięta w tym samym dokumencie.
- **Kolejność drenażu offline.** Mutacje zależne (`meal.create`/`shopping.create` z `recipeId` po
  `recipe.create`) muszą zachować kolejność — batch wysyłamy uporządkowany, serwer przetwarza sekwencyjnie
  (jak Finanse/Podróże). Store dokłada mutacje w kolejności wywołań akcji.

## Decyzje z rundy pytań doprecyzowujących

Wszystkie poniższe pytania zostały zadane użytkownikowi po sporządzeniu planu; we wszystkich przypadkach
zaakceptowano rekomendację planu — poniżej ostateczne, wiążące decyzje:

- **Ujawnienie historycznie prywatnych przepisów**: zaakceptowane. Przepisy z `user_workspace_states`
  migrują jako wspólne dla gospodarstwa (zero utraty danych przeważa nad ujawnieniem), odnotować w opisie PR.
- **Bulk vs seria mutacji**: **seria** pojedynczych `shopping.delete`/`shopping.create` w jednym batchu
  (dla „Usuń kupione" i generowania listy z przepisu). Bez dedykowanych opów bulk — YAGNI.
- **Unikalność slotu `(date, type)`**: egzekwowanie **wyłącznie po stronie klienta** (jak dziś), bez
  DB-owego `UNIQUE (household_id, date, type)` — parytet z dzisiejszym zachowaniem, mniej niespodzianek.
- **Wersja odpiętych dzieci przy `recipe.delete`**: zostajemy przy deklaratywnym FK `ON DELETE SET NULL`
  bez bumpowania `version` slotów/pozycji i bez zwracania ich klientowi — klient odpina lokalnie
  optymistycznie.
- **Semantyka „Usuń z planu" → `meal.delete`**: potwierdzone. Zamiana dzisiejszego „pusty slot" na realne
  usunięcie rekordu jest akceptowalna (sprzątnięcie, nie regresja; wymuszone przez `nonEmptyText` w
  schemacie).
- **Heurystyka kaskady rename tytułu slotu**: zostaje dzisiejsza reguła „aktualizuj `title` tylko slotów,
  których `title === stara nazwa przepisu`", jako seria klientowych `meal.update` — parytet z
  `MealsPage.tsx:233-237`.

# Zakładki ustawień: zarządzanie użytkownikami i strefa niebezpieczna

> Plan wygenerowany przez skill `/plan-feature`. Slug: `zakladki-ustawien-uzytkownicy-i-strefa-niebezpieczna`. Branch: `feature/zakladki-ustawien-uzytkownicy-i-strefa-niebezpieczna`.

## Kontekst / Problem

Strona Ustawień (`src/pages/SettingsPage.tsx`) to dziś płaska, długa lista kart (`.settings-grid`) zakończona sekcją `.danger-zone`. Generowanie linku zapraszającego oraz lista członków gospodarstwa są wmieszane w komponent `HouseholdSettings` i widoczne dla ownera **oraz** admina. Nie ma żadnego sposobu na usunięcie kogoś z gospodarstwa z poziomu UI — jedyne wejście to zaproszenia, wyjścia brak.

Owner potrzebuje wydzielonego miejsca do zarządzania ludźmi: generowania zaproszeń i usuwania członków. Przy okazji porządkujemy całą stronę Ustawień, rozbijając ją na zakładki (tabów w aplikacji dziś nie ma w ogóle), a nieodwracalne akcje przenosimy do osobnej zakładki „Strefa niebezpieczna”. Efekt: czytelniejsze Ustawienia, spójne uprawnienia (zarządzanie ludźmi wyłącznie dla ownera) i bezpieczne, wymuszane po stronie serwera usuwanie członka wraz ze sprzątnięciem jego danych prywatnych w tym gospodarstwie.

## Wymagania

- Pełna przebudowa `SettingsPage` na nawigację tabową. Zakładki (w tej kolejności): **Ogólne**, **Wygląd**, **Powiadomienia**, **Dane**, **Użytkownicy** (tylko owner), **Strefa niebezpieczna** (tylko owner).
- Zakładka „Użytkownicy” zawiera: listę członków gospodarstwa (imię, e-mail, rola), przeniesione z `HouseholdSettings` generowanie linku zaproszenia, oraz nową akcję „Usuń” przy każdym członku, którego wolno usunąć.
- Zakładki „Użytkownicy” i „Strefa niebezpieczna” widzi **wyłącznie owner** (zawężenie względem dzisiejszego `canManageHousehold`, które dopuszczało też admina). Admin i member ich nie widzą, a admin traci dostęp do tworzenia zaproszeń i do czyszczenia danych aplikacji z UI.
- „Usunięcie użytkownika” = usunięcie **członkostwa** w bieżącym gospodarstwie (`household_members`), nie globalnego konta `users`. Konto pozostaje w systemie.
- Przy usunięciu członka kasujemy jego **dane prywatne dla tego gospodarstwa**: wiersz `user_workspace_states (household_id, user_id)` (zawiera wszystkie jego rekordy `visibility: private` wraz z dziećmi oraz osobiste ustawienia). Dane wspólne gospodarstwa pozostają.
- Ochrony wymuszane po stronie serwera (niezależnie od frontendu): tylko owner może usuwać; nie można usunąć ownera; nie można usunąć samego siebie; cel musi być członkiem tego gospodarstwa.
- Backendowy endpoint zaproszeń zawężamy z `["owner", "admin"]` do `["owner"]` — spójność uprawnień UI i API.
- Nowy komponent zakładek dostępny (ARIA `tablist`/`tab`/`tabpanel`, nawigacja klawiaturą), wizualnie spójny z istniejącą stylistyką (`.settings-card`, `.panel`, zmienne CSS motywu).
- Każda mutacja członkostwa logowana przez `audit(...)`.
- PWA: strona nadal poprawna na wąskim ekranie (pasek zakładek zwija się / przewija poziomo).

## Zakres i Non-goals

**W zakresie:**
- Nowy, reużywalny komponent zakładek (`src/components/Tabs.tsx`).
- Przebudowa `SettingsPage` na taby i rozdzielenie istniejących sekcji między zakładki.
- Przeniesienie generowania zaproszeń i listy członków do zakładki „Użytkownicy” (owner-only) + akcja usuwania członka z modalem potwierdzenia.
- Nowy endpoint `DELETE /api/v1/households/current/members/:userId` z pełną walidacją, transakcyjnym sprzątaniem `user_workspace_states` i wpisem audytowym.
- Zawężenie autoryzacji `POST /api/v1/households/current/invitations` do `owner`.
- Style CSS dla zakładek + drobne dostosowania układu.

**Non-goals (świadomie pomijamy):**
- Globalne usuwanie / dezaktywacja konta `users` (`disabled_at`), zmiana roli członka, transfer własności gospodarstwa (owner→admin), wielu ownerów.
- Normalizacja danych prywatnych do osobnych tabel (pozostaje model dokumentowy JSONB).
- Czyszczenie danych *wspólnych* powiązanych z usuwanym użytkownikiem (np. wspólne konto finansowe, którego jest `ownerId`) — to dane gospodarstwa, zostają.
- Usuwanie globalnych zasobów użytkownika: `push_subscriptions`, `google_connections` (użytkownik może należeć do innych gospodarstw).
- Zmiana mechanizmu synchronizacji / rewizji `workspace_states`.
- Zmiana zachowania „Wyczyść dane aplikacji” (`clearAllAppData`) — pozostaje czysto kliencką operacją, tylko przenosimy ją do zakładki.

## Podejście

Trzy warstwy, implementacja w kolejności Baza → Backend → Frontend.

**Model danych — co realnie trzeba wyczyścić (kluczowe ustalenie z researchu).** Dane prywatne użytkownika w gospodarstwie żyją **w całości** w wierszu `user_workspace_states (household_id, user_id)`. Potwierdza to `server/src/workspace.mjs`: `splitWorkspaceData` wydziela rekordy `visibility: private` (wraz z dziećmi wg `CHILD_RELATIONS` — transakcje prywatnego konta, plan/rezerwacje/pakowanie prywatnej podróży, wydatki/terminy prywatnego auta) oraz osobiste pola (`scratchpad`, `intention`, `energy`, `preferences`, `hideAmounts`) i zapisuje je do `user_workspace_states`; część wspólna trafia do `workspace_states`. Każdy użytkownik zapisuje wyłącznie swój własny wiersz, a `mergeWorkspaceData` scala przy odczycie tylko prywatną część zalogowanej osoby. Nie istnieją żadne znormalizowane tabele encji prywatnych — wszystko jest w tym jednym dokumencie JSONB. **Wniosek: skasowanie wiersza `user_workspace_states` dla (household_id, usuwany user_id) usuwa komplet danych prywatnych tej osoby w tym gospodarstwie.**

`household_members` ma `ON DELETE CASCADE` tylko na `household_id`/`user_id` względem `households`/`users`; **nie** kaskaduje z usunięcia samego członkostwa na `user_workspace_states`. Dlatego sprzątanie musi być jawne i transakcyjne w handlerze (wzorem `transaction(...)` z `households/invitations/accept`): w jednej transakcji `DELETE household_members` + `DELETE user_workspace_states` + repointowanie sesji + `audit`.

`householdMembers` widoczne w aplikacji są **serwer-autorytatywne**: w `mergeWorkspaceData` są zawsze regenerowane z zapytania o `household_members`, a `splitWorkspaceData` je usuwa przed zapisem (`delete sharedAdvanced.householdMembers`); klientowy `workspaceMerge.ts` w ogóle ich nie dotyka. Usunięty członek nie może więc „odrodzić się” przez synchronizację — zniknie z listy przy najbliższym odczycie workspace.

**Sesja usuwanego użytkownika (decyzja: bez repointu).** `getSession` robi `LEFT JOIN household_members`; po usunięciu członkostwa `role` = NULL, więc `requireHousehold` zwróci mu `403` na endpointach workspace tego gospodarstwa, a `AuthGate`/`WorkspaceSync` potraktują 403 jak wygasłą sesję (`isRejectedSession`) i wylogują lokalnie. Świadomie **nie** repointujemy `sessions.household_id` — prostszy, mniej ryzykowny endpoint; usunięty użytkownik loguje się ponownie, jeśli chce wrócić do innego swojego gospodarstwa. Zaakceptowany kompromis UX.

**Uprawnienia — decyzja o backendzie zaproszeń.** Rekomendacja przyjęta: zawężamy `POST /api/v1/households/current/invitations` z `["owner", "admin"]` do `["owner"]`. Uzasadnienie: skoro UI zaproszeń znika dla admina i cała funkcja przenosi się do owner-only zakładki, pozostawienie w API furtki dla admina rozjeżdżałoby model uprawnień (admin mógłby zapraszać przez bezpośrednie wywołanie API, choć nie ma do tego UI). Nie znaleziono w kodzie żadnego innego konsumenta tego endpointu poza `HouseholdSettings`, więc zawężenie jest bezpieczne. `CHECK` na `household_invitations.role IN ('admin','member')` zostaje bez zmian — owner nadal może zaprosić kogoś w roli admina.

**Frontend — nawigacja tabowa.** W repo nie ma żadnego komponentu tabów ani segmented control (`src/components/` zawiera tylko `CommandPalette`, `EmptyState`, `Layout`, `Modal`, `QuickAddModal`, `TaskItem`, `ModuleErrorBoundary`). Projektujemy nowy, prosty i dostępny `Tabs` (kontrolowany: `activeId` + `onChange`), renderujący `role="tablist"` z roving tabindex i obsługą strzałek/Home/End; panele renderuje rodzic w `role="tabpanel"`. Istniejące sekcje kart (`HouseholdSettings`, `GoogleCalendarSettings`, `ThemeOption`, karty „O Tobie”, „Powiadomienia”, „Twoje dane”, „Sesja”, `danger-zone`) rozdzielamy między panele — logika pozostaje bez zmian, zmienia się tylko kontener. Modal potwierdzenia usunięcia reużywa istniejący `src/components/Modal.tsx`. Po usunięciu wołamy `refresh()` z `useServerAuth` (odświeża snapshot) i ponownie pobieramy listę członków.

Odrzucona alternatywa: routing per-zakładka (osobne ścieżki) — aplikacja nie ma routera stron ustawień, a `SettingsPage` jest montowana jako pojedynczy widok; lokalny `useState` na aktywną zakładkę jest wystarczający i tańszy.

## Pliki do zmiany

**Baza (warstwa danych):** — brak — *(brak zmian schematu i brak nowej migracji: dane prywatne to jeden wiersz JSONB `user_workspace_states`, a jego usunięcie realizujemy transakcyjnie w handlerze — patrz warstwa Backend. FK nie pozwala skaskadować tego z usunięcia członkostwa, więc migracja nic by tu nie dała. Wspólne typy w `src/types.ts` / `src/advancedTypes.ts` bez zmian — kontrakt członka nie ulega zmianie.)*

**Backend (warstwa backend):**

- `server/src/server.mjs` — **nowy endpoint** `DELETE /api/v1/households/current/members/:userId` (wstawić tuż po `POST /api/v1/households/current/invitations`, ~linia 465). Reużyć: `requireHousehold(request, ["owner"])`, `assertUuidParam`, `transaction`, `audit`, `httpError`. Logika:
  1. `const session = await requireHousehold(request, ["owner"]);`
  2. `assertUuidParam(request.params.userId);`
  3. jeśli `request.params.userId === session.user_id` → `400 CANNOT_REMOVE_SELF` („Nie możesz usunąć samego siebie z gospodarstwa”).
  4. w transakcji: `SELECT role FROM household_members WHERE household_id = $1 AND user_id = $2 FOR UPDATE`; brak → `404 MEMBER_NOT_FOUND` („Ten użytkownik nie należy do gospodarstwa”).
  5. jeśli `role === 'owner'` → `403 CANNOT_REMOVE_OWNER` („Nie można usunąć właściciela gospodarstwa”).
  6. `DELETE FROM household_members WHERE household_id = $1 AND user_id = $2`.
  7. `DELETE FROM user_workspace_states WHERE household_id = $1 AND user_id = $2` (sprzątnięcie danych prywatnych).
  8. `audit(client, session, "member.remove", "user", userId, { role, householdId: session.household_id })`.
  9. zwróć `{ ok: true }`.
  - Bez repointu sesji usuwanego użytkownika (decyzja użytkownika) — jego istniejące sesje wskazujące to gospodarstwo zaczną dostawać `403` na workspace i zostaną lokalnie wylogowane przez `AuthGate`, jak każda odrzucona sesja.
  - **Kontrakt / kody błędów:** `200 {ok:true}`; `400 INVALID_ID` (zły UUID), `400 CANNOT_REMOVE_SELF`; `401 UNAUTHENTICATED` (brak sesji); `403 FORBIDDEN` (nie-owner), `403 CANNOT_REMOVE_OWNER`; `404 MEMBER_NOT_FOUND`; `500` wewnętrzny. CSRF/Origin pokrywa istniejący `onRequest` hook (DELETE jest w liście metod chronionych).
- `server/src/server.mjs` — **zmiana** `POST /api/v1/households/current/invitations` (linia ~448): `requireHousehold(request, ["owner", "admin"])` → `requireHousehold(request, ["owner"])`.
- `server/src/server.mjs` (lub nowy mały moduł, np. `server/src/householdMembers.mjs`, jeśli to ułatwi import bez uruchamiania Fastify) — wydzielić czystą funkcję walidacji `assertRemovableMember({ targetUserId, targetRole, sessionUserId })`, którą endpoint wywołuje przed jakimkolwiek `DELETE`: rzuca `httpError` z odpowiednim kodem dla self (`400 CANNOT_REMOVE_SELF`), celu-ownera (`403 CANNOT_REMOVE_OWNER`) i braku członkostwa reprezentowanego przez `targetRole == null` (`404 MEMBER_NOT_FOUND`); dla poprawnego `member`/`admin` nic nie rzuca.
- `server/test/server.node.mjs` (nowy plik, wzorem istniejących `test/*.node.mjs` bez DB, uruchamiane przez `npm run test:server` = `node --test`) — testy jednostkowe **wyłącznie** dla `assertRemovableMember` w izolacji (bez bazy, zgodnie z decyzją użytkownika): nie-owner nie dociera tu w ogóle (to `requireHousehold`, pokryty już przez wzorzec ról w innych endpointach) — testujemy: cel = sesja wywołującego → 400; `targetRole === "owner"` → 403; `targetRole === null` (brak członkostwa) → 404; `targetRole` = `"member"`/`"admin"` i inny `userId` → przechodzi bez błędu.

**Frontend (warstwa frontend):**

- `src/components/Tabs.tsx` — **nowy komponent** (reużywalny pasek zakładek, ARIA).
  - Props: `interface TabItem { id: string; label: string; icon?: LucideIcon; }` oraz `interface TabsProps { tabs: TabItem[]; activeId: string; onChange: (id: string) => void; idBase: string; ariaLabel: string; }`.
  - Render: `<div role="tablist" aria-label={ariaLabel} className="settings-tabs">` z przyciskami `role="tab"`, `id={`${idBase}-tab-${tab.id}`}`, `aria-selected`, `aria-controls={`${idBase}-panel-${tab.id}`}`, `tabIndex={active ? 0 : -1}` (roving tabindex).
  - Klawiatura: `ArrowLeft`/`ArrowRight` (cyklicznie), `Home`/`End` — przenoszą fokus i aktywują (`onChange`).
  - Panele renderuje rodzic: `<section role="tabpanel" id={`${idBase}-panel-${id}`} aria-labelledby={`${idBase}-tab-${id}`} tabIndex={0}>`.
- `src/pages/SettingsPage.tsx` — **przebudowa** na taby. `useState<string>("general")` na aktywną zakładkę. Zbudować listę zakładek zależnie od roli: `Ogólne`, `Wygląd`, `Powiadomienia`, `Dane` zawsze; `Użytkownicy` i `Strefa niebezpieczna` tylko gdy `serverMode && snapshot && activeHousehold?.role === "owner"` (obie zakładki zawężone do ownera; `canManageHousehold` — dziś obejmujący też admina — przestaje być używany do sterowania widocznością tych dwóch zakładek). Rozdział istniejących sekcji między panele:
  - **Ogólne:** karta „O Tobie” + `GoogleCalendarSettings` + karta „Sesja” (wyloguj) + `about-card`.
  - **Wygląd:** karta motywu (`ThemeOption`).
  - **Powiadomienia:** karta powiadomień (istniejąca logika `requestNotifications`/`disableNotifications`).
  - **Dane:** karta „Twoje dane” (eksport/import kopii).
  - **Użytkownicy (owner-only):** nowy `UsersSettings` (rozbudowany `HouseholdSettings`): lista członków (`GET /api/v1/households/current/members`), formularz generowania linku (`POST .../invitations`), przycisk „Usuń” przy każdym członku ≠ owner i ≠ zalogowany, otwierający `Modal` potwierdzenia; po potwierdzeniu `apiRequest("/api/v1/households/current/members/${userId}", { method: "DELETE", json: {} })`, następnie ponowny fetch członków + `refresh()` z `useServerAuth`; obsługa błędów przez `onToast` (mapowanie `ApiError.message`).
  - **Strefa niebezpieczna:** istniejąca zawartość `danger-zone` (`clearAllAppData`), niezmieniona logika.
  - Reużyć: `useServerAuth`, `apiRequest`, `ApiError`, `Modal`, ikony `lucide-react` (`UsersRound`, `Trash2`, `AlertTriangle`, `ShieldAlert` itp.).
  - Usunąć wolnostojącą sekcję `.danger-zone` z dołu i płaską `.settings-grid` na rzecz struktury `Tabs` + panele.
- `src/styles.css` — **nowe style** dla `.settings-tabs` (pasek zakładek, sticky/scroll na mobile), `.settings-tab` / `.settings-tab.active` (spójne z `--brand`, `--brand-pale`, `--border`), styl listy członków w zakładce Użytkowników i przycisku usuwania (reużyć `.button--danger-ghost`, `.data-summary`, `.settings-card`). Zaktualizować/uporządkować istniejące reguły `.danger-zone`/`.settings-grid` pod nowy układ oraz media queries (~1597+, 1759+) dla wąskiego ekranu.

## Kryteria akceptacji

- [ ] Ustawienia renderują pasek zakładek; przełączanie działa myszą i klawiaturą (strzałki/Home/End), ARIA `tablist`/`tab`/`tabpanel` poprawne (widoczne w drzewie dostępności).
- [ ] Zakładka „Użytkownicy” widoczna **tylko** dla ownera; admin i member jej nie widzą; admin nie ma już w UI formularza zaproszeń.
- [ ] Owner w zakładce „Użytkownicy” widzi listę członków, może wygenerować link zaproszenia (7 dni) i usunąć członka `member`/`admin` po potwierdzeniu w modalu.
- [ ] Przycisk „Usuń” nie pojawia się przy ownerze ani przy samym zalogowanym ownerze.
- [ ] `DELETE /api/v1/households/current/members/:userId`: wymusza owner-only (403 dla nie-ownera), 403 przy próbie usunięcia ownera, 400 przy usunięciu samego siebie, 404 dla nie-członka, 400 dla złego UUID; happy-path usuwa wiersz `household_members` i `user_workspace_states` w jednej transakcji oraz zapisuje `audit_events` z akcją `member.remove`.
- [ ] Po usunięciu członek znika z `householdMembers` w aplikacji po odświeżeniu workspace; usunięty użytkownik traci dostęp do gospodarstwa; jego dane wspólne w gospodarstwie pozostają.
- [ ] `POST /api/v1/households/current/invitations` zwraca 403 dla admina i membera, działa dla ownera.
- [ ] „Strefa niebezpieczna” to osobna zakładka widoczna **tylko** dla ownera (admin i member jej nie widzą); „Wyczyść dane aplikacji” działa jak dotychczas.
- [ ] Układ poprawny na wąskim ekranie (PWA) — pasek zakładek się nie rozjeżdża.
- [ ] `npm run build`, `npm test` i `npm run test:server` przechodzą.
- [ ] Aplikacja odpala się i feature działa w preview.

## Ryzyka

- **Granica prywatne/wspólne.** Musimy skasować **tylko** `user_workspace_states` usuwanego użytkownika. Nie ruszamy `workspace_states` (dane wspólne) — inaczej skasowalibyśmy dane całego gospodarstwa. `ownerId` prywatnych rekordów pochodzi z sesji (`withOwner`), nie od klienta, więc nie da się usunąć „cudzych” prywatnych danych przez podanie obcego `user_id` w dokumencie — ale endpoint operuje na `:userId` z URL, dlatego twarde reguły (owner-only, nie-owner cel, nie-self, cel-jest-członkiem) muszą być wymuszone serwerowo, przed jakimkolwiek `DELETE`.
- **Osierocone referencje w danych wspólnych.** Wspólne rekordy mogą trzymać `ownerId`/przypisania wskazujące na usuniętego użytkownika, który zniknął z `householdMembers`. UI pokoloruje/opisze taką osobę jako nieznaną. Świadomie zostawiamy (to dane gospodarstwa) — potencjalny drobny defekt kosmetyczny do rozważenia osobno.
- **Wylogowanie usuniętego użytkownika (zaakceptowane).** Bez repointowania sesji usunięty użytkownik dostanie 403 na workspace tego gospodarstwa i `AuthGate` wyloguje go lokalnie (`isRejectedSession`). Świadomie zaakceptowany kompromis — prostszy endpoint, gorszy UX dla osoby, która należy też do innych gospodarstw (musi zalogować się ponownie).
- **Transakcyjność i blokady.** `SELECT ... FOR UPDATE` na `household_members` chroni przed wyścigiem (np. równoległe usuwanie/akceptacja zaproszenia). Cały ciąg `DELETE`/`UPDATE`/`audit` w jednym `transaction(...)`.
- **Brak jednego ownera / wielu ownerów.** Dziś zaproszenia dopuszczają tylko `admin`/`member` (CHECK), więc realnie jest dokładnie jeden owner — reguła „nie usuwaj ownera” w pełni pokrywa „nie usuwaj siebie” dla ownera, ale utrzymujemy oba warunki jawnie (defense in depth, jaśniejszy komunikat).
- **Zasoby globalne użytkownika.** `push_subscriptions`, `google_connections` zostają (per-użytkownik, nie per-gospodarstwo). Historyczne `notification_deliveries (household_id, user_id)` nie są kasowane przy usunięciu członkostwa (kaskada tylko od usunięcia household/user) — zostają jako log; opcjonalne czyszczenie poza zakresem.
- **Odświeżenie stanu po usunięciu.** Lista `householdMembers` w store aktualizuje się dopiero przy kolejnym odczycie workspace (`WorkspaceSync`). W zakładce pobieramy członków bezpośrednio i wołamy `refresh()`; trzeba zadbać, by lista w UI odświeżyła się od razu, a nie dopiero po następnym pullu.
- **Pierwszy w repo komponent tabów.** Brak wzorca — łatwo pominąć poprawną semantykę ARIA / roving tabindex. Trzymać się specyfikacji WAI-ARIA Tabs; pokryć testem renderu/klawiatury (`@testing-library/react` już w zależnościach).
- **Zawężenie API zaproszeń to zmiana kontraktu.** Potwierdzono brak innych konsumentów `POST .../invitations` niż `HouseholdSettings`, więc bezpieczne; gdyby istniała automatyzacja admina wołająca to API, przestanie działać.

## Pytania do doprecyzowania

Wszystkie pytania rozstrzygnięte z użytkownikiem po fazie planowania:

- **Widoczność „Strefa niebezpieczna”:** tylko owner (nie `canManageHousehold`/admin jak dziś) — zastosowane w sekcjach powyżej.
- **Repoint sesji przy usuwaniu:** bez repointu — zastosowane w kontrakcie endpointu powyżej.
- **Zakres testów backendu:** izolowany helper walidacji `assertRemovableMember` bez DB — zastosowane w „Pliki do zmiany” → Backend.
- **Kolejność/nazwy/ikony zakładek i przypisanie kart Sesja/Google/about-card do „Ogólne”:** propozycja plannera zaakceptowana bez zmian.
- **Treść modala potwierdzenia** (imię + e-mail, informacja o nieodwracalności i utracie prywatnych danych) i **toast po sukcesie** („Usunięto {imię} z gospodarstwa”, natychmiastowe ponowne pobranie listy członków w zakładce): przyjęto propozycję z sekcji „Podejście”/„Pliki do zmiany” jako ostateczną — nie wymagało dodatkowej rundy pytań.

Brak otwartych pytań — plan gotowy do implementacji.

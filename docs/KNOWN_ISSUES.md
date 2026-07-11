# Znane pozostałości po przeglądzie kodu (11.07.2026)

Po naprawie 62 potwierdzonych ustaleń z przeglądu kodu ("Solidny fundament, kilka realnych dziur do załatania")
22 równoległe agenty zgłosiły poniższe rzeczy jako świadomie pozostawione poza zakresem — nie są to błędy
z oryginalnego raportu, tylko doprecyzowania/edge case'y zauważone przy okazji. Żadne nie jest pilne.

## Naprawione (11.07.2026)

- ~~Brak przełącznika UI dla „tydzień zaczyna się w poniedziałek”.~~ Dodano przełącznik w sekcji „O Tobie”
  w `src/pages/SettingsPage.tsx`, podpięty pod `preferences.weekStartsOnMonday`.
- ~~Duplikat generatora ID w `src/pages/CarPage.tsx`.~~ Lokalny `makeId` zastąpiono wspólnym
  `generateId` z `src/lib/id.ts`.
- ~~Przycisk „Usuń” w `NoteCard` nie ma potwierdzenia.~~ Dodano `window.confirm` zgodny ze wzorcem
  stosowanym w reszcie appki.
- ~~Przycisk „Usuń” w `TaskEditModal` nie ma potwierdzenia.~~ Dodano `window.confirm` zgodny z
  `TaskItem.tsx`.
- ~~`src/pages/TodayPage.tsx` — „wydarzeń” zapisane na sztywno w podglądzie jutra.~~ Wspólny helper
  odmiany (`polishPlural`) wydzielono do `src/lib/pluralize.ts` i użyto go zarówno dla „wydarzeń”, jak i
  dla „zadań” w tej sekcji.
- ~~`src/pages/NotesPage.tsx` — licznik notatek nie obsługiwał wyjątku 12–14.~~ Licznik notatek korzysta
  teraz z tego samego `polishPlural`.

## Naprawione (11.07.2026, druga tura — świadome kompromisy podniesione do rangi naprawy)

- ~~`src/server/workspaceMerge.ts` — tie-break po `updatedAt` działał tylko dla `Note`.~~ Dodano pole
  `updatedAt` do `Task`, `CalendarEvent`, `Reminder`, `Habit` oraz do rekordów finansowych/podróżnych
  (`FinanceAccount`, `FinanceTransaction`, `FinanceBudget`, `SavingsGoal`, `Trip`, `TripItineraryItem`,
  `TripBooking`, `PackingItem`) — w typach, schemacie zod, mutatorach store'ów i danych startowych.
  `workspaceMerge.ts` samo w sobie nie wymagało zmian (już czytało `updatedAt` generycznie), więc tie-break
  po najnowszej zmianie działa teraz dla tych typów tak samo jak wcześniej dla notatek.
- ~~Cross-tab wylogowanie nie rozróżniało wygaśnięcia sesji od prawdziwego wylogowania.~~
  `src/server/AuthGate.tsx` rozgłasza teraz `{type:"logout", reason}` przez `BroadcastChannel`, a inne karty
  wywołują `endLocalSession(false, reason)` z tym samym powodem — karta z niezsynchronizowanymi zmianami
  zachowuje dane lokalnie także wtedy, gdy sygnał przyszedł z innej karty.
- ~~`Trip.budgetMinor` nie miał stanu „nieustawiony”.~~ Pole jest teraz opcjonalne (`budgetMinor?: number`)
  w typach i schemacie. Pusty formularz budżetu zapisuje `undefined` zamiast `0`, a UI w TripsPage.tsx
  pokazuje „bez ustalonego budżetu” zamiast paska postępu dzielącego przez zero.
- ~~`src/components/QuickAddModal.tsx` mogło nadpisać ręczną poprawkę pola Od/Godzina.~~ Modal śledzi teraz,
  czy użytkownik ręcznie edytował te pola (`dateEditedManually`/`timeEditedManually`) i przestaje je
  nadpisywać rozpoznaną frazą czasową po pierwszej ręcznej zmianie.
- ~~Blokada przewijania tła w `Layout.tsx`/`CommandPalette.tsx`/`Modal.tsx` była niezależna w każdym
  miejscu.~~ Wydzielono wspólny licznik otwarć w `src/lib/scrollLock.ts` (`lockBodyScroll()`), używany przez
  wszystkie trzy komponenty — zamknięcie jednej nakładki już nie odblokowuje przewijania, dopóki inna jest
  otwarta.
- ~~`confirmClose` w `Modal.tsx` był zdefiniowany, ale nieużywany.~~ Podłączono go w `TaskEditModal`
  (`src/pages/TasksPage.tsx`) i `EditTripModal` (`src/pages/TripsPage.tsx`) — obie porównują bieżący stan
  formularza z oryginalnym rekordem i pytają o potwierdzenie tylko wtedy, gdy są realne niezapisane zmiany.
  `NoteCard` w `src/pages/NotesPage.tsx` **nie** został podłączony — to nie jest komponent `Modal` (edycja
  dzieje się bezpośrednio na karcie) i już autosave'uje na `blur`/z 400 ms debounce, więc nie ma tu
  scenariusza „zamknięcie odrzuca zmiany” do zabezpieczenia.

## Edge case'y i świadome kompromisy (niżej priorytet, do rozważenia w przyszłości)

- **`src/pages/FinancePage.tsx`** — nowa blokada duplikatu nazwy budżetu porównuje kategorie niezależnie od
  waluty, więc nie da się już celowo mieć dwóch budżetów o tej samej nazwie kategorii w różnych walutach
  (np. „Jedzenie” w PLN i w USD).
- **`src/lib/csvImport.ts`** — w skrajnym przypadku, gdy dwa wiersze CSV są identyczne dosłownie w każdej
  kolumnie (brak referencji banku, salda itp.), rozpoznawanie duplikatów nadal opiera się o kolejność
  wystąpienia (tak jak wcześniej) — w pełni niezależny od kolejności fingerprint jest w takim przypadku
  matematycznie niemożliwy bez utraty rozróżnienia dwóch faktycznie osobnych transakcji.

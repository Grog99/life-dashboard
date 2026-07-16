# Pomysły na rozwój aplikacji (16.07.2026)

Przegląd całego repozytorium (kod, `ARCHITECTURE.md`, `DEPLOYMENT.md`, `FINANCE_IMPORT.md`,
`KNOWN_ISSUES.md`) pod kątem tego, co warto zmienić, ulepszyć lub dodać. Pomysły są pogrupowane
w trzy kategorie i w miarę możliwości odwołują się do konkretnych plików/modułów.

## Co zmienić

1. **Model synchronizacji danych.** Każdy moduł to obecnie jeden duży dokument JSONB w Postgresie
   (`workspace_states` / `user_workspace_states`), scalany 3-way mergem po `updatedAt`
   (`src/server/workspaceMerge.ts`, `server/src/workspace.mjs`). Działa dobrze przy obecnej skali,
   ale nie skaluje się dobrze przy wielu domownikach edytujących równolegle. `ARCHITECTURE.md` sam
   wskazuje to jako kierunek ewolucji — warto rozważyć przejście na znormalizowane tabele i mutacje
   domenowe z kluczami idempotencji, zaczynając od Finansów jako najbardziej naturalnego kandydata.
2. **Rozmiar największych stron.** `src/pages/FinancePage.tsx` (~1150 linii) i
   `src/pages/TripsPage.tsx` (~940 linii) robią zbyt dużo w jednym pliku. Warto rozbić je na mniejsze
   komponenty (np. osobno: lista transakcji, formularz budżetu, kreator importu CSV) — ułatwi to
   testowanie i dalszy rozwój.
3. **Ograniczona dolna nawigacja mobilna.** Zgodnie z `docs/plans/mobile-bottom-nav-buttons.md` pasek
   dolny celowo pokazuje tylko Dzisiaj/Zadania/Kalendarz/Notatki — Finanse, Podróże, Zwierzęta itd. są
   o dodatkowy klik dalej na telefonie. Warto zweryfikować w praktyce, czy to nadal trafny wybór, albo
   dać użytkownikowi możliwość spersonalizowania zawartości dolnego paska.
4. **Reguła unikalności nazwy budżetu** w `FinancePage.tsx` ignoruje walutę — nie można mieć dwóch
   budżetów o tej samej nazwie w różnych walutach. Drobna, ale łatwa do naprawienia niespójność
   (odnotowana też w `docs/KNOWN_ISSUES.md`).

## Co ulepszyć

1. **Brak CI.** Testy (Vitest dla frontendu, `node:test` dla serwera) istnieją i są całkiem
   kompletne, ale nic nie uruchamia ich automatycznie przy pushu/PR — w repo nie ma katalogu
   `.github/workflows`. Prosty workflow (build + `npm test` + `cd server && npm test`) to szybki
   zysk jakości.
2. **Brak lintingu.** Jedyną bramką jakości jest `tsc` (strict mode). ESLint + Prettier zapobiegłyby
   dryfowi stylu w miarę wzrostu kodu, szczególnie że część stron już przekracza 500–1000 linii.
3. **Synchronizacja Google Calendar.** Obecnie to ręczny, jednorazowy import wydarzeń 90 dni do
   przodu (przycisk „Importuj z Google” w widoku Kalendarza). Przejście na `syncToken` + webhook
   (już wskazane w roadmapie `ARCHITECTURE.md`) dałoby prawdziwie automatyczną synchronizację bez
   klikania.
4. **Import CSV z banku.** Działa (`src/lib/csvImport.ts`: wykrywanie separatora/locale, mapowanie
   kolumn, odcisk palca duplikatów), ale mapowanie kolumn trzeba powtarzać przy każdym imporcie.
   Zapamiętywanie profilu kolumn per bank — rekomendowany następny krok wg `docs/FINANCE_IMPORT.md` —
   znacząco przyspieszyłoby powtarzalny import.
5. **Testy komponentów stron.** Pokrycie testami skupia się na store'ach i logice (sync, recurrence,
   CSV, schema), a największe strony (Finanse, Podróże, Zdrowie, Zwierzęta, Subskrypcje) nie mają
   testów interakcji użytkownika — ich poprawność opiera się wyłącznie na ręcznym QA.
6. **Powiadomienia o terminach przebiegowych auta.** `docs/DEPLOYMENT.md` wprost przyznaje, że
   terminy liczone po przebiegu (a nie po dacie) nie mają naturalnej godziny wysyłki push. Warto
   dopracować tę logikę, np. przez stałą, codzienną porę sprawdzania zamiast próby wyznaczenia
   „dokładnego” momentu.
7. **Eksport danych w Ustawieniach** obejmuje tylko JSON z danych aplikacji — bez kont, sesji,
   integracji. Pełne odzyskiwanie po awarii wciąż wymaga `pg_dump` na poziomie bazy. Warto to
   jaśniej zakomunikować w UI albo dodać prostszy „pełny backup” dla administratora.

## Co dodać

1. **Podsumowania / statystyki w czasie.** Miesięczny lub roczny przegląd: wydatki wg kategorii,
   ukończone nawyki, wskaźnik realizacji zadań. Dane już tam są (Finanse, Rytuały, Zadania) —
   brakuje tylko warstwy wizualizacji trendów.
2. **Wykresy trendów zdrowotnych.** Pomiary (waga, ciśnienie, glukoza, temperatura) w
   `HealthPage.tsx` są zbierane, ale pokazywane tylko jako lista. Prosty wykres liniowy w czasie
   dałby dużo więcej wartości przy tym samym modelu danych.
3. **Eksport list do PDF/druku.** Lista pakowania na podróż czy wspólna lista zakupów przydałaby się
   w formie do wydruku lub udostępnienia poza aplikacją.
4. **Ściślejsze powiązania między modułami.** Np. przypięcie zadania do konkretnej podróży albo
   transakcji do celu oszczędnościowego — tak, żeby widok „Dzisiaj” mógł pokazać jeszcze pełniejszy
   kontekst (obecnie robi to częściowo sekcja przeglądu modułów).
5. **CAMT.053 / MT940, ewentualnie Open Banking.** Kolejny krok na już zaplanowanej ścieżce
   automatyzacji importu bankowego (`docs/FINANCE_IMPORT.md`), obecnie ograniczonej do CSV.
6. **„Przegląd tygodnia”.** Rytuał w stylu GTD: krótkie podsumowanie na koniec tygodnia (co zrobione,
   co się przesunęło, budżet vs. plan) — jako osobny, opcjonalny widok albo część „Dzisiaj” w
   niedzielę.
7. **MFA / WebAuthn.** Dla trybu wieloużytkownikowego (households) sensowne wzmocnienie
   bezpieczeństwa logowania — wskazane w `ARCHITECTURE.md` jako dalszy krok ewolucji.

## Uwaga metodologiczna

Powyższa lista powstała na podstawie przeglądu struktury projektu, kluczowych modułów (`src/pages/`,
`src/store/`, `server/src/`) oraz istniejącej dokumentacji roadmapy i znanych ograniczeń. Część
punktów pokrywa się z tym, co zespół już sam sobie zaplanował w `ARCHITECTURE.md` i
`docs/FINANCE_IMPORT.md` — potraktuj to jako potwierdzenie kierunku, a resztę jako nowe propozycje
do priorytetyzacji.

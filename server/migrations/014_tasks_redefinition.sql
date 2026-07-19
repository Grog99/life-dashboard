-- Redefinicja zadań (tasks): zadanie wraca do swojej istoty -- "rzecz do zrobienia", bez
-- przypisanej daty/godziny/czasu trwania/powtarzalności. Sztywna `category` znika na rzecz
-- wolnych tagów. Patrz docs/plans/zadania-redefinicja.md ("Podejście", "Pliki do zmiany" ->
-- "Baza (warstwa danych)").
--
-- Czternasta migracja tej serii (po Life/013). Dotyczy WYŁĄCZNIE tabeli `tasks` -- `events`
-- zostaje nietknięte, z pełnym kompletem kolumn `date`/`series_id`/`series_index`/`recurrence`
-- (powtarzalność i daty nadal obsługują wydarzenia/nawyki, patrz plan "Non-goals").
--
-- Reprezentacja tagów: kolumna `tags jsonb NOT NULL DEFAULT '[]'::jsonb`, wzór 1:1 z
-- `recipes.tags` (server/migrations/008_meals_normalized.sql) -- NIE tabela pomocnicza
-- `task_tags` (Life z założenia nie ma FK/kaskad widoczności między swoimi tabelami, patrz
-- nagłówek 013_life_normalized.sql). Tag to absolutny set nadpisywany w całości przy edycji,
-- jak `habits.completed_dates` / `recipes.tags` -- walidacja i zapis leżą w warstwie backend
-- (server/src/life.mjs, poza zakresem tej migracji).
--
-- Kolejność kroków (każdy idempotentny, bezpieczny do ponownego uruchomienia):
--   1. Dodajemy `tags` PRZED odcięciem `category`, żeby móc przenieść dane.
--   2. Migrujemy istniejącą, niepustą `category` na pojedynczy tag -- mapowanie 1:1, z
--      zachowaniem oryginalnej pisowni (np. "Dom" -> tag "Dom"), bez lowercase, bez pomijania
--      wartości (decyzja domknięta w planie). Pusta/NULL kategoria -> brak tagu (`tags = []`).
--      Guard `tags = '[]'::jsonb` czyni krok bezpiecznym do ponownego uruchomienia (nie
--      nadpisuje tagów, jeśli migracja/klient już coś tam zapisał).
--   3. Zdejmujemy indeks po `series_id`, zanim dropniemy samą kolumnę.
--   4. DROP COLUMN (nieodwracalne, decyzja zaakceptowana w planie "Ryzyka"/"Decyzje domknięte"):
--      `date`, `time`, `estimated_minutes`, `category`, `series_id`, `series_index`,
--      `recurrence`. Dawne serie zadań stają się zwykłymi, pojedynczymi zadaniami (kolumny
--      serii znikają razem z nimi -- nic dodatkowego do zrobienia).
--   5. Indeks GIN na `tags` pod przyszłe grupowanie/filtrowanie po tagu (TasksPage).
--
-- `IF EXISTS`/`IF NOT EXISTS` wszędzie -- migracja jest no-op przy ponownym uruchomieniu.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE tasks
   SET tags = jsonb_build_array(category)
 WHERE tags = '[]'::jsonb
   AND category IS NOT NULL
   AND btrim(category) <> '';

DROP INDEX IF EXISTS tasks_household_series_idx;

ALTER TABLE tasks
  DROP COLUMN IF EXISTS date,
  DROP COLUMN IF EXISTS time,
  DROP COLUMN IF EXISTS estimated_minutes,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS series_id,
  DROP COLUMN IF EXISTS series_index,
  DROP COLUMN IF EXISTS recurrence;

CREATE INDEX IF NOT EXISTS tasks_tags_idx ON tasks USING gin (tags);

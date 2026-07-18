-- Znormalizowane Życie (Life): pięć płaskich kolekcji (tasks/events/reminders/notes/habits)
-- przestaje być częścią dokumentu JSONB (`life` w workspace_states / user_workspace_states) i
-- dostaje własne tabele z optymistyczną współbieżnością per rekord (kolumna `version`) oraz
-- własną tabelę idempotencji mutacji (`life_mutations`, NIE reużywamy `health_mutations` itd.).
-- Patrz docs/plans/zadania-kalendarz-notatki-nawyki-sql.md ("Model tabel (Postgres)", "Projekt
-- pól specjalnych", "Migracja danych historycznych").
--
-- Siódma migracja wg tego wzorca (po Finansach/006, Podróżach/007, Meals/008, Aucie/009,
-- Zwierzętach/010, Zdrowiu/011, Subskrypcjach/012) -- NAJWIĘKSZY moduł serii (5 tabel zamiast
-- 1-3), ale strukturalnie NAJBLIŻSZY analog to Zdrowie (011): pięć CAŁKOWICIE NIEZALEŻNYCH,
-- płaskich kolekcji -- żadnego FK między nimi (poza households/users), żadnej kaskady
-- widoczności, żadnego guardu sierot, żadnego `EXISTS` na rodzicu. Każda tabela ma WŁASNĄ
-- `owner_id`/`visibility` i filtruje wyłącznie po swoim wierszu.
--
-- Trzy komplikacje bez precedensu we wcześniejszych modułach serii (patrz plan "Czym Life RÓŻNI
-- SIĘ"):
--   1. `recurrence` (obiekt zagnieżdżony z tablicą `weekdays`) na tasks/events -> kolumna `jsonb`
--      (wzór: `pets.fish_stock`), zapisywana 1:1 bez interpretacji -- materializacja okna
--      wystąpień zostaje po stronie klienta (`src/lib/recurrence.ts`, Wariant A). `series_id`/
--      `series_index` -> zwykłe kolumny. Wystąpienia serii mają DETERMINISTYCZNE `id`
--      (`${seriesId}#${seriesIndex}`) -- kolizja `id` między urządzeniami jest zamierzona
--      (dedup przez PRIMARY KEY, patrz "Idempotencja deterministycznych `id`" w planie).
--   2. `habits.completed_dates` -- tablica iso-dat jako `jsonb`, nadpisywana jako ABSOLUTNY SET
--      przy każdym toggle (nie prawdziwy flip).
--   3. `reminders.notified_at` -- jedyne pole tej serii pisane PRZEZ WORKERA (writeback po
--      udanej dostawie push, bez bumpu `version`) ORAZ przez klienta (`snoozeReminder`/
--      `markReminderNotified`).
--
-- `id` jest typu `text` (nie `uuid`) -- wymagane dla deterministycznych `id` wystąpień serii,
-- które zawierają `#` (`${seriesId}#${index}`); parytet z pozostałymi tabelami tej serii
-- (`id text PRIMARY KEY`).
--
-- Historyczne prywatne zadania/wydarzenia/przypomnienia/notatki/nawyki migrują jako PRYWATNE --
-- bez ujawnienia (parytet z 009/010/011/012). `owner_id` prywatnych rekordów jest ZAWSZE brany z
-- kolumny `user_id` wiersza `user_workspace_states` (sesja), NIGDY z pola `ownerId` w JSON.
--
-- Po migracji danych wycinamy WYŁĄCZNIE pięć kolekcji z `life` w dokumencie JSONB -- pola
-- osobiste (`scratchpad`/`intention`/`energy`/`preferences`) i `advanced` (metadane
-- gospodarstwa + `hideAmounts`) ZOSTAJĄ nietknięte (`life` dokumentu dalej istnieje z samymi
-- skalarami).

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  title text NOT NULL,
  description text,
  status text NOT NULL CHECK (status IN ('todo', 'done')),
  priority text NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
  date date,
  -- clockTime "HH:MM" jako text, nie `time` -- parytet z pozostałymi tabelami tej serii (unika
  -- strefowego parsowania node-postgres), wzór health_appointments.time / pet_visits.time.
  time text,
  estimated_minutes integer CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
  category text NOT NULL,
  is_focus boolean NOT NULL,
  energy text NOT NULL CHECK (energy IN ('low', 'medium', 'high')),
  completed_at timestamptz,
  -- Powtarzalność (Wariant A, patrz komentarz nagłówka) -- zapisywane 1:1 bez interpretacji.
  series_id text,
  series_index integer CHECK (series_index IS NULL OR series_index >= 0),
  recurrence jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS tasks_household_idx ON tasks(household_id);
CREATE INDEX IF NOT EXISTS tasks_household_visibility_idx ON tasks(household_id, visibility);
CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS tasks_household_series_idx ON tasks(household_id, series_id);

CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  title text NOT NULL,
  date date NOT NULL,
  -- clockTime "HH:MM" jako text -- z tej samej racji co tasks.time.
  start_time text NOT NULL,
  end_time text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('meeting', 'focus', 'personal')),
  location text,
  notes text,
  source text CHECK (source IS NULL OR source IN ('manual', 'google')),
  external_id text,
  -- Free-form timestamp (Google Calendar), `z.string().refine(Date.parse)` w eventSchema -- NIE
  -- isoDate, więc `text` bez rzutowania, dokładnie jak health_measurements.measured_at.
  external_updated_at text,
  series_id text,
  series_index integer CHECK (series_index IS NULL OR series_index >= 0),
  recurrence jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS events_household_idx ON events(household_id);
CREATE INDEX IF NOT EXISTS events_household_visibility_idx ON events(household_id, visibility);
CREATE INDEX IF NOT EXISTS events_owner_idx ON events(owner_id);
CREATE INDEX IF NOT EXISTS events_household_series_idx ON events(household_id, series_id);

CREATE TABLE IF NOT EXISTS reminders (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  title text NOT NULL,
  date date NOT NULL,
  -- clockTime "HH:MM" jako text -- z tej samej racji co tasks.time/events.start_time.
  time text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  -- PISANE PRZEZ WORKERA (writeback po udanej dostawie push, bez bumpu `version`) ORAZ przez
  -- klienta (`snoozeReminder` czyści, `markReminderNotified` ustawia). Patrz komentarz nagłówka
  -- pliku, punkt 3.
  notified_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS reminders_household_idx ON reminders(household_id);
CREATE INDEX IF NOT EXISTS reminders_household_visibility_idx ON reminders(household_id, visibility);
CREATE INDEX IF NOT EXISTS reminders_owner_idx ON reminders(owner_id);
-- Indeks częściowy do workera (`manualReminders`): tylko przypomnienia jeszcze niedostarczone.
CREATE INDEX IF NOT EXISTS reminders_pending_idx ON reminders(household_id)
  WHERE done = false AND notified_at IS NULL;

CREATE TABLE IF NOT EXISTS notes (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  title text NOT NULL,
  content text NOT NULL DEFAULT '',
  color text NOT NULL CHECK (color IN ('cream', 'mint', 'sky', 'lilac')),
  pinned boolean NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS notes_household_idx ON notes(household_id);
CREATE INDEX IF NOT EXISTS notes_household_visibility_idx ON notes(household_id, visibility);
CREATE INDEX IF NOT EXISTS notes_owner_idx ON notes(owner_id);

CREATE TABLE IF NOT EXISTS habits (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  name text NOT NULL,
  icon text NOT NULL CHECK (icon IN ('water', 'walk', 'read', 'stretch', 'meditate')),
  target_label text NOT NULL,
  -- Tablica iso-dat, absolutny SET nadpisywany w całości przy toggle (nie prawdziwy flip) --
  -- patrz komentarz nagłówka pliku, punkt 2.
  completed_dates jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS habits_household_idx ON habits(household_id);
CREATE INDEX IF NOT EXISTS habits_household_visibility_idx ON habits(household_id, visibility);
CREATE INDEX IF NOT EXISTS habits_owner_idx ON habits(owner_id);

CREATE TABLE IF NOT EXISTS life_mutations (
  idempotency_key uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  op text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS life_mutations_created_idx ON life_mutations(created_at);

-- ---------------------------------------------------------------------------
-- Migracja danych z JSONB.
--   workspace_states       = dane wspólne gospodarstwa (visibility zwykle 'household', ale mogą
--                             zawierać legacy rekordy oznaczone 'private').
--   user_workspace_states  = prywatne rekordy zalogowanego użytkownika; owner_id jest ZAWSZE
--                             brany z kolumny `user_id` tego wiersza (sesja), NIGDY z pola
--                             `ownerId` w JSON. Prywatne rekordy migrują jako PRYWATNE (bez
--                             ujawnienia -- parytet z 009/010/011/012).
-- Life nie ma relacji rodzic/dziecko -- BRAK guardów sierot, BRAK EXISTS na rodzicu. Wszystko
-- defensywne wobec NULL/nieobecnych kolekcji i legacy `ownerId` ("me", stare id).
-- Dane żyją pod `data->'life'->'<collection>'` (NIE `data->'advanced'->...` jak w modułach
-- advanced) -- `LIFE_COLLECTIONS` w server/src/workspace.mjs.
-- ---------------------------------------------------------------------------

-- Zadania (tasks): wspólne
INSERT INTO tasks (
  id, household_id, owner_id, visibility, title, description, status, priority, date, time,
  estimated_minutes, category, is_focus, energy, completed_at, series_id, series_index,
  recurrence, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE(NULLIF(rec->>'title', ''), 'Zadanie'),
  NULLIF(rec->>'description', ''),
  CASE WHEN rec->>'status' IN ('todo', 'done') THEN rec->>'status' ELSE 'todo' END,
  CASE WHEN rec->>'priority' IN ('low', 'medium', 'high') THEN rec->>'priority' ELSE 'medium' END,
  NULLIF(rec->>'date', '')::date,
  NULLIF(rec->>'time', ''),
  NULLIF(rec->>'estimatedMinutes', '')::integer,
  COALESCE(NULLIF(rec->>'category', ''), 'Ogólne'),
  COALESCE((rec->>'isFocus')::boolean, false),
  CASE WHEN rec->>'energy' IN ('low', 'medium', 'high') THEN rec->>'energy' ELSE 'medium' END,
  NULLIF(rec->>'completedAt', '')::timestamptz,
  NULLIF(rec->>'seriesId', ''),
  NULLIF(rec->>'seriesIndex', '')::integer,
  rec->'recurrence',
  1,
  COALESCE((rec->>'createdAt')::timestamptz, (rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(ws.data->'life'->'tasks', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Zadania (tasks): prywatne (owner_id z wiersza user_workspace_states, nie z JSON)
INSERT INTO tasks (
  id, household_id, owner_id, visibility, title, description, status, priority, date, time,
  estimated_minutes, category, is_focus, energy, completed_at, series_id, series_index,
  recurrence, version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  uws.user_id,
  'private',
  COALESCE(NULLIF(rec->>'title', ''), 'Zadanie'),
  NULLIF(rec->>'description', ''),
  CASE WHEN rec->>'status' IN ('todo', 'done') THEN rec->>'status' ELSE 'todo' END,
  CASE WHEN rec->>'priority' IN ('low', 'medium', 'high') THEN rec->>'priority' ELSE 'medium' END,
  NULLIF(rec->>'date', '')::date,
  NULLIF(rec->>'time', ''),
  NULLIF(rec->>'estimatedMinutes', '')::integer,
  COALESCE(NULLIF(rec->>'category', ''), 'Ogólne'),
  COALESCE((rec->>'isFocus')::boolean, false),
  CASE WHEN rec->>'energy' IN ('low', 'medium', 'high') THEN rec->>'energy' ELSE 'medium' END,
  NULLIF(rec->>'completedAt', '')::timestamptz,
  NULLIF(rec->>'seriesId', ''),
  NULLIF(rec->>'seriesIndex', '')::integer,
  rec->'recurrence',
  1,
  COALESCE((rec->>'createdAt')::timestamptz, (rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(uws.data->'life'->'tasks', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Wydarzenia (events): wspólne
INSERT INTO events (
  id, household_id, owner_id, visibility, title, date, start_time, end_time, kind, location,
  notes, source, external_id, external_updated_at, series_id, series_index, recurrence,
  version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE(NULLIF(rec->>'title', ''), 'Wydarzenie'),
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  COALESCE(NULLIF(rec->>'startTime', ''), '00:00'),
  COALESCE(NULLIF(rec->>'endTime', ''), '00:00'),
  CASE WHEN rec->>'kind' IN ('meeting', 'focus', 'personal') THEN rec->>'kind' ELSE 'personal' END,
  NULLIF(rec->>'location', ''),
  NULLIF(rec->>'notes', ''),
  CASE WHEN rec->>'source' IN ('manual', 'google') THEN rec->>'source' ELSE NULL END,
  NULLIF(rec->>'externalId', ''),
  NULLIF(rec->>'externalUpdatedAt', ''),
  NULLIF(rec->>'seriesId', ''),
  NULLIF(rec->>'seriesIndex', '')::integer,
  rec->'recurrence',
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(ws.data->'life'->'events', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Wydarzenia (events): prywatne
INSERT INTO events (
  id, household_id, owner_id, visibility, title, date, start_time, end_time, kind, location,
  notes, source, external_id, external_updated_at, series_id, series_index, recurrence,
  version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  uws.user_id,
  'private',
  COALESCE(NULLIF(rec->>'title', ''), 'Wydarzenie'),
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  COALESCE(NULLIF(rec->>'startTime', ''), '00:00'),
  COALESCE(NULLIF(rec->>'endTime', ''), '00:00'),
  CASE WHEN rec->>'kind' IN ('meeting', 'focus', 'personal') THEN rec->>'kind' ELSE 'personal' END,
  NULLIF(rec->>'location', ''),
  NULLIF(rec->>'notes', ''),
  CASE WHEN rec->>'source' IN ('manual', 'google') THEN rec->>'source' ELSE NULL END,
  NULLIF(rec->>'externalId', ''),
  NULLIF(rec->>'externalUpdatedAt', ''),
  NULLIF(rec->>'seriesId', ''),
  NULLIF(rec->>'seriesIndex', '')::integer,
  rec->'recurrence',
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(uws.data->'life'->'events', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Przypomnienia (reminders): wspólne
INSERT INTO reminders (
  id, household_id, owner_id, visibility, title, date, time, done, notified_at, version,
  created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE(NULLIF(rec->>'title', ''), 'Przypomnienie'),
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  COALESCE(NULLIF(rec->>'time', ''), '00:00'),
  COALESCE((rec->>'done')::boolean, false),
  NULLIF(rec->>'notifiedAt', '')::timestamptz,
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(ws.data->'life'->'reminders', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Przypomnienia (reminders): prywatne
INSERT INTO reminders (
  id, household_id, owner_id, visibility, title, date, time, done, notified_at, version,
  created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  uws.user_id,
  'private',
  COALESCE(NULLIF(rec->>'title', ''), 'Przypomnienie'),
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  COALESCE(NULLIF(rec->>'time', ''), '00:00'),
  COALESCE((rec->>'done')::boolean, false),
  NULLIF(rec->>'notifiedAt', '')::timestamptz,
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(uws.data->'life'->'reminders', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Notatki (notes): wspólne
INSERT INTO notes (
  id, household_id, owner_id, visibility, title, content, color, pinned, version, created_at,
  updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE(NULLIF(rec->>'title', ''), 'Notatka'),
  COALESCE(rec->>'content', ''),
  CASE WHEN rec->>'color' IN ('cream', 'mint', 'sky', 'lilac') THEN rec->>'color' ELSE 'cream' END,
  COALESCE((rec->>'pinned')::boolean, false),
  1,
  COALESCE((rec->>'createdAt')::timestamptz, (rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(ws.data->'life'->'notes', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Notatki (notes): prywatne
INSERT INTO notes (
  id, household_id, owner_id, visibility, title, content, color, pinned, version, created_at,
  updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  uws.user_id,
  'private',
  COALESCE(NULLIF(rec->>'title', ''), 'Notatka'),
  COALESCE(rec->>'content', ''),
  CASE WHEN rec->>'color' IN ('cream', 'mint', 'sky', 'lilac') THEN rec->>'color' ELSE 'cream' END,
  COALESCE((rec->>'pinned')::boolean, false),
  1,
  COALESCE((rec->>'createdAt')::timestamptz, (rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(uws.data->'life'->'notes', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Nawyki (habits): wspólne
INSERT INTO habits (
  id, household_id, owner_id, visibility, name, icon, target_label, completed_dates, version,
  created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE(NULLIF(rec->>'name', ''), 'Nawyk'),
  CASE WHEN rec->>'icon' IN ('water', 'walk', 'read', 'stretch', 'meditate')
       THEN rec->>'icon' ELSE 'water' END,
  COALESCE(NULLIF(rec->>'targetLabel', ''), 'Codziennie'),
  COALESCE(rec->'completedDates', '[]'::jsonb),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(ws.data->'life'->'habits', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Nawyki (habits): prywatne
INSERT INTO habits (
  id, household_id, owner_id, visibility, name, icon, target_label, completed_dates, version,
  created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  uws.user_id,
  'private',
  COALESCE(NULLIF(rec->>'name', ''), 'Nawyk'),
  CASE WHEN rec->>'icon' IN ('water', 'walk', 'read', 'stretch', 'meditate')
       THEN rec->>'icon' ELSE 'water' END,
  COALESCE(NULLIF(rec->>'targetLabel', ''), 'Codziennie'),
  COALESCE(rec->'completedDates', '[]'::jsonb),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(uws.data->'life'->'habits', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Wycięcie WYŁĄCZNIE pięciu kolekcji Life z JSONB po migracji. Pola osobiste
-- (`scratchpad`/`intention`/`energy`/`preferences`) i `advanced` ZOSTAJĄ nietknięte -- `life`
-- dokumentu dalej istnieje z samymi skalarami. Bump `revision` wymusza czysty refetch u
-- podłączonych klientów (por. docs/ARCHITECTURE.md "Synchronizacja"). WHERE-guardy czynią to
-- bezpiecznym do ponownego uruchomienia (no-op gdy już wycięte).
-- ---------------------------------------------------------------------------

UPDATE workspace_states
SET data = data
    #- '{life,tasks}'
    #- '{life,events}'
    #- '{life,reminders}'
    #- '{life,notes}'
    #- '{life,habits}',
  revision = revision + 1
WHERE data->'life' ?| array['tasks', 'events', 'reminders', 'notes', 'habits'];

UPDATE user_workspace_states
SET data = data
    #- '{life,tasks}'
    #- '{life,events}'
    #- '{life,reminders}'
    #- '{life,notes}'
    #- '{life,habits}',
  updated_at = now()
WHERE data->'life' ?| array['tasks', 'events', 'reminders', 'notes', 'habits'];

-- Znormalizowane Podróże: trips/tripItinerary/tripBookings/packingItems przestają być
-- częścią dokumentów JSONB (workspace_states / user_workspace_states) i dostają własne
-- tabele z optymistyczną współbieżnością per rekord (kolumna `version`) oraz tabelę
-- idempotencji mutacji. Patrz docs/plans/podroze-trips.md ("Model tabel").
--
-- W odróżnieniu od Finansów podróże NIE MAJĄ `owner_id`/`visibility` — są zawsze wspólne dla
-- gospodarstwa (decyzja użytkownika, patrz plan "Decyzje ustalone z góry" #6). Historyczne
-- prywatne podróże z `user_workspace_states` migrują jako wspólne (household) — świadomie
-- zaakceptowane ujawnienie, patrz "Ryzyka" w planie.

CREATE TABLE IF NOT EXISTS trips (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name text NOT NULL,
  destination text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('idea', 'planning', 'active', 'archived')),
  budget_minor bigint,
  currency char(3) NOT NULL,
  travelers jsonb NOT NULL DEFAULT '[]',
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  accent text NOT NULL CHECK (accent IN ('terracotta', 'ocean', 'forest', 'violet')),
  notes text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS trips_household_idx ON trips(household_id);

CREATE TABLE IF NOT EXISTS trip_itinerary (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  trip_id text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  date date NOT NULL,
  time text NOT NULL,
  title text NOT NULL,
  type text NOT NULL CHECK (type IN ('transport', 'stay', 'activity', 'food', 'other')),
  location text,
  cost_minor bigint,
  booked boolean NOT NULL DEFAULT false,
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS trip_itinerary_household_idx ON trip_itinerary(household_id);
CREATE INDEX IF NOT EXISTS trip_itinerary_trip_idx ON trip_itinerary(trip_id);

CREATE TABLE IF NOT EXISTS trip_bookings (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  trip_id text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  -- Bez FK celowo: usunięcie punktu planu nie może wysypać powiązanej rezerwacji (parytet
  -- z dzisiejszym luźnym powiązaniem w JSONB). Osierocone itinerary_item_id są tolerowane.
  itinerary_item_id text,
  type text NOT NULL CHECK (type IN ('flight', 'train', 'stay', 'car', 'activity')),
  provider text NOT NULL DEFAULT '',
  reference text NOT NULL DEFAULT '',
  title text NOT NULL,
  start_at timestamptz NOT NULL,
  amount_minor bigint NOT NULL DEFAULT 0,
  paid boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS trip_bookings_household_idx ON trip_bookings(household_id);
CREATE INDEX IF NOT EXISTS trip_bookings_trip_idx ON trip_bookings(trip_id);

CREATE TABLE IF NOT EXISTS packing_items (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  trip_id text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('documents', 'clothes', 'electronics', 'health', 'other')),
  packed boolean NOT NULL DEFAULT false,
  assigned_to text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS packing_items_household_idx ON packing_items(household_id);
CREATE INDEX IF NOT EXISTS packing_items_trip_idx ON packing_items(trip_id);

CREATE TABLE IF NOT EXISTS trip_mutations (
  idempotency_key uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  op text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_mutations_created_idx ON trip_mutations(created_at);

-- ---------------------------------------------------------------------------
-- Migracja danych z JSONB.
--   workspace_states       = dane wspólne gospodarstwa.
--   user_workspace_states  = historyczne prywatne podróże zalogowanego użytkownika — migrują
--                             jako WSPÓLNE (household_id = uws.household_id), bo podróże nie
--                             mają już kolumny visibility (decyzja "zawsze wspólne", patrz plan).
-- Kolejność: najpierw trips (FK z dzieci), potem itinerary/bookings/packing.
-- Wszystko defensywne wobec NULL/nieobecnych kolekcji; dzieci pomijają sieroty bez
-- zmigrowanego rodzica w tym samym gospodarstwie.
-- ---------------------------------------------------------------------------

-- Trips: wspólne
INSERT INTO trips (
  id, household_id, name, destination, start_date, end_date, status, budget_minor, currency,
  travelers, progress, accent, notes, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(NULLIF(rec->>'name', ''), 'Podróż'),
  COALESCE(rec->>'destination', ''),
  COALESCE((rec->>'startDate')::date, CURRENT_DATE),
  COALESCE((rec->>'endDate')::date, CURRENT_DATE),
  CASE WHEN rec->>'status' IN ('idea', 'planning', 'active', 'archived')
       THEN rec->>'status' ELSE 'idea' END,
  (rec->>'budgetMinor')::bigint,
  COALESCE(NULLIF(rec->>'currency', ''), 'PLN'),
  COALESCE(rec->'travelers', '[]'::jsonb),
  LEAST(100, GREATEST(0, COALESCE((rec->>'progress')::integer, 0))),
  CASE WHEN rec->>'accent' IN ('terracotta', 'ocean', 'forest', 'violet')
       THEN rec->>'accent' ELSE 'terracotta' END,
  COALESCE(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'trips', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Trips: prywatne (historyczne) -- migrują jako wspólne, household_id z wiersza user_workspace_states.
INSERT INTO trips (
  id, household_id, name, destination, start_date, end_date, status, budget_minor, currency,
  travelers, progress, accent, notes, version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  COALESCE(NULLIF(rec->>'name', ''), 'Podróż'),
  COALESCE(rec->>'destination', ''),
  COALESCE((rec->>'startDate')::date, CURRENT_DATE),
  COALESCE((rec->>'endDate')::date, CURRENT_DATE),
  CASE WHEN rec->>'status' IN ('idea', 'planning', 'active', 'archived')
       THEN rec->>'status' ELSE 'idea' END,
  (rec->>'budgetMinor')::bigint,
  COALESCE(NULLIF(rec->>'currency', ''), 'PLN'),
  COALESCE(rec->'travelers', '[]'::jsonb),
  LEAST(100, GREATEST(0, COALESCE((rec->>'progress')::integer, 0))),
  CASE WHEN rec->>'accent' IN ('terracotta', 'ocean', 'forest', 'violet')
       THEN rec->>'accent' ELSE 'terracotta' END,
  COALESCE(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'trips', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Plan podróży (itinerary): wspólne
INSERT INTO trip_itinerary (
  id, household_id, trip_id, date, time, title, type, location, cost_minor, booked, notes,
  version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  rec->>'tripId',
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  COALESCE(NULLIF(rec->>'time', ''), '00:00'),
  COALESCE(NULLIF(rec->>'title', ''), 'Punkt planu'),
  CASE WHEN rec->>'type' IN ('transport', 'stay', 'activity', 'food', 'other')
       THEN rec->>'type' ELSE 'other' END,
  NULLIF(rec->>'location', ''),
  (rec->>'costMinor')::bigint,
  COALESCE((rec->>'booked')::boolean, false),
  NULLIF(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'tripItinerary', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM trips t WHERE t.id = rec->>'tripId' AND t.household_id = ws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- Plan podróży (itinerary): prywatne (historyczne), rodzic musi być zmigrowany do tego samego gospodarstwa
INSERT INTO trip_itinerary (
  id, household_id, trip_id, date, time, title, type, location, cost_minor, booked, notes,
  version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  rec->>'tripId',
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  COALESCE(NULLIF(rec->>'time', ''), '00:00'),
  COALESCE(NULLIF(rec->>'title', ''), 'Punkt planu'),
  CASE WHEN rec->>'type' IN ('transport', 'stay', 'activity', 'food', 'other')
       THEN rec->>'type' ELSE 'other' END,
  NULLIF(rec->>'location', ''),
  (rec->>'costMinor')::bigint,
  COALESCE((rec->>'booked')::boolean, false),
  NULLIF(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'tripItinerary', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM trips t WHERE t.id = rec->>'tripId' AND t.household_id = uws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- Rezerwacje (bookings): wspólne
INSERT INTO trip_bookings (
  id, household_id, trip_id, itinerary_item_id, type, provider, reference, title, start_at,
  amount_minor, paid, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  rec->>'tripId',
  NULLIF(rec->>'itineraryItemId', ''),
  CASE WHEN rec->>'type' IN ('flight', 'train', 'stay', 'car', 'activity')
       THEN rec->>'type' ELSE 'activity' END,
  COALESCE(rec->>'provider', ''),
  COALESCE(rec->>'reference', ''),
  COALESCE(NULLIF(rec->>'title', ''), 'Rezerwacja'),
  COALESCE((rec->>'startAt')::timestamptz, now()),
  COALESCE((rec->>'amountMinor')::bigint, 0),
  COALESCE((rec->>'paid')::boolean, false),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'tripBookings', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM trips t WHERE t.id = rec->>'tripId' AND t.household_id = ws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- Rezerwacje (bookings): prywatne (historyczne)
INSERT INTO trip_bookings (
  id, household_id, trip_id, itinerary_item_id, type, provider, reference, title, start_at,
  amount_minor, paid, version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  rec->>'tripId',
  NULLIF(rec->>'itineraryItemId', ''),
  CASE WHEN rec->>'type' IN ('flight', 'train', 'stay', 'car', 'activity')
       THEN rec->>'type' ELSE 'activity' END,
  COALESCE(rec->>'provider', ''),
  COALESCE(rec->>'reference', ''),
  COALESCE(NULLIF(rec->>'title', ''), 'Rezerwacja'),
  COALESCE((rec->>'startAt')::timestamptz, now()),
  COALESCE((rec->>'amountMinor')::bigint, 0),
  COALESCE((rec->>'paid')::boolean, false),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'tripBookings', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM trips t WHERE t.id = rec->>'tripId' AND t.household_id = uws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- Pakowanie (packing_items): wspólne
INSERT INTO packing_items (
  id, household_id, trip_id, name, category, packed, assigned_to, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  rec->>'tripId',
  COALESCE(NULLIF(rec->>'name', ''), 'Przedmiot'),
  CASE WHEN rec->>'category' IN ('documents', 'clothes', 'electronics', 'health', 'other')
       THEN rec->>'category' ELSE 'other' END,
  COALESCE((rec->>'packed')::boolean, false),
  NULLIF(rec->>'assignedTo', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'packingItems', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM trips t WHERE t.id = rec->>'tripId' AND t.household_id = ws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- Pakowanie (packing_items): prywatne (historyczne)
INSERT INTO packing_items (
  id, household_id, trip_id, name, category, packed, assigned_to, version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  rec->>'tripId',
  COALESCE(NULLIF(rec->>'name', ''), 'Przedmiot'),
  CASE WHEN rec->>'category' IN ('documents', 'clothes', 'electronics', 'health', 'other')
       THEN rec->>'category' ELSE 'other' END,
  COALESCE((rec->>'packed')::boolean, false),
  NULLIF(rec->>'assignedTo', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'packingItems', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM trips t WHERE t.id = rec->>'tripId' AND t.household_id = uws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Wycięcie trips z JSONB po migracji. Bump `revision` wymusza czysty refetch
-- u podłączonych klientów (por. docs/ARCHITECTURE.md "Synchronizacja").
-- WHERE-guardy czynią to bezpiecznym do ponownego uruchomienia (no-op gdy już wycięte).
-- ---------------------------------------------------------------------------

UPDATE workspace_states
SET data = data
    #- '{advanced,trips}'
    #- '{advanced,tripItinerary}'
    #- '{advanced,tripBookings}'
    #- '{advanced,packingItems}',
  revision = revision + 1
WHERE data->'advanced' ?| array['trips', 'tripItinerary', 'tripBookings', 'packingItems'];

UPDATE user_workspace_states
SET data = data
    #- '{advanced,trips}'
    #- '{advanced,tripItinerary}'
    #- '{advanced,tripBookings}'
    #- '{advanced,packingItems}',
  updated_at = now()
WHERE data->'advanced' ?| array['trips', 'tripItinerary', 'tripBookings', 'packingItems'];

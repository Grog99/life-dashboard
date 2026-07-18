-- Znormalizowane Subskrypcje: kolekcja `subscriptions` przestaje być częścią dokumentów JSONB
-- (workspace_states / user_workspace_states) i dostaje własną tabelę z optymistyczną
-- współbieżnością per rekord (kolumna `version`) oraz tabelę idempotencji mutacji.
-- Patrz docs/plans/subskrypcje-sql.md ("Model tabeli", "Migracja danych historycznych").
--
-- Szósta migracja wg tego wzorca (po Finansach/006, Podróżach/007, Meals/008, Aucie/009,
-- Zwierzętach/010, Zdrowiu/011) -- NAJPROSTSZY przypadek w całej serii: JEDNA płaska kolekcja,
-- bez relacji rodzic/dziecko (żadnego FK między tabelami poza households/users), bez kaskady
-- widoczności, bez guardu sierot, bez `EXISTS` na rodzicu. Jedyna tabela filtruje wyłącznie po
-- swoim wierszu (`visibility='household' OR owner_id=$user`), dokładnie jak trzy tabele Zdrowia
-- (011) -- tu wystarczy jedna.
--
-- Historyczne prywatne subskrypcje migrują jako PRYWATNE -- bez ujawnienia (parytet z 009/010/011).
-- `owner_id` prywatnych rekordów jest ZAWSZE brany z kolumny `user_id` wiersza
-- `user_workspace_states` (sesja), NIGDY z pola `ownerId` w JSON.

CREATE TABLE IF NOT EXISTS subscriptions (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  name text NOT NULL,
  category text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency IN ('PLN', 'EUR', 'USD', 'GBP')),
  cycle text NOT NULL CHECK (cycle IN ('monthly', 'quarterly', 'yearly')),
  next_payment date NOT NULL,
  payer text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('active', 'trial', 'paused', 'cancelled')),
  reminder_days integer NOT NULL DEFAULT 0 CHECK (reminder_days >= 0 AND reminder_days <= 365),
  color text NOT NULL,
  -- Nullable -- `cancelUrl?` opcjonalny w `Subscription`, wzór `species`/`notes`/`specialty` w
  -- pets.mjs/health.mjs.
  cancel_url text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS subscriptions_household_idx ON subscriptions(household_id);
CREATE INDEX IF NOT EXISTS subscriptions_household_visibility_idx
  ON subscriptions(household_id, visibility);
CREATE INDEX IF NOT EXISTS subscriptions_owner_idx ON subscriptions(owner_id);

CREATE TABLE IF NOT EXISTS subscription_mutations (
  idempotency_key uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  op text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_mutations_created_idx ON subscription_mutations(created_at);

-- ---------------------------------------------------------------------------
-- Migracja danych z JSONB.
--   workspace_states       = dane wspólne gospodarstwa (visibility zwykle 'household', ale mogą
--                             zawierać legacy rekordy oznaczone 'private').
--   user_workspace_states  = prywatne rekordy zalogowanego użytkownika; owner_id jest ZAWSZE
--                             brany z kolumny `user_id` tego wiersza (sesja), NIGDY z pola
--                             `ownerId` w JSON. Prywatne rekordy migrują jako PRYWATNE (bez
--                             ujawnienia -- parytet z 009/010/011).
-- Subskrypcje nie mają relacji rodzic/dziecko -- BRAK guardów sierot, BRAK EXISTS na rodzicu.
-- Wszystko defensywne wobec NULL/nieobecnych kolekcji i legacy `ownerId` ("me", stare id).
-- ---------------------------------------------------------------------------

-- Subskrypcje: wspólne
INSERT INTO subscriptions (
  id, household_id, owner_id, visibility, name, category, amount_minor, currency, cycle,
  next_payment, payer, status, reminder_days, color, cancel_url, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE(NULLIF(rec->>'name', ''), 'Subskrypcja'),
  COALESCE(NULLIF(rec->>'category', ''), 'Inne'),
  GREATEST(0, COALESCE((rec->>'amountMinor')::bigint, 0)),
  CASE WHEN rec->>'currency' IN ('PLN', 'EUR', 'USD', 'GBP') THEN rec->>'currency' ELSE 'PLN' END,
  CASE WHEN rec->>'cycle' IN ('monthly', 'quarterly', 'yearly') THEN rec->>'cycle' ELSE 'monthly' END,
  COALESCE((rec->>'nextPayment')::date, CURRENT_DATE),
  COALESCE(rec->>'payer', ''),
  CASE WHEN rec->>'status' IN ('active', 'trial', 'paused', 'cancelled')
       THEN rec->>'status' ELSE 'active' END,
  -- Default 1, nie 0 -- parytet z dawnym fallbackiem workera (`derivedReminders`,
  -- `Number.isFinite(...) ? Math.max(0, ...) : 1`) dla rekordów bez pola.
  LEAST(365, GREATEST(0, COALESCE((rec->>'reminderDays')::integer, 1))),
  COALESCE(NULLIF(rec->>'color', ''), '#397763'),
  NULLIF(rec->>'cancelUrl', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(ws.data->'advanced'->'subscriptions', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Subskrypcje: prywatne (owner_id z wiersza user_workspace_states, nie z JSON)
INSERT INTO subscriptions (
  id, household_id, owner_id, visibility, name, category, amount_minor, currency, cycle,
  next_payment, payer, status, reminder_days, color, cancel_url, version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  uws.user_id,
  'private',
  COALESCE(NULLIF(rec->>'name', ''), 'Subskrypcja'),
  COALESCE(NULLIF(rec->>'category', ''), 'Inne'),
  GREATEST(0, COALESCE((rec->>'amountMinor')::bigint, 0)),
  CASE WHEN rec->>'currency' IN ('PLN', 'EUR', 'USD', 'GBP') THEN rec->>'currency' ELSE 'PLN' END,
  CASE WHEN rec->>'cycle' IN ('monthly', 'quarterly', 'yearly') THEN rec->>'cycle' ELSE 'monthly' END,
  COALESCE((rec->>'nextPayment')::date, CURRENT_DATE),
  COALESCE(rec->>'payer', ''),
  CASE WHEN rec->>'status' IN ('active', 'trial', 'paused', 'cancelled')
       THEN rec->>'status' ELSE 'active' END,
  LEAST(365, GREATEST(0, COALESCE((rec->>'reminderDays')::integer, 1))),
  COALESCE(NULLIF(rec->>'color', ''), '#397763'),
  NULLIF(rec->>'cancelUrl', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(uws.data->'advanced'->'subscriptions', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Wycięcie Subskrypcji z JSONB po migracji. Bump `revision` wymusza czysty refetch u podłączonych
-- klientów (por. docs/ARCHITECTURE.md "Synchronizacja"). WHERE-guardy czynią to bezpiecznym do
-- ponownego uruchomienia (no-op gdy już wycięte).
-- ---------------------------------------------------------------------------

UPDATE workspace_states
SET data = data #- '{advanced,subscriptions}',
  revision = revision + 1
WHERE data->'advanced' ? 'subscriptions';

UPDATE user_workspace_states
SET data = data #- '{advanced,subscriptions}',
  updated_at = now()
WHERE data->'advanced' ? 'subscriptions';

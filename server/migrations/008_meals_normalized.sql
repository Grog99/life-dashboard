-- Znormalizowane Posiłki: recipes/mealSlots/shoppingItems przestają być częścią dokumentów
-- JSONB (workspace_states / user_workspace_states) i dostają własne tabele z optymistyczną
-- współbieżnością per rekord (kolumna `version`) oraz tabelę idempotencji mutacji.
-- Patrz docs/plans/lista-zakupow-meals.md ("Model tabel").
--
-- Wzorzec 1:1 z server/migrations/007_trips_normalized.sql: BRAK `owner_id`/`visibility` --
-- wszystkie trzy kolekcje są zawsze wspólne dla gospodarstwa (decyzja użytkownika, patrz plan
-- "Decyzje ustalone z góry" #5). Historyczne prywatne przepisy z `user_workspace_states`
-- migrują jako wspólne (household) -- świadomie zaakceptowane ujawnienie, patrz "Ryzyka" w planie.
--
-- Różnica kluczowa względem Podróży: usunięcie przepisu ODPINA (nie kasuje) powiązane
-- mealSlots/shoppingItems -- FK `recipe_id`/`source_recipe_id` używają `ON DELETE SET NULL`,
-- nie `CASCADE`. Oba FK są NULL-owalne od startu: lista zakupów działa też jako ogólna, wspólna
-- lista niezwiązana z żadnym przepisem, a slot posiłku może istnieć bez przypisanego przepisu.

CREATE TABLE IF NOT EXISTS recipes (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name text NOT NULL,
  minutes integer NOT NULL CHECK (minutes > 0),
  servings integer NOT NULL CHECK (servings > 0),
  tags jsonb NOT NULL DEFAULT '[]',
  ingredients jsonb NOT NULL DEFAULT '[]',
  favorite boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS recipes_household_idx ON recipes(household_id);

CREATE TABLE IF NOT EXISTS meal_slots (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- Nullable: usunięcie przepisu odpina slot (SET NULL), nie kasuje go (decyzja #6 planu).
  recipe_id text REFERENCES recipes(id) ON DELETE SET NULL,
  date date NOT NULL,
  type text NOT NULL CHECK (type IN ('breakfast', 'lunch', 'dinner')),
  title text NOT NULL,
  servings integer NOT NULL CHECK (servings > 0),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS meal_slots_household_idx ON meal_slots(household_id);
CREATE INDEX IF NOT EXISTS meal_slots_recipe_idx ON meal_slots(recipe_id);

CREATE TABLE IF NOT EXISTS shopping_items (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- Nullable: lista zakupów działa też jako ogólna, wspólna lista niezwiązana z żadnym
  -- przepisem; usunięcie przepisu odpina pozycję (SET NULL), nie kasuje jej (decyzja #6 planu).
  source_recipe_id text REFERENCES recipes(id) ON DELETE SET NULL,
  name text NOT NULL,
  quantity text NOT NULL DEFAULT '',
  category text NOT NULL,
  checked boolean NOT NULL DEFAULT false,
  assigned_to text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS shopping_items_household_idx ON shopping_items(household_id);
CREATE INDEX IF NOT EXISTS shopping_items_source_recipe_idx ON shopping_items(source_recipe_id);

CREATE TABLE IF NOT EXISTS meal_mutations (
  idempotency_key uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  op text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meal_mutations_created_idx ON meal_mutations(created_at);

-- ---------------------------------------------------------------------------
-- Migracja danych z JSONB.
--   workspace_states       = dane wspólne gospodarstwa.
--   user_workspace_states  = historyczne prywatne przepisy zalogowanego użytkownika -- migrują
--                             jako WSPÓLNE (household_id = uws.household_id), bo przepisy nie
--                             mają już kolumny visibility (decyzja "zawsze wspólne", patrz plan).
-- Kolejność: najpierw recipes (rodzic opcjonalny dla dzieci), potem mealSlots/shoppingItems.
-- Wszystko defensywne wobec NULL/nieobecnych kolekcji.
--
-- Różnica względem 007 (Podróże): tam dzieci bez zmigrowanego rodzica były POMIJANE
-- (WHERE EXISTS ...). Tu mealSlots/shoppingItems MIGRUJĄ ZAWSZE (rodzic opcjonalny) --
-- brakujący/nieznany recipeId/sourceRecipeId daje NULL w FK, a nie pominięcie rekordu.
-- ---------------------------------------------------------------------------

-- Przepisy: wspólne
INSERT INTO recipes (
  id, household_id, name, minutes, servings, tags, ingredients, favorite, version,
  created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(NULLIF(rec->>'name', ''), 'Przepis'),
  GREATEST(1, COALESCE((rec->>'minutes')::integer, 1)),
  GREATEST(1, COALESCE((rec->>'servings')::integer, 1)),
  COALESCE(rec->'tags', '[]'::jsonb),
  COALESCE(rec->'ingredients', '[]'::jsonb),
  COALESCE((rec->>'favorite')::boolean, false),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'recipes', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Przepisy: prywatne (historyczne) -- migrują jako wspólne, household_id z wiersza user_workspace_states.
INSERT INTO recipes (
  id, household_id, name, minutes, servings, tags, ingredients, favorite, version,
  created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  COALESCE(NULLIF(rec->>'name', ''), 'Przepis'),
  GREATEST(1, COALESCE((rec->>'minutes')::integer, 1)),
  GREATEST(1, COALESCE((rec->>'servings')::integer, 1)),
  COALESCE(rec->'tags', '[]'::jsonb),
  COALESCE(rec->'ingredients', '[]'::jsonb),
  COALESCE((rec->>'favorite')::boolean, false),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'recipes', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Sloty posiłków (meal_slots): wspólne. recipe_id wpisany TYLKO gdy zmigrowany przepis istnieje
-- w tym samym gospodarstwie, inaczej NULL (slot bez przepisu jest legalny).
INSERT INTO meal_slots (
  id, household_id, recipe_id, date, type, title, servings, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  CASE
    WHEN NULLIF(rec->>'recipeId', '') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM recipes r
        WHERE r.id = rec->>'recipeId' AND r.household_id = ws.household_id
      )
    THEN rec->>'recipeId'
    ELSE NULL
  END,
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  CASE WHEN rec->>'type' IN ('breakfast', 'lunch', 'dinner')
       THEN rec->>'type' ELSE 'dinner' END,
  COALESCE(NULLIF(rec->>'title', ''), 'Posiłek'),
  GREATEST(1, COALESCE((rec->>'servings')::integer, 1)),
  1,
  now(),
  now()
FROM workspace_states ws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'mealSlots', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Sloty posiłków (meal_slots): prywatne (historyczne) -- migrują jako wspólne.
INSERT INTO meal_slots (
  id, household_id, recipe_id, date, type, title, servings, version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  CASE
    WHEN NULLIF(rec->>'recipeId', '') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM recipes r
        WHERE r.id = rec->>'recipeId' AND r.household_id = uws.household_id
      )
    THEN rec->>'recipeId'
    ELSE NULL
  END,
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  CASE WHEN rec->>'type' IN ('breakfast', 'lunch', 'dinner')
       THEN rec->>'type' ELSE 'dinner' END,
  COALESCE(NULLIF(rec->>'title', ''), 'Posiłek'),
  GREATEST(1, COALESCE((rec->>'servings')::integer, 1)),
  1,
  now(),
  now()
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'mealSlots', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Lista zakupów (shopping_items): wspólne. source_recipe_id analogicznie NULL-owalny z guardem
-- (pozycja bez przepisu jest legalna).
INSERT INTO shopping_items (
  id, household_id, source_recipe_id, name, quantity, category, checked, assigned_to,
  version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  CASE
    WHEN NULLIF(rec->>'sourceRecipeId', '') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM recipes r
        WHERE r.id = rec->>'sourceRecipeId' AND r.household_id = ws.household_id
      )
    THEN rec->>'sourceRecipeId'
    ELSE NULL
  END,
  COALESCE(NULLIF(rec->>'name', ''), 'Pozycja'),
  COALESCE(rec->>'quantity', ''),
  COALESCE(NULLIF(rec->>'category', ''), 'Inne'),
  COALESCE((rec->>'checked')::boolean, false),
  NULLIF(rec->>'assignedTo', ''),
  1,
  now(),
  now()
FROM workspace_states ws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'shoppingItems', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Lista zakupów (shopping_items): prywatne (historyczne) -- migrują jako wspólne.
INSERT INTO shopping_items (
  id, household_id, source_recipe_id, name, quantity, category, checked, assigned_to,
  version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  CASE
    WHEN NULLIF(rec->>'sourceRecipeId', '') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM recipes r
        WHERE r.id = rec->>'sourceRecipeId' AND r.household_id = uws.household_id
      )
    THEN rec->>'sourceRecipeId'
    ELSE NULL
  END,
  COALESCE(NULLIF(rec->>'name', ''), 'Pozycja'),
  COALESCE(rec->>'quantity', ''),
  COALESCE(NULLIF(rec->>'category', ''), 'Inne'),
  COALESCE((rec->>'checked')::boolean, false),
  NULLIF(rec->>'assignedTo', ''),
  1,
  now(),
  now()
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'shoppingItems', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Wycięcie meals z JSONB po migracji. Bump `revision` wymusza czysty refetch
-- u podłączonych klientów (por. docs/ARCHITECTURE.md "Synchronizacja").
-- WHERE-guardy czynią to bezpiecznym do ponownego uruchomienia (no-op gdy już wycięte).
-- ---------------------------------------------------------------------------

UPDATE workspace_states
SET data = data
    #- '{advanced,recipes}'
    #- '{advanced,mealSlots}'
    #- '{advanced,shoppingItems}',
  revision = revision + 1
WHERE data->'advanced' ?| array['recipes', 'mealSlots', 'shoppingItems'];

UPDATE user_workspace_states
SET data = data
    #- '{advanced,recipes}'
    #- '{advanced,mealSlots}'
    #- '{advanced,shoppingItems}',
  updated_at = now()
WHERE data->'advanced' ?| array['recipes', 'mealSlots', 'shoppingItems'];

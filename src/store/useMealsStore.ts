// Dedykowany store modułu Posiłki — patrz docs/plans/lista-zakupow-meals.md
// ("Frontend — dedykowany store + silnik sync"). Posiłki nie są już częścią dokumentu JSONB
// (AdvancedData/useAdvancedStore) — mają własne znormalizowane tabele SQL i endpointy
// `/api/v1/meals` (snapshot) + `/api/v1/meals/mutations` (batch mutacji z idempotencją +
// optymistyczną współbieżnością per rekord, kolumna `version`). Wzór 1:1 z
// src/store/useTripsStore.ts, z dwiema różnicami specyficznymi dla Meals:
//   1. Meals nie mają pola agregującego (odpowiednika `trip.progress`) — `reconcileTerminal` jest
//      prostszy, żaden wynik mutacji nie niesie dodatkowego pola obok `record`.
//   2. `recipe.delete` odpina (SET NULL), nie kasuje dzieci — serwer nie bumpuje `version`
//      odpiętych `mealSlots`/`shoppingItems` ani ich nie zwraca, więc klient musi sam
//      optymistycznie odpiąć `recipeId`/`sourceRecipeId` lokalnie (wzór `deleteTrip`).
//
// Ten plik trzyma WYŁĄCZNIE stan i akcje domenowe (optymistyczne mutacje lokalne + kolejka
// `pendingMutations`). Nie wie nic o sieci — silnik synchronizacji (src/hooks/useMealsSync.ts,
// src/server/MealsSync.tsx) obserwuje ten store z zewnątrz (`useMealsStore.subscribe`) i
// odpowiada za GET/POST, dokładnie jak TripsSync robi to dla Podróży.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { generateId as makeId } from "../lib/id";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import { mealSlotSchema, recipeSchema, shoppingItemSchema } from "../lib/schema";
import type { MealSlot, Recipe, ShoppingItem } from "../mealsTypes";

const STORAGE_NAME = "puls-meals";

export type MealOp =
  | "recipe.create"
  | "recipe.update"
  | "recipe.delete"
  | "meal.create"
  | "meal.update"
  | "meal.delete"
  | "shopping.create"
  | "shopping.update"
  | "shopping.delete";

export interface PendingMealMutation {
  idempotencyKey: string;
  op: MealOp;
  payload: Record<string, unknown>;
  baseVersion?: number;
}

export interface MealMutationResult {
  idempotencyKey: string;
  status: "applied" | "duplicate" | "conflict" | "error";
  record?: unknown;
  currentVersion?: number;
  error?: string;
  code?: string;
}

export interface MealsSnapshot {
  recipes: Recipe[];
  mealSlots: MealSlot[];
  shoppingItems: ShoppingItem[];
  serverAt: string;
}

// Pola edytowalne przez `*.update` — muszą być 1:1 zgodne z *_UPDATE_KEYS w server/src/meals.mjs.
const RECIPE_UPDATE_KEYS = [
  "name",
  "minutes",
  "servings",
  "tags",
  "ingredients",
  "favorite",
] as const;
const MEAL_UPDATE_KEYS = ["recipeId", "title", "servings", "date", "type"] as const;
const SHOPPING_UPDATE_KEYS = ["checked", "name", "quantity", "category", "assignedTo"] as const;

function pickChanges<T extends Record<string, unknown>>(
  source: T,
  keys: readonly string[],
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) changes[key] = source[key];
  }
  return changes;
}

// `recipeId` (meal) może być jawnie odpięty przez `null` — odróżnione od "nie zmieniaj"
// (pominięcie klucza). Skoro modal posiłku w MealsPage.tsx buduje ZAWSZE pełny obiekt zmian
// (nie deltę), obecność klucza jest tu traktowana jako intencja "odepnij".
function pickMealChanges(changes: Partial<MealSlot>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of MEAL_UPDATE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
    if (key === "recipeId") {
      out.recipeId = changes.recipeId ?? null;
    } else {
      out[key] = (changes as Record<string, unknown>)[key];
    }
  }
  return out;
}

// `assignedTo` (shopping) może być jawnie wyczyszczony przez `null`, tak samo jak `recipeId`.
function pickShoppingChanges(changes: Partial<ShoppingItem>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SHOPPING_UPDATE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
    if (key === "assignedTo") {
      out.assignedTo = changes.assignedTo ?? null;
    } else {
      out[key] = (changes as Record<string, unknown>)[key];
    }
  }
  return out;
}

function isUpdateOp(op: MealOp): op is "recipe.update" | "meal.update" | "shopping.update" {
  return op === "recipe.update" || op === "meal.update" || op === "shopping.update";
}

function upsertById<T extends { id: string }>(list: T[], record: T): T[] {
  const index = list.findIndex((item) => item.id === record.id);
  if (index === -1) return [record, ...list];
  const next = list.slice();
  next[index] = record;
  return next;
}

function removeById<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter((item) => item.id !== id);
}

interface Collections {
  recipes: Recipe[];
  mealSlots: MealSlot[];
  shoppingItems: ShoppingItem[];
}

// Rebase konfliktu update: przyjmij świeży rekord serwera jako bazę i reaplikuj TYLKO deltę,
// którą ta mutacja próbowała zapisać (wzór: upsertByUpdateOp w useTripsStore.ts).
function upsertByUpdateOp(op: MealOp, record: unknown, collections: Collections): Collections {
  switch (op) {
    case "recipe.update":
      return { ...collections, recipes: upsertById(collections.recipes, record as Recipe) };
    case "meal.update":
      return { ...collections, mealSlots: upsertById(collections.mealSlots, record as MealSlot) };
    case "shopping.update":
      return {
        ...collections,
        shoppingItems: upsertById(collections.shoppingItems, record as ShoppingItem),
      };
    default:
      return collections;
  }
}

// Rozliczenie wyniku terminalnego (applied/duplicate, oraz conflict na *.create — id kolizja).
// Meals nie ma pola agregującego (brak odpowiednika `trip`), więc — w odróżnieniu od Podróży —
// wystarczy zaadoptować `result.record`.
function reconcileTerminal(
  mutation: PendingMealMutation,
  result: MealMutationResult,
  collections: Collections,
): Collections {
  let { recipes, mealSlots, shoppingItems } = collections;
  const payload = mutation.payload as { id?: string };
  switch (mutation.op) {
    case "recipe.create":
    case "recipe.update":
      if (result.record) recipes = upsertById(recipes, result.record as Recipe);
      break;
    case "recipe.delete":
      recipes = removeById(recipes, String(payload.id));
      break;
    case "meal.create":
    case "meal.update":
      if (result.record) mealSlots = upsertById(mealSlots, result.record as MealSlot);
      break;
    case "meal.delete":
      mealSlots = removeById(mealSlots, String(payload.id));
      break;
    case "shopping.create":
    case "shopping.update":
      if (result.record) shoppingItems = upsertById(shoppingItems, result.record as ShoppingItem);
      break;
    case "shopping.delete":
      shoppingItems = removeById(shoppingItems, String(payload.id));
      break;
  }
  return { recipes, mealSlots, shoppingItems };
}

interface MealsState {
  recipes: Recipe[];
  mealSlots: MealSlot[];
  shoppingItems: ShoppingItem[];
  pendingMutations: PendingMealMutation[];
  serverAt: string | null;
  hydrated: boolean;
}

interface MealsActions {
  addRecipe: (recipe: Omit<Recipe, "id" | "updatedAt" | "version">) => string;
  updateRecipe: (recipeId: string, changes: Partial<Recipe>) => void;
  toggleRecipeFavorite: (recipeId: string) => void;
  deleteRecipe: (recipeId: string) => void;
  setMealSlot: (slot: Omit<MealSlot, "id" | "updatedAt" | "version"> & { id?: string }) => void;
  deleteMealSlot: (slotId: string) => void;
  addShoppingItem: (item: Omit<ShoppingItem, "id" | "updatedAt" | "version">) => void;
  toggleShoppingItem: (itemId: string) => void;
  updateShoppingItem: (itemId: string, changes: Partial<ShoppingItem>) => void;
  removeShoppingItem: (itemId: string) => void;
  clearCheckedShoppingItems: () => number;
  addRecipeIngredientsToShopping: (recipeId: string) => number;
  hydrateFromSnapshot: (snapshot: MealsSnapshot) => void;
  applyMutationResults: (results: MealMutationResult[]) => void;
  resetMealsData: () => void;
}

export type MealsStore = MealsState & MealsActions;

function emptyState(): MealsState {
  return {
    recipes: [],
    mealSlots: [],
    shoppingItems: [],
    pendingMutations: [],
    serverAt: null,
    hydrated: false,
  };
}

const mealOpSchema = z.enum([
  "recipe.create",
  "recipe.update",
  "recipe.delete",
  "meal.create",
  "meal.update",
  "meal.delete",
  "shopping.create",
  "shopping.update",
  "shopping.delete",
]);
const pendingMutationSchema = z.object({
  idempotencyKey: z.string().min(1),
  op: mealOpSchema,
  payload: z.record(z.string(), z.unknown()),
  baseVersion: z.number().int().min(1).optional(),
});

function parseArrayField<T>(value: unknown, schema: z.ZodType<T>): { items: T[]; dropped: number } {
  if (value === undefined) return { items: [], dropped: 0 };
  if (!Array.isArray(value)) return { items: [], dropped: 1 };
  let dropped = 0;
  const items: T[] = [];
  for (const raw of value) {
    const result = schema.safeParse(raw);
    if (result.success) items.push(result.data);
    else dropped += 1;
  }
  return { items, dropped };
}

export const useMealsStore = create<MealsStore>()(
  persist(
    (set, get) => ({
      ...emptyState(),

      addRecipe: (recipe) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: Recipe = { ...recipe, id, version: 1, updatedAt };
        set((state) => ({
          recipes: [record, ...state.recipes],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "recipe.create", payload: { id, ...recipe } },
          ],
        }));
        return id;
      },

      updateRecipe: (recipeId, changes) => {
        const existing = get().recipes.find((recipe) => recipe.id === recipeId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        set((state) => {
          const nextRecipe: Recipe = { ...existing, ...changes, updatedAt };
          // Kaskada rename tytułu slotu (plan "Podejście" → "Kaskada rename tytułu slotu przy
          // edycji przepisu"): sloty, których recipeId === ten przepis I title === stara nazwa,
          // dostają nowy tytuł — lokalnie oraz jako seria meal.update.
          const renameName =
            changes.name !== undefined && changes.name !== existing.name ? changes.name : null;
          const affectedSlots = renameName
            ? state.mealSlots.filter(
                (slot) => slot.recipeId === recipeId && slot.title === existing.name,
              )
            : [];
          const mealSlots = renameName
            ? state.mealSlots.map((slot) =>
                slot.recipeId === recipeId && slot.title === existing.name
                  ? { ...slot, title: renameName, updatedAt }
                  : slot,
              )
            : state.mealSlots;
          const slotMutations = affectedSlots.map((slot) => ({
            idempotencyKey: makeId(),
            op: "meal.update" as const,
            payload: { id: slot.id, changes: { title: renameName } },
            baseVersion: slot.version,
          }));
          return {
            recipes: upsertById(state.recipes, nextRecipe),
            mealSlots,
            pendingMutations: [
              ...state.pendingMutations,
              {
                idempotencyKey: makeId(),
                op: "recipe.update",
                payload: { id: recipeId, changes: pickChanges(changes, RECIPE_UPDATE_KEYS) },
                baseVersion: existing.version,
              },
              ...slotMutations,
            ],
          };
        });
      },

      toggleRecipeFavorite: (recipeId) => {
        const existing = get().recipes.find((recipe) => recipe.id === recipeId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const nextFavorite = !existing.favorite;
        set((state) => ({
          recipes: state.recipes.map((recipe) =>
            recipe.id === recipeId ? { ...recipe, favorite: nextFavorite, updatedAt } : recipe,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "recipe.update",
              payload: { id: recipeId, changes: { favorite: nextFavorite } },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      deleteRecipe: (recipeId) => {
        set((state) => ({
          recipes: state.recipes.filter((recipe) => recipe.id !== recipeId),
          // Serwer odpina dzieci przez FK ON DELETE SET NULL (bez bumpowania ich version) --
          // odbijamy to lokalnie od razu, wzór deleteTrip w useTripsStore.ts, ale bez kasowania.
          mealSlots: state.mealSlots.map((slot) =>
            slot.recipeId === recipeId ? { ...slot, recipeId: undefined } : slot,
          ),
          shoppingItems: state.shoppingItems.map((item) =>
            item.sourceRecipeId === recipeId ? { ...item, sourceRecipeId: undefined } : item,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "recipe.delete", payload: { id: recipeId } },
          ],
        }));
      },

      setMealSlot: (slot) => {
        set((state) => {
          const existing = state.mealSlots.find(
            (item) => item.id === slot.id || (item.date === slot.date && item.type === slot.type),
          );
          const updatedAt = new Date().toISOString();
          if (existing) {
            const nextSlot: MealSlot = { ...existing, ...slot, id: existing.id, updatedAt };
            return {
              mealSlots: upsertById(state.mealSlots, nextSlot),
              pendingMutations: [
                ...state.pendingMutations,
                {
                  idempotencyKey: makeId(),
                  op: "meal.update",
                  payload: {
                    id: existing.id,
                    changes: pickMealChanges({
                      date: slot.date,
                      type: slot.type,
                      recipeId: slot.recipeId,
                      title: slot.title,
                      servings: slot.servings,
                    }),
                  },
                  baseVersion: existing.version,
                },
              ],
            };
          }
          const id = makeId();
          const record: MealSlot = { ...slot, id, version: 1, updatedAt };
          return {
            mealSlots: [...state.mealSlots, record],
            pendingMutations: [
              ...state.pendingMutations,
              {
                idempotencyKey: makeId(),
                op: "meal.create",
                payload: {
                  id,
                  date: slot.date,
                  type: slot.type,
                  recipeId: slot.recipeId,
                  title: slot.title,
                  servings: slot.servings,
                },
              },
            ],
          };
        });
      },

      deleteMealSlot: (slotId) => {
        set((state) => ({
          mealSlots: state.mealSlots.filter((slot) => slot.id !== slotId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "meal.delete", payload: { id: slotId } },
          ],
        }));
      },

      addShoppingItem: (item) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        set((state) => ({
          shoppingItems: [...state.shoppingItems, { ...item, id, version: 1, updatedAt }],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "shopping.create", payload: { id, ...item } },
          ],
        }));
      },

      toggleShoppingItem: (itemId) => {
        const existing = get().shoppingItems.find((item) => item.id === itemId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const nextChecked = !existing.checked;
        set((state) => ({
          shoppingItems: state.shoppingItems.map((item) =>
            item.id === itemId ? { ...item, checked: nextChecked, updatedAt } : item,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "shopping.update",
              payload: { id: itemId, changes: { checked: nextChecked } },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      updateShoppingItem: (itemId, changes) => {
        const existing = get().shoppingItems.find((item) => item.id === itemId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        set((state) => ({
          shoppingItems: state.shoppingItems.map((item) =>
            item.id === itemId ? { ...item, ...changes, updatedAt } : item,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "shopping.update",
              payload: { id: itemId, changes: pickShoppingChanges(changes) },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      removeShoppingItem: (itemId) => {
        set((state) => ({
          shoppingItems: state.shoppingItems.filter((item) => item.id !== itemId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "shopping.delete", payload: { id: itemId } },
          ],
        }));
      },

      clearCheckedShoppingItems: () => {
        const checked = get().shoppingItems.filter((item) => item.checked);
        if (!checked.length) return 0;
        set((state) => ({
          shoppingItems: state.shoppingItems.filter((item) => !item.checked),
          pendingMutations: [
            ...state.pendingMutations,
            ...checked.map((item) => ({
              idempotencyKey: makeId(),
              op: "shopping.delete" as const,
              payload: { id: item.id },
            })),
          ],
        }));
        return checked.length;
      },

      addRecipeIngredientsToShopping: (recipeId) => {
        const recipe = get().recipes.find((item) => item.id === recipeId);
        if (!recipe) return 0;
        const normalize = (value: string) => value.trim().toLocaleLowerCase("pl");
        const seen = new Set(get().shoppingItems.map((item) => normalize(item.name)));
        const additions = recipe.ingredients
          .map((ingredient) => {
            const match = ingredient.match(/^(.+?)\s+(\d.*)$/);
            return {
              name: (match?.[1] ?? ingredient).trim(),
              quantity: (match?.[2] ?? "1 szt.").trim(),
            };
          })
          .filter((ingredient) => {
            const key = normalize(ingredient.name);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((ingredient) => ({
            ...ingredient,
            id: makeId(),
            category: "Z przepisu",
            checked: false,
            sourceRecipeId: recipeId,
          }));
        if (!additions.length) return 0;
        const updatedAt = new Date().toISOString();
        set((state) => ({
          shoppingItems: [
            ...state.shoppingItems,
            ...additions.map((addition) => ({ ...addition, version: 1, updatedAt })),
          ],
          pendingMutations: [
            ...state.pendingMutations,
            ...additions.map((addition) => ({
              idempotencyKey: makeId(),
              op: "shopping.create" as const,
              payload: { ...addition },
            })),
          ],
        }));
        return additions.length;
      },

      hydrateFromSnapshot: (snapshot) => {
        // Nie nadpisuj lokalnego stanu, dopóki w kolejce są niewysłane mutacje — silnik sync
        // (useMealsSync) i tak wywołuje to tylko, gdy pendingMutations jest puste, ale ten guard
        // zostaje na wypadek błędu wywołania.
        if (get().pendingMutations.length > 0) return;
        try {
          set({
            recipes: z.array(recipeSchema).parse(snapshot.recipes),
            mealSlots: z.array(mealSlotSchema).parse(snapshot.mealSlots),
            shoppingItems: z.array(shoppingItemSchema).parse(snapshot.shoppingItems),
            serverAt: snapshot.serverAt,
            hydrated: true,
          });
        } catch {
          reportStorageWarning("Nie udało się przetworzyć danych posiłków z serwera");
          set({ hydrated: true });
        }
      },

      applyMutationResults: (results) => {
        set((state) => {
          const resultByKey = new Map(results.map((result) => [result.idempotencyKey, result]));
          let collections: Collections = {
            recipes: state.recipes,
            mealSlots: state.mealSlots,
            shoppingItems: state.shoppingItems,
          };
          const remaining: PendingMealMutation[] = [];
          const rebased: PendingMealMutation[] = [];

          for (const mutation of state.pendingMutations) {
            const result = resultByKey.get(mutation.idempotencyKey);
            if (!result) {
              // Mutacja dołączona do kolejki już PO wysłaniu tego batcha — poczekaj na kolejny.
              remaining.push(mutation);
              continue;
            }

            if (result.status === "error") {
              // Trwałe odrzucenie (np. RECIPE_NOT_FOUND, NOT_FOUND) — zdejmij z kolejki, nie
              // retry'uj w nieskończoność (parytet z Podróżami/Finansami).
              continue;
            }

            if (result.status === "conflict" && isUpdateOp(mutation.op)) {
              // Cichy rebase: przyjmij świeży rekord serwera jako bazę i reaplikuj TYLKO deltę,
              // którą ta mutacja próbowała zapisać, z nowym idempotencyKey.
              const freshRecord = result.record as Record<string, unknown> | undefined;
              const currentVersion = result.currentVersion;
              if (!freshRecord || currentVersion === undefined) continue;
              const payload = mutation.payload as { id: string; changes: Record<string, unknown> };
              collections = upsertByUpdateOp(
                mutation.op,
                { ...freshRecord, ...payload.changes },
                collections,
              );
              rebased.push({
                idempotencyKey: makeId(),
                op: mutation.op,
                payload: { id: payload.id, changes: payload.changes },
                baseVersion: currentVersion,
              });
              continue;
            }

            // applied / duplicate / conflict na *.create (id już istnieje i jest widoczny —
            // zaadoptuj zwrócony rekord tak samo jak przy sukcesie).
            collections = reconcileTerminal(mutation, result, collections);
          }

          return { ...collections, pendingMutations: [...remaining, ...rebased] };
        });
      },

      resetMealsData: () => set(emptyState()),
    }),
    {
      name: STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      // `hydrated` jest znacznikiem sesji bieżącego montowania silnika sync, nie danymi trwałymi —
      // każdy świeży start strony powinien znów przejść przez hydratację z serwera.
      partialize: (state) => ({
        recipes: state.recipes,
        mealSlots: state.mealSlots,
        shoppingItems: state.shoppingItems,
        pendingMutations: state.pendingMutations,
        serverAt: state.serverAt,
      }),
      merge: (persistedState, currentState) => {
        // `persistedState` jest `undefined` na czystej instalacji (localStorage nigdy nie miał
        // tego klucza) -- persist middleware zustanda wywołuje `merge` bezwarunkowo, nawet gdy nie
        // było nic do deserializacji. To normalny pierwszy start, nie uszkodzenie danych, więc musi
        // pozostać ciche; tylko realnie obecna, ale niepoprawna wartość jest prawdziwym ostrzeżeniem
        // "niezgodny format" (patrz useTripsStore.ts -- ta sama luka #3 ze Statusu Finansów).
        if (persistedState === undefined) return currentState;
        if (persistedState === null || typeof persistedState !== "object") {
          reportStorageWarning(
            "Zapis posiłków miał niezgodny format — zachowano bezpieczne dane startowe",
          );
          return currentState;
        }
        const state = persistedState as Record<string, unknown>;
        const recipes = parseArrayField(state.recipes, recipeSchema);
        const mealSlots = parseArrayField(state.mealSlots, mealSlotSchema);
        const shoppingItems = parseArrayField(state.shoppingItems, shoppingItemSchema);
        const pendingMutations = parseArrayField(state.pendingMutations, pendingMutationSchema);
        const droppedCount =
          recipes.dropped + mealSlots.dropped + shoppingItems.dropped + pendingMutations.dropped;

        if (droppedCount > 0) {
          reportStorageWarning(
            "Część zapisanych danych posiłków była uszkodzona i została pominięta — pozostałe pozycje zostały zachowane",
          );
          quarantineRawValue(STORAGE_NAME, JSON.stringify(persistedState));
        }

        return {
          ...currentState,
          recipes: recipes.items,
          mealSlots: mealSlots.items,
          shoppingItems: shoppingItems.items,
          pendingMutations: pendingMutations.items as PendingMealMutation[],
          serverAt: typeof state.serverAt === "string" ? state.serverAt : null,
        };
      },
    },
  ),
);

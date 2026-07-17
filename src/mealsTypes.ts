// Typy modułu Posiłki (Meals). Od docs/plans/lista-zakupow-meals.md dane posiłków
// (recipes/mealSlots/shoppingItems) nie są już częścią dokumentu JSONB (AdvancedData) — mają
// własne znormalizowane tabele SQL (server/migrations/008_meals_normalized.sql) z optymistyczną
// współbieżnością per rekord (pole `version`). Ten plik jest wspólnym źródłem prawdy dla
// backendu i frontendu Posiłków (wzór: src/tripsTypes.ts / src/financeTypes.ts).
//
// Tak jak Podróże, Meals NIE MAJĄ `ownerId`/`visibility` — wszystkie trzy kolekcje są zawsze
// wspólne dla gospodarstwa (decyzja użytkownika, patrz plan "Decyzje ustalone z góry" #5), więc
// `Recipe` przestaje rozszerzać `SharedMeta` (w odróżnieniu od dzisiejszego stanu w
// `advancedTypes.ts`, gdzie miał aktywny selektor prywatności).

export interface Recipe {
  id: string;
  name: string;
  minutes: number;
  servings: number;
  tags: string[];
  ingredients: string[];
  favorite: boolean;
  version: number;
  updatedAt: string;
}

export interface MealSlot {
  id: string;
  date: string;
  type: "breakfast" | "lunch" | "dinner";
  recipeId?: string;
  title: string;
  servings: number;
  version: number;
  updatedAt: string;
}

export interface ShoppingItem {
  id: string;
  name: string;
  quantity: string;
  category: string;
  checked: boolean;
  assignedTo?: string;
  sourceRecipeId?: string;
  version: number;
  updatedAt: string;
}

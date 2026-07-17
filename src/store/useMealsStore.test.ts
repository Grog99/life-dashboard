import { beforeEach, describe, expect, it } from "vitest";
import { useMealsStore, type MealMutationResult } from "./useMealsStore";

function seedRecipe(overrides: Partial<ReturnType<typeof recipe>> = {}) {
  useMealsStore.setState({
    recipes: [recipe(overrides)],
  });
}

function recipe(overrides: Record<string, unknown> = {}) {
  return {
    id: "recipe-1",
    name: "Naleśniki",
    minutes: 20,
    servings: 4,
    tags: ["śniadanie"],
    ingredients: ["mąka 200g", "mleko 300ml", "jajko 2 szt."],
    favorite: false,
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("useMealsStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useMealsStore.setState({
      recipes: [],
      mealSlots: [],
      shoppingItems: [],
      pendingMutations: [],
      serverAt: null,
      hydrated: false,
    });
  });

  it("addRecipe dodaje przepis optymistycznie i kolejkuje mutację recipe.create bez baseVersion", () => {
    const id = useMealsStore.getState().addRecipe({
      name: "Naleśniki",
      minutes: 20,
      servings: 4,
      tags: [],
      ingredients: [],
      favorite: false,
    });

    const created = useMealsStore.getState().recipes.find((item) => item.id === id);
    expect(created).toMatchObject({ name: "Naleśniki", version: 1 });

    const mutation = useMealsStore.getState().pendingMutations[0];
    expect(mutation.op).toBe("recipe.create");
    expect(mutation.baseVersion).toBeUndefined();
    expect(mutation.payload).toMatchObject({ id, name: "Naleśniki" });
  });

  it("addShoppingItem dodaje pozycję optymistycznie i kolejkuje mutację shopping.create", () => {
    useMealsStore.getState().addShoppingItem({
      name: "Mleko",
      quantity: "1L",
      category: "Nabiał",
      checked: false,
    });

    expect(useMealsStore.getState().shoppingItems).toHaveLength(1);
    expect(useMealsStore.getState().shoppingItems[0]).toMatchObject({ name: "Mleko", version: 1 });
    const mutation = useMealsStore.getState().pendingMutations[0];
    expect(mutation.op).toBe("shopping.create");
    expect(mutation.payload).toMatchObject({ name: "Mleko" });
  });

  it("setMealSlot na nowy (date,type) tworzy slot i kolejkuje meal.create", () => {
    useMealsStore.getState().setMealSlot({
      date: "2026-08-01",
      type: "lunch",
      title: "Obiad",
      servings: 2,
    });

    expect(useMealsStore.getState().mealSlots).toHaveLength(1);
    const mutation = useMealsStore.getState().pendingMutations[0];
    expect(mutation.op).toBe("meal.create");
    expect(mutation.baseVersion).toBeUndefined();
  });

  it("setMealSlot na istniejący (date,type) robi upsert -- aktualizuje ten sam slot zamiast tworzyć duplikat", () => {
    useMealsStore.setState({
      mealSlots: [
        {
          id: "slot-1",
          date: "2026-08-01",
          type: "lunch",
          title: "Stary obiad",
          servings: 2,
          version: 3,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    useMealsStore.getState().setMealSlot({
      date: "2026-08-01",
      type: "lunch",
      title: "Nowy obiad",
      servings: 3,
    });

    // Nie ma duplikatu -- dokładnie jeden slot dla tego (date,type), z tym samym id.
    expect(useMealsStore.getState().mealSlots).toHaveLength(1);
    expect(useMealsStore.getState().mealSlots[0]).toMatchObject({
      id: "slot-1",
      title: "Nowy obiad",
      servings: 3,
    });

    // Emitowana mutacja to meal.update (nie create), niesie baseVersion bieżącego rekordu.
    const mutation = useMealsStore.getState().pendingMutations[0];
    expect(mutation.op).toBe("meal.update");
    expect(mutation.baseVersion).toBe(3);
    expect(mutation.payload).toMatchObject({
      id: "slot-1",
      changes: { title: "Nowy obiad", servings: 3 },
    });
  });

  it("setMealSlot znajduje slot także po id (edycja istniejącego slotu wprost)", () => {
    useMealsStore.setState({
      mealSlots: [
        {
          id: "slot-1",
          date: "2026-08-01",
          type: "lunch",
          title: "Obiad",
          servings: 2,
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    useMealsStore.getState().setMealSlot({
      id: "slot-1",
      date: "2026-08-02",
      type: "dinner",
      title: "Kolacja",
      servings: 2,
    });

    expect(useMealsStore.getState().mealSlots).toHaveLength(1);
    expect(useMealsStore.getState().mealSlots[0]).toMatchObject({ id: "slot-1", title: "Kolacja" });
  });

  it("updateRecipe/toggleRecipeFavorite/updateShoppingItem/deleteMealSlot/removeShoppingItem niosą baseVersion bieżącego rekordu", () => {
    seedRecipe({ version: 5 });
    useMealsStore.setState({
      shoppingItems: [
        {
          id: "item-1",
          name: "Mleko",
          quantity: "1L",
          category: "Nabiał",
          checked: false,
          version: 2,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      mealSlots: [
        {
          id: "slot-1",
          date: "2026-08-01",
          type: "lunch",
          title: "Obiad",
          servings: 2,
          version: 4,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    useMealsStore.getState().toggleRecipeFavorite("recipe-1");
    expect(useMealsStore.getState().pendingMutations[0]).toMatchObject({
      op: "recipe.update",
      baseVersion: 5,
      payload: { id: "recipe-1", changes: { favorite: true } },
    });

    useMealsStore.getState().updateShoppingItem("item-1", { checked: true });
    expect(useMealsStore.getState().pendingMutations[1]).toMatchObject({
      op: "shopping.update",
      baseVersion: 2,
      payload: { id: "item-1", changes: { checked: true } },
    });

    useMealsStore.getState().deleteMealSlot("slot-1");
    expect(useMealsStore.getState().pendingMutations[2]).toMatchObject({
      op: "meal.delete",
      payload: { id: "slot-1" },
    });
    expect(useMealsStore.getState().mealSlots).toHaveLength(0);

    useMealsStore.getState().removeShoppingItem("item-1");
    expect(useMealsStore.getState().pendingMutations[3]).toMatchObject({
      op: "shopping.delete",
      payload: { id: "item-1" },
    });
    expect(useMealsStore.getState().shoppingItems).toHaveLength(0);
  });

  it(
    "deleteRecipe usuwa przepis lokalnie ORAZ optymistycznie odpina recipeId/sourceRecipeId dzieci " +
      "(odbicie serwerowego ON DELETE SET NULL)",
    () => {
      seedRecipe();
      useMealsStore.setState({
        mealSlots: [
          {
            id: "slot-1",
            date: "2026-08-01",
            type: "lunch",
            recipeId: "recipe-1",
            title: "Naleśniki",
            servings: 2,
            version: 1,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "slot-2",
            date: "2026-08-02",
            type: "dinner",
            recipeId: "other-recipe",
            title: "Coś innego",
            servings: 2,
            version: 1,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        shoppingItems: [
          {
            id: "item-1",
            name: "Mąka",
            quantity: "200g",
            category: "Z przepisu",
            checked: false,
            sourceRecipeId: "recipe-1",
            version: 1,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      useMealsStore.getState().deleteRecipe("recipe-1");

      expect(useMealsStore.getState().recipes).toHaveLength(0);
      // Slot linked to the deleted recipe is unlinked, not removed.
      const slots = useMealsStore.getState().mealSlots;
      expect(slots).toHaveLength(2);
      expect(slots.find((slot) => slot.id === "slot-1")?.recipeId).toBeUndefined();
      // Unrelated slot is untouched.
      expect(slots.find((slot) => slot.id === "slot-2")?.recipeId).toBe("other-recipe");
      const items = useMealsStore.getState().shoppingItems;
      expect(items[0].sourceRecipeId).toBeUndefined();

      const mutation = useMealsStore.getState().pendingMutations[0];
      expect(mutation).toMatchObject({ op: "recipe.delete", payload: { id: "recipe-1" } });
    },
  );

  it("updateRecipe zmieniający name kaskaduje title slotów, których title === stara nazwa I recipeId pasuje", () => {
    seedRecipe({ name: "Stara nazwa" });
    useMealsStore.setState({
      mealSlots: [
        {
          id: "slot-match",
          date: "2026-08-01",
          type: "lunch",
          recipeId: "recipe-1",
          title: "Stara nazwa",
          servings: 2,
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "slot-renamed-by-user",
          date: "2026-08-02",
          type: "dinner",
          recipeId: "recipe-1",
          title: "Zmieniony ręcznie tytuł",
          servings: 2,
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    useMealsStore.getState().updateRecipe("recipe-1", { name: "Nowa nazwa" });

    const slots = useMealsStore.getState().mealSlots;
    expect(slots.find((slot) => slot.id === "slot-match")?.title).toBe("Nowa nazwa");
    // The slot whose title diverged from the recipe name is left alone (today's heuristic).
    expect(slots.find((slot) => slot.id === "slot-renamed-by-user")?.title).toBe(
      "Zmieniony ręcznie tytuł",
    );

    const mutations = useMealsStore.getState().pendingMutations;
    expect(mutations).toHaveLength(2); // recipe.update + one cascaded meal.update
    expect(mutations[0].op).toBe("recipe.update");
    const cascaded = mutations[1];
    expect(cascaded).toMatchObject({
      op: "meal.update",
      baseVersion: 1,
      payload: { id: "slot-match", changes: { title: "Nowa nazwa" } },
    });
  });

  it("addRecipeIngredientsToShopping deduplikuje po znormalizowanej nazwie względem bieżącej listy", () => {
    seedRecipe({
      ingredients: ["Mąka 200g", "Mleko 300ml", "Jajko 2 szt."],
    });
    useMealsStore.setState({
      shoppingItems: [
        {
          id: "existing-1",
          name: "mąka", // same ingredient, different case/whitespace -- should be treated as a dup
          quantity: "500g",
          category: "Nabiał",
          checked: false,
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const added = useMealsStore.getState().addRecipeIngredientsToShopping("recipe-1");

    // "Mąka" is deduped against the existing "mąka" entry; "Mleko" and "Jajko" are new.
    expect(added).toBe(2);
    const names = useMealsStore
      .getState()
      .shoppingItems.map((item) => item.name)
      .sort();
    expect(names).toEqual(["Jajko", "Mleko", "mąka"]);
    expect(
      useMealsStore
        .getState()
        .shoppingItems.every(
          (item) => item.category === "Nabiał" || item.category === "Z przepisu",
        ),
    ).toBe(true);

    const createMutations = useMealsStore
      .getState()
      .pendingMutations.filter((mutation) => mutation.op === "shopping.create");
    expect(createMutations).toHaveLength(2);
    for (const mutation of createMutations) {
      expect(mutation.payload).toMatchObject({
        sourceRecipeId: "recipe-1",
        category: "Z przepisu",
      });
    }
  });

  it("addRecipeIngredientsToShopping zwraca 0 i nie kolejkuje niczego, gdy wszystko już jest na liście", () => {
    seedRecipe({ ingredients: ["Mąka 200g"] });
    useMealsStore.setState({
      shoppingItems: [
        {
          id: "existing-1",
          name: "Mąka",
          quantity: "1kg",
          category: "Z przepisu",
          checked: false,
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const before = useMealsStore.getState().pendingMutations.length;
    const added = useMealsStore.getState().addRecipeIngredientsToShopping("recipe-1");
    expect(added).toBe(0);
    expect(useMealsStore.getState().shoppingItems).toHaveLength(1);
    expect(useMealsStore.getState().pendingMutations.length).toBe(before);
  });

  it("clearCheckedShoppingItems usuwa wyłącznie odhaczone pozycje jako seria shopping.delete", () => {
    useMealsStore.setState({
      shoppingItems: [
        {
          id: "item-checked",
          name: "Mleko",
          quantity: "1L",
          category: "Nabiał",
          checked: true,
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "item-unchecked",
          name: "Chleb",
          quantity: "1 szt.",
          category: "Pieczywo",
          checked: false,
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const removed = useMealsStore.getState().clearCheckedShoppingItems();
    expect(removed).toBe(1);
    expect(useMealsStore.getState().shoppingItems).toHaveLength(1);
    expect(useMealsStore.getState().shoppingItems[0].id).toBe("item-unchecked");
    const mutation = useMealsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "shopping.delete", payload: { id: "item-checked" } });
  });

  it("applyMutationResults zdejmuje z kolejki mutacje applied/duplicate w kolejności i adoptuje autorytatywny rekord", () => {
    const id = useMealsStore.getState().addRecipe({
      name: "Naleśniki",
      minutes: 20,
      servings: 4,
      tags: [],
      ingredients: [],
      favorite: false,
    });
    const mutation = useMealsStore.getState().pendingMutations[0];
    const results: MealMutationResult[] = [
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "applied",
        record: {
          id,
          name: "Naleśniki",
          minutes: 20,
          servings: 4,
          tags: [],
          ingredients: [],
          favorite: false,
          version: 1,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    ];
    useMealsStore.getState().applyMutationResults(results);
    expect(useMealsStore.getState().pendingMutations).toHaveLength(0);
    expect(useMealsStore.getState().recipes[0]).toMatchObject({
      version: 1,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("applyMutationResults zachowuje kolejność -- kolejne mutacje z tej samej rundy zdejmowane są niezależnie od pozycji", () => {
    useMealsStore.getState().addRecipe({
      name: "A",
      minutes: 10,
      servings: 1,
      tags: [],
      ingredients: [],
      favorite: false,
    });
    useMealsStore.getState().addRecipe({
      name: "B",
      minutes: 10,
      servings: 1,
      tags: [],
      ingredients: [],
      favorite: false,
    });
    const [first, second] = useMealsStore.getState().pendingMutations;
    expect(useMealsStore.getState().pendingMutations).toHaveLength(2);

    // Only the second mutation's result comes back this round -- the first should remain queued.
    useMealsStore.getState().applyMutationResults([
      {
        idempotencyKey: second.idempotencyKey,
        status: "applied",
        record: {
          id: (second.payload as { id: string }).id,
          name: "B",
          minutes: 10,
          servings: 1,
          tags: [],
          ingredients: [],
          favorite: false,
          version: 1,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    ]);

    const remaining = useMealsStore.getState().pendingMutations;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].idempotencyKey).toBe(first.idempotencyKey);
  });

  it("applyMutationResults zdejmuje z kolejki trwałe błędy (error) bez ponawiania", () => {
    useMealsStore.getState().addShoppingItem({
      name: "Mleko",
      quantity: "1L",
      category: "Nabiał",
      checked: false,
      sourceRecipeId: "does-not-exist",
    });
    const mutation = useMealsStore.getState().pendingMutations[0];
    useMealsStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "error",
        error: "Przepis nie istnieje",
        code: "RECIPE_NOT_FOUND",
      },
    ]);
    expect(useMealsStore.getState().pendingMutations).toHaveLength(0);
  });

  it("applyMutationResults na conflict robi cichy rebase: nowy idempotencyKey, świeży baseVersion, reaplikowana delta", () => {
    useMealsStore.setState({
      shoppingItems: [
        {
          id: "item-1",
          name: "Mleko",
          quantity: "1L",
          category: "Nabiał",
          checked: false,
          version: 3,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    useMealsStore.getState().updateShoppingItem("item-1", { checked: true });
    const originalMutation = useMealsStore.getState().pendingMutations[0];
    expect(originalMutation.baseVersion).toBe(3);

    useMealsStore.getState().applyMutationResults([
      {
        idempotencyKey: originalMutation.idempotencyKey,
        status: "conflict",
        currentVersion: 4,
        record: {
          id: "item-1",
          name: "Mleko 2%",
          quantity: "1L",
          category: "Nabiał",
          checked: false,
          version: 4,
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
      },
    ]);

    // Local record: name fresh from server, but our delta (checked) still applied.
    expect(useMealsStore.getState().shoppingItems[0]).toMatchObject({
      name: "Mleko 2%",
      checked: true,
      version: 4,
    });

    const rebased = useMealsStore.getState().pendingMutations;
    expect(rebased).toHaveLength(1);
    expect(rebased[0].idempotencyKey).not.toBe(originalMutation.idempotencyKey);
    expect(rebased[0].baseVersion).toBe(4);
    expect(rebased[0].payload).toEqual({ id: "item-1", changes: { checked: true } });
  });

  it("merge nie pokazuje fałszywego ostrzeżenia o uszkodzonych danych na czystej instalacji (persistedState === undefined)", () => {
    const warnings: string[] = [];
    const onWarning = (event: Event) => warnings.push((event as CustomEvent<string>).detail);
    window.addEventListener("puls:storage-warning", onWarning);
    try {
      const merge = useMealsStore.persist.getOptions().merge!;
      const currentState = useMealsStore.getState();
      const merged = merge(undefined, currentState);
      expect(merged).toBe(currentState);
      expect(warnings).toHaveLength(0);

      merge("not-an-object", currentState);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("niezgodny format");
    } finally {
      window.removeEventListener("puls:storage-warning", onWarning);
    }
  });

  it("hydrateFromSnapshot nie nadpisuje stanu, gdy w kolejce są niewysłane mutacje", () => {
    useMealsStore.getState().addRecipe({
      name: "Naleśniki",
      minutes: 20,
      servings: 4,
      tags: [],
      ingredients: [],
      favorite: false,
    });
    expect(useMealsStore.getState().pendingMutations.length).toBeGreaterThan(0);

    useMealsStore.getState().hydrateFromSnapshot({
      recipes: [],
      mealSlots: [],
      shoppingItems: [],
      serverAt: "2026-01-05T00:00:00.000Z",
    });

    // Local optimistic state (and hydrated flag) untouched -- pending queue must drain first.
    expect(useMealsStore.getState().recipes).toHaveLength(1);
    expect(useMealsStore.getState().hydrated).toBe(false);
  });

  it("resetMealsData czyści cały stan i kolejkę", () => {
    seedRecipe();
    useMealsStore.getState().addShoppingItem({
      name: "Mleko",
      quantity: "1L",
      category: "Nabiał",
      checked: false,
    });
    useMealsStore.getState().resetMealsData();
    const state = useMealsStore.getState();
    expect(state.recipes).toHaveLength(0);
    expect(state.mealSlots).toHaveLength(0);
    expect(state.shoppingItems).toHaveLength(0);
    expect(state.pendingMutations).toHaveLength(0);
    expect(state.hydrated).toBe(false);
  });
});

import {
  CalendarDays,
  Check,
  ChefHat,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Heart,
  ListChecks,
  Plus,
  Search,
  ShoppingBasket,
  Sparkles,
  Trash2,
  Users,
  Utensils,
} from "lucide-react";
import { addWeeks, format, isSameDay } from "date-fns";
import { pl } from "date-fns/locale";
import { useMemo, useState, type FormEvent } from "react";
import type { MealSlot, Recipe } from "../mealsTypes";
import { Modal } from "../components/Modal";
import { dateKey, formatDayName, weekDays } from "../lib/date";
import { useMealsStore } from "../store/useMealsStore";
import { useLifeStore } from "../store/useLifeStore";
import "../styles/modules.css";

interface MealsPageProps {
  onToast: (message: string) => void;
}

type MealsTab = "plan" | "recipes" | "shopping";
type MealType = MealSlot["type"];

interface MealDraft {
  date: string;
  type: MealType;
  recipeId: string;
  title: string;
  servings: string;
}

interface RecipeDraft {
  name: string;
  minutes: string;
  servings: string;
  tags: string;
  ingredients: string;
}

const mealLabels: Record<MealType, string> = {
  breakfast: "Śniadanie",
  lunch: "Lunch",
  dinner: "Obiad / kolacja",
};

const newRecipeDraft = (): RecipeDraft => ({
  name: "",
  minutes: "30",
  servings: "2",
  tags: "",
  ingredients: "",
});

export function MealsPage({ onToast }: MealsPageProps) {
  const preferences = useLifeStore((state) => state.preferences);
  const recipes = useMealsStore((state) => state.recipes);
  const mealSlots = useMealsStore((state) => state.mealSlots);
  const shoppingItems = useMealsStore((state) => state.shoppingItems);
  const setMealSlot = useMealsStore((state) => state.setMealSlot);
  const addRecipe = useMealsStore((state) => state.addRecipe);
  const updateRecipe = useMealsStore((state) => state.updateRecipe);
  const toggleRecipeFavorite = useMealsStore((state) => state.toggleRecipeFavorite);
  const deleteRecipe = useMealsStore((state) => state.deleteRecipe);
  const deleteMealSlot = useMealsStore((state) => state.deleteMealSlot);
  const addShoppingItem = useMealsStore((state) => state.addShoppingItem);
  const toggleShoppingItem = useMealsStore((state) => state.toggleShoppingItem);
  const removeShoppingItem = useMealsStore((state) => state.removeShoppingItem);
  const clearCheckedShoppingItems = useMealsStore((state) => state.clearCheckedShoppingItems);
  const addRecipeIngredientsToShopping = useMealsStore(
    (state) => state.addRecipeIngredientsToShopping,
  );

  const [tab, setTab] = useState<MealsTab>("plan");
  const [weekAnchor, setWeekAnchor] = useState(new Date());
  const [mealModalOpen, setMealModalOpen] = useState(false);
  const [mealDraft, setMealDraft] = useState<MealDraft>({
    date: dateKey(),
    type: "dinner",
    recipeId: "",
    title: "",
    servings: "2",
  });
  const [editingSlot, setEditingSlot] = useState<MealSlot | null>(null);
  const [recipeModalOpen, setRecipeModalOpen] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);
  const [recipeDraft, setRecipeDraft] = useState<RecipeDraft>(newRecipeDraft);
  const [recipeSearch, setRecipeSearch] = useState("");
  const [shoppingName, setShoppingName] = useState("");
  const [shoppingQuantity, setShoppingQuantity] = useState("");
  const [shoppingCategory, setShoppingCategory] = useState("Inne");

  const days = weekDays(weekAnchor, preferences.weekStartsOnMonday);
  const defaultPlanDate = days.some((day) => isSameDay(day, new Date()))
    ? dateKey()
    : dateKey(days[0]);
  const visibleDateKeys = new Set(days.map((day) => dateKey(day)));
  const weekSlots = mealSlots.filter((slot) => visibleDateKeys.has(slot.date) && slot.title.trim());
  const todayMeals = mealSlots.filter((slot) => slot.date === dateKey() && slot.title.trim());
  const uncheckedItems = shoppingItems.filter((item) => !item.checked);
  const shoppingProgress = shoppingItems.length
    ? Math.round((shoppingItems.filter((item) => item.checked).length / shoppingItems.length) * 100)
    : 0;
  const filteredRecipes = useMemo(() => {
    const query = recipeSearch.trim().toLocaleLowerCase("pl");
    return recipes.filter(
      (recipe) =>
        !query ||
        recipe.name.toLocaleLowerCase("pl").includes(query) ||
        recipe.tags.some((tag) => tag.toLocaleLowerCase("pl").includes(query)),
    );
  }, [recipeSearch, recipes]);
  const shoppingGroups = useMemo(() => {
    const groups = new Map<string, typeof shoppingItems>();
    shoppingItems.forEach((item) => {
      const group = groups.get(item.category) ?? [];
      group.push(item);
      groups.set(item.category, group);
    });
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "pl"));
  }, [shoppingItems]);

  const openMeal = (date: string, type: MealType) => {
    const existing = mealSlots.find((slot) => slot.date === date && slot.type === type) ?? null;
    setEditingSlot(existing);
    setMealDraft({
      date,
      type,
      recipeId: existing?.recipeId ?? "",
      title: existing?.title ?? "",
      servings: String(existing?.servings ?? 2),
    });
    setMealModalOpen(true);
  };

  const selectRecipeForMeal = (recipeId: string) => {
    const recipe = recipes.find((item) => item.id === recipeId);
    setMealDraft((current) => ({
      ...current,
      recipeId,
      title: recipe?.name ?? current.title,
      servings: recipe ? String(recipe.servings) : current.servings,
    }));
  };

  const saveMeal = (event: FormEvent) => {
    event.preventDefault();
    if (!mealDraft.title.trim()) {
      onToast("Wpisz nazwę posiłku albo wybierz przepis");
      return;
    }
    setMealSlot({
      id: editingSlot?.id,
      date: mealDraft.date,
      type: mealDraft.type,
      recipeId: mealDraft.recipeId || undefined,
      title: mealDraft.title.trim(),
      servings: Math.max(1, Number.parseInt(mealDraft.servings, 10) || 1),
    });
    setMealModalOpen(false);
    onToast(editingSlot ? "Plan posiłku został zaktualizowany" : "Posiłek został zaplanowany");
  };

  const clearMeal = () => {
    if (!editingSlot) return;
    deleteMealSlot(editingSlot.id);
    setMealModalOpen(false);
    onToast("Posiłek został usunięty z planu");
  };

  const openRecipeCreate = () => {
    setEditingRecipe(null);
    setRecipeDraft(newRecipeDraft());
    setRecipeModalOpen(true);
  };

  const openRecipeEdit = (recipe: Recipe) => {
    setEditingRecipe(recipe);
    setRecipeDraft({
      name: recipe.name,
      minutes: String(recipe.minutes),
      servings: String(recipe.servings),
      tags: recipe.tags.join(", "),
      ingredients: recipe.ingredients.join("\n"),
    });
    setRecipeModalOpen(true);
  };

  const saveRecipe = (event: FormEvent) => {
    event.preventDefault();
    const name = recipeDraft.name.trim();
    const ingredients = recipeDraft.ingredients
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!name || !ingredients.length) {
      onToast("Podaj nazwę oraz przynajmniej jeden składnik");
      return;
    }
    const data = {
      name,
      minutes: Math.max(1, Number.parseInt(recipeDraft.minutes, 10) || 1),
      servings: Math.max(1, Number.parseInt(recipeDraft.servings, 10) || 1),
      tags: recipeDraft.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      ingredients,
    };
    if (editingRecipe) {
      updateRecipe(editingRecipe.id, data);
      onToast("Przepis został zaktualizowany");
    } else {
      addRecipe({ ...data, favorite: false });
      onToast("Przepis został dodany");
    }
    setRecipeModalOpen(false);
  };

  const toggleFavorite = (recipeId: string) => {
    toggleRecipeFavorite(recipeId);
  };

  const removeRecipe = (recipe: Recipe) => {
    if (!window.confirm(`Usunąć przepis „${recipe.name}”?`)) return;
    deleteRecipe(recipe.id);
    onToast("Przepis został usunięty");
  };

  const putRecipeOnList = (recipe: Recipe) => {
    const count = addRecipeIngredientsToShopping(recipe.id);
    onToast(count ? `Dodano ${count} składników do listy` : "Wszystkie składniki są już na liście");
  };

  const addWeekToShopping = () => {
    const recipeIds = [
      ...new Set(weekSlots.map((slot) => slot.recipeId).filter(Boolean)),
    ] as string[];
    const count = recipeIds.reduce(
      (total, recipeId) => total + addRecipeIngredientsToShopping(recipeId),
      0,
    );
    setTab("shopping");
    onToast(
      count ? `Dodano ${count} składników z planu tygodnia` : "Lista zawiera już składniki z planu",
    );
  };

  const addManualShoppingItem = (event: FormEvent) => {
    event.preventDefault();
    if (!shoppingName.trim()) return;
    addShoppingItem({
      name: shoppingName.trim(),
      quantity: shoppingQuantity.trim() || "1 szt.",
      category: shoppingCategory.trim() || "Inne",
      checked: false,
    });
    setShoppingName("");
    setShoppingQuantity("");
    onToast("Produkt został dodany do listy");
  };

  const clearChecked = () => {
    const removed = clearCheckedShoppingItems();
    if (!removed) {
      onToast("Nie ma kupionych produktów do usunięcia");
      return;
    }
    onToast(`Usunięto ${removed} kupionych produktów`);
  };

  return (
    <div className="life-module-page page-enter">
      <header className="page-header life-module-header">
        <div>
          <span className="page-eyebrow">Spokojniejsze planowanie tygodnia</span>
          <h1>Posiłki</h1>
          <p>
            Zaplanuj menu, zachowuj sprawdzone przepisy i zbieraj zakupy na jednej wspólnej liście.
          </p>
        </div>
        <button
          className="button button--primary"
          type="button"
          onClick={() =>
            tab === "recipes" ? openRecipeCreate() : openMeal(defaultPlanDate, "dinner")
          }
        >
          <Plus size={17} /> {tab === "recipes" ? "Nowy przepis" : "Zaplanuj posiłek"}
        </button>
      </header>

      <section
        className="module-stat-grid module-stat-grid--three"
        aria-label="Podsumowanie posiłków"
      >
        <article className="module-stat-card module-stat-card--accent">
          <span className="module-stat-card__icon">
            <Utensils size={19} />
          </span>
          <div>
            <span>Dzisiaj</span>
            <strong>
              {todayMeals.length
                ? todayMeals.map((meal) => meal.title).join(" · ")
                : "Jeszcze bez planu"}
            </strong>
            <small>{todayMeals.length} zaplanowanych posiłków</small>
          </div>
        </article>
        <article className="module-stat-card">
          <span className="module-stat-card__icon module-stat-card__icon--amber">
            <ChefHat size={19} />
          </span>
          <div>
            <span>Przepisy</span>
            <strong>{recipes.length}</strong>
            <small>{recipes.filter((recipe) => recipe.favorite).length} ulubionych</small>
          </div>
        </article>
        <article className="module-stat-card">
          <span className="module-stat-card__icon module-stat-card__icon--blue">
            <ShoppingBasket size={19} />
          </span>
          <div>
            <span>Do kupienia</span>
            <strong>{uncheckedItems.length}</strong>
            <small>{shoppingProgress}% listy gotowe</small>
          </div>
        </article>
      </section>

      <nav className="module-tabs" aria-label="Obszary planowania posiłków">
        <button
          className={tab === "plan" ? "active" : ""}
          type="button"
          onClick={() => setTab("plan")}
        >
          <CalendarDays size={16} /> Plan tygodnia
        </button>
        <button
          className={tab === "recipes" ? "active" : ""}
          type="button"
          onClick={() => setTab("recipes")}
        >
          <ChefHat size={16} /> Przepisy
        </button>
        <button
          className={tab === "shopping" ? "active" : ""}
          type="button"
          onClick={() => setTab("shopping")}
        >
          <ShoppingBasket size={16} /> Lista zakupów{" "}
          {uncheckedItems.length > 0 && <span>{uncheckedItems.length}</span>}
        </button>
      </nav>

      {tab === "plan" && (
        <section className="panel module-panel meal-plan-panel">
          <header className="module-panel__header">
            <div>
              <span className="section-kicker">
                <CalendarDays size={14} /> Menu
              </span>
              <h2>
                {format(days[0], "d MMM", { locale: pl })} –{" "}
                {format(days[6], "d MMMM yyyy", { locale: pl })}
              </h2>
            </div>
            <div className="module-toolbar-actions">
              <button
                className="button button--ghost-border button--small"
                type="button"
                onClick={() => setWeekAnchor(addWeeks(weekAnchor, -1))}
                aria-label="Poprzedni tydzień"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                className="button button--ghost-border button--small"
                type="button"
                onClick={() => setWeekAnchor(new Date())}
              >
                Ten tydzień
              </button>
              <button
                className="button button--ghost-border button--small"
                type="button"
                onClick={() => setWeekAnchor(addWeeks(weekAnchor, 1))}
                aria-label="Następny tydzień"
              >
                <ChevronRight size={16} />
              </button>
              <button
                className="button button--soft button--small"
                type="button"
                onClick={addWeekToShopping}
              >
                <ShoppingBasket size={15} /> Składniki na listę
              </button>
            </div>
          </header>
          <div className="meal-week-scroll">
            <div className="meal-week-grid">
              <div className="meal-week-corner">Pora dnia</div>
              {days.map((day) => (
                <div
                  className={
                    isSameDay(day, new Date())
                      ? "meal-day-head meal-day-head--today"
                      : "meal-day-head"
                  }
                  key={dateKey(day)}
                >
                  <span>{formatDayName(day)}</span>
                  <strong>{format(day, "d")}</strong>
                </div>
              ))}
              {(["breakfast", "lunch", "dinner"] as MealType[]).map((type) => (
                <MealWeekRow
                  key={type}
                  type={type}
                  days={days}
                  slots={mealSlots}
                  onOpen={openMeal}
                />
              ))}
            </div>
          </div>
          {!weekSlots.length && (
            <div className="module-inline-tip">
              <Sparkles size={17} />
              <span>
                Ten tydzień ma jeszcze dużo miejsca. Zacznij od zaplanowania głównych obiadów.
              </span>
            </div>
          )}
        </section>
      )}

      {tab === "recipes" && (
        <section className="panel module-panel">
          <header className="module-panel__header">
            <div>
              <span className="section-kicker">
                <ChefHat size={14} /> Twoja kuchnia
              </span>
              <h2>Przepisy</h2>
            </div>
            <div className="module-toolbar-actions">
              <label className="search-field">
                <Search size={15} />
                <input
                  value={recipeSearch}
                  onChange={(event) => setRecipeSearch(event.target.value)}
                  placeholder="Szukaj przepisu lub tagu"
                />
              </label>
              <button
                className="button button--soft button--small"
                type="button"
                onClick={openRecipeCreate}
              >
                <Plus size={15} /> Dodaj przepis
              </button>
            </div>
          </header>
          {filteredRecipes.length ? (
            <div className="recipe-grid">
              {filteredRecipes.map((recipe) => (
                <article className="recipe-card" key={recipe.id}>
                  <div className="recipe-card__top">
                    <span className="recipe-card__icon">
                      <ChefHat size={21} />
                    </span>
                    <button
                      className={recipe.favorite ? "recipe-favorite active" : "recipe-favorite"}
                      type="button"
                      onClick={() => toggleFavorite(recipe.id)}
                      aria-label={recipe.favorite ? "Usuń z ulubionych" : "Dodaj do ulubionych"}
                      aria-pressed={recipe.favorite}
                    >
                      <Heart size={17} fill={recipe.favorite ? "currentColor" : "none"} />
                    </button>
                  </div>
                  <h3>{recipe.name}</h3>
                  <div className="recipe-meta">
                    <span>
                      <Clock3 size={14} /> {recipe.minutes} min
                    </span>
                    <span>
                      <Users size={14} /> {recipe.servings} porcje
                    </span>
                  </div>
                  <div className="recipe-tags">
                    {recipe.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  <ul>
                    {recipe.ingredients.slice(0, 4).map((ingredient) => (
                      <li key={ingredient}>{ingredient}</li>
                    ))}
                  </ul>
                  {recipe.ingredients.length > 4 && (
                    <small className="recipe-more">+ {recipe.ingredients.length - 4} więcej</small>
                  )}
                  <footer>
                    <button
                      className="button button--soft button--small"
                      type="button"
                      onClick={() => putRecipeOnList(recipe)}
                    >
                      <ShoppingBasket size={14} /> Na listę
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => openRecipeEdit(recipe)}
                    >
                      Edytuj
                    </button>
                    <button
                      className="icon-button module-danger-icon"
                      type="button"
                      onClick={() => removeRecipe(recipe)}
                      aria-label={`Usuń przepis ${recipe.name}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </footer>
                </article>
              ))}
            </div>
          ) : (
            <div className="module-empty">
              <ChefHat size={24} />
              <strong>Nie znaleziono przepisów</strong>
              <span>Zmień wyszukiwanie albo dodaj nowy pomysł.</span>
            </div>
          )}
        </section>
      )}

      {tab === "shopping" && (
        <div className="shopping-layout">
          <section className="panel module-panel shopping-main">
            <header className="module-panel__header">
              <div>
                <span className="section-kicker">
                  <ListChecks size={14} /> Wspólna lista
                </span>
                <h2>Zakupy</h2>
              </div>
              <button className="text-button" type="button" onClick={clearChecked}>
                Usuń kupione
              </button>
            </header>
            <div className="shopping-progress">
              <div>
                <span style={{ width: `${shoppingProgress}%` }} />
              </div>
              <strong>{shoppingProgress}%</strong>
              <small>
                {shoppingItems.filter((item) => item.checked).length} z {shoppingItems.length}{" "}
                kupione
              </small>
            </div>
            {shoppingGroups.length ? (
              <div className="shopping-groups">
                {shoppingGroups.map(([category, items]) => (
                  <section className="shopping-group" key={category}>
                    <header>
                      <strong>{category}</strong>
                      <span>{items.filter((item) => !item.checked).length} do kupienia</span>
                    </header>
                    {items.map((item) => (
                      <div
                        className={
                          item.checked ? "shopping-row shopping-row--checked" : "shopping-row"
                        }
                        key={item.id}
                      >
                        <button
                          type="button"
                          onClick={() => toggleShoppingItem(item.id)}
                          aria-label={
                            item.checked
                              ? `Przywróć ${item.name}`
                              : `Oznacz ${item.name} jako kupione`
                          }
                        >
                          <Check size={14} />
                        </button>
                        <div>
                          <strong>{item.name}</strong>
                          <span>
                            {item.quantity}
                            {item.assignedTo ? ` · ${item.assignedTo}` : ""}
                          </span>
                        </div>
                        <button
                          className="icon-button module-danger-icon"
                          type="button"
                          onClick={() => removeShoppingItem(item.id)}
                          aria-label={`Usuń ${item.name}`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            ) : (
              <div className="module-empty">
                <ShoppingBasket size={24} />
                <strong>Lista jest pusta</strong>
                <span>Dodaj produkt albo wygeneruj składniki z planu.</span>
              </div>
            )}
          </section>
          <aside className="panel module-panel shopping-add-card">
            <span className="section-kicker">
              <Plus size={14} /> Szybkie dodawanie
            </span>
            <h2>Nowy produkt</h2>
            <form className="form-grid" onSubmit={addManualShoppingItem}>
              <label className="field field--prominent">
                <span>Produkt</span>
                <input
                  value={shoppingName}
                  onChange={(event) => setShoppingName(event.target.value)}
                  placeholder="np. pomidory"
                />
              </label>
              <div className="form-grid form-grid--2">
                <label className="field">
                  <span>Ilość</span>
                  <input
                    value={shoppingQuantity}
                    onChange={(event) => setShoppingQuantity(event.target.value)}
                    placeholder="2 szt."
                  />
                </label>
                <label className="field">
                  <span>Kategoria</span>
                  <input
                    value={shoppingCategory}
                    onChange={(event) => setShoppingCategory(event.target.value)}
                  />
                </label>
              </div>
              <button className="button button--primary" type="submit">
                <Plus size={15} /> Dodaj do listy
              </button>
            </form>
            <div className="module-inline-tip">
              <Sparkles size={17} />
              <span>Składniki z tego samego przepisu nie zostaną dodane drugi raz.</span>
            </div>
          </aside>
        </div>
      )}

      <Modal
        open={mealModalOpen}
        onClose={() => setMealModalOpen(false)}
        title={editingSlot ? "Edytuj posiłek" : "Zaplanuj posiłek"}
        eyebrow={
          mealDraft.date
            ? format(parseLocalDate(mealDraft.date), "EEEE, d MMMM", { locale: pl })
            : "Plan tygodnia"
        }
      >
        <form className="form-grid" onSubmit={saveMeal}>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Data</span>
              <input
                type="date"
                required
                value={mealDraft.date}
                onChange={(event) => setMealDraft({ ...mealDraft, date: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Pora dnia</span>
              <select
                value={mealDraft.type}
                onChange={(event) =>
                  setMealDraft({ ...mealDraft, type: event.target.value as MealType })
                }
              >
                <option value="breakfast">Śniadanie</option>
                <option value="lunch">Lunch</option>
                <option value="dinner">Obiad / kolacja</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Wybierz zapisany przepis</span>
            <select
              value={mealDraft.recipeId}
              onChange={(event) => selectRecipeForMeal(event.target.value)}
            >
              <option value="">Własny posiłek</option>
              {recipes.map((recipe) => (
                <option value={recipe.id} key={recipe.id}>
                  {recipe.name}
                </option>
              ))}
            </select>
          </label>
          <div className="form-grid form-grid--2">
            <label className="field field--prominent">
              <span>Nazwa posiłku</span>
              <input
                autoFocus
                value={mealDraft.title}
                onChange={(event) =>
                  setMealDraft({ ...mealDraft, title: event.target.value, recipeId: "" })
                }
                placeholder="Co będziecie jeść?"
              />
            </label>
            <label className="field">
              <span>Liczba porcji</span>
              <input
                type="number"
                min="1"
                max="100"
                value={mealDraft.servings}
                onChange={(event) => setMealDraft({ ...mealDraft, servings: event.target.value })}
              />
            </label>
          </div>
          <div className="modal-actions">
            <div>
              {editingSlot && (
                <button className="button button--danger-ghost" type="button" onClick={clearMeal}>
                  <Trash2 size={15} /> Usuń z planu
                </button>
              )}
            </div>
            <div>
              <button
                className="button button--ghost"
                type="button"
                onClick={() => setMealModalOpen(false)}
              >
                Anuluj
              </button>
              <button className="button button--primary" type="submit">
                Zapisz posiłek
              </button>
            </div>
          </div>
        </form>
      </Modal>

      <Modal
        open={recipeModalOpen}
        onClose={() => setRecipeModalOpen(false)}
        title={editingRecipe ? "Edytuj przepis" : "Nowy przepis"}
        eyebrow="Domowa książka kucharska"
        size="large"
      >
        <form className="form-grid" onSubmit={saveRecipe}>
          <label className="field field--prominent">
            <span>Nazwa przepisu</span>
            <input
              autoFocus
              required
              value={recipeDraft.name}
              onChange={(event) => setRecipeDraft({ ...recipeDraft, name: event.target.value })}
              placeholder="np. Curry z ciecierzycą"
            />
          </label>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Czas (min)</span>
              <input
                min="1"
                type="number"
                value={recipeDraft.minutes}
                onChange={(event) =>
                  setRecipeDraft({ ...recipeDraft, minutes: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Porcje</span>
              <input
                min="1"
                type="number"
                value={recipeDraft.servings}
                onChange={(event) =>
                  setRecipeDraft({ ...recipeDraft, servings: event.target.value })
                }
              />
            </label>
          </div>
          <label className="field">
            <span>Tagi, oddzielone przecinkami</span>
            <input
              value={recipeDraft.tags}
              onChange={(event) => setRecipeDraft({ ...recipeDraft, tags: event.target.value })}
              placeholder="szybkie, wegetariańskie"
            />
          </label>
          <label className="field">
            <span>Składniki — jeden w wierszu</span>
            <textarea
              required
              value={recipeDraft.ingredients}
              onChange={(event) =>
                setRecipeDraft({ ...recipeDraft, ingredients: event.target.value })
              }
              placeholder={"makaron 250 g\npesto 1 słoik\npomidorki 250 g"}
            />
          </label>
          <div className="modal-actions">
            <button
              className="button button--ghost"
              type="button"
              onClick={() => setRecipeModalOpen(false)}
            >
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              {editingRecipe ? "Zapisz zmiany" : "Dodaj przepis"}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function MealWeekRow({
  type,
  days,
  slots,
  onOpen,
}: {
  type: MealType;
  days: Date[];
  slots: MealSlot[];
  onOpen: (date: string, type: MealType) => void;
}) {
  return (
    <>
      <div className="meal-type-cell">
        <span>
          <Utensils size={15} />
        </span>
        <strong>{mealLabels[type]}</strong>
      </div>
      {days.map((day) => {
        const key = dateKey(day);
        const slot = slots.find(
          (item) => item.date === key && item.type === type && item.title.trim(),
        );
        return (
          <button
            className={slot ? "meal-slot-cell meal-slot-cell--filled" : "meal-slot-cell"}
            type="button"
            key={`${key}-${type}`}
            onClick={() => onOpen(key, type)}
          >
            {slot ? (
              <>
                <strong>{slot.title}</strong>
                <span>{slot.servings} porcje</span>
              </>
            ) : (
              <>
                <Plus size={14} />
                <span>Dodaj</span>
              </>
            )}
          </button>
        );
      })}
    </>
  );
}

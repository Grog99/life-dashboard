import {
  BellRing,
  CalendarClock,
  Check,
  CirclePause,
  CirclePlay,
  CreditCard,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { addMonths, addYears, format, isAfter, parseISO, startOfDay } from "date-fns";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { CurrencyCode, Subscription, Visibility } from "../advancedTypes";
import { Modal } from "../components/Modal";
import { formatShortDate, relativeDay } from "../lib/date";
import { formatMoney, monthlySubscriptionCost, parseMoneyToMinor } from "../lib/money";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { useSubscriptionsStore } from "../store/useSubscriptionsStore";
import { useServerAuth } from "../server/AuthGate";
import "../styles/modules.css";

interface SubscriptionsPageProps {
  onToast: (message: string) => void;
}

type SubscriptionFilter = "all" | Subscription["status"];

interface SubscriptionDraft {
  name: string;
  category: string;
  amount: string;
  currency: CurrencyCode;
  cycle: Subscription["cycle"];
  nextPayment: string;
  payer: string;
  status: Subscription["status"];
  reminderDays: string;
  visibility: Visibility;
  color: string;
  cancelUrl: string;
}

const cycleLabels: Record<Subscription["cycle"], string> = {
  monthly: "co miesiąc",
  quarterly: "co kwartał",
  yearly: "co rok",
};

const statusLabels: Record<Subscription["status"], string> = {
  active: "Aktywna",
  trial: "Okres próbny",
  paused: "Wstrzymana",
  cancelled: "Anulowana",
};

const emptyDraft = (): SubscriptionDraft => ({
  name: "",
  category: "Inne",
  amount: "",
  currency: "PLN",
  cycle: "monthly",
  nextPayment: format(addMonths(new Date(), 1), "yyyy-MM-dd"),
  payer: "Ty",
  status: "active",
  reminderDays: "2",
  visibility: "private",
  color: "#397763",
  cancelUrl: "",
});

function advancePayment(subscription: Subscription): string {
  const today = startOfDay(new Date());
  let next = parseISO(subscription.nextPayment);
  do {
    next =
      subscription.cycle === "yearly"
        ? addYears(next, 1)
        : addMonths(next, subscription.cycle === "quarterly" ? 3 : 1);
  } while (!isAfter(next, today));
  return format(next, "yyyy-MM-dd");
}

function moneyTotalsLabel(totals: Map<CurrencyCode, number>, hideAmounts: boolean): string {
  const values = [...totals.entries()].filter(([, amount]) => amount !== 0);
  if (!values.length) return formatMoney(0, "PLN", hideAmounts);
  return values.map(([currency, amount]) => formatMoney(amount, currency, hideAmounts)).join(" + ");
}

export function SubscriptionsPage({ onToast }: SubscriptionsPageProps) {
  const { snapshot } = useServerAuth();
  const currentOwnerId = snapshot?.user.id ?? "me";
  const subscriptions = useSubscriptionsStore((state) => state.subscriptions);
  const hideAmounts = useAdvancedStore((state) => state.hideAmounts);
  const addSubscription = useSubscriptionsStore((state) => state.addSubscription);
  const updateSubscription = useSubscriptionsStore((state) => state.updateSubscription);
  const deleteSubscription = useSubscriptionsStore((state) => state.deleteSubscription);

  const [filter, setFilter] = useState<SubscriptionFilter>("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [draft, setDraft] = useState<SubscriptionDraft>(emptyDraft);
  const [menuId, setMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuId) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuId(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuId(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuId]);

  const recurring = subscriptions.filter(
    (subscription) => subscription.status === "active" || subscription.status === "trial",
  );
  const monthlyTotals = useMemo(() => {
    const totals = new Map<CurrencyCode, number>();
    recurring.forEach((subscription) => {
      totals.set(
        subscription.currency,
        (totals.get(subscription.currency) ?? 0) +
          monthlySubscriptionCost(subscription.amountMinor, subscription.cycle),
      );
    });
    return totals;
  }, [recurring]);
  const yearlyTotals = useMemo(
    () => new Map([...monthlyTotals].map(([currency, amount]) => [currency, amount * 12])),
    [monthlyTotals],
  );
  const sortedSubscriptions = useMemo(
    () =>
      subscriptions
        .filter((subscription) => filter === "all" || subscription.status === filter)
        .sort((a, b) => a.nextPayment.localeCompare(b.nextPayment)),
    [filter, subscriptions],
  );
  const nextRenewal = recurring
    .slice()
    .sort((a, b) => a.nextPayment.localeCompare(b.nextPayment))[0];
  const sharedCount = subscriptions.filter(
    (subscription) =>
      subscription.visibility === "household" && subscription.status !== "cancelled",
  ).length;

  const openCreate = () => {
    setEditing(null);
    setDraft(emptyDraft());
    setFormOpen(true);
  };

  const openEdit = (subscription: Subscription) => {
    setEditing(subscription);
    setDraft({
      name: subscription.name,
      category: subscription.category,
      amount: (subscription.amountMinor / 100).toFixed(2).replace(".", ","),
      currency: subscription.currency,
      cycle: subscription.cycle,
      nextPayment: subscription.nextPayment,
      payer: subscription.payer,
      status: subscription.status,
      reminderDays: String(subscription.reminderDays),
      visibility: subscription.visibility,
      color: subscription.color,
      cancelUrl: subscription.cancelUrl ?? "",
    });
    setMenuId(null);
    setFormOpen(true);
  };

  const saveSubscription = (event: FormEvent) => {
    event.preventDefault();
    const amountMinor = parseMoneyToMinor(draft.amount);
    if (!draft.name.trim() || amountMinor <= 0) {
      onToast("Podaj nazwę i poprawną kwotę subskrypcji");
      return;
    }
    const data = {
      name: draft.name.trim(),
      category: draft.category.trim() || "Inne",
      amountMinor,
      currency: draft.currency,
      cycle: draft.cycle,
      nextPayment: draft.nextPayment,
      payer: draft.payer.trim() || "Ty",
      status: draft.status,
      reminderDays: Math.max(0, Number.parseInt(draft.reminderDays, 10) || 0),
      visibility: draft.visibility,
      color: draft.color,
      cancelUrl: draft.cancelUrl.trim() || undefined,
    };
    if (editing) {
      updateSubscription(editing.id, data);
      onToast("Zapisano zmiany subskrypcji");
    } else {
      addSubscription({ ...data, ownerId: currentOwnerId });
      onToast("Subskrypcja została dodana");
    }
    setFormOpen(false);
  };

  const renew = (subscription: Subscription) => {
    const nextPayment = advancePayment(subscription);
    updateSubscription(subscription.id, { nextPayment, status: "active" });
    setMenuId(null);
    onToast(`Odnowiono ${subscription.name}. Następna płatność ${formatShortDate(nextPayment)}`);
  };

  const togglePause = (subscription: Subscription) => {
    const status = subscription.status === "paused" ? "active" : "paused";
    updateSubscription(subscription.id, { status });
    setMenuId(null);
    onToast(
      status === "paused" ? "Subskrypcja została wstrzymana" : "Subskrypcja jest ponownie aktywna",
    );
  };

  const remove = (subscription: Subscription) => {
    if (!window.confirm(`Usunąć subskrypcję „${subscription.name}”?`)) return;
    deleteSubscription(subscription.id);
    setMenuId(null);
    onToast("Subskrypcja została usunięta");
  };

  return (
    <div className="life-module-page page-enter">
      <header className="page-header life-module-header">
        <div>
          <span className="page-eyebrow">Stałe koszty pod kontrolą</span>
          <h1>Subskrypcje</h1>
          <p>Wszystkie cykliczne opłaty, daty odnowień i okresy próbne w jednym miejscu.</p>
        </div>
        <button className="button button--primary" type="button" onClick={openCreate}>
          <Plus size={17} /> Dodaj subskrypcję
        </button>
      </header>

      <section className="module-stat-grid" aria-label="Podsumowanie subskrypcji">
        <article className="module-stat-card module-stat-card--accent">
          <span className="module-stat-card__icon">
            <CreditCard size={19} />
          </span>
          <div>
            <span>Miesięczny koszt</span>
            <strong>{moneyTotalsLabel(monthlyTotals, hideAmounts)}</strong>
            <small>{recurring.length} aktywnych opłat</small>
          </div>
        </article>
        <article className="module-stat-card">
          <span className="module-stat-card__icon module-stat-card__icon--amber">
            <CalendarClock size={19} />
          </span>
          <div>
            <span>Najbliższe odnowienie</span>
            <strong>
              {nextRenewal
                ? formatMoney(nextRenewal.amountMinor, nextRenewal.currency, hideAmounts)
                : "Brak"}
            </strong>
            <small>
              {nextRenewal
                ? `${nextRenewal.name} · ${relativeDay(nextRenewal.nextPayment)}`
                : "Nic nie nadchodzi"}
            </small>
          </div>
        </article>
        <article className="module-stat-card">
          <span className="module-stat-card__icon module-stat-card__icon--blue">
            <RefreshCw size={19} />
          </span>
          <div>
            <span>Prognoza roczna</span>
            <strong>{moneyTotalsLabel(yearlyTotals, hideAmounts)}</strong>
            <small>przy obecnych planach</small>
          </div>
        </article>
        <article className="module-stat-card">
          <span className="module-stat-card__icon module-stat-card__icon--violet">
            <BellRing size={19} />
          </span>
          <div>
            <span>Współdzielone</span>
            <strong>{sharedCount}</strong>
            <small>widoczne dla domowników</small>
          </div>
        </article>
      </section>

      <section className="panel module-panel">
        <header className="module-panel__header">
          <div>
            <span className="section-kicker">
              <RefreshCw size={14} /> Cykliczne płatności
            </span>
            <h2>Twoje plany</h2>
          </div>
          <div className="module-segmented" aria-label="Filtr statusu">
            {(["all", "active", "trial", "paused", "cancelled"] as const).map((value) => (
              <button
                className={filter === value ? "active" : ""}
                type="button"
                key={value}
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
              >
                {value === "all" ? "Wszystkie" : statusLabels[value]}
              </button>
            ))}
          </div>
        </header>

        {sortedSubscriptions.length ? (
          <div className="subscription-list">
            {sortedSubscriptions.map((subscription) => (
              <article
                className={`subscription-row subscription-row--${subscription.status}`}
                key={subscription.id}
              >
                <span
                  className="subscription-mark"
                  style={{ "--item-color": subscription.color } as React.CSSProperties}
                >
                  {subscription.name.slice(0, 1).toLocaleUpperCase("pl")}
                </span>
                <div className="subscription-row__identity">
                  <div>
                    <strong>{subscription.name}</strong>
                    <span className={`module-status module-status--${subscription.status}`}>
                      {statusLabels[subscription.status]}
                    </span>
                  </div>
                  <small>
                    {subscription.category} · płaci {subscription.payer} ·{" "}
                    {subscription.visibility === "household" ? "wspólna" : "prywatna"}
                  </small>
                </div>
                <div className="subscription-row__renewal">
                  <span>Następna płatność</span>
                  <strong>{relativeDay(subscription.nextPayment)}</strong>
                  <small>
                    {formatShortDate(subscription.nextPayment)} · przypomnienie{" "}
                    {subscription.reminderDays} dni wcześniej
                  </small>
                </div>
                <div className="subscription-row__price">
                  <strong>
                    {formatMoney(subscription.amountMinor, subscription.currency, hideAmounts)}
                  </strong>
                  <span>{cycleLabels[subscription.cycle]}</span>
                </div>
                <div className="module-more" ref={menuId === subscription.id ? menuRef : undefined}>
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() =>
                      setMenuId((value) => (value === subscription.id ? null : subscription.id))
                    }
                    aria-label={`Opcje: ${subscription.name}`}
                    aria-expanded={menuId === subscription.id}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                  {menuId === subscription.id && (
                    <div className="module-more__menu">
                      {subscription.status !== "cancelled" && (
                        <button type="button" onClick={() => renew(subscription)}>
                          <Check size={15} /> Oznacz odnowienie
                        </button>
                      )}
                      <button type="button" onClick={() => openEdit(subscription)}>
                        <Pencil size={15} /> Edytuj
                      </button>
                      {subscription.status !== "cancelled" && (
                        <button type="button" onClick={() => togglePause(subscription)}>
                          {subscription.status === "paused" ? (
                            <CirclePlay size={15} />
                          ) : (
                            <CirclePause size={15} />
                          )}
                          {subscription.status === "paused" ? "Wznów" : "Wstrzymaj"}
                        </button>
                      )}
                      {subscription.cancelUrl && (
                        <a href={subscription.cancelUrl} target="_blank" rel="noreferrer">
                          <ExternalLink size={15} /> Zarządzaj planem
                        </a>
                      )}
                      <button className="danger" type="button" onClick={() => remove(subscription)}>
                        <Trash2 size={15} /> Usuń
                      </button>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="module-empty">
            <CreditCard size={24} />
            <strong>Brak subskrypcji w tym widoku</strong>
            <span>Zmień filtr albo dodaj pierwszą cykliczną płatność.</span>
          </div>
        )}
      </section>

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? "Edytuj subskrypcję" : "Nowa subskrypcja"}
        eyebrow="Cykliczna płatność"
        size="large"
      >
        <form className="form-grid" onSubmit={saveSubscription}>
          <div className="form-grid form-grid--2">
            <label className="field field--prominent">
              <span>Nazwa</span>
              <input
                autoFocus
                required
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="np. Netflix"
              />
            </label>
            <label className="field">
              <span>Kategoria</span>
              <input
                value={draft.category}
                onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                placeholder="Wideo, praca, zdrowie…"
              />
            </label>
          </div>
          <div className="form-grid form-grid--3">
            <label className="field">
              <span>Kwota</span>
              <input
                required
                inputMode="decimal"
                value={draft.amount}
                onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
                placeholder="49,99"
              />
            </label>
            <label className="field">
              <span>Waluta</span>
              <select
                value={draft.currency}
                onChange={(event) =>
                  setDraft({ ...draft, currency: event.target.value as CurrencyCode })
                }
              >
                <option>PLN</option>
                <option>EUR</option>
                <option>USD</option>
                <option>GBP</option>
              </select>
            </label>
            <label className="field">
              <span>Cykl</span>
              <select
                value={draft.cycle}
                onChange={(event) =>
                  setDraft({ ...draft, cycle: event.target.value as Subscription["cycle"] })
                }
              >
                <option value="monthly">Co miesiąc</option>
                <option value="quarterly">Co kwartał</option>
                <option value="yearly">Co rok</option>
              </select>
            </label>
          </div>
          <div className="form-grid form-grid--3">
            <label className="field">
              <span>Następna płatność</span>
              <input
                required
                type="date"
                value={draft.nextPayment}
                onChange={(event) => setDraft({ ...draft, nextPayment: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Płatnik</span>
              <input
                value={draft.payer}
                onChange={(event) => setDraft({ ...draft, payer: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Przypomnij dni wcześniej</span>
              <input
                min="0"
                max="60"
                type="number"
                value={draft.reminderDays}
                onChange={(event) => setDraft({ ...draft, reminderDays: event.target.value })}
              />
            </label>
          </div>
          <div className="form-grid form-grid--3">
            <label className="field">
              <span>Status</span>
              <select
                value={draft.status}
                onChange={(event) =>
                  setDraft({ ...draft, status: event.target.value as Subscription["status"] })
                }
              >
                <option value="active">Aktywna</option>
                <option value="trial">Okres próbny</option>
                <option value="paused">Wstrzymana</option>
                <option value="cancelled">Anulowana</option>
              </select>
            </label>
            <label className="field">
              <span>Widoczność</span>
              <select
                value={draft.visibility}
                onChange={(event) =>
                  setDraft({ ...draft, visibility: event.target.value as Visibility })
                }
              >
                <option value="private">Tylko ja</option>
                <option value="household">Domownicy</option>
              </select>
            </label>
            <label className="field">
              <span>Kolor</span>
              <input
                className="module-color-input"
                type="color"
                value={draft.color}
                onChange={(event) => setDraft({ ...draft, color: event.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span>Adres zarządzania lub anulowania (opcjonalnie)</span>
            <input
              type="url"
              value={draft.cancelUrl}
              onChange={(event) => setDraft({ ...draft, cancelUrl: event.target.value })}
              placeholder="https://…"
            />
          </label>
          <div className="modal-actions">
            <button
              className="button button--ghost"
              type="button"
              onClick={() => setFormOpen(false)}
            >
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              {editing ? "Zapisz zmiany" : "Dodaj subskrypcję"}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

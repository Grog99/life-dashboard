import {
  AlertTriangle,
  Bell,
  CalendarSync,
  Check,
  Copy,
  Database,
  Download,
  Info,
  Link2,
  LogOut,
  Laptop,
  Moon,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Trash2,
  Upload,
  UserRound,
  UsersRound,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { format } from "date-fns";
import { backupEnvelopeSchema, backupEnvelopeV2Schema, lifeDataSchema } from "../lib/schema";
import { exportData, useLifeStore } from "../store/useLifeStore";
import { exportAdvancedData, useAdvancedStore } from "../store/useAdvancedStore";
import { useFinanceStore } from "../store/useFinanceStore";
import { apiRequest, serverMode } from "../server/api";
import { useServerAuth } from "../server/AuthGate";
import { removeCurrentPushSubscription } from "../server/push";
import { Tabs, type TabItem } from "../components/Tabs";
import { Modal } from "../components/Modal";
import type { Theme } from "../types";

const SETTINGS_TABS_ID_BASE = "settings";

export function SettingsPage({ onToast }: { onToast: (message: string) => void }) {
  const preferences = useLifeStore((state) => state.preferences);
  const updatePreferences = useLifeStore((state) => state.updatePreferences);
  const replaceData = useLifeStore((state) => state.replaceData);
  const tasks = useLifeStore((state) => state.tasks);
  const events = useLifeStore((state) => state.events);
  const replaceAdvancedData = useAdvancedStore((state) => state.replaceAdvancedData);
  const resetFinanceData = useFinanceStore((state) => state.resetFinanceData);
  const financeTransactions = useFinanceStore((state) => state.transactions);
  const trips = useAdvancedStore((state) => state.trips);
  const householdMembers = useAdvancedStore((state) => state.householdMembers);
  const { snapshot, logout } = useServerAuth();
  const fileInput = useRef<HTMLInputElement>(null);
  const [clearingData, setClearingData] = useState(false);
  const activeHousehold = snapshot?.households.find(
    (item) => item.id === snapshot.activeHouseholdId,
  );
  const isOwner = serverMode && !!snapshot && activeHousehold?.role === "owner";
  const canManageHousehold =
    !serverMode || activeHousehold?.role === "owner" || activeHousehold?.role === "admin";

  const tabs = useMemo<TabItem[]>(() => {
    const base: TabItem[] = [
      { id: "general", label: "Ogólne", icon: UserRound },
      { id: "appearance", label: "Wygląd", icon: Sun },
      { id: "notifications", label: "Powiadomienia", icon: Bell },
      { id: "data", label: "Dane", icon: Database },
    ];
    if (isOwner) {
      base.push({ id: "users", label: "Użytkownicy", icon: UsersRound });
      base.push({ id: "danger", label: "Strefa niebezpieczna", icon: ShieldAlert });
    }
    return base;
  }, [isOwner]);

  const [activeTab, setActiveTab] = useState<string>("general");

  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) setActiveTab("general");
  }, [tabs, activeTab]);

  const requestNotifications = async () => {
    if (!("Notification" in window)) {
      onToast("Ta przeglądarka nie obsługuje powiadomień systemowych");
      return;
    }
    const permission = await Notification.requestPermission();
    const enabled = permission === "granted";
    if (enabled && serverMode && "serviceWorker" in navigator && "PushManager" in window) {
      try {
        const { publicKey } = await apiRequest<{ publicKey: string | null }>(
          "/api/v1/push/public-key",
        );
        if (publicKey) {
          const registration = await navigator.serviceWorker.ready;
          const subscription =
            (await registration.pushManager.getSubscription()) ??
            (await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(publicKey),
            }));
          await apiRequest("/api/v1/push/subscriptions", {
            method: "POST",
            json: subscription.toJSON(),
          });
        }
      } catch {
        onToast("Powiadomienia w aplikacji działają, ale push z serwera wymaga konfiguracji VAPID");
      }
    }
    updatePreferences({ notificationsEnabled: enabled });
    onToast(enabled ? "Powiadomienia są włączone" : "Powiadomienia nie zostały włączone");
  };

  const disableNotifications = async () => {
    await removeCurrentPushSubscription().catch(() => undefined);
    updatePreferences({ notificationsEnabled: false });
    onToast("Powiadomienia push są wyłączone na tym urządzeniu");
  };

  const downloadBackup = () => {
    const backup = {
      schemaVersion: 2,
      appVersion: "2.0.0",
      exportedAt: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      data: { life: exportData(), advanced: exportAdvancedData() },
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `puls-kopia-${format(new Date(), "yyyy-MM-dd")}.json`;
    link.click();
    URL.revokeObjectURL(url);
    onToast("Kopia danych została przygotowana");
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const v2Result = backupEnvelopeV2Schema.safeParse(parsed);
      if (v2Result.success) {
        replaceData(v2Result.data.data.life);
        replaceAdvancedData(v2Result.data.data.advanced);
        onToast("Kopia Puls 2.0 została przywrócona");
        return;
      }
      const envelopeResult = backupEnvelopeSchema.safeParse(parsed);
      const result = envelopeResult.success
        ? { success: true as const, data: envelopeResult.data.data }
        : lifeDataSchema.safeParse(parsed);
      if (!result.success) throw new Error("invalid-schema");
      replaceData(result.data);
      onToast("Kopia danych została przywrócona");
    } catch {
      onToast("Nie udało się wczytać pliku — obecne dane pozostały bez zmian");
    }
  };

  const clearAllAppData = async () => {
    if (
      !window.confirm(
        "Czy na pewno chcesz całkowicie wyczyścić dane aplikacji? Tej operacji nie można cofnąć.",
      )
    )
      return;
    // Finanse nie są już częścią dokumentu JSONB, więc nie da się ich wyczyścić samym lokalnym
    // replaceAdvancedData -- trzeba jawnie poprosić serwer o usunięcie znormalizowanych rekordów.
    // Robimy to PRZED czyszczeniem reszty i przerywamy przy błędzie sieci, żeby nie pokazać
    // "wyczyszczono", gdy finanse w rzeczywistości przetrwały na serwerze i wrócą przy kolejnej
    // synchronizacji.
    setClearingData(true);
    try {
      await apiRequest("/api/v1/finance/reset", { method: "POST", json: {} });
    } catch (error) {
      onToast(
        error instanceof Error
          ? error.message
          : "Nie udało się wyczyścić danych finansowych na serwerze — spróbuj ponownie",
      );
      return;
    } finally {
      setClearingData(false);
    }
    replaceData({
      tasks: [],
      events: [],
      reminders: [],
      notes: [],
      habits: [],
      scratchpad: "",
      intention: "",
      energy: "medium",
      preferences,
    });
    replaceAdvancedData({
      householdName: "Dom",
      hideAmounts: false,
      householdMembers: [],
      trips: [],
      tripItinerary: [],
      tripBookings: [],
      packingItems: [],
      subscriptions: [],
      recipes: [],
      mealSlots: [],
      shoppingItems: [],
      vehicles: [],
      carExpenses: [],
      vehicleDeadlines: [],
      pets: [],
      petExpenses: [],
      petVisits: [],
      healthAppointments: [],
      medications: [],
      healthMeasurements: [],
    });
    resetFinanceData();
    onToast("Dane aplikacji zostały całkowicie wyczyszczone");
  };

  return (
    <div className="settings-page page-enter">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Puls dopasowany do Ciebie</span>
          <h1>Ustawienia</h1>
          <p>Konto, wspólny dom, integracje, wygląd i bezpieczna kopia danych.</p>
        </div>
      </header>

      <Tabs
        tabs={tabs}
        activeId={activeTab}
        onChange={setActiveTab}
        idBase={SETTINGS_TABS_ID_BASE}
        ariaLabel="Sekcje ustawień"
      />

      {activeTab === "general" && (
        <section
          role="tabpanel"
          id={`${SETTINGS_TABS_ID_BASE}-panel-general`}
          aria-labelledby={`${SETTINGS_TABS_ID_BASE}-tab-general`}
          tabIndex={0}
          className="settings-grid"
        >
          <section className="panel settings-card">
            <header>
              <span className="settings-icon">
                <UserRound size={19} />
              </span>
              <div>
                <h2>O Tobie</h2>
                <p>Drobna personalizacja porannego widoku.</p>
              </div>
            </header>
            <label className="field">
              <span>Jak mam się do Ciebie zwracać?</span>
              <input
                value={preferences.name}
                onChange={(event) => updatePreferences({ name: event.target.value })}
                placeholder="Twoje imię"
              />
            </label>
            <div className="settings-row">
              <div>
                <strong>Tydzień zaczyna się w poniedziałek</strong>
                <span>{preferences.weekStartsOnMonday ? "Poniedziałek" : "Niedziela"}</span>
              </div>
              <button
                className={
                  preferences.weekStartsOnMonday ? "toggle-switch active" : "toggle-switch"
                }
                type="button"
                onClick={() =>
                  updatePreferences({ weekStartsOnMonday: !preferences.weekStartsOnMonday })
                }
                aria-label="Tydzień zaczyna się w poniedziałek"
                aria-pressed={preferences.weekStartsOnMonday}
              >
                <span />
              </button>
            </div>
          </section>

          {serverMode && <GoogleCalendarSettings onToast={onToast} />}

          {serverMode && snapshot && (
            <section className="panel settings-card settings-card--danger">
              <header>
                <span className="settings-icon">
                  <LogOut size={19} />
                </span>
                <div>
                  <h2>Sesja</h2>
                  <p>Zalogowano jako {snapshot.user.email}</p>
                </div>
              </header>
              <button
                className="button button--danger-ghost"
                type="button"
                onClick={() => void logout()}
              >
                <LogOut size={16} /> Wyloguj się
              </button>
            </section>
          )}

          <section className="about-card">
            <span className="brand__mark">P</span>
            <div>
              <strong>Puls 2.0</strong>
              <p>Self-hosted centrum codziennego życia.</p>
            </div>
            <Check size={17} />
            <span>
              {serverMode ? `${householdMembers.length} osoby we wspólnym domu` : "Tryb lokalny"}
            </span>
          </section>
        </section>
      )}

      {activeTab === "appearance" && (
        <section
          role="tabpanel"
          id={`${SETTINGS_TABS_ID_BASE}-panel-appearance`}
          aria-labelledby={`${SETTINGS_TABS_ID_BASE}-tab-appearance`}
          tabIndex={0}
          className="settings-panel--single"
        >
          <section className="panel settings-card">
            <header>
              <span className="settings-icon">
                <Sun size={19} />
              </span>
              <div>
                <h2>Wygląd</h2>
                <p>Wybierz motyw wygodny dla oczu.</p>
              </div>
            </header>
            <div className="theme-options">
              <ThemeOption
                value="light"
                current={preferences.theme}
                onSelect={(theme) => updatePreferences({ theme })}
                icon={Sun}
                label="Jasny"
              />
              <ThemeOption
                value="dark"
                current={preferences.theme}
                onSelect={(theme) => updatePreferences({ theme })}
                icon={Moon}
                label="Ciemny"
              />
              <ThemeOption
                value="system"
                current={preferences.theme}
                onSelect={(theme) => updatePreferences({ theme })}
                icon={Laptop}
                label="Systemowy"
              />
            </div>
          </section>
        </section>
      )}

      {activeTab === "notifications" && (
        <section
          role="tabpanel"
          id={`${SETTINGS_TABS_ID_BASE}-panel-notifications`}
          aria-labelledby={`${SETTINGS_TABS_ID_BASE}-tab-notifications`}
          tabIndex={0}
          className="settings-panel--single"
        >
          <section className="panel settings-card settings-card--notifications">
            <header>
              <span className="settings-icon">
                <Bell size={19} />
              </span>
              <div>
                <h2>Powiadomienia</h2>
                <p>
                  {serverMode
                    ? "Systemowe przypomnienia również po zamknięciu PWA."
                    : "Przypomnienia, kiedy dashboard jest otwarty."}
                </p>
              </div>
            </header>
            <div className="settings-row">
              <div>
                <strong>Powiadomienia przeglądarki</strong>
                <span>{preferences.notificationsEnabled ? "Włączone" : "Wyłączone"}</span>
              </div>
              <button
                className={
                  preferences.notificationsEnabled ? "toggle-switch active" : "toggle-switch"
                }
                type="button"
                onClick={
                  preferences.notificationsEnabled
                    ? () => void disableNotifications()
                    : requestNotifications
                }
                aria-label="Powiadomienia przeglądarki"
                aria-pressed={preferences.notificationsEnabled}
              >
                <span />
              </button>
            </div>
            <div className="info-callout">
              <Info size={16} />
              <p>
                {serverMode
                  ? "PWA może odbierać przypomnienia push również po zamknięciu dashboardu, jeśli serwer ma skonfigurowane klucze VAPID."
                  : "Przeglądarka może wysłać alert tylko wtedy, gdy aplikacja jest otwarta."}
              </p>
            </div>
          </section>
        </section>
      )}

      {activeTab === "data" && (
        <section
          role="tabpanel"
          id={`${SETTINGS_TABS_ID_BASE}-panel-data`}
          aria-labelledby={`${SETTINGS_TABS_ID_BASE}-tab-data`}
          tabIndex={0}
          className="settings-panel--single"
        >
          <section className="panel settings-card settings-card--data">
            <header>
              <span className="settings-icon">
                <Database size={19} />
              </span>
              <div>
                <h2>Twoje dane</h2>
                <p>
                  {serverMode
                    ? "Dane są synchronizowane z prywatnym serwerem."
                    : "Wszystko jest zapisane lokalnie w tej przeglądarce."}
                </p>
              </div>
            </header>
            <div className="data-summary">
              <span>
                <strong>{tasks.length}</strong> zadań
              </span>
              <span>
                <strong>{events.length}</strong> wydarzeń
              </span>
              <span>
                <strong>{financeTransactions.length}</strong> transakcji
              </span>
              <span>
                <strong>{trips.length}</strong> podróży
              </span>
            </div>
            <div className="backup-actions">
              <button className="button button--soft" type="button" onClick={downloadBackup}>
                <Download size={16} /> Eksportuj kopię
              </button>
              {canManageHousehold && (
                <button
                  className="button button--ghost-border"
                  type="button"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={16} /> Importuj dane
                </button>
              )}
              <input
                ref={fileInput}
                hidden
                type="file"
                accept="application/json,.json"
                onChange={importBackup}
              />
            </div>
            <div className="privacy-note">
              <ShieldCheck size={16} />
              <span>
                {serverMode
                  ? "Dane pozostają na Twoim serwerze i są oddzielone per gospodarstwo."
                  : "Bez konta, bez wysyłania danych, bez śledzenia."}
              </span>
            </div>
          </section>
        </section>
      )}

      {activeTab === "users" && isOwner && (
        <section
          role="tabpanel"
          id={`${SETTINGS_TABS_ID_BASE}-panel-users`}
          aria-labelledby={`${SETTINGS_TABS_ID_BASE}-tab-users`}
          tabIndex={0}
          className="settings-panel--single"
        >
          <UsersSettings onToast={onToast} />
        </section>
      )}

      {activeTab === "danger" && isOwner && (
        <section
          role="tabpanel"
          id={`${SETTINGS_TABS_ID_BASE}-panel-danger`}
          aria-labelledby={`${SETTINGS_TABS_ID_BASE}-tab-danger`}
          tabIndex={0}
          className="danger-zone"
        >
          <header className="danger-zone__header">
            <AlertTriangle size={17} />
            <div>
              <h2>Strefa niebezpieczna</h2>
              <p>Poniższe działanie jest nieodwracalne — zachowaj ostrożność.</p>
            </div>
          </header>
          <div className="panel settings-card settings-card--danger">
            <header>
              <span className="settings-icon">
                <Trash2 size={19} />
              </span>
              <div>
                <h2>Wyczyść dane aplikacji</h2>
                <p>
                  Usuwa na stałe wszystkie zadania, wydarzenia, notatki, finanse i pozostałe
                  zapisane dane.
                </p>
              </div>
            </header>
            <button
              className="button button--danger-ghost"
              type="button"
              disabled={clearingData}
              onClick={() => void clearAllAppData()}
            >
              <Trash2 size={16} /> {clearingData ? "Czyszczenie…" : "Wyczyść wszystkie dane"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

interface MemberRecord {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  joined_at?: string;
}

function roleLabel(role: MemberRecord["role"]) {
  if (role === "owner") return "Właściciel";
  if (role === "admin") return "Administrator";
  return "Członek";
}

function UsersSettings({ onToast }: { onToast: (message: string) => void }) {
  const { snapshot, refresh } = useServerAuth();
  const household = snapshot?.households.find((item) => item.id === snapshot.activeHouseholdId);
  const currentUserId = snapshot?.user.id;
  const [email, setEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [memberToRemove, setMemberToRemove] = useState<MemberRecord | null>(null);
  const [removing, setRemoving] = useState(false);

  const loadMembers = () =>
    apiRequest<{ members: MemberRecord[] }>("/api/v1/households/current/members")
      .then((result) => setMembers(result.members))
      .catch(() => undefined);

  useEffect(() => {
    void loadMembers();
  }, []);

  const submitInvite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await apiRequest<{ inviteUrl: string }>(
        "/api/v1/households/current/invitations",
        {
          method: "POST",
          json: { email: email || undefined, role: "member" },
        },
      );
      setInviteUrl(result.inviteUrl);
      setEmail("");
      onToast("Zaproszenie jest gotowe i ważne przez 7 dni");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Nie udało się utworzyć zaproszenia");
    } finally {
      setBusy(false);
    }
  };

  const closeRemoveModal = () => {
    if (removing) return;
    setMemberToRemove(null);
  };

  const confirmRemove = async () => {
    if (!memberToRemove) return;
    setRemoving(true);
    try {
      await apiRequest(`/api/v1/households/current/members/${memberToRemove.id}`, {
        method: "DELETE",
        json: {},
      });
      onToast(`Usunięto ${memberToRemove.name} z gospodarstwa`);
      setMemberToRemove(null);
      await loadMembers();
      await refresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Nie udało się usunąć użytkownika");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <>
      <section className="panel settings-card settings-card--household">
        <header>
          <span className="settings-icon">
            <UsersRound size={19} />
          </span>
          <div>
            <h2>Wspólny dom</h2>
            <p>
              {household?.name ?? "Dom"} · Twoja rola:{" "}
              {household?.role ? roleLabel(household.role) : "—"}
            </p>
          </div>
        </header>
        {members.length > 0 && (
          <ul className="members-list">
            {members.map((member) => {
              const removable = member.role !== "owner" && member.id !== currentUserId;
              return (
                <li key={member.id} className="member-row">
                  <div className="member-row__info">
                    <strong>{member.name}</strong>
                    <span>{member.email}</span>
                  </div>
                  <span className={`member-role-badge member-role-badge--${member.role}`}>
                    {roleLabel(member.role)}
                  </span>
                  {removable && (
                    <button
                      className="icon-button icon-button--danger"
                      type="button"
                      onClick={() => setMemberToRemove(member)}
                      aria-label={`Usuń ${member.name} z gospodarstwa`}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <form className="invite-form" onSubmit={submitInvite}>
          <label className="field">
            <span>Zaproś przez e-mail</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Opcjonalnie — link może być uniwersalny"
            />
          </label>
          <button className="button button--soft" type="submit" disabled={busy}>
            <Link2 size={15} /> Utwórz link
          </button>
        </form>
        {inviteUrl && (
          <div className="invite-link">
            <span>{inviteUrl}</span>
            <button
              className="icon-button"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(inviteUrl);
                onToast("Link skopiowany");
              }}
              aria-label="Skopiuj zaproszenie"
            >
              <Copy size={15} />
            </button>
          </div>
        )}
      </section>

      <Modal
        open={memberToRemove !== null}
        onClose={closeRemoveModal}
        title="Usuń członka gospodarstwa"
        eyebrow="Nieodwracalne"
        size="small"
      >
        {memberToRemove && (
          <div className="remove-member-confirm">
            <p>
              Czy na pewno chcesz usunąć <strong>{memberToRemove.name}</strong> (
              {memberToRemove.email}) z gospodarstwa?
            </p>
            <p className="remove-member-confirm__warning">
              <AlertTriangle size={15} /> Ta operacja jest nieodwracalna — usunie też wszystkie jego
              prywatne dane w tym gospodarstwie (prywatne konta, podróże, samochody i ustawienia).
            </p>
            <div className="modal-actions">
              <button
                className="button button--ghost-border"
                type="button"
                onClick={closeRemoveModal}
                disabled={removing}
              >
                Anuluj
              </button>
              <button
                className="button button--danger-ghost"
                type="button"
                onClick={() => void confirmRemove()}
                disabled={removing}
              >
                {removing ? "Usuwanie…" : "Usuń z gospodarstwa"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function GoogleCalendarSettings({ onToast }: { onToast: (message: string) => void }) {
  const [status, setStatus] = useState<{
    configured: boolean;
    connected: boolean;
    connection?: { google_email?: string } | null;
  } | null>(null);
  useEffect(() => {
    void apiRequest<typeof status>("/api/v1/integrations/google/status")
      .then(setStatus)
      .catch(() => setStatus({ configured: false, connected: false }));
  }, []);
  const connect = async () => {
    try {
      const result = await apiRequest<{ url: string }>("/api/v1/integrations/google/start", {
        method: "POST",
        json: { returnPath: "/" },
      });
      window.location.assign(result.url);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Nie udało się połączyć kalendarza");
    }
  };
  const disconnect = async () => {
    try {
      await apiRequest("/api/v1/integrations/google", { method: "DELETE", json: {} });
      setStatus((current) =>
        current ? { ...current, connected: false, connection: null } : current,
      );
      onToast("Google Calendar został odłączony");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Nie udało się odłączyć kalendarza");
    }
  };
  return (
    <section className="panel settings-card">
      <header>
        <span className="settings-icon">
          <CalendarSync size={19} />
        </span>
        <div>
          <h2>Google Calendar</h2>
          <p>
            {status?.connected
              ? `Połączono: ${status.connection?.google_email ?? "konto Google"}`
              : "Import wydarzeń do wspólnej osi dnia."}
          </p>
        </div>
      </header>
      {status === null ? (
        <div className="info-callout">
          <Info size={16} />
          <p>Sprawdzanie stanu integracji…</p>
        </div>
      ) : !status.configured ? (
        <div className="info-callout">
          <Info size={16} />
          <p>
            Uzupełnij zmienne GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET i GOOGLE_REDIRECT_URI na
            serwerze.
          </p>
        </div>
      ) : (
        <div className="backup-actions">
          <button className="button button--soft" type="button" onClick={() => void connect()}>
            <CalendarSync size={16} /> {status.connected ? "Połącz ponownie" : "Połącz kalendarz"}
          </button>
          {status.connected && (
            <button
              className="button button--ghost-border"
              type="button"
              onClick={() => void disconnect()}
            >
              Odłącz
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function ThemeOption({
  value,
  current,
  onSelect,
  icon: Icon,
  label,
}: {
  value: Theme;
  current: Theme;
  onSelect: (theme: Theme) => void;
  icon: typeof Sun;
  label: string;
}) {
  return (
    <button
      className={current === value ? "theme-option active" : "theme-option"}
      type="button"
      onClick={() => onSelect(value)}
      aria-pressed={current === value}
    >
      <span>
        <Icon size={20} />
      </span>
      <strong>{label}</strong>
      {current === value && <Check size={15} />}
    </button>
  );
}

function urlBase64ToUint8Array(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)))
    .buffer as ArrayBuffer;
}

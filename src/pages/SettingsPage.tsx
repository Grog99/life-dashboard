import {
  AlertTriangle,
  Bell,
  CalendarSync,
  Check,
  Database,
  Download,
  Info,
  Link2,
  LogOut,
  Laptop,
  Moon,
  ShieldCheck,
  Sun,
  Trash2,
  Upload,
  UserRound,
  UsersRound,
  Copy,
} from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { format } from "date-fns";
import {
  backupEnvelopeSchema,
  backupEnvelopeV2Schema,
  lifeDataSchema,
} from "../lib/schema";
import { exportData, useLifeStore } from "../store/useLifeStore";
import { exportAdvancedData, useAdvancedStore } from "../store/useAdvancedStore";
import { apiRequest, serverMode } from "../server/api";
import { useServerAuth } from "../server/AuthGate";
import { removeCurrentPushSubscription } from "../server/push";
import type { Theme } from "../types";

export function SettingsPage({ onToast }: { onToast: (message: string) => void }) {
  const preferences = useLifeStore((state) => state.preferences);
  const updatePreferences = useLifeStore((state) => state.updatePreferences);
  const replaceData = useLifeStore((state) => state.replaceData);
  const tasks = useLifeStore((state) => state.tasks);
  const events = useLifeStore((state) => state.events);
  const replaceAdvancedData = useAdvancedStore((state) => state.replaceAdvancedData);
  const financeTransactions = useAdvancedStore((state) => state.financeTransactions);
  const trips = useAdvancedStore((state) => state.trips);
  const householdMembers = useAdvancedStore((state) => state.householdMembers);
  const { snapshot, logout } = useServerAuth();
  const fileInput = useRef<HTMLInputElement>(null);
  const activeHousehold = snapshot?.households.find((item) => item.id === snapshot.activeHouseholdId);
  const canManageHousehold = !serverMode || activeHousehold?.role === "owner" || activeHousehold?.role === "admin";

  const requestNotifications = async () => {
    if (!("Notification" in window)) {
      onToast("Ta przeglądarka nie obsługuje powiadomień systemowych");
      return;
    }
    const permission = await Notification.requestPermission();
    const enabled = permission === "granted";
    if (enabled && serverMode && "serviceWorker" in navigator && "PushManager" in window) {
      try {
        const { publicKey } = await apiRequest<{ publicKey: string | null }>("/api/v1/push/public-key");
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

  const clearAllAppData = () => {
    if (!window.confirm("Czy na pewno chcesz całkowicie wyczyścić dane aplikacji? Tej operacji nie można cofnąć.")) return;
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
      financeAccounts: [],
      financeTransactions: [],
      financeBudgets: [],
      savingsGoals: [],
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
      healthAppointments: [],
      medications: [],
      healthMeasurements: [],
    });
    onToast("Dane aplikacji zostały całkowicie wyczyszczone");
  };

  return (
    <div className="settings-page page-enter">
      <header className="page-header">
        <div><span className="page-eyebrow">Puls dopasowany do Ciebie</span><h1>Ustawienia</h1><p>Konto, wspólny dom, integracje, wygląd i bezpieczna kopia danych.</p></div>
      </header>

      <div className="settings-grid">
        {serverMode && snapshot && <HouseholdSettings onToast={onToast} />}

        <section className="panel settings-card">
          <header><span className="settings-icon"><UserRound size={19} /></span><div><h2>O Tobie</h2><p>Drobna personalizacja porannego widoku.</p></div></header>
          <label className="field"><span>Jak mam się do Ciebie zwracać?</span><input value={preferences.name} onChange={(event) => updatePreferences({ name: event.target.value })} placeholder="Twoje imię" /></label>
          <div className="settings-row">
            <div><strong>Tydzień zaczyna się w poniedziałek</strong><span>{preferences.weekStartsOnMonday ? "Poniedziałek" : "Niedziela"}</span></div>
            <button className={preferences.weekStartsOnMonday ? "toggle-switch active" : "toggle-switch"} type="button" onClick={() => updatePreferences({ weekStartsOnMonday: !preferences.weekStartsOnMonday })} aria-label="Tydzień zaczyna się w poniedziałek" aria-pressed={preferences.weekStartsOnMonday}><span /></button>
          </div>
        </section>

        {serverMode && <GoogleCalendarSettings onToast={onToast} />}

        <section className="panel settings-card">
          <header><span className="settings-icon"><Sun size={19} /></span><div><h2>Wygląd</h2><p>Wybierz motyw wygodny dla oczu.</p></div></header>
          <div className="theme-options">
            <ThemeOption value="light" current={preferences.theme} onSelect={(theme) => updatePreferences({ theme })} icon={Sun} label="Jasny" />
            <ThemeOption value="dark" current={preferences.theme} onSelect={(theme) => updatePreferences({ theme })} icon={Moon} label="Ciemny" />
            <ThemeOption value="system" current={preferences.theme} onSelect={(theme) => updatePreferences({ theme })} icon={Laptop} label="Systemowy" />
          </div>
        </section>

        <section className="panel settings-card settings-card--notifications">
          <header><span className="settings-icon"><Bell size={19} /></span><div><h2>Powiadomienia</h2><p>{serverMode ? "Systemowe przypomnienia również po zamknięciu PWA." : "Przypomnienia, kiedy dashboard jest otwarty."}</p></div></header>
          <div className="settings-row">
            <div><strong>Powiadomienia przeglądarki</strong><span>{preferences.notificationsEnabled ? "Włączone" : "Wyłączone"}</span></div>
            <button className={preferences.notificationsEnabled ? "toggle-switch active" : "toggle-switch"} type="button" onClick={preferences.notificationsEnabled ? () => void disableNotifications() : requestNotifications} aria-label="Powiadomienia przeglądarki" aria-pressed={preferences.notificationsEnabled}><span /></button>
          </div>
          <div className="info-callout"><Info size={16} /><p>{serverMode ? "PWA może odbierać przypomnienia push również po zamknięciu dashboardu, jeśli serwer ma skonfigurowane klucze VAPID." : "Przeglądarka może wysłać alert tylko wtedy, gdy aplikacja jest otwarta."}</p></div>
        </section>

        <section className="panel settings-card settings-card--data">
          <header><span className="settings-icon"><Database size={19} /></span><div><h2>Twoje dane</h2><p>{serverMode ? "Dane są synchronizowane z prywatnym serwerem." : "Wszystko jest zapisane lokalnie w tej przeglądarce."}</p></div></header>
          <div className="data-summary"><span><strong>{tasks.length}</strong> zadań</span><span><strong>{events.length}</strong> wydarzeń</span><span><strong>{financeTransactions.length}</strong> transakcji</span><span><strong>{trips.length}</strong> podróży</span></div>
          <div className="backup-actions">
            <button className="button button--soft" type="button" onClick={downloadBackup}><Download size={16} /> Eksportuj kopię</button>
            {canManageHousehold && <button className="button button--ghost-border" type="button" onClick={() => fileInput.current?.click()}><Upload size={16} /> Importuj dane</button>}
            <input ref={fileInput} hidden type="file" accept="application/json,.json" onChange={importBackup} />
          </div>
          <div className="privacy-note"><ShieldCheck size={16} /><span>{serverMode ? "Dane pozostają na Twoim serwerze i są oddzielone per gospodarstwo." : "Bez konta, bez wysyłania danych, bez śledzenia."}</span></div>
        </section>

        {serverMode && snapshot && <section className="panel settings-card settings-card--danger"><header><span className="settings-icon"><LogOut size={19} /></span><div><h2>Sesja</h2><p>Zalogowano jako {snapshot.user.email}</p></div></header><button className="button button--danger-ghost" type="button" onClick={() => void logout()}><LogOut size={16} /> Wyloguj się</button></section>}

        <section className="about-card">
          <span className="brand__mark">P</span><div><strong>Puls 2.0</strong><p>Self-hosted centrum codziennego życia.</p></div><Check size={17} /><span>{serverMode ? `${householdMembers.length} osoby we wspólnym domu` : "Tryb lokalny"}</span>
        </section>
      </div>

      {canManageHousehold && (
        <section className="danger-zone">
          <header className="danger-zone__header">
            <AlertTriangle size={17} />
            <div><h2>Strefa niebezpieczna</h2><p>Poniższe działanie jest nieodwracalne — zachowaj ostrożność.</p></div>
          </header>
          <div className="panel settings-card settings-card--danger">
            <header><span className="settings-icon"><Trash2 size={19} /></span><div><h2>Wyczyść dane aplikacji</h2><p>Usuwa na stałe wszystkie zadania, wydarzenia, notatki, finanse i pozostałe zapisane dane.</p></div></header>
            <button className="button button--danger-ghost" type="button" onClick={clearAllAppData}><Trash2 size={16} /> Wyczyść wszystkie dane</button>
          </div>
        </section>
      )}
    </div>
  );
}

function HouseholdSettings({ onToast }: { onToast: (message: string) => void }) {
  const { snapshot } = useServerAuth();
  const household = snapshot?.households.find((item) => item.id === snapshot.activeHouseholdId);
  const canInvite = household?.role === "owner" || household?.role === "admin";
  const [email, setEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<Array<{ id: string; name: string; email: string; role: string }>>([]);
  useEffect(() => { void apiRequest<{ members: typeof members }>("/api/v1/households/current/members").then((result) => setMembers(result.members)).catch(() => undefined); }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try {
      const result = await apiRequest<{ inviteUrl: string }>("/api/v1/households/current/invitations", { method: "POST", json: { email: email || undefined, role: "member" } });
      setInviteUrl(result.inviteUrl); setEmail(""); onToast("Zaproszenie jest gotowe i ważne przez 7 dni");
    } catch (error) { onToast(error instanceof Error ? error.message : "Nie udało się utworzyć zaproszenia"); }
    finally { setBusy(false); }
  };
  return <section className="panel settings-card settings-card--household"><header><span className="settings-icon"><UsersRound size={19} /></span><div><h2>Wspólny dom</h2><p>{household?.name ?? "Dom"} · Twoja rola: {household?.role}</p></div></header>{members.length > 0 && <div className="data-summary">{members.map((member) => <span key={member.id}><strong>{member.name}</strong>{member.role}</span>)}</div>}{canInvite && <form className="invite-form" onSubmit={submit}><label className="field"><span>Zaproś przez e-mail</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Opcjonalnie — link może być uniwersalny" /></label><button className="button button--soft" type="submit" disabled={busy}><Link2 size={15} /> Utwórz link</button></form>}{inviteUrl && <div className="invite-link"><span>{inviteUrl}</span><button className="icon-button" type="button" onClick={() => { void navigator.clipboard.writeText(inviteUrl); onToast("Link skopiowany"); }} aria-label="Skopiuj zaproszenie"><Copy size={15} /></button></div>}</section>;
}

function GoogleCalendarSettings({ onToast }: { onToast: (message: string) => void }) {
  const [status, setStatus] = useState<{ configured: boolean; connected: boolean; connection?: { google_email?: string } | null } | null>(null);
  useEffect(() => { void apiRequest<typeof status>("/api/v1/integrations/google/status").then(setStatus).catch(() => setStatus({ configured: false, connected: false })); }, []);
  const connect = async () => { try { const result = await apiRequest<{ url: string }>("/api/v1/integrations/google/start", { method: "POST", json: { returnPath: "/" } }); window.location.assign(result.url); } catch (error) { onToast(error instanceof Error ? error.message : "Nie udało się połączyć kalendarza"); } };
  const disconnect = async () => {
    try {
      await apiRequest("/api/v1/integrations/google", { method: "DELETE", json: {} });
      setStatus((current) => current ? { ...current, connected: false, connection: null } : current);
      onToast("Google Calendar został odłączony");
    } catch (error) { onToast(error instanceof Error ? error.message : "Nie udało się odłączyć kalendarza"); }
  };
  return <section className="panel settings-card"><header><span className="settings-icon"><CalendarSync size={19} /></span><div><h2>Google Calendar</h2><p>{status?.connected ? `Połączono: ${status.connection?.google_email ?? "konto Google"}` : "Import wydarzeń do wspólnej osi dnia."}</p></div></header>{status === null ? <div className="info-callout"><Info size={16} /><p>Sprawdzanie stanu integracji…</p></div> : !status.configured ? <div className="info-callout"><Info size={16} /><p>Uzupełnij zmienne GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET i GOOGLE_REDIRECT_URI na serwerze.</p></div> : <div className="backup-actions"><button className="button button--soft" type="button" onClick={() => void connect()}><CalendarSync size={16} /> {status.connected ? "Połącz ponownie" : "Połącz kalendarz"}</button>{status.connected && <button className="button button--ghost-border" type="button" onClick={() => void disconnect()}>Odłącz</button>}</div>}</section>;
}

function ThemeOption({ value, current, onSelect, icon: Icon, label }: { value: Theme; current: Theme; onSelect: (theme: Theme) => void; icon: typeof Sun; label: string }) {
  return <button className={current === value ? "theme-option active" : "theme-option"} type="button" onClick={() => onSelect(value)} aria-pressed={current === value}><span><Icon size={20} /></span><strong>{label}</strong>{current === value && <Check size={15} />}</button>;
}

function urlBase64ToUint8Array(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0))).buffer as ArrayBuffer;
}

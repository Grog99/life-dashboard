import { useEffect, useRef } from "react";
import { useLifeStore } from "../store/useLifeStore";
import { toDateTime } from "../lib/date";
import type { Reminder } from "../types";

export function useReminderEngine(onDue: (reminder: Reminder) => void): void {
  const delivered = useRef(new Set<string>());
  const reminders = useLifeStore((state) => state.reminders);
  const notificationsEnabled = useLifeStore(
    (state) => state.preferences.notificationsEnabled,
  );
  const markReminderNotified = useLifeStore((state) => state.markReminderNotified);

  useEffect(() => {
    const check = () => {
      const now = new Date();
      reminders.forEach((reminder) => {
        if (!reminder.notifiedAt && toDateTime(reminder.date, reminder.time) > now) {
          delivered.current.delete(reminder.id);
        }
      });
      const reminder = reminders
        .filter(
          (item) =>
            !item.done &&
            !item.notifiedAt &&
            !delivered.current.has(item.id) &&
            toDateTime(item.date, item.time) <= now,
        )
        .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))[0];
      if (!reminder) return;

      delivered.current.add(reminder.id);
      onDue(reminder);
      markReminderNotified(reminder.id);

      if (
        notificationsEnabled &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        new Notification("Puls — przypomnienie", {
          body: reminder.title,
          icon: "/favicon.svg",
          tag: `reminder-${reminder.id}-${reminder.date}T${reminder.time}`,
        });
      }
    };

    check();
    const interval = window.setInterval(check, 30_000);
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [markReminderNotified, notificationsEnabled, onDue, reminders]);
}

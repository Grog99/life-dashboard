import webpush from "web-push";
import { pool, query } from "./db.mjs";

const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 30_000);
if (!Number.isFinite(intervalMs) || intervalMs < 5_000 || intervalMs > 3_600_000) {
  throw new Error("WORKER_INTERVAL_MS must be between 5000 and 3600000");
}
let lastMaintenanceAt = 0;

if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.warn("VAPID keys are not configured; worker will not send web push notifications");
} else {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

function localNowKey(timezone) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone || "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

async function deliverReminder(workspace, reminder, targetUserId = null) {
  const members = await query(
    `SELECT hm.user_id, ps.id AS subscription_id, ps.endpoint, ps.p256dh, ps.auth_secret
       FROM household_members hm
       JOIN push_subscriptions ps ON ps.user_id = hm.user_id
      WHERE hm.household_id = $1 AND ($2::uuid IS NULL OR hm.user_id = $2)`,
    [workspace.household_id, targetUserId],
  );
  const occurrence = `${reminder.date}T${reminder.time}`;
  for (const member of members.rows) {
    const claim = await query(
      `INSERT INTO notification_deliveries(household_id, user_id, subscription_id, reminder_id, occurrence)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (household_id, subscription_id, reminder_id, occurrence, channel)
       DO UPDATE SET status = 'claimed', claimed_at = now(), next_attempt_at = NULL,
                     attempt_count = notification_deliveries.attempt_count + 1, error_code = NULL
         WHERE (notification_deliveries.status = 'failed'
                AND notification_deliveries.attempt_count < 5
                AND notification_deliveries.next_attempt_at <= now())
            OR (notification_deliveries.status = 'claimed'
                AND notification_deliveries.claimed_at < now() - interval '5 minutes')
       RETURNING id, attempt_count`,
      [workspace.household_id, member.user_id, member.subscription_id, reminder.id, occurrence],
    );
    if (!claim.rowCount) continue;
    try {
      await webpush.sendNotification(
        { endpoint: member.endpoint, keys: { p256dh: member.p256dh, auth: member.auth_secret } },
        JSON.stringify({
          title: "Puls — przypomnienie",
          body: reminder.title,
          tag: `reminder-${reminder.id}-${occurrence}`,
          url: "/",
        }),
        { TTL: 3600, urgency: "normal", timeout: 15_000 },
      );
      await query(
        "UPDATE notification_deliveries SET status = 'delivered', delivered_at = now() WHERE id = $1",
        [claim.rows[0].id],
      );
    } catch (error) {
      const statusCode = Number(error?.statusCode ?? 0);
      await query(
        `UPDATE notification_deliveries
            SET status = 'failed', error_code = $1,
                next_attempt_at = now() + make_interval(secs => LEAST(3600, 30 * power(2, attempt_count - 1)::integer))
          WHERE id = $2`,
        [String(statusCode || error?.code || "push_error").slice(0, 80), claim.rows[0].id],
      );
      if (statusCode === 404 || statusCode === 410) {
        await query("DELETE FROM push_subscriptions WHERE endpoint = $1", [member.endpoint]);
      }
    }
  }
  if (!members.rowCount) return false;
  const states = await query(
    `SELECT subscription_id, status, attempt_count
       FROM notification_deliveries
      WHERE household_id = $1 AND reminder_id = $2 AND occurrence = $3
        AND subscription_id = ANY($4::uuid[])`,
    [
      workspace.household_id,
      reminder.id,
      occurrence,
      members.rows.map((member) => member.subscription_id),
    ],
  );
  return members.rows.every((member) => {
    const state = states.rows.find((item) => item.subscription_id === member.subscription_id);
    return (
      state?.status === "delivered" || (state?.status === "failed" && state.attempt_count >= 5)
    );
  });
}

function shiftLocalDateTime(date, time, minutes) {
  const parsed = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCMinutes(parsed.getUTCMinutes() + minutes);
  return parsed.toISOString().slice(0, 16).replace("T", " ");
}

function withinDeliveryWindow(dueKey, nowKey, days = 7) {
  if (!dueKey || dueKey > nowKey) return false;
  const oldest = shiftLocalDateTime(nowKey.slice(0, 10), nowKey.slice(11, 16), -days * 24 * 60);
  return Boolean(oldest && dueKey >= oldest);
}

// Trips (Podróże) are no longer part of the workspace JSONB document (server/migrations/
// 007_trips_normalized.sql, docs/plans/podroze-trips.md "Worker"): they live in the normalized `trips`
// table and are always household-wide (no private trips), so this reads them once per household
// instead of going through derivedReminders/data.advanced like the other collections above. Same
// "Za tydzień: <nazwa>" push, same 7-day window and archived-exclusion as before the migration.
async function tripReminders(householdId, nowKey) {
  const result = await query(
    `SELECT id, name, start_date::text AS start_date, status
       FROM trips WHERE household_id = $1 AND status <> 'archived'`,
    [householdId],
  );
  const reminders = [];
  for (const trip of result.rows) {
    const dueKey = shiftLocalDateTime(trip.start_date, "09:00", -7 * 24 * 60);
    if (withinDeliveryWindow(dueKey, nowKey)) {
      reminders.push({
        id: `trip:${trip.id}`,
        title: `Za tydzień: ${trip.name}`,
        date: trip.start_date,
        time: "09:00",
      });
    }
  }
  return reminders;
}

// Car (Auto) deadlines are no longer part of the workspace JSONB document (server/migrations/
// 009_car_normalized.sql, docs/plans/auto-car.md "Worker"): they live in `vehicle_deadlines`, joined to
// `vehicles` for visibility/ownership. Unlike tripReminders (always household-wide), Auto keeps the
// private/shared distinction -- each row also carries a `targetUserId`: null for a household-visible
// vehicle (deliverReminder fans out to every member), or the owner's user id for a private vehicle
// (deliverReminder narrows to that one member). Same 14-day window / completed/dueDate guard as the
// JSONB loop this replaces.
async function carDeadlineReminders(householdId, nowKey) {
  const result = await query(
    `SELECT d.id, d.title, d.due_date::text AS due_date, v.visibility, v.owner_id
       FROM vehicle_deadlines d
       JOIN vehicles v ON v.id = d.vehicle_id
      WHERE d.household_id = $1 AND d.completed = false AND d.due_date IS NOT NULL`,
    [householdId],
  );
  const reminders = [];
  for (const row of result.rows) {
    const dueKey = shiftLocalDateTime(row.due_date, "09:00", -14 * 24 * 60);
    if (withinDeliveryWindow(dueKey, nowKey, 14)) {
      reminders.push({
        reminder: {
          id: `vehicle:${row.id}`,
          title: `Samochód: ${row.title}`,
          date: row.due_date,
          time: "09:00",
        },
        targetUserId: row.visibility === "private" ? row.owner_id : null,
      });
    }
  }
  return reminders;
}

// Pets (Zwierzęta): pet_visits is a normalized table, not part of the workspace JSONB document (see
// docs/plans/zwierzeta-sql.md and server/src/pets.mjs) -- this replaces the advanced.petVisits loop
// that used to live in derivedReminders. Simpler than carDeadlineReminders: no JOIN, because each
// visit already carries its own visibility/owner_id (unlike vehicle_deadlines, which inherits from
// its parent vehicle), and the reminder time comes from the row's own `time` column instead of a
// fixed "09:00". Same targeting rule: null = every household member, owner_id = only that member.
async function petVisitReminders(householdId, nowKey) {
  const result = await query(
    `SELECT id, title, date::text AS date, time, visibility, owner_id
       FROM pet_visits
      WHERE household_id = $1 AND status = 'scheduled'`,
    [householdId],
  );
  const reminders = [];
  for (const row of result.rows) {
    const dueKey = shiftLocalDateTime(row.date, row.time, -24 * 60);
    if (withinDeliveryWindow(dueKey, nowKey, 2)) {
      reminders.push({
        reminder: {
          id: `pet-visit:${row.id}`,
          title: `Wizyta u weterynarza: ${row.title}`,
          date: row.date,
          time: row.time,
        },
        targetUserId: row.visibility === "private" ? row.owner_id : null,
      });
    }
  }
  return reminders;
}

// Health (Zdrowie): health_appointments/medications are normalized tables, not part of the
// workspace JSONB document (see docs/plans/zdrowie-sql.md and server/src/health.mjs) -- these
// replace the advanced.healthAppointments/advanced.medications loops that used to live in
// derivedReminders. Same shape as petVisitReminders: no JOIN, each row already carries its own
// visibility/owner_id, and the reminder time comes from the row's own `time`/`reminder_time`
// column. Same targeting rule: null = every household member, owner_id = only that member.
async function healthAppointmentReminders(householdId, nowKey) {
  const result = await query(
    `SELECT id, title, date::text AS date, time, visibility, owner_id
       FROM health_appointments
      WHERE household_id = $1 AND status = 'scheduled'`,
    [householdId],
  );
  const reminders = [];
  for (const row of result.rows) {
    const dueKey = shiftLocalDateTime(row.date, row.time, -24 * 60);
    if (withinDeliveryWindow(dueKey, nowKey, 2)) {
      reminders.push({
        reminder: {
          id: `health-appointment:${row.id}`,
          title: `Nadchodzi wizyta: ${row.title}`,
          date: row.date,
          time: row.time,
        },
        targetUserId: row.visibility === "private" ? row.owner_id : null,
      });
    }
  }
  return reminders;
}

// `date: today` (not the medication's own date, it has none) preserves the daily dedup key
// (`occurrence = today T reminderTime`) 1:1 with the pre-migration JSONB loop -- one push per
// day, no duplicates/gaps (docs/plans/zdrowie-sql.md "Ryzyka": "Regresja obu pushów zdrowia").
// The `last_taken_on <> today` filter is done in SQL rather than JS, but is equivalent to the
// old `medication.lastTakenOn !== today` check (IS DISTINCT FROM also treats NULL as "not today").
async function medicationReminders(householdId, nowKey) {
  const today = nowKey.slice(0, 10);
  const result = await query(
    `SELECT id, name, dosage, reminder_time, visibility, owner_id
       FROM medications
      WHERE household_id = $1 AND active = true AND reminder_time IS NOT NULL
        AND last_taken_on IS DISTINCT FROM $2::date`,
    [householdId, today],
  );
  const reminders = [];
  for (const row of result.rows) {
    if (
      /^\d{2}:\d{2}$/.test(row.reminder_time ?? "") &&
      `${today} ${row.reminder_time}` <= nowKey
    ) {
      reminders.push({
        reminder: {
          id: `medication:${row.id}`,
          title: `Pora przyjąć: ${row.name} ${row.dosage}`,
          date: today,
          time: row.reminder_time,
        },
        targetUserId: row.visibility === "private" ? row.owner_id : null,
      });
    }
  }
  return reminders;
}

// Subscriptions (Subskrypcje): `subscriptions` is a normalized table, not part of the workspace
// JSONB document (see docs/plans/subskrypcje-sql.md and server/src/subscriptions.mjs) -- this
// replaces the `advanced.subscriptions` loop that used to live in derivedReminders. No JOIN --
// each row already carries its own visibility/owner_id. Unlike petVisitReminders/
// healthAppointmentReminders, the offset is PER-ROW (`reminder_days`), not a fixed constant, and
// the delivery window is the default 7 days (`withinDeliveryWindow` called WITHOUT a third
// argument) -- both must stay 1:1 with the pre-migration JSONB loop (docs/plans/subskrypcje-sql.md
// "Ryzyka": "Regresja pushu subskrypcji"). Same targeting rule: null = every household member,
// owner_id = only that member. `time: "09:00"` and `date: next_payment` are kept 1:1 so the
// `notification_deliveries` dedup key (`occurrence`) is unchanged.
async function subscriptionReminders(householdId, nowKey) {
  const result = await query(
    `SELECT id, name, next_payment::text AS next_payment, reminder_days, visibility, owner_id
       FROM subscriptions
      WHERE household_id = $1 AND status <> 'cancelled'`,
    [householdId],
  );
  const reminders = [];
  for (const row of result.rows) {
    const days = Math.max(0, row.reminder_days);
    const dueKey = shiftLocalDateTime(row.next_payment, "09:00", -days * 24 * 60);
    if (withinDeliveryWindow(dueKey, nowKey)) {
      reminders.push({
        reminder: {
          id: `subscription:${row.id}`,
          title: `Nadchodzi płatność: ${row.name}`,
          date: row.next_payment,
          time: "09:00",
        },
        targetUserId: row.visibility === "private" ? row.owner_id : null,
      });
    }
  }
  return reminders;
}

// Life (events): `events` is a normalized table, not part of the workspace JSONB document (see
// docs/plans/zadania-kalendarz-notatki-nawyki-sql.md and server/src/life.mjs) -- this replaces the
// old `derivedReminders`/`deliverDerived` loop that used to read `life.events` from the JSONB
// document. Same shape as petVisitReminders/healthAppointmentReminders: no JOIN, each row already
// carries its own visibility/owner_id. Same "Za 30 min: <title>" push, 30 minutes before
// `date`+`start_time`, SAME 1-day delivery window (not the default 7) and SAME `event:` id prefix
// as before the migration -- both must stay 1:1 to avoid regressing
// docs/plans/zadania-wydarzenia-powtarzalne.md's dedup guarantees. Deterministic occurrence ids
// (`event:seriesId#index`) give each series occurrence its own dedup key in
// `notification_deliveries`, same as before.
async function eventReminders(householdId, nowKey) {
  const result = await query(
    `SELECT id, title, date::text AS date, start_time, visibility, owner_id
       FROM events
      WHERE household_id = $1`,
    [householdId],
  );
  const reminders = [];
  for (const row of result.rows) {
    const dueKey = shiftLocalDateTime(row.date, row.start_time, -30);
    if (withinDeliveryWindow(dueKey, nowKey, 1)) {
      reminders.push({
        reminder: {
          id: `event:${row.id}`,
          title: `Za 30 min: ${row.title}`,
          date: row.date,
          time: row.start_time,
        },
        targetUserId: row.visibility === "private" ? row.owner_id : null,
      });
    }
  }
  return reminders;
}

// Life (reminders): `reminders` is a normalized table, not part of the workspace JSONB document
// (see docs/plans/zadania-kalendarz-notatki-nawyki-sql.md and server/src/life.mjs) -- this
// replaces the old `dueReminders` loop that used to read `life.reminders` from the JSONB document
// (both the shared `workspace_states` loop AND the now-removed private `user_workspace_states`
// loop, unified here because reminders carry their own `visibility`/`owner_id`). Filter mirrors
// `dueReminders` 1:1: not done, not yet notified, due now-or-earlier. `id` carries NO PREFIX
// (parity with the pre-migration behaviour -- prefixing it would break the
// `notification_deliveries` dedup key). After a SUCCESSFUL delivery the caller writes back
// `notified_at` directly on the row (see tick() below), WITHOUT bumping `version` (docs/plans/
// …"Projekt pól specjalnych": `notified_at` is worker-derived, not part of the user's OCC'd
// edit set).
async function manualReminders(householdId, nowKey) {
  const result = await query(
    `SELECT id, title, date::text AS date, time, visibility, owner_id
       FROM reminders
      WHERE household_id = $1 AND done = false AND notified_at IS NULL`,
    [householdId],
  );
  const reminders = [];
  for (const row of result.rows) {
    if (/^\d{2}:\d{2}$/.test(row.time ?? "") && `${row.date} ${row.time}` <= nowKey) {
      reminders.push({
        reminder: { id: row.id, title: row.title, date: row.date, time: row.time },
        targetUserId: row.visibility === "private" ? row.owner_id : null,
      });
    }
  }
  return reminders;
}

async function tick() {
  if (Date.now() - lastMaintenanceAt > 60 * 60_000) {
    await Promise.all([
      query("DELETE FROM sessions WHERE expires_at < now()"),
      query("DELETE FROM oauth_states WHERE expires_at < now()"),
      query("DELETE FROM household_invitations WHERE expires_at < now() - interval '30 days'"),
      query("DELETE FROM notification_deliveries WHERE created_at < now() - interval '180 days'"),
      // finance_mutations/trip_mutations/meal_mutations are idempotency-key dedup windows, not
      // audit logs (see docs/plans/model-synchronizacji-danych.md "Retencja kluczy idempotencji:
      // 30 dni", docs/plans/podroze-trips.md "Worker", and docs/plans/lista-zakupow-meals.md
      // "Prune retencji meal_mutations w workerze").
      query("DELETE FROM finance_mutations WHERE created_at < now() - interval '30 days'"),
      query("DELETE FROM trip_mutations WHERE created_at < now() - interval '30 days'"),
      query("DELETE FROM meal_mutations WHERE created_at < now() - interval '30 days'"),
      query("DELETE FROM car_mutations WHERE created_at < now() - interval '30 days'"),
      query("DELETE FROM pet_mutations WHERE created_at < now() - interval '30 days'"),
      query("DELETE FROM health_mutations WHERE created_at < now() - interval '30 days'"),
      query("DELETE FROM subscription_mutations WHERE created_at < now() - interval '30 days'"),
      query("DELETE FROM life_mutations WHERE created_at < now() - interval '30 days'"),
    ]);
    lastMaintenanceAt = Date.now();
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  const workspaces = await query(
    `SELECT ws.household_id, ws.revision, ws.data, h.timezone
       FROM workspace_states ws JOIN households h ON h.id = ws.household_id`,
  );
  for (const workspace of workspaces.rows) {
    try {
      const nowKey = localNowKey(workspace.timezone);
      for (const reminder of await tripReminders(workspace.household_id, nowKey)) {
        try {
          await deliverReminder(workspace, reminder);
        } catch (error) {
          console.error("Trip reminder failed", {
            householdId: workspace.household_id,
            reminderId: reminder.id,
            error,
          });
        }
      }
      for (const { reminder, targetUserId } of await carDeadlineReminders(
        workspace.household_id,
        nowKey,
      )) {
        try {
          await deliverReminder(workspace, reminder, targetUserId);
        } catch (error) {
          console.error("Car deadline reminder failed", {
            householdId: workspace.household_id,
            reminderId: reminder.id,
            error,
          });
        }
      }
      for (const { reminder, targetUserId } of await petVisitReminders(
        workspace.household_id,
        nowKey,
      )) {
        try {
          await deliverReminder(workspace, reminder, targetUserId);
        } catch (error) {
          console.error("Pet visit reminder failed", {
            householdId: workspace.household_id,
            reminderId: reminder.id,
            error,
          });
        }
      }
      for (const { reminder, targetUserId } of await healthAppointmentReminders(
        workspace.household_id,
        nowKey,
      )) {
        try {
          await deliverReminder(workspace, reminder, targetUserId);
        } catch (error) {
          console.error("Health appointment reminder failed", {
            householdId: workspace.household_id,
            reminderId: reminder.id,
            error,
          });
        }
      }
      for (const { reminder, targetUserId } of await medicationReminders(
        workspace.household_id,
        nowKey,
      )) {
        try {
          await deliverReminder(workspace, reminder, targetUserId);
        } catch (error) {
          console.error("Medication reminder failed", {
            householdId: workspace.household_id,
            reminderId: reminder.id,
            error,
          });
        }
      }
      for (const { reminder, targetUserId } of await subscriptionReminders(
        workspace.household_id,
        nowKey,
      )) {
        try {
          await deliverReminder(workspace, reminder, targetUserId);
        } catch (error) {
          console.error("Subscription reminder failed", {
            householdId: workspace.household_id,
            reminderId: reminder.id,
            error,
          });
        }
      }
      for (const { reminder, targetUserId } of await eventReminders(
        workspace.household_id,
        nowKey,
      )) {
        try {
          await deliverReminder(workspace, reminder, targetUserId);
        } catch (error) {
          console.error("Event reminder failed", {
            householdId: workspace.household_id,
            reminderId: reminder.id,
            error,
          });
        }
      }
      // Manual reminders (Life): unlike the other reminder loops above, a successful delivery
      // writes back `notified_at` directly on the row -- idempotent (`WHERE notified_at IS NULL`)
      // and WITHOUT bumping `version` (docs/plans/…"Projekt pól specjalnych": the client also
      // edits this column via `reminder.update`, and the column is worker-derived, not part of
      // the OCC'd edit set). Targets private owners the same way every other per-row reminder
      // loop above does -- this single loop now covers BOTH shared and private manual reminders,
      // replacing the removed `user_workspace_states` private loop.
      for (const { reminder, targetUserId } of await manualReminders(
        workspace.household_id,
        nowKey,
      )) {
        try {
          const delivered = await deliverReminder(workspace, reminder, targetUserId);
          if (delivered) {
            await query(
              `UPDATE reminders SET notified_at = now()
                WHERE id = $1 AND household_id = $2 AND notified_at IS NULL`,
              [reminder.id, workspace.household_id],
            );
          }
        } catch (error) {
          console.error("Manual reminder failed", {
            householdId: workspace.household_id,
            reminderId: reminder.id,
            error,
          });
        }
      }
    } catch (error) {
      console.error("Reminder workspace failed", { householdId: workspace.household_id, error });
    }
  }
}

let stopping = false;
let wakeWorker;
const waitForNextTick = () =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, intervalMs);
    wakeWorker = () => {
      clearTimeout(timer);
      resolve();
    };
  });
const run = async () => {
  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      console.error("Reminder worker tick failed", error);
    }
    if (stopping) break;
    await waitForNextTick();
  }
};

const stop = async () => {
  if (stopping) return;
  stopping = true;
  wakeWorker?.();
  await pool.end();
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

await run();

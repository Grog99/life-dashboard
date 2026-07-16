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

function dueReminders(reminders, nowKey) {
  if (!Array.isArray(reminders)) return [];
  return reminders.filter(
    (reminder) =>
      typeof reminder?.id === "string" &&
      reminder.id.length > 0 &&
      reminder.id.length <= 200 &&
      !reminder.done &&
      !reminder.notifiedAt &&
      /^\d{4}-\d{2}-\d{2}$/.test(reminder.date ?? "") &&
      /^\d{2}:\d{2}$/.test(reminder.time ?? "") &&
      `${reminder.date} ${reminder.time}` <= nowKey,
  );
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

function derivedReminders(data, nowKey) {
  const advanced = data?.advanced ?? {};
  const life = data?.life ?? {};
  const reminders = [];
  for (const event of Array.isArray(life.events) ? life.events : []) {
    const dueKey = shiftLocalDateTime(event?.date, event?.startTime, -30);
    if (event?.id && withinDeliveryWindow(dueKey, nowKey, 1)) {
      reminders.push({
        id: `event:${event.id}`,
        title: `Za 30 min: ${event.title}`,
        date: event.date,
        time: event.startTime,
      });
    }
  }
  for (const subscription of Array.isArray(advanced.subscriptions) ? advanced.subscriptions : []) {
    const days = Number.isFinite(subscription?.reminderDays)
      ? Math.max(0, subscription.reminderDays)
      : 1;
    const dueKey = shiftLocalDateTime(subscription?.nextPayment, "09:00", -days * 24 * 60);
    if (
      subscription?.id &&
      subscription.status !== "cancelled" &&
      withinDeliveryWindow(dueKey, nowKey)
    ) {
      reminders.push({
        id: `subscription:${subscription.id}`,
        title: `Nadchodzi płatność: ${subscription.name}`,
        date: subscription.nextPayment,
        time: "09:00",
      });
    }
  }
  for (const trip of Array.isArray(advanced.trips) ? advanced.trips : []) {
    const dueKey = shiftLocalDateTime(trip?.startDate, "09:00", -7 * 24 * 60);
    if (trip?.id && trip.status !== "archived" && withinDeliveryWindow(dueKey, nowKey)) {
      reminders.push({
        id: `trip:${trip.id}`,
        title: `Za tydzień: ${trip.name}`,
        date: trip.startDate,
        time: "09:00",
      });
    }
  }
  for (const deadline of Array.isArray(advanced.vehicleDeadlines)
    ? advanced.vehicleDeadlines
    : []) {
    if (!deadline?.id || deadline.completed || !deadline.dueDate) continue;
    const dueKey = shiftLocalDateTime(deadline.dueDate, "09:00", -14 * 24 * 60);
    if (withinDeliveryWindow(dueKey, nowKey, 14)) {
      reminders.push({
        id: `vehicle:${deadline.id}`,
        title: `Samochód: ${deadline.title}`,
        date: deadline.dueDate,
        time: "09:00",
      });
    }
  }
  for (const appointment of Array.isArray(advanced.healthAppointments)
    ? advanced.healthAppointments
    : []) {
    const dueKey = shiftLocalDateTime(appointment?.date, appointment?.time, -24 * 60);
    if (
      appointment?.id &&
      appointment.status === "scheduled" &&
      withinDeliveryWindow(dueKey, nowKey, 2)
    ) {
      reminders.push({
        id: `health-appointment:${appointment.id}`,
        title: `Nadchodzi wizyta: ${appointment.title}`,
        date: appointment.date,
        time: appointment.time,
      });
    }
  }
  for (const visit of Array.isArray(advanced.petVisits) ? advanced.petVisits : []) {
    const dueKey = shiftLocalDateTime(visit?.date, visit?.time, -24 * 60);
    if (visit?.id && visit.status === "scheduled" && withinDeliveryWindow(dueKey, nowKey, 2)) {
      reminders.push({
        id: `pet-visit:${visit.id}`,
        title: `Wizyta u weterynarza: ${visit.title}`,
        date: visit.date,
        time: visit.time,
      });
    }
  }
  for (const medication of Array.isArray(advanced.medications) ? advanced.medications : []) {
    const reminderTime = medication?.reminderTime;
    const today = nowKey.slice(0, 10);
    if (
      medication?.id &&
      medication.active &&
      medication.lastTakenOn !== today &&
      /^\d{2}:\d{2}$/.test(reminderTime ?? "") &&
      `${today} ${reminderTime}` <= nowKey
    ) {
      reminders.push({
        id: `medication:${medication.id}`,
        title: `Pora przyjąć: ${medication.name} ${medication.dosage}`,
        date: today,
        time: reminderTime,
      });
    }
  }
  return reminders;
}

async function deliverDerived(workspace, data, targetUserId = null) {
  const nowKey = localNowKey(workspace.timezone);
  for (const reminder of derivedReminders(data, nowKey)) {
    try {
      await deliverReminder(workspace, reminder, targetUserId);
    } catch (error) {
      console.error("Derived reminder failed", {
        householdId: workspace.household_id,
        reminderId: reminder.id,
        error,
      });
    }
  }
}

async function tick() {
  if (Date.now() - lastMaintenanceAt > 60 * 60_000) {
    await Promise.all([
      query("DELETE FROM sessions WHERE expires_at < now()"),
      query("DELETE FROM oauth_states WHERE expires_at < now()"),
      query("DELETE FROM household_invitations WHERE expires_at < now() - interval '30 days'"),
      query("DELETE FROM notification_deliveries WHERE created_at < now() - interval '180 days'"),
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
      await deliverDerived(workspace, workspace.data);
      const nowKey = localNowKey(workspace.timezone);
      const due = dueReminders(workspace.data?.life?.reminders, nowKey);
      if (!due.length) continue;
      const completedIds = [];
      for (const reminder of due) {
        try {
          if (await deliverReminder(workspace, reminder)) completedIds.push(reminder.id);
        } catch (error) {
          console.error("Reminder delivery failed", {
            householdId: workspace.household_id,
            reminderId: reminder.id,
            error,
          });
        }
      }
      if (!completedIds.length) continue;
      const nextData = structuredClone(workspace.data);
      nextData.life.reminders = nextData.life.reminders.map((reminder) =>
        completedIds.includes(reminder.id)
          ? { ...reminder, notifiedAt: new Date().toISOString() }
          : reminder,
      );
      const updated = await query(
        `UPDATE workspace_states SET data = $1::jsonb, revision = revision + 1, updated_at = now()
          WHERE household_id = $2 AND revision = $3`,
        [JSON.stringify(nextData), workspace.household_id, workspace.revision],
      );
      if (!updated.rowCount)
        console.warn(
          "Workspace changed while marking reminders; retrying next tick",
          workspace.household_id,
        );
    } catch (error) {
      console.error("Reminder workspace failed", { householdId: workspace.household_id, error });
    }
  }
  const privateWorkspaces = await query(
    `SELECT uws.household_id, uws.user_id, uws.data, h.timezone
       FROM user_workspace_states uws JOIN households h ON h.id = uws.household_id`,
  );
  for (const workspace of privateWorkspaces.rows) {
    try {
      await deliverDerived(workspace, workspace.data, workspace.user_id);
      const nowKey = localNowKey(workspace.timezone);
      const due = dueReminders(workspace.data?.life?.reminders, nowKey);
      for (const reminder of due) {
        try {
          await deliverReminder(workspace, reminder, workspace.user_id);
        } catch (error) {
          console.error("Private reminder delivery failed", {
            householdId: workspace.household_id,
            userId: workspace.user_id,
            reminderId: reminder.id,
            error,
          });
        }
      }
      // Intentionally not persisting notifiedAt to user_workspace_states here: that table has
      // no revision column, so writing back risks clobbering a concurrent user edit. Delivery
      // dedup is already guaranteed by the notification_deliveries unique constraint.
    } catch (error) {
      console.error("Private workspace failed", {
        householdId: workspace.household_id,
        userId: workspace.user_id,
        error,
      });
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

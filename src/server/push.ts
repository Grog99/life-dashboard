import { apiRequest, serverMode } from "./api";

export async function removeCurrentPushSubscription(): Promise<void> {
  if (!serverMode || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  try {
    await apiRequest("/api/v1/push/subscriptions", {
      method: "DELETE",
      json: { endpoint: subscription.endpoint },
    });
  } finally {
    await subscription.unsubscribe().catch(() => false);
  }
}

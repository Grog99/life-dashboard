export interface ServerUser {
  id: string;
  email: string;
  name: string;
  locale: string;
  timezone: string;
}

export interface ServerHousehold {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  role: "owner" | "admin" | "member";
}

export interface AuthSnapshot {
  user: ServerUser;
  activeHouseholdId: string;
  households: ServerHousehold[];
}

export class ApiError extends Error {
  status: number;
  code: string;
  payload: unknown;

  constructor(status: number, message: string, code = "API_ERROR", payload?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { json?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const { json, timeoutMs = 30_000, signal: callerSignal, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = window.setTimeout(
    () =>
      controller.abort(new DOMException("Przekroczono czas oczekiwania na serwer", "TimeoutError")),
    Math.max(1_000, timeoutMs),
  );
  try {
    const response = await fetch(path, {
      ...requestOptions,
      credentials: "same-origin",
      headers,
      signal: controller.signal,
      body: json !== undefined ? JSON.stringify(json) : requestOptions.body,
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const body = payload as { error?: string; code?: string } | null;
      throw new ApiError(
        response.status,
        body?.error ?? "Nie udało się połączyć z serwerem",
        body?.code,
        payload,
      );
    }
    return payload as T;
  } finally {
    window.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export const serverMode = import.meta.env.VITE_SERVER_MODE === "true";

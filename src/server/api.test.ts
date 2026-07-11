import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "./api";

describe("apiRequest", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves a structured server error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Sesja wygasła", code: "UNAUTHENTICATED" }),
      { status: 401, headers: { "content-type": "application/json" } },
    )));

    await expect(apiRequest("/api/v1/auth/me")).rejects.toEqual(
      expect.objectContaining({
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Sesja wygasła",
      }),
    );
  });

  it("aborts a request that exceeds its timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_path: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = options.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ));

    const request = apiRequest("/api/v1/workspace", { timeoutMs: 1_000 });
    const assertion = expect(request).rejects.toEqual(expect.objectContaining({ name: "TimeoutError" }));
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});

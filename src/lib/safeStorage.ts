import type { StateStorage } from "zustand/middleware";

const STORAGE_WARNING_KEY = "puls-storage-warning";

export function reportStorageWarning(message: string): void {
  try {
    sessionStorage.setItem(STORAGE_WARNING_KEY, message);
  } catch {
    // Storage may be entirely unavailable; the in-memory app can still work.
  }
  window.dispatchEvent(new CustomEvent("puls:storage-warning", { detail: message }));
}

export function safeGetStorageItem(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    reportStorageWarning(
      "Lokalny cache jest niedostępny. Puls będzie działać w pamięci i spróbuje synchronizacji z serwerem",
    );
    return null;
  }
}

export function safeSetStorageItem(name: string, value: string): boolean {
  try {
    localStorage.setItem(name, value);
    return true;
  } catch {
    reportStorageWarning(
      "Brak miejsca na lokalny cache. Dane serwerowe nadal będą synchronizowane; wykonaj też kopię w Ustawieniach",
    );
    return false;
  }
}

export function safeRemoveStorageItem(name: string): void {
  try {
    localStorage.removeItem(name);
  } catch {
    reportStorageWarning("Nie udało się wyczyścić lokalnego zapisu");
  }
}

export function safeRemoveStoragePrefix(prefix: string): void {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    reportStorageWarning("Nie udało się wyczyścić części lokalnego zapisu");
  }
}

export function quarantineRawValue(name: string, raw: string): void {
  try {
    localStorage.setItem(`${name}:corrupt:${Date.now()}`, raw);
  } catch {
    // Best-effort quarantine only.
  }
}

export const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(name);
      if (raw) JSON.parse(raw);
      return raw;
    } catch {
      if (raw) quarantineRawValue(name, raw);
      try {
        localStorage.removeItem(name);
      } catch {
        // Best-effort quarantine only.
      }
      reportStorageWarning(
        "Nie udało się odczytać zapisanych danych — uruchomiono bezpieczny zestaw startowy",
      );
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      reportStorageWarning(
        "Brak miejsca na lokalny cache. Dane serwerowe nadal będą synchronizowane; wykonaj też kopię w Ustawieniach",
      );
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      reportStorageWarning("Nie udało się wyczyścić lokalnego zapisu");
    }
  },
};

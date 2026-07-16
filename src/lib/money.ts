import type { CurrencyCode } from "../advancedTypes";

export function formatMoney(
  amountMinor: number,
  currency: CurrencyCode = "PLN",
  hide = false,
): string {
  if (hide) return "••••••";
  return new Intl.NumberFormat("pl-PL", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

export function parseMoneyToMinor(value: string): number {
  const source = value.replace(/\s/g, "").replace(/[^0-9,.-]/g, "");
  const negative = source.includes("-");
  const unsigned = source.replace(/-/g, "");
  const comma = unsigned.lastIndexOf(",");
  const dot = unsigned.lastIndexOf(".");
  const separatorIndex = Math.max(comma, dot);
  const fractionLength = separatorIndex >= 0 ? unsigned.length - separatorIndex - 1 : 0;
  const hasDecimal = separatorIndex >= 0 && fractionLength > 0 && fractionLength <= 2;
  const integerDigits = (hasDecimal ? unsigned.slice(0, separatorIndex) : unsigned).replace(
    /\D/g,
    "",
  );
  const fractionDigits = hasDecimal
    ? unsigned
        .slice(separatorIndex + 1)
        .replace(/\D/g, "")
        .padEnd(2, "0")
        .slice(0, 2)
    : "00";
  if (!integerDigits && fractionDigits === "00") return 0;
  const minor = Number(integerDigits || "0") * 100 + Number(fractionDigits);
  return Number.isSafeInteger(minor) ? (negative ? -minor : minor) : 0;
}

export function monthlySubscriptionCost(
  amountMinor: number,
  cycle: "monthly" | "quarterly" | "yearly",
): number {
  if (cycle === "yearly") return Math.round(amountMinor / 12);
  if (cycle === "quarterly") return Math.round(amountMinor / 3);
  return amountMinor;
}

import { addDays, format } from "date-fns";

export interface ParsedCapture {
  title: string;
  date?: string;
  time?: string;
}

export function parseSmartCapture(input: string, now = new Date()): ParsedCapture {
  let title = input.trim();
  let date: string | undefined;
  let time: string | undefined;

  if (/\bjutro\b/i.test(title)) {
    date = format(addDays(now, 1), "yyyy-MM-dd");
    title = title.replace(/\bjutro\b/gi, "");
  } else if (/\b(?:dzisiaj|dziś)(?=\s|$)/i.test(title)) {
    date = format(now, "yyyy-MM-dd");
    title = title.replace(/\b(?:dzisiaj|dziś)(?=\s|$)/gi, "");
  }

  const timeMatch =
    title.match(/(?:\bo\s*)?\b([01]?\d|2[0-3]):([0-5]\d)\b/i) ??
    title.match(/\bo\s+([01]?\d|2[0-3])\.([0-5]\d)\b/i);
  const hourOnlyMatch = title.match(/\bo\s+([01]?\d|2[0-3])(?=\s*(?:$|[,;.!?-]))/i);

  if (timeMatch) {
    time = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
    title = title.replace(timeMatch[0], "");
  } else if (hourOnlyMatch) {
    time = `${hourOnlyMatch[1].padStart(2, "0")}:00`;
    title = title.replace(hourOnlyMatch[0], "");
  }

  title = title
    .replace(/\s{2,}/g, " ")
    .replace(/^[,\s-]+|[,\s-]+$/g, "")
    .trim();

  return { title: title || input.trim(), date, time };
}

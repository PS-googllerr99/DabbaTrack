/** Date helpers working on plain "YYYY-MM-DD" strings (server-local dates), avoiding timezone drift. */

function parseIso(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

export function addDays(iso: string, days: number): string {
  const dt = parseIso(iso);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseIso(toIso).getTime() - parseIso(fromIso).getTime()) / 86400000);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatDate(iso: string | null | undefined, withWeekday = false): string {
  if (!iso) return "-";
  const dt = parseIso(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  const base = `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`;
  return withWeekday ? `${WEEKDAYS[dt.getUTCDay()]}, ${base}` : base;
}

/** "2026-11-11T12:48:12" -> "11 Nov, 12:48 PM" (server timestamps are local, no zone). */
export function formatDateTime(ts: string | null | undefined): string {
  if (!ts) return "";
  const [datePart, timePart = ""] = ts.split("T");
  return `${formatDate(datePart)}, ${formatTime(timePart.slice(0, 5))}`;
}

export function formatTime(hhmm: string): string {
  const [hRaw, m] = hhmm.split(":");
  const h = Number(hRaw);
  if (Number.isNaN(h) || m === undefined) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${suffix}`;
}

export function formatMoney(amount: number | null | undefined): string {
  if (amount == null) return "-";
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

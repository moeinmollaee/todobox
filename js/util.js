export const uid = () => crypto.randomUUID();

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function isSameDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

export function fmtDay(ts) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(ts));
}

export function fmtShortDay(ts) {
  const d = new Date(ts);
  if (isSameDay(d, new Date())) return "Today";
  if (isSameDay(d, addDays(startOfDay(), 1))) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
}

export function fmtTime(ts) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts));
}

export function fmtDateInput(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fmtTimeInput(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function parseDateTimeLocal(dateStr, timeStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  if (timeStr) {
    const [hh, mm] = timeStr.split(":").map(Number);
    return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
  }
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

export function greeting(now = new Date()) {
  const h = now.getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function looksLikeUrl(query) {
  const q = query.trim();
  if (!q) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) return true;
  if (/\s/.test(q)) return false;
  return /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/.*)?$/i.test(q);
}

export function toNavigableUrl(query) {
  const q = query.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) return q;
  return `https://${q}`;
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export { faviconUrl } from "./platform/index.js";

export function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = () => {
    clearTimeout(t);
    fn();
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function likeEscape(text) {
  return String(text).replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

export function recurrenceLabel(value) {
  const map = {
    daily: "Every day",
    weekly: "Every week",
    monthly: "Every month",
    yearly: "Every year",
    weekdays: "Every weekday",
  };
  if (!value) return "Does not repeat";
  if (map[value]) return map[value];
  const m = /^every:(\d+):days$/.exec(value);
  if (m) return `Every ${m[1]} days`;
  return value;
}

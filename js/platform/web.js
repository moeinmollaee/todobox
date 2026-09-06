const PREFIX = "todobox:";
const TB = "tb:";
const timers = new Map();
const snoozeTimers = new Map();
let reminderIndex = {};

export const isWebApp = true;
export const hasTopSites = false;

function read(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function write(key, value) {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
}

export function storageGet(keys) {
  const keyList = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const k of keyList) out[k] = read(k);
  return Promise.resolve(out);
}

export function storageSet(obj) {
  for (const [k, v] of Object.entries(obj)) write(k, v);
  return Promise.resolve();
}

export function getAssetUrlSync(relativePath) {
  const path = String(relativePath || "").replace(/^\//, "");
  return new URL(path, document.baseURI).href;
}

export function getAssetUrl(relativePath) {
  return Promise.resolve(getAssetUrlSync(relativePath));
}

export function faviconUrl(pageUrl, size = 32) {
  try {
    const host = new URL(pageUrl).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`;
  } catch {
    return "";
  }
}

function loadReminderIndex() {
  reminderIndex = read("reminderIndex") || {};
}

function saveReminderIndex() {
  write("reminderIndex", reminderIndex);
}

async function playSound() {
  const sound = read("notificationSound");
  if (!sound || sound === "none") return;
  try {
    const url = await getAssetUrl(`sounds/${sound}`);
    const a = new Audio(url);
    await a.play();
  } catch {
    /* ignore */
  }
}

async function fireReminder(notifId, snoozed = false) {
  const item = reminderIndex[notifId];
  if (!item) return;
  if ("Notification" in window && Notification.permission === "granted") {
    const n = new Notification(snoozed ? "TodoBox (snoozed)" : "TodoBox", {
      body: item.title || "Task reminder",
      icon: new URL("icons/icon128.png", document.baseURI).href,
      tag: notifId,
    });
    n.onclick = () => {
      window.focus();
      window.dispatchEvent(new CustomEvent("todobox:open-tasks"));
    };
  }
  await playSound();
  window.dispatchEvent(new CustomEvent("todobox:reminder", {
    detail: { id: notifId, title: item.title, taskId: item.taskId, snoozed },
  }));
}

function scheduleInPage(name, when, snoozed = false) {
  const delay = when - Date.now();
  if (delay <= 0) return;
  const existing = timers.get(name);
  if (existing) clearTimeout(existing);
  timers.set(name, setTimeout(() => {
    timers.delete(name);
    fireReminder(name, snoozed);
  }, delay));
}

export function snoozeReminder(notifId, minutes = 5) {
  const item = reminderIndex[notifId];
  if (!item) return;
  const existing = snoozeTimers.get(notifId);
  if (existing) clearTimeout(existing);
  snoozeTimers.set(notifId, setTimeout(() => {
    snoozeTimers.delete(notifId);
    fireReminder(notifId, true);
  }, minutes * 60 * 1000));
}

export function dismissReminder(notifId) {
  const t = snoozeTimers.get(notifId);
  if (t) {
    clearTimeout(t);
    snoozeTimers.delete(notifId);
  }
}

export function syncReminders(items) {
  loadReminderIndex();
  for (const [name, t] of timers) {
    if (name.startsWith(TB)) {
      clearTimeout(t);
      timers.delete(name);
    }
  }
  const snoozed = new Set([...snoozeTimers.keys()]);
  const nextIndex = {};
  for (const key of snoozed) {
    if (reminderIndex[key]) nextIndex[key] = reminderIndex[key];
  }
  const now = Date.now();
  for (const item of items || []) {
    if (!item.remind_at || item.remind_at <= now) continue;
    const name = `${TB}${item.id}`;
    nextIndex[name] = { title: item.title, taskId: item.task_id };
    if (!snoozed.has(name)) scheduleInPage(name, item.remind_at);
  }
  reminderIndex = nextIndex;
  saveReminderIndex();
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "sync-reminders", items });
  }
  return Promise.resolve();
}

export function getTopSites() {
  return Promise.resolve([]);
}

export async function initWebApp() {
  if ("Notification" in window && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      /* ignore */
    }
  }
}

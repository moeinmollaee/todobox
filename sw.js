const TB = "tb:";
const timers = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "sync-reminders") {
    scheduleReminders(event.data.items || []);
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.focus();
          client.postMessage({ type: "open-tasks" });
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow("/app.html?view=tasks");
    })
  );
});

function scheduleReminders(items) {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  const now = Date.now();
  for (const item of items) {
    if (!item.remind_at || item.remind_at <= now) continue;
    const delay = Math.min(item.remind_at - now, 2147483647);
    const id = `${TB}${item.id}`;
    timers.set(id, setTimeout(() => showNotification(item.title, id), delay));
  }
}

function showNotification(title, tag) {
  self.registration.showNotification("TodoBox", {
    body: title || "Task reminder",
    icon: "/icons/icon128.png",
    tag,
  });
}

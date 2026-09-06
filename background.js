chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("theme", (data) => {
    if (!data.theme) chrome.storage.local.set({ theme: "system" });
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "sync-reminders") {
    syncReminders(msg.items || []).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith("snooze:")) {
    const origName = alarm.name.slice(7);
    const { reminderIndex } = await chrome.storage.local.get("reminderIndex");
    const item = (reminderIndex || {})[origName];
    if (!item) return;
    await chrome.notifications.create(origName, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "TodoBox (snoozed)",
      message: item.title || "Task reminder",
      priority: 2,
      buttons: [
        { title: "Stop" },
        { title: "Snooze 5 min" },
      ],
      requireInteraction: true,
    });
    await playNotificationSound();
    return;
  }

  if (!alarm.name.startsWith("tb:")) return;
  const { reminderIndex } = await chrome.storage.local.get("reminderIndex");
  const item = (reminderIndex || {})[alarm.name];
  if (!item) return;
  await chrome.notifications.create(alarm.name, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "TodoBox",
    message: item.title || "Task reminder",
    priority: 2,
    buttons: [
      { title: "Stop" },
      { title: "Snooze 5 min" },
    ],
    requireInteraction: true,
  });
  await playNotificationSound();
});

chrome.notifications.onButtonClicked.addListener(async (notifId, buttonIndex) => {
  if (buttonIndex === 0) {
    stopSound();
    chrome.notifications.clear(notifId);
  } else if (buttonIndex === 1) {
    stopSound();
    chrome.notifications.clear(notifId);
    const { reminderIndex } = await chrome.storage.local.get("reminderIndex");
    const item = (reminderIndex || {})[notifId];
    if (item) {
      const snoozeIndex = { ...(reminderIndex || {}), [notifId]: item };
      await chrome.storage.local.set({ reminderIndex: snoozeIndex });
    }
    chrome.alarms.create(`snooze:${notifId}`, { delayInMinutes: 5 });
  }
});

chrome.notifications.onClicked.addListener((id) => {
  stopSound();
  chrome.tabs.create({ url: chrome.runtime.getURL("newtab.html") + "?view=tasks" });
  chrome.notifications.clear(id);
});

chrome.notifications.onClosed.addListener(() => {
  stopSound();
});

async function playNotificationSound() {
  const { notificationSound } = await chrome.storage.local.get("notificationSound");
  if (!notificationSound || notificationSound === "none") return;
  const soundUrl = chrome.runtime.getURL(`sounds/${notificationSound}`);
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: "play-sound", file: soundUrl });
}

function stopSound() {
  ensureOffscreen().then(() => {
    chrome.runtime.sendMessage({ type: "stop-sound" });
  }).catch(() => {});
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Playing notification sound for task reminder",
  });
}

async function syncReminders(items) {
  const alarms = await chrome.alarms.getAll();
  const snoozeAlarms = alarms.filter((a) => a.name.startsWith("snooze:"));
  await Promise.all(
    alarms.filter((a) => a.name.startsWith("tb:")).map((a) => chrome.alarms.clear(a.name))
  );
  const { reminderIndex: oldIndex } = await chrome.storage.local.get("reminderIndex");
  const snoozedKeys = new Set(snoozeAlarms.map((a) => a.name.slice(7)));
  const reminderIndex = {};
  for (const key of snoozedKeys) {
    if ((oldIndex || {})[key]) reminderIndex[key] = oldIndex[key];
  }
  const now = Date.now();
  for (const item of items) {
    if (!item.remind_at || item.remind_at <= now) continue;
    const name = `tb:${item.id}`;
    reminderIndex[name] = { title: item.title, taskId: item.task_id };
    chrome.alarms.create(name, { when: item.remind_at });
  }
  await chrome.storage.local.set({ reminderIndex });
}

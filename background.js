let mailPollInFlight = null;

function ensureMailPollAlarm() {
  chrome.alarms.create("mail-poll", { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("theme", (data) => {
    if (!data.theme) chrome.storage.local.set({ theme: "system" });
  });
  ensureMailPollAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureMailPollAlarm();
});

ensureMailPollAlarm();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "sync-reminders") {
    syncReminders(msg.items || []).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "mail-poll-now") {
    pollMailUnread({ notify: msg.notify !== false }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "mail-baseline") {
    // UI read/marked messages — keep baseline in sync so the next new mail still notifies.
    chrome.storage.local.get("mailPollState").then(async (data) => {
      const next = { ...(data.mailPollState || {}) };
      if (msg.accountId && msg.status) {
        next[msg.accountId] = {
          uidNext: Number(msg.status.uidNext) || next[msg.accountId]?.uidNext || 0,
          unseen: Number(msg.status.unseen) || 0,
          messages: Number(msg.status.messages) || 0,
        };
      }
      const unseenTotal = Object.values(next).reduce((sum, s) => sum + (s.unseen || 0), 0);
      await chrome.storage.local.set({ mailPollState: next, mailUnseenPrev: unseenTotal });
      const text = unseenTotal > 0 ? (unseenTotal > 99 ? "99+" : String(unseenTotal)) : "";
      await chrome.action.setBadgeText({ text });
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "mail-poll") {
    await pollMailUnread();
    return;
  }
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
  const view = id === "todobox-mail-new" || String(id).startsWith("mail-new-") ? "mail" : "tasks";
  chrome.tabs.create({ url: `${chrome.runtime.getURL("newtab.html")}?view=${view}` });
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

function truncateNotif(s, max) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

async function fetchLatestMailMeta(account) {
  try {
    const resp = await fetch(
      `http://127.0.0.1:8080/api/mail/accounts/${encodeURIComponent(account.id)}/messages?folder=INBOX&page=1&pageSize=1&fresh=1`
    );
    if (!resp.ok) return {};
    const data = await resp.json();
    const msg = (data.messages || [])[0];
    if (!msg) return {};
    const from0 = Array.isArray(msg.from) ? msg.from[0] : null;
    return {
      fromName: String(from0?.name || "").trim(),
      fromAddress: String(from0?.address || "").trim(),
      subject: String(msg.subject || "").trim(),
    };
  } catch {
    return {};
  }
}

async function pollMailUnread({ notify = true } = {}) {
  // Coalesce overlapping polls (alarm + startup) so one email ≠ two notifications.
  if (mailPollInFlight) return mailPollInFlight;
  mailPollInFlight = (async () => {
    try {
      const health = await fetch("http://127.0.0.1:8080/api/mail/health");
      if (!health.ok) throw new Error("offline");
      const accResp = await fetch("http://127.0.0.1:8080/api/mail/accounts");
      const accData = await accResp.json();
      const accounts = accData.accounts || [];
      const { mailPollState: prevState } = await chrome.storage.local.get("mailPollState");
      const prev = prevState || {};
      const next = {};
      let unseenTotal = 0;
      let notifyAccount = null;

      for (const a of accounts) {
        try {
          const st = await fetch(`http://127.0.0.1:8080/api/mail/accounts/${encodeURIComponent(a.id)}/unread?folder=INBOX&fresh=1`);
          if (!st.ok) continue;
          const data = await st.json();
          const uidNext = Number(data.uidNext) || 0;
          const unseen = Number(data.unseen) || 0;
          const messages = Number(data.messages) || 0;
          unseenTotal += unseen;
          const before = prev[a.id];
          if (before) {
            const arrived = uidNext > (before.uidNext || 0) || unseen > (before.unseen || 0);
            if (arrived && !notifyAccount) notifyAccount = a;
          }
          next[a.id] = { uidNext, unseen, messages };
        } catch {
          /* ignore per-account */
        }
      }

      const text = unseenTotal > 0 ? (unseenTotal > 99 ? "99+" : String(unseenTotal)) : "";
      await chrome.action.setBadgeText({ text });
      await chrome.action.setBadgeBackgroundColor({ color: "#0f6e62" });

      // Persist baseline BEFORE notifying so a concurrent poll cannot re-fire.
      await chrome.storage.local.set({
        mailPollState: next,
        mailUnseenPrev: unseenTotal,
      });

      if (notify && notifyAccount) {
        // Drop stale list/unread cache so the next Mail open/reload is not old inbox.
        try {
          await fetch(
            `http://127.0.0.1:8080/api/mail/accounts/${encodeURIComponent(notifyAccount.id)}/invalidate`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ folder: "INBOX" }),
            }
          );
        } catch {
          /* bridge may be briefly busy */
        }
        await chrome.storage.local.set({
          mailInboxDirty: {
            accountId: notifyAccount.id,
            at: Date.now(),
          },
        });
        chrome.runtime.sendMessage({
          type: "mail-inbox-dirty",
          accountId: notifyAccount.id,
        }).catch(() => {});

        const { mailNotifications } = await chrome.storage.local.get("mailNotifications");
        if (mailNotifications === false) {
          // Setting off: keep badge + inbox refresh, skip toast/sound.
          return;
        }

        const detail = await fetchLatestMailMeta(notifyAccount);
        const toAddr = notifyAccount.email || notifyAccount.name || "Inbox";
        const fromLabel = detail.fromName || detail.fromAddress || "Unknown sender";
        const subject = detail.subject ? truncateNotif(detail.subject, 80) : "";
        await chrome.notifications.create("todobox-mail-new", {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: fromLabel,
          message: subject
            ? `To: ${toAddr}\n${subject}`
            : `To: ${toAddr}\nNew email received`,
          priority: 2,
          requireInteraction: true,
        });
        await playNotificationSound();
      }
    } catch {
      await chrome.action.setBadgeText({ text: "" });
    }
  })().finally(() => {
    mailPollInFlight = null;
  });
  return mailPollInFlight;
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

// After function declarations — avoids TDZ on mailPollInFlight / pollMailUnread.
pollMailUnread({ notify: true });

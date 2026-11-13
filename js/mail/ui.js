import * as mail from "./client.js";
import { mountIsolatedHtml } from "./sanitize.js";
import { buildTaskDraftFromMessage, mailTaskMarker } from "./to-task.js";
import {
  mountComposeEditor,
  plainToHtml,
  extractInlineImages,
} from "./compose-editor.js";
import { esc } from "../util.js";

/** Soft client TTL: re-entering Mail within this window reuses in-memory data. */
const CLIENT_TTL_MS = 2 * 60 * 1000;
const ALL_ACCOUNTS = "__all__";
const PAGE_SIZE = 50;

const state = {
  bridgeOk: false,
  accounts: [],
  accountId: null,
  folders: [],
  folder: "INBOX",
  messages: [],
  allPool: [], // merged inbox rows when All is selected
  allTotal: 0, // real combined INBOX count across mailboxes
  total: 0,
  page: 1,
  selectedUid: null,
  selectedKey: null, // `${accountId}:${uid}` (needed for All)
  message: null,
  loading: false,
  statusText: "",
  checked: false,
  error: "",
  compose: null,
  syncedAt: 0,
  syncKey: "",
  readerTheme: "light",
  readerView: "html", // html | plain — plain always uses high-contrast text
};

function isAllAccounts() {
  return state.accountId === ALL_ACCOUNTS;
}

function msgKey(accountId, uid) {
  return `${accountId}:${uid}`;
}

function rowAccountId(m) {
  return m?.accountId || state.accountId;
}

let hooks = {
  toast: () => {},
  openModal: () => {},
  closeModal: () => {},
  addTask: null,
  findTaskByMailId: null,
  openTasks: null,
};

function isMailPageVisible() {
  const root = $("mail");
  return !!(root && !root.classList.contains("hidden"));
}

function markClientStale() {
  state.syncedAt = 0;
  state.syncKey = "";
}

async function consumeInboxDirty() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  try {
    const { mailInboxDirty } = await chrome.storage.local.get("mailInboxDirty");
    if (!mailInboxDirty) return null;
    await chrome.storage.local.remove("mailInboxDirty");
    return mailInboxDirty;
  } catch {
    return null;
  }
}

export function initMailUi(options = {}) {
  hooks = { ...hooks, ...options };
  try {
    state.accountId = localStorage.getItem("todobox:mailAccountId") || null;
    state.folder = localStorage.getItem("todobox:mailFolder") || "INBOX";
    const rt = localStorage.getItem("todobox:mailReaderTheme");
    if (rt === "dark" || rt === "light") state.readerTheme = rt;
  } catch {
    /* ignore */
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== "mail-inbox-dirty") return;
      markClientStale();
      if (
        msg.accountId
        && state.accountId
        && !isAllAccounts()
        && msg.accountId !== state.accountId
      ) {
        // Different mailbox — still drop soft TTL; open/switch will force-fetch.
        return;
      }
      if (isMailPageVisible()) {
        // Live inbox: jump to INBOX page 1 and force-refresh (no stale soft cache).
        state.folder = "INBOX";
        state.page = 1;
        state.selectedUid = null;
        state.selectedKey = null;
        state.message = null;
        try {
          localStorage.setItem("todobox:mailFolder", "INBOX");
        } catch {
          /* ignore */
        }
        reloadMail();
      }
    });
  }

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.mailInboxDirty?.newValue) return;
      markClientStale();
    });
  }
}

function cycleReaderTheme() {
  // light desk vs dark desk — HTML email always stays on white paper
  state.readerTheme = state.readerTheme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem("todobox:mailReaderTheme", state.readerTheme);
  } catch {
    /* ignore */
  }
  if (state.message) renderReader();
}

function cycleReaderView() {
  state.readerView = state.readerView === "plain" ? "html" : "plain";
  if (state.message) renderReader();
}

function $(id) {
  return document.getElementById(id);
}

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function fromLabel(list) {
  if (!list?.length) return "(unknown)";
  const a = list[0];
  return a.name || a.address || "(unknown)";
}

function addrText(list) {
  return (list || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).filter(Boolean).join(", ");
}

async function refreshAccounts() {
  state.accounts = await mail.listAccounts();
  if (isAllAccounts()) {
    localStorage.setItem("todobox:mailAccountId", ALL_ACCOUNTS);
    return;
  }
  if (!state.accounts.find((a) => a.id === state.accountId)) {
    state.accountId = state.accounts.length > 1 ? ALL_ACCOUNTS : (state.accounts[0]?.id || null);
  }
  if (state.accountId) localStorage.setItem("todobox:mailAccountId", state.accountId);
}

async function refreshFolders({ fresh = false } = {}) {
  if (!state.accountId) {
    state.folders = [];
    return;
  }
  if (isAllAccounts()) {
    state.folder = "INBOX";
    state.folders = [{ path: "INBOX", name: "INBOX (all)" }];
    localStorage.setItem("todobox:mailFolder", "INBOX");
    return;
  }
  state.folders = await mail.listFolders(state.accountId, { fresh });
  if (!state.folders.find((f) => f.path === state.folder)) {
    const inbox = state.folders.find((f) => /inbox/i.test(f.path) || f.specialUse === "\\Inbox");
    state.folder = inbox?.path || state.folders[0]?.path || "INBOX";
  }
  localStorage.setItem("todobox:mailFolder", state.folder);
}

function applyAllPageSlice() {
  const start = (state.page - 1) * PAGE_SIZE;
  state.messages = state.allPool.slice(start, start + PAGE_SIZE);
  // Prefer real combined mailbox totals; fall back to what we have loaded.
  state.total = Math.max(state.allTotal || 0, state.allPool.length);
}

async function refreshAllInboxes({ fresh = false } = {}) {
  if (!state.accounts.length) {
    state.allPool = [];
    state.allTotal = 0;
    state.messages = [];
    state.total = 0;
    return;
  }
  const need = state.page * PAGE_SIZE;
  // Reuse merged pool when this page is already covered.
  if (!fresh && state.allPool.length >= need) {
    applyAllPageSlice();
    return;
  }
  // Worst case: the newest `need` mails are all from one mailbox, so fetch
  // that many pages from every account, then merge by date.
  const pagesNeeded = Math.max(1, Math.ceil(need / PAGE_SIZE));
  const lists = await Promise.all(state.accounts.map(async (a) => {
    const rows = [];
    let total = 0;
    try {
      for (let page = 1; page <= pagesNeeded; page += 1) {
        const data = await mail.listMessages(a.id, "INBOX", {
          page,
          pageSize: PAGE_SIZE,
          fresh: fresh && page === 1,
        });
        total = Number(data.total) || total;
        for (const m of data.messages || []) {
          rows.push({
            ...m,
            accountId: a.id,
            accountEmail: a.email,
            accountLabel: senderNameValue(a) || a.name || a.email,
            folder: "INBOX",
            listKey: msgKey(a.id, m.uid),
          });
        }
        if ((data.messages || []).length < PAGE_SIZE) break;
      }
    } catch {
      /* skip offline/failing mailbox */
    }
    return { rows, total };
  }));

  const seen = new Set();
  const merged = [];
  let grandTotal = 0;
  for (const { rows, total } of lists) {
    grandTotal += total;
    for (const m of rows) {
      if (seen.has(m.listKey)) continue;
      seen.add(m.listKey);
      merged.push(m);
    }
  }
  merged.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });
  state.allPool = merged;
  state.allTotal = grandTotal;
  applyAllPageSlice();

  const byAccount = new Map();
  for (const m of state.messages) {
    if (!byAccount.has(m.accountId)) byAccount.set(m.accountId, []);
    byAccount.get(m.accountId).push(m.uid);
  }
  await Promise.all([...byAccount.entries()].map(async ([accountId, uids]) => {
    try {
      await mail.prefetchMessages(accountId, "INBOX", uids);
    } catch {
      /* list still usable */
    }
  }));
}

async function refreshMessages({ fresh = false } = {}) {
  if (!state.accountId) {
    state.messages = [];
    state.allPool = [];
    state.allTotal = 0;
    state.total = 0;
    return;
  }
  if (isAllAccounts()) {
    await refreshAllInboxes({ fresh });
    return;
  }
  const data = await mail.listMessages(state.accountId, state.folder, {
    page: state.page,
    pageSize: PAGE_SIZE,
    fresh,
  });
  state.messages = (data.messages || []).map((m) => ({
    ...m,
    accountId: state.accountId,
    folder: state.folder,
    listKey: msgKey(state.accountId, m.uid),
  }));
  state.total = data.total || 0;
  state.allPool = [];
  state.allTotal = 0;
  const uids = state.messages.slice(0, PAGE_SIZE).map((m) => m.uid);
  if (uids.length) {
    try {
      await mail.prefetchMessages(state.accountId, state.folder, uids);
    } catch {
      /* list still usable; open may fall back to live fetch */
    }
  }
}

function syncKey() {
  return `${state.accountId || ""}|${state.folder}|${state.page}`;
}

function syncMailBaseline() {
  if (typeof chrome === "undefined" || !chrome.runtime?.id) return;
  const targets = isAllAccounts()
    ? state.accounts
    : state.accounts.filter((a) => a.id === state.accountId);
  for (const a of targets) {
    mail.unread(a.id, "INBOX", { fresh: true })
      .then((status) => {
        chrome.runtime.sendMessage({
          type: "mail-baseline",
          accountId: a.id,
          status,
        }).catch(() => {});
      })
      .catch(() => {});
  }
}

export async function bootMail({ force = false } = {}) {
  const dirty = await consumeInboxDirty();
  if (dirty) {
    force = true;
    markClientStale();
    if (dirty.accountId && state.accounts.some((a) => a.id === dirty.accountId)) {
      state.accountId = dirty.accountId;
      try {
        localStorage.setItem("todobox:mailAccountId", state.accountId);
      } catch {
        /* ignore */
      }
    } else if (dirty.accountId && !state.accounts.length) {
      // accounts not loaded yet — apply after refreshAccounts below via pending
      state._pendingDirtyAccountId = dirty.accountId;
    }
    state.folder = "INBOX";
    state.page = 1;
    state.selectedUid = null;
    state.selectedKey = null;
    state.message = null;
    try {
      localStorage.setItem("todobox:mailFolder", "INBOX");
    } catch {
      /* ignore */
    }
  }

  const softHit = !force
    && state.checked
    && state.bridgeOk
    && state.accounts.length
    && (isAllAccounts() || state.folders.length)
    && state.syncKey === syncKey()
    && (Date.now() - state.syncedAt) < CLIENT_TTL_MS;

  if (softHit) {
    renderShell();
    return;
  }

  state.loading = true;
  state.error = "";
  state.statusText = "Checking mail bridge…";
  renderShell();
  try {
    state.statusText = "Connecting…";
    renderShell();
    await mail.health();
    state.bridgeOk = true;

    state.statusText = "Loading mailboxes…";
    renderShell();
    await refreshAccounts();

    if (state._pendingDirtyAccountId) {
      if (state.accounts.some((a) => a.id === state._pendingDirtyAccountId)) {
        state.accountId = state._pendingDirtyAccountId;
        try {
          localStorage.setItem("todobox:mailAccountId", state.accountId);
        } catch {
          /* ignore */
        }
      }
      delete state._pendingDirtyAccountId;
    }

    if (!state.accounts.length) {
      state.checked = true;
      return;
    }

    if (state.accountId) {
      state.statusText = "Loading folders…";
      renderShell();
      await refreshFolders({ fresh: force });
      state.statusText = "Downloading recent messages…";
      renderShell();
      await refreshMessages({ fresh: force });
    }
    state.syncedAt = Date.now();
    state.syncKey = syncKey();
    state.checked = true;
    syncMailBaseline();
  } catch (err) {
    state.bridgeOk = false;
    state.checked = true;
    state.error = err.message || String(err);
  } finally {
    state.loading = false;
    state.statusText = "";
    renderShell();
  }
}

export async function reloadMail() {
  return bootMail({ force: true });
}

function renderShell() {
  const root = $("mail");
  if (!root) return;

  if (state.loading || !state.checked) {
    root.innerHTML = `
      <div class="mail-offline mail-loading">
        <h1>Mail</h1>
        <div class="mail-spinner" aria-hidden="true"></div>
        <p>${esc(state.statusText || "Loading…")}</p>
      </div>
    `;
    return;
  }

  if (!state.bridgeOk) {
    root.innerHTML = `
      <div class="mail-offline">
        <h1>Mail</h1>
        <p>${esc(state.error || "Mail bridge is offline.")}</p>
        <p class="hint">If the TodoBox icon is still near the clock, right-click it → <strong>Restart mail server</strong>, wait a few seconds, then retry. Or run <code>app install\\run.bat</code>.</p>
        <div class="btn-row">
          <button class="primary" type="button" id="mail-retry">Retry connection</button>
        </div>
      </div>
    `;
    $("mail-retry").onclick = () => bootMail({ force: true });
    return;
  }

  if (!state.accounts.length) {
    root.innerHTML = `
      <div class="mail-offline">
        <h1>Mail</h1>
        <p>No mailbox connected yet.</p>
        <p class="hint">Add an IMAP / SMTP account to get started. Passwords stay on this PC only.</p>
        <div class="btn-row">
          <button class="primary" type="button" id="mail-add-first">Add account</button>
        </div>
      </div>
    `;
    $("mail-add-first").onclick = () => openAccountModal();
    return;
  }

  const totalPages = Math.max(1, Math.ceil((state.total || 0) / PAGE_SIZE));
  const from = state.total ? (state.page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(state.page * PAGE_SIZE, state.total || 0);
  const canNewer = state.page > 1;
  const canOlder = state.page * PAGE_SIZE < (state.total || 0);
  const allMode = isAllAccounts();
  const activeAcc = allMode ? null : state.accounts.find((a) => a.id === state.accountId);
  const profileEmail = allMode ? "All inboxes" : (activeAcc?.email || "");
  const profileName = allMode ? "" : senderNameValue(activeAcc);
  const folderTitle = allMode ? "All inboxes" : state.folder;

  root.innerHTML = `
    <aside class="mail-sidebar">
      <div class="mail-account-block">
        <div class="mail-account-picker" id="mail-account-picker">
          <button type="button" class="mail-account-trigger" id="mail-account-trigger" aria-haspopup="listbox" aria-expanded="false" aria-label="Account"></button>
          <div class="mail-account-menu hidden" id="mail-account-menu" role="listbox"></div>
        </div>
        <div class="mail-account-actions">
          <button class="icon-btn" type="button" id="mail-account-add" title="Add account" aria-label="Add account">+</button>
          <button class="ghost-btn mail-account-settings" type="button" id="mail-account-edit" title="Edit mailbox settings" ${allMode ? "disabled" : ""}>Settings</button>
        </div>
      </div>
      ${profileEmail ? `
      <div class="mail-profile-badge${allMode ? " mail-profile-badge-all" : ""}" title="${esc(profileName ? `${profileName} <${profileEmail}>` : profileEmail)}">
        <span class="mail-profile-badge-email" dir="ltr">${esc(profileEmail)}</span>
      </div>` : ""}
      <button class="primary mail-compose-btn" type="button" id="mail-compose">Compose</button>
      <nav class="mail-folders" id="mail-folders"></nav>
      <button class="text-btn" type="button" id="mail-refresh">Refresh</button>
    </aside>
    <section class="mail-list-pane">
      <div class="mail-list-head">
        <div>
          <h1 id="mail-folder-title">${esc(folderTitle)}</h1>
          <p class="mail-page-info">${state.total
            ? `${from}–${to} of ${state.total} · Page ${state.page}/${totalPages}`
            : "No messages"}</p>
        </div>
      </div>
      <div class="mail-list" id="mail-list"></div>
      <div class="mail-list-foot">
        <button class="ghost-btn" type="button" id="mail-prev" ${canNewer ? "" : "disabled"}>Newer</button>
        <span class="mail-page-chip">${state.page} / ${totalPages}</span>
        <button class="ghost-btn" type="button" id="mail-next" ${canOlder ? "" : "disabled"}>Older</button>
      </div>
    </section>
    <section class="mail-read-pane" id="mail-read-pane"></section>
  `;

  bindAccountPicker();

  $("mail-account-add").onclick = () => openAccountModal();
  $("mail-account-edit").onclick = () => {
    if (isAllAccounts()) {
      hooks.toast("Pick a mailbox first to edit settings");
      return;
    }
    const acc = state.accounts.find((a) => a.id === state.accountId);
    if (acc) openAccountModal(acc);
  };
  $("mail-compose").onclick = () => {
    if (isAllAccounts()) {
      const first = state.accounts[0];
      if (!first) return hooks.toast("No mailbox to send from");
      openCompose({ accountId: first.id });
      return;
    }
    openCompose();
  };
  $("mail-refresh").onclick = () => bootMail({ force: true });
  $("mail-prev").onclick = async () => {
    if (state.page <= 1) return;
    state.page -= 1;
    await safeLoad(() => refreshMessages({ fresh: false }));
  };
  $("mail-next").onclick = async () => {
    if (state.page * PAGE_SIZE >= state.total) return;
    state.page += 1;
    await safeLoad(() => refreshMessages({ fresh: false }));
  };

  $("mail-folders").innerHTML = state.folders.map((f) => `
    <button type="button" class="mail-folder ${f.path === state.folder ? "active" : ""}" data-folder="${esc(f.path)}">
      ${esc(f.name || f.path)}
    </button>
  `).join("");
  $("mail-folders").onclick = async (e) => {
    const btn = e.target.closest("[data-folder]");
    if (!btn) return;
    if (isAllAccounts() && btn.dataset.folder !== "INBOX") {
      hooks.toast("All view shows INBOX only — pick a mailbox for other folders");
      return;
    }
    state.folder = btn.dataset.folder;
    localStorage.setItem("todobox:mailFolder", state.folder);
    state.page = 1;
    state.selectedUid = null;
    state.selectedKey = null;
    state.message = null;
    state.syncedAt = 0;
    await safeLoad(async () => {
      await refreshMessages({ fresh: false });
      state.syncedAt = Date.now();
      state.syncKey = syncKey();
    });
  };

  renderMessageList();
  renderReader();
}

function accountOptionLabel(a) {
  return senderNameValue(a) || a.name || a.email || "";
}

function renderAccountTriggerLabel(el, value) {
  if (!el) return;
  if (value === ALL_ACCOUNTS) {
    el.innerHTML = `
      <span class="mail-account-opt-name">All</span>
      <span class="mail-account-opt-email">All inboxes</span>
    `;
    return;
  }
  const a = state.accounts.find((x) => x.id === value);
  const name = accountOptionLabel(a);
  const email = a?.email || "";
  el.innerHTML = `
    <span class="mail-account-opt-name">${esc(name)}</span>
    ${email ? `<span class="mail-account-opt-email" dir="ltr">${esc(email)}</span>` : ""}
  `;
}

function bindAccountPicker() {
  const trigger = $("mail-account-trigger");
  const menu = $("mail-account-menu");
  const picker = $("mail-account-picker");
  if (!trigger || !menu || !picker) return;

  const options = [];
  if (state.accounts.length > 1) {
    options.push({
      value: ALL_ACCOUNTS,
      name: "All",
      email: "All inboxes",
      title: "Merged INBOX from every mailbox",
    });
  }
  for (const a of state.accounts) {
    options.push({
      value: a.id,
      name: accountOptionLabel(a),
      email: a.email || "",
      title: a.email ? `${accountOptionLabel(a)} — ${a.email}` : accountOptionLabel(a),
    });
  }

  renderAccountTriggerLabel(trigger, state.accountId);
  menu.innerHTML = options.map((o) => `
    <button type="button" class="mail-account-option ${o.value === state.accountId ? "active" : ""}" role="option" data-value="${esc(o.value)}" title="${esc(o.title)}" aria-selected="${o.value === state.accountId ? "true" : "false"}">
      <span class="mail-account-opt-name">${esc(o.name)}</span>
      ${o.email ? `<span class="mail-account-opt-email" dir="ltr">${esc(o.email)}</span>` : ""}
    </button>
  `).join("");

  const closeMenu = () => {
    menu.classList.add("hidden");
    trigger.setAttribute("aria-expanded", "false");
    picker.classList.remove("open");
  };
  const openMenu = () => {
    menu.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
    picker.classList.add("open");
  };

  trigger.onclick = (e) => {
    e.stopPropagation();
    if (menu.classList.contains("hidden")) openMenu();
    else closeMenu();
  };

  menu.onclick = async (e) => {
    const btn = e.target.closest("[data-value]");
    if (!btn) return;
    const value = btn.dataset.value;
    closeMenu();
    if (value === state.accountId) return;
    state.accountId = value;
    localStorage.setItem("todobox:mailAccountId", state.accountId);
    state.page = 1;
    state.selectedUid = null;
    state.selectedKey = null;
    state.message = null;
    state.syncedAt = 0;
    if (isAllAccounts()) state.folder = "INBOX";
    await safeLoad(async () => {
      await refreshFolders({ fresh: false });
      await refreshMessages({ fresh: false });
      state.syncedAt = Date.now();
      state.syncKey = syncKey();
    });
  };

  // One document listener is enough; replace prior handler if re-rendered.
  if (bindAccountPicker._onDocClick) {
    document.removeEventListener("click", bindAccountPicker._onDocClick);
  }
  bindAccountPicker._onDocClick = (e) => {
    if (!picker.contains(e.target)) closeMenu();
  };
  document.addEventListener("click", bindAccountPicker._onDocClick);
}

function renderMessageList() {
  const list = $("mail-list");
  if (!list) return;
  if (state.loading) {
    list.innerHTML = `<p class="hint">Loading…</p>`;
    return;
  }
  if (!state.messages.length) {
    list.innerHTML = `<p class="hint">No messages in this folder.</p>`;
    return;
  }
  const showMailbox = isAllAccounts();
  list.innerHTML = state.messages.map((m) => {
    const key = m.listKey || msgKey(rowAccountId(m), m.uid);
    return `
    <button type="button" class="mail-row ${key === state.selectedKey ? "active" : ""} ${m.unseen ? "unseen" : ""}" data-key="${esc(key)}" data-uid="${m.uid}" data-account="${esc(rowAccountId(m))}">
      <span class="mail-row-from">
        <span class="mail-row-from-name">${esc(fromLabel(m.from))}</span>
        ${showMailbox
          ? `<span class="mail-row-mailbox" title="${esc(m.accountEmail || "")}">${esc(m.accountEmail || m.accountLabel || "")}</span>`
          : ""}
      </span>
      <span class="mail-row-subject">${esc(m.subject)}</span>
      <span class="mail-row-date">${esc(fmtWhen(m.date))}</span>
    </button>`;
  }).join("");
  list.onclick = (e) => {
    const btn = e.target.closest("[data-key]");
    if (!btn) return;
    openMessage(Number(btn.dataset.uid), btn.dataset.account);
  };
}

async function openMessage(uid, accountId = null) {
  const accId = accountId || rowAccountId(state.messages.find((m) => m.uid === uid)) || state.accountId;
  if (!accId || accId === ALL_ACCOUNTS || !uid) return;
  const folder = state.messages.find((m) => m.uid === uid && rowAccountId(m) === accId)?.folder
    || (isAllAccounts() ? "INBOX" : state.folder);
  state.selectedUid = uid;
  state.selectedKey = msgKey(accId, uid);
  renderMessageList();
  const pane = $("mail-read-pane");
  if (pane) {
    pane.innerHTML = `<div class="mail-empty-read"><p class="hint">Opening…</p></div>`;
  }

  try {
    state.message = await mail.getMessage(accId, folder, uid, {
      fresh: false,
      markSeen: false,
    });
    state.message = {
      ...state.message,
      accountId: accId,
      folder,
      listKey: msgKey(accId, uid),
    };

    const row = state.messages.find((m) => (m.listKey || msgKey(rowAccountId(m), m.uid)) === state.selectedKey);
    const wasUnseen = row?.unseen || !(state.message.flags || []).includes("\\Seen");
    if (row) {
      row.unseen = false;
      const flags = new Set(row.flags || []);
      flags.add("\\Seen");
      row.flags = [...flags];
    }
    if (state.message) {
      const flags = new Set(state.message.flags || []);
      flags.add("\\Seen");
      state.message.flags = [...flags];
    }

    renderMessageList();
    renderReader();

    if (wasUnseen) {
      mail.setFlags(accId, folder, uid, { add: ["\\Seen"] })
        .then(() => syncMailBaseline())
        .catch(() => {});
    }
  } catch (err) {
    if (pane) {
      pane.innerHTML = `<div class="mail-empty-read"><p class="hint">${esc(err.message || String(err))}</p></div>`;
    }
    hooks.toast(err.message || String(err));
  }
}

function renderReader() {
  const pane = $("mail-read-pane");
  if (!pane) return;
  if (!state.message) {
    pane.innerHTML = `
      <div class="mail-empty-read">
        <div class="mail-empty-illus" aria-hidden="true">
          <svg viewBox="0 0 120 96" width="88" height="70">
            <rect x="14" y="28" width="92" height="58" rx="8" fill="none" stroke="currentColor" stroke-width="3"/>
            <path d="M18 34 L60 62 L102 34" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M22 82 L48 58" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity="0.45"/>
            <path d="M98 82 L72 58" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity="0.45"/>
            <path d="M38 22 L60 8 L82 22" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>
          </svg>
        </div>
        <p class="hint">Select a message</p>
      </div>
    `;
    return;
  }
  const m = state.message;
  const msgAccountId = m.accountId || state.accountId;
  const msgFolder = m.folder || state.folder || "INBOX";
  const msgAcc = state.accounts.find((a) => a.id === msgAccountId);
  const existingMailTask = m.messageId && hooks.findTaskByMailId
    ? hooks.findTaskByMailId(m.messageId)
    : null;
  const night = state.readerTheme === "dark";
  const atts = (m.attachments || []).map((a) => {
    const url = mail.attachmentUrl(msgAccountId, msgFolder, m.uid, a.part, a.filename);
    const image = isImageAttachment(a);
    const ext = fileExtLabel(a.filename, a.type);
    return `
      <button type="button" class="mail-attach-card" data-url="${esc(url)}" data-name="${esc(a.filename || "attachment")}" title="Download ${esc(a.filename || "attachment")}">
        <span class="mail-attach-thumb ${image ? "is-image" : "is-file"}">
          ${image
            ? `<img src="${esc(url)}" alt="" loading="lazy" />`
            : `<span class="mail-attach-ext">${esc(ext)}</span>`}
        </span>
        <span class="mail-attach-meta">
          <span class="mail-attach-name" dir="auto">${esc(a.filename || "attachment")}</span>
          <span class="mail-attach-size">${esc(formatBytes(a.size))}</span>
        </span>
      </button>
    `;
  }).join("");

  pane.dataset.readerTheme = state.readerTheme;
  pane.innerHTML = `
    <div class="mail-read-head">
      <div class="mail-read-head-top">
        <h2 dir="auto">${esc(m.subject)}</h2>
        <div class="mail-reader-tools">
          ${m.html && m.text ? `<button class="ghost-btn mail-reader-view-btn" type="button" id="mail-reader-plain" title="Toggle HTML / plain text">${state.readerView === "plain" ? "HTML" : "Text"}</button>` : ""}
          <button class="icon-btn mail-reader-theme-btn" type="button" id="mail-reader-theme" title="${night ? "Light desk" : "Dark desk"}" aria-label="${night ? "Light desk" : "Dark desk"}">
            ${night
              ? `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 18a6 6 0 1 1 0-12 6 6 0 0 1 0 12Zm0 4a1 1 0 0 1-1-1v-1a1 1 0 1 1 2 0v1a1 1 0 0 1-1 1ZM12 4a1 1 0 0 1-1-1V2a1 1 0 1 1 2 0v1a1 1 0 0 1-1 1Zm8 9a1 1 0 0 1-1-1 1 1 0 1 1 2 0 1 1 0 0 1-1 1ZM4 13a1 1 0 0 1-1-1 1 1 0 1 1 2 0 1 1 0 0 1-1 1Zm13.66 6.66a1 1 0 0 1-1.41 0l-.71-.7a1 1 0 1 1 1.41-1.42l.71.71a1 1 0 0 1 0 1.41ZM6.05 7.05a1 1 0 0 1-1.41 0l-.71-.7A1 1 0 0 1 5.34 4.9l.71.71a1 1 0 0 1 0 1.41Zm12.02-2.12a1 1 0 0 1 0 1.41l-.71.71A1 1 0 1 1 15.95 5.6l.71-.7a1 1 0 0 1 1.41 0ZM6.05 16.95a1 1 0 0 1 0 1.41l-.71.71a1 1 0 1 1-1.41-1.42l.71-.7a1 1 0 0 1 1.41 0Z"/></svg>`
              : `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21 14.5A8.5 8.5 0 0 1 9.5 3a7 7 0 1 0 11.5 11.5Z"/></svg>`}
          </button>
        </div>
      </div>
      <div class="mail-meta">
        ${isAllAccounts() && msgAcc ? `<div><strong>Mailbox</strong> ${esc(msgAcc.email || msgAcc.name || "")}</div>` : ""}
        <div><strong>From</strong> ${esc(addrText(m.from))}</div>
        <div><strong>To</strong> ${esc(addrText(m.to))}</div>
        ${m.cc?.length ? `<div><strong>Cc</strong> ${esc(addrText(m.cc))}</div>` : ""}
        <div><strong>Date</strong> ${esc(m.date ? new Date(m.date).toLocaleString() : "")}</div>
      </div>
      <div class="btn-row mail-read-actions">
        <button class="primary" type="button" id="mail-reply">Reply</button>
        <button class="ghost-btn" type="button" id="mail-reply-all">Reply all</button>
        <button class="ghost-btn" type="button" id="mail-forward">Forward</button>
        <button class="ghost-btn" type="button" id="mail-add-task" title="${existingMailTask ? "Open the linked task (already saved)" : "Save as a task immediately — no extra Save needed"}">${existingMailTask ? "Open task" : "Add as task"}</button>
        <button class="ghost-btn" type="button" id="mail-toggle-read">${m.flags?.includes("\\Seen") ? "Mark unread" : "Mark read"}</button>
        <button class="ghost-btn" type="button" id="mail-move">Move</button>
        <button class="danger-btn" type="button" id="mail-delete">Delete</button>
      </div>
      ${atts ? `<div class="mail-attach-box"><div class="mail-attach-box-label">Attachments</div><div class="mail-attach-list">${atts}</div></div>` : ""}
    </div>
    <div class="mail-read-body" id="mail-read-body"></div>
  `;

  $("mail-reader-theme").onclick = () => cycleReaderTheme();
  $("mail-reader-plain")?.addEventListener("click", () => cycleReaderView());
  pane.querySelectorAll(".mail-attach-card").forEach((btn) => {
    btn.addEventListener("click", () => downloadMailAttachment(btn));
  });

  const bodyEl = $("mail-read-body");
  const preferPlain = state.readerView === "plain" || !m.html;
  if (!preferPlain && m.html) {
    const host = document.createElement("div");
    host.className = "mail-html-host";
    bodyEl.appendChild(host);
    mountIsolatedHtml(host, m.html);
  } else {
    bodyEl.innerHTML = `<pre class="mail-text">${esc(m.text || "")}</pre>`;
  }

  $("mail-reply").onclick = () => openCompose({
    mode: "reply",
    accountId: msgAccountId,
    to: addrText(m.replyTo?.length ? m.replyTo : m.from),
    subject: /^re:/i.test(m.subject || "") ? m.subject : `Re: ${m.subject || ""}`,
    text: "",
    inReplyTo: m.messageId || "",
    references: buildReferences(m),
  });
  $("mail-reply-all").onclick = () => {
    const mine = (msgAcc?.email || "").toLowerCase();
    const people = [...(m.from || []), ...(m.to || []), ...(m.cc || [])]
      .filter((a) => (a.address || "").toLowerCase() !== mine);
    openCompose({
      mode: "reply-all",
      accountId: msgAccountId,
      to: addrText(m.replyTo?.length ? m.replyTo : m.from),
      cc: people.map((a) => a.address).filter(Boolean).join(", "),
      subject: /^re:/i.test(m.subject || "") ? m.subject : `Re: ${m.subject || ""}`,
      text: "",
      inReplyTo: m.messageId || "",
      references: buildReferences(m),
    });
  };
  $("mail-forward").onclick = () => openCompose({
    mode: "forward",
    accountId: msgAccountId,
    subject: /^fwd:/i.test(m.subject || "") ? m.subject : `Fwd: ${m.subject || ""}`,
    text: forwardDraftBody(m),
  });
  $("mail-add-task").onclick = () => addMessageAsTask(m, existingMailTask);
  $("mail-toggle-read").onclick = async () => {
    const seen = m.flags?.includes("\\Seen");
    try {
      await mail.setFlags(msgAccountId, msgFolder, m.uid, seen
        ? { remove: ["\\Seen"] }
        : { add: ["\\Seen"] });
      const flags = new Set(m.flags || []);
      if (seen) flags.delete("\\Seen");
      else flags.add("\\Seen");
      state.message = { ...m, flags: [...flags], accountId: msgAccountId, folder: msgFolder };
      const row = state.messages.find((x) => (x.listKey || msgKey(rowAccountId(x), x.uid)) === msgKey(msgAccountId, m.uid));
      if (row) {
        row.unseen = seen;
        row.flags = [...flags];
      }
      renderMessageList();
      renderReader();
      syncMailBaseline();
    } catch (err) {
      hooks.toast(err.message || String(err));
    }
  };
  $("mail-move").onclick = () => openMoveModal(m.uid, msgAccountId, msgFolder);
  $("mail-delete").onclick = async () => {
    if (!confirm("Delete this message?")) return;
    await safeLoad(async () => {
      await mail.deleteMessages(msgAccountId, msgFolder, [m.uid]);
      state.selectedUid = null;
      state.selectedKey = null;
      state.message = null;
      await refreshMessages({ fresh: true });
      state.syncedAt = Date.now();
      state.syncKey = syncKey();
      hooks.toast("Message deleted");
    });
  };
}

function formatBytes(n) {
  const size = Number(n) || 0;
  if (size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageAttachment(a) {
  const type = String(a?.type || "").toLowerCase();
  if (type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a?.filename || "");
}

function fileExtLabel(filename, type) {
  const fromName = String(filename || "").split(".").pop();
  if (fromName && fromName !== filename && fromName.length <= 5) return fromName.toUpperCase();
  const sub = String(type || "").split("/")[1] || "FILE";
  return sub.slice(0, 5).toUpperCase();
}

async function downloadMailAttachment(btn) {
  const url = btn?.dataset?.url;
  const name = btn?.dataset?.name || "attachment";
  if (!url) return;
  btn.disabled = true;
  try {
    const resp = await fetch(url);
    const type = (resp.headers.get("content-type") || "").toLowerCase();
    if (!resp.ok || type.includes("application/json")) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `Download failed (${resp.status})`);
    }
    const blob = await resp.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (err) {
    hooks.toast(err.message || String(err));
  } finally {
    btn.disabled = false;
  }
}

function stripHtmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainBody(m) {
  const text = String(m.text || "").trim();
  if (text) return text;
  return stripHtmlToText(m.html);
}

function addMessageAsTask(m, existing = null) {
  if (!hooks.addTask) {
    hooks.toast("Tasks are not available in this view");
    return;
  }
  // Already linked — open it; do not create a duplicate.
  if (existing?.id) {
    hooks.toast("Opening linked task");
    if (hooks.openTasks) hooks.openTasks(existing.id);
    return;
  }
  const draft = buildTaskDraftFromMessage(m);
  if (draft.messageId && hooks.findTaskByMailId) {
    const again = hooks.findTaskByMailId(draft.messageId);
    if (again?.id) {
      hooks.toast("Opening linked task");
      renderReader();
      if (hooks.openTasks) hooks.openTasks(again.id);
      return;
    }
  }
  // Fallback marker if Message-ID is missing (rare).
  if (!draft.marker) {
    const accId = m.accountId || state.accountId || "";
    draft.notes = `${draft.notes}\n${mailTaskMarker(`${accId}:${m.uid}`)}`.trim();
  }
  try {
    const id = hooks.addTask({
      title: draft.title,
      notes: draft.notes,
      url: draft.url,
      due_at: draft.due_at,
      due_has_time: draft.due_has_time,
      remind_at: draft.remind_at,
    });
    // Stay on Mail — task is already persisted (no separate Save step).
    // Meetings with a future due date live under Upcoming, not Today.
    const where = draft.due_at
      ? (draft.due_at > Date.now() ? "Upcoming" : "Today")
      : "Inbox";
    hooks.toast(draft.isEvent
      ? `Meeting saved — look under ${where} (or Open task)`
      : `Task saved — look under ${where} (or Open task)`);
    void id;
    renderReader();
  } catch (err) {
    hooks.toast(err.message || String(err));
  }
}

function buildReferences(m) {
  const parts = `${m.references || ""} ${m.messageId || ""}`.trim().split(/\s+/).filter(Boolean);
  return [...new Set(parts)].join(" ");
}

function forwardDraftBody(m) {
  const who = addrText(m.from) || fromLabel(m.from);
  const when = m.date ? new Date(m.date).toLocaleString() : "";
  return `\n\n---------- Forwarded message ----------\nFrom: ${who}\nDate: ${when}\nSubject: ${m.subject || ""}\n\n${plainBody(m)}`;
}

async function safeLoad(fn) {
  state.loading = true;
  state.error = "";
  renderMessageList();
  try {
    await fn();
  } catch (err) {
    state.error = err.message || String(err);
    hooks.toast(state.error);
  } finally {
    state.loading = false;
    renderShell();
  }
}

function senderNameValue(account) {
  const name = String(account?.name || "").trim();
  const email = String(account?.email || "").trim();
  // Treat email-as-name as unset so edit prompts for a real sender name.
  if (!name || name.toLowerCase() === email.toLowerCase()) return "";
  return name;
}

function openAccountModal(existing = null) {
  const domainGuess = (existing?.email || "").split("@")[1] || "yourdomain.com";
  const senderName = senderNameValue(existing);
  hooks.openModal(`
    <h2>${existing ? "Mailbox settings" : "Add mail account"}</h2>
    <p class="hint">IMAP receives mail; SMTP sends it. Passwords stay in <code>%LOCALAPPDATA%\\TodoBox</code> on this PC only.</p>
    <div class="field">
      <label for="m-name">Sender name</label>
      <input id="m-name" value="${esc(senderName)}" placeholder="e.g. Moein Mollaee" required />
      <p class="hint">Recipients see this as the From name (not just the email address).</p>
    </div>
    <div class="field"><label for="m-email">Email address</label><input id="m-email" value="${esc(existing?.email || "")}" placeholder="you@${esc(domainGuess)}" /></div>
    <div class="field"><label for="m-pass">Password ${existing ? "(leave blank to keep current)" : ""}</label><input id="m-pass" type="password" autocomplete="new-password" /></div>
    <div class="field"><label for="m-imap-host">IMAP host</label><input id="m-imap-host" value="${esc(existing?.imap?.host || `mail.${domainGuess}`)}" /></div>
    <div class="field"><label for="m-imap-port">IMAP port</label><input id="m-imap-port" type="number" value="${esc(String(existing?.imap?.port || 993))}" /></div>
    <label class="check-row"><input id="m-imap-secure" type="checkbox" ${existing?.imap?.secure !== false ? "checked" : ""} /> IMAP SSL/TLS</label>
    <div class="field"><label for="m-smtp-host">SMTP host</label><input id="m-smtp-host" value="${esc(existing?.smtp?.host || existing?.imap?.host || `mail.${domainGuess}`)}" /></div>
    <div class="field"><label for="m-smtp-port">SMTP port</label><input id="m-smtp-port" type="number" value="${esc(String(existing?.smtp?.port || 465))}" /></div>
    <label class="check-row"><input id="m-smtp-secure" type="checkbox" ${existing?.smtp?.secure !== false ? "checked" : ""} /> SMTP SSL/TLS</label>
    <div class="btn-row">
      <button class="primary" type="button" id="m-save">Save</button>
      <button class="ghost-btn" type="button" id="m-test">Test</button>
      ${existing ? `<button class="danger-btn" type="button" id="m-del">Remove</button>` : ""}
    </div>
  `);

  const payloadFromForm = () => {
    const email = $("m-email").value.trim();
    const pass = $("m-pass").value;
    const name = $("m-name").value.trim();
    const body = {
      name,
      email,
      imap: {
        host: $("m-imap-host").value.trim(),
        port: Number($("m-imap-port").value) || 993,
        secure: $("m-imap-secure").checked,
        user: email,
        pass: pass || undefined,
      },
      smtp: {
        host: $("m-smtp-host").value.trim(),
        port: Number($("m-smtp-port").value) || 465,
        secure: $("m-smtp-secure").checked,
        user: email,
        pass: pass || undefined,
      },
    };
    return body;
  };

  $("m-name").focus();

  $("m-save").onclick = async () => {
    try {
      const body = payloadFromForm();
      if (!body.name) return hooks.toast("Sender name is required");
      if (!body.email) return hooks.toast("Email is required");
      if (!existing && !body.imap.pass) return hooks.toast("Password is required");
      const saved = existing
        ? await mail.updateAccount(existing.id, body)
        : await mail.createAccount(body);
      state.accountId = saved.id;
      hooks.closeModal();
      hooks.toast("Account saved");
      state.syncedAt = 0;
      await bootMail({ force: true });
    } catch (err) {
      hooks.toast(err.message || String(err));
    }
  };

  $("m-test").onclick = async () => {
    try {
      const body = payloadFromForm();
      if (!body.email) return hooks.toast("Email is required");
      if (!existing && !body.imap.pass) return hooks.toast("Password is required to test");
      if (existing) body.id = existing.id;
      const result = await mail.testConnection(body);
      hooks.toast(result.imap?.ok
        ? (result.smtp?.ok ? "IMAP + SMTP OK" : `IMAP OK, SMTP: ${result.smtp?.error || "failed"}`)
        : "IMAP test failed");
    } catch (err) {
      hooks.toast(err.message || String(err));
    }
  };

  $("m-del")?.addEventListener("click", async () => {
    if (!existing || !confirm("Remove this account from TodoBox?")) return;
    try {
      await mail.removeAccount(existing.id);
      hooks.closeModal();
      hooks.toast("Account removed");
      state.syncedAt = 0;
      await bootMail({ force: true });
    } catch (err) {
      hooks.toast(err.message || String(err));
    }
  });
}

function openCompose(preset = {}) {
  const isReply = String(preset.mode || "").startsWith("reply");
  const sendAccountId = preset.accountId
    || (!isAllAccounts() ? state.accountId : null)
    || state.accounts[0]?.id;
  const acc = state.accounts.find((a) => a.id === sendAccountId);
  const fromName = senderNameValue(acc);
  const fromLine = fromName
    ? `${fromName} <${acc?.email || ""}>`
    : (acc?.email || "");
  const initialHtml = preset.html
    || (preset.text ? plainToHtml(preset.text) : "");
  hooks.openModal(`
    <h2>${preset.mode === "forward" ? "Forward" : isReply ? "Reply" : "Compose"}</h2>
    <p class="hint">From: <strong dir="auto">${esc(fromLine || "(set sender name in Settings)")}</strong>${
      fromName ? "" : ` — <button class="text-btn" type="button" id="c-fix-from">Mailbox settings</button>`
    }</p>
    <div class="field"><label>To</label><input id="c-to" value="${esc(preset.to || "")}" /></div>
    <div class="field"><label>Cc</label><input id="c-cc" value="${esc(preset.cc || "")}" /></div>
    <div class="field"><label>Subject</label><input id="c-subject" value="${esc(preset.subject || "")}" dir="auto" /></div>
    <div class="field">
      <label>Message</label>
      <div id="c-editor"></div>
    </div>
    <div class="field"><label>Attachments</label><input id="c-files" type="file" multiple /></div>
    <div class="btn-row">
      <button class="primary" type="button" id="c-send">Send</button>
    </div>
  `);
  $("c-fix-from")?.addEventListener("click", () => {
    if (acc) openAccountModal(acc);
  });
  const editor = mountComposeEditor($("c-editor"), {
    initialHtml,
    placeholder: isReply ? "Write your reply…" : "Write your message…",
  });
  if (isReply || preset.mode === "forward") {
    editor.focus();
  } else {
    $("c-to").focus();
  }
  $("c-send").onclick = async () => {
    try {
      if (!sendAccountId || sendAccountId === ALL_ACCOUNTS) {
        return hooks.toast("Pick a mailbox to send from");
      }
      if (!senderNameValue(acc)) {
        hooks.toast("Set a sender name in Mailbox settings before sending");
        openAccountModal(acc);
        return;
      }
      const files = [...($("c-files").files || [])];
      const attachments = [];
      for (const file of files) {
        const contentBase64 = await fileToBase64(file);
        attachments.push({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          contentBase64,
        });
      }
      const rawHtml = editor.getHtml();
      const text = editor.getText();
      const { html, inlineAttachments } = extractInlineImages(rawHtml);
      attachments.push(...inlineAttachments);
      if (!text && !html && !attachments.length) {
        return hooks.toast("Write a message or add an attachment");
      }
      const result = await mail.sendMail(sendAccountId, {
        to: $("c-to").value.trim(),
        cc: $("c-cc").value.trim() || undefined,
        subject: $("c-subject").value.trim(),
        text: text || (html ? undefined : ""),
        html: html || undefined,
        inReplyTo: preset.inReplyTo || undefined,
        references: preset.references || undefined,
        attachments,
      });
      editor.destroy();
      hooks.closeModal();
      hooks.toast(result?.savedToSent
        ? "Message sent · saved to Sent"
        : "Message sent · could not save to Sent folder");
      // Refresh if user is looking at Sent so the copy appears.
      if (result?.savedToSent && /sent/i.test(state.folder || "")) {
        state.syncedAt = 0;
        await bootMail({ force: true });
      }
    } catch (err) {
      hooks.toast(err.message || String(err));
    }
  };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : "");
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

async function openMoveModal(uid, accountId = null, folder = null) {
  const accId = accountId || state.accountId;
  const fromFolder = folder || state.folder || "INBOX";
  if (!accId || accId === ALL_ACCOUNTS) {
    hooks.toast("Pick a mailbox first");
    return;
  }
  let folders = state.folders;
  if (isAllAccounts() || !folders?.length) {
    try {
      folders = await mail.listFolders(accId, { fresh: false });
    } catch (err) {
      hooks.toast(err.message || String(err));
      return;
    }
  }
  hooks.openModal(`
    <h2>Move message</h2>
    <div class="field">
      <label>Destination folder</label>
      <select id="mv-folder">
        ${folders.map((f) => `<option value="${esc(f.path)}">${esc(f.path)}</option>`).join("")}
      </select>
    </div>
    <div class="btn-row"><button class="primary" type="button" id="mv-go">Move</button></div>
  `);
  $("mv-go").onclick = async () => {
    try {
      const destination = $("mv-folder").value;
      await mail.moveMessages(accId, fromFolder, [uid], destination);
      hooks.closeModal();
      state.selectedUid = null;
      state.selectedKey = null;
      state.message = null;
      hooks.toast("Moved");
      await safeLoad(async () => {
        await refreshMessages({ fresh: true });
        state.syncedAt = Date.now();
        state.syncKey = syncKey();
      });
    } catch (err) {
      hooks.toast(err.message || String(err));
    }
  };
}

export async function pollUnreadTotal() {
  try {
    await mail.health();
    const accounts = await mail.listAccounts();
    let total = 0;
    for (const a of accounts) {
      try {
        const st = await mail.unread(a.id, "INBOX");
        total += st.unseen || 0;
      } catch {
        /* ignore per-account */
      }
    }
    return { ok: true, unseen: total };
  } catch {
    return { ok: false, unseen: 0 };
  }
}

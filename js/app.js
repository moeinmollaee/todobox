import * as db from "./db.js";
import { parseQuickAdd } from "./nlp.js";
import {
  esc, fmtDay, fmtShortDay, fmtTime, fmtDateInput, fmtTimeInput, greeting,
  looksLikeUrl, toNavigableUrl, hostnameOf, faviconUrl, parseDateTimeLocal,
  recurrenceLabel,
} from "./util.js";
import {
  storageGet, storageSet, getAssetUrl, getTopSites, hasTopSites, initWebApp,
} from "./platform/index.js";
import { initMailUi, bootMail } from "./mail/ui.js";

const $ = (id) => document.getElementById(id);

const PROJECT_COLORS = ["#0f6e62", "#c45c26", "#3d5a80", "#7a5cbf", "#b4534b", "#4d7c0f"];

const ui = {
  page: "home",
  view: "today",
  projectId: null,
  tagId: null,
  selectedId: null,
  board: false,
  query: "",
  priority: "",
  themePref: "system",
  hiddenTopSites: [],
  undo: [],
  folderWritable: false,
};

let topSites = [];

function pushUndo(label, restore) {
  ui.undo.push({ label, restore });
  if (ui.undo.length > 30) ui.undo.shift();
}

function toast(message, actionLabel, action) {
  const el = $("toast");
  el.innerHTML = `<span>${esc(message)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ""}`;
  el.classList.remove("hidden");
  const btn = el.querySelector("button");
  const hide = () => el.classList.add("hidden");
  if (btn && action) btn.onclick = () => { action(); hide(); };
  clearTimeout(toast._t);
  toast._t = setTimeout(hide, 5000);
}

function undoLast() {
  const item = ui.undo.pop();
  if (!item) return;
  item.restore();
  toast("Undone");
  render();
}

function applyTheme(pref) {
  ui.themePref = pref;
  const resolved = pref === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : pref;
  document.documentElement.dataset.theme = resolved;
  storageSet({ theme: pref });
  if (db.isReady() && db.getSetting("theme") !== pref) db.setSetting("theme", pref);
}

function cycleTheme() {
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(ui.themePref) + 1) % order.length];
  applyTheme(next);
  toast(`Theme: ${next}`);
}

/** Pick a Tasks nav view where this task actually appears in the list. */
function viewForTaskVisibility(task) {
  if (!task || task.deleted_at || task.archived) return "inbox";
  if (task.completed_at) return "completed";
  if (task.project_id) return "project";
  if (!task.due_at) return "inbox";
  const endToday = new Date();
  endToday.setHours(23, 59, 59, 999);
  if (task.due_at <= endToday.getTime()) return "today";
  const endUpcoming = new Date();
  endUpcoming.setHours(0, 0, 0, 0);
  endUpcoming.setDate(endUpcoming.getDate() + 14);
  endUpcoming.setHours(23, 59, 59, 999);
  if (task.due_at <= endUpcoming.getTime()) return "upcoming";
  // Dated further out — still listed under Inbox (no project).
  return "inbox";
}

function setPage(page) {
  ui.page = page;
  $("home").classList.toggle("hidden", page !== "home");
  $("workspace").classList.toggle("hidden", page !== "tasks");
  $("mail")?.classList.toggle("hidden", page !== "mail");
  $("go-tasks")?.classList.toggle("active-nav", page === "tasks");
  $("go-mail")?.classList.toggle("active-nav", page === "mail");
  document.body.classList.toggle("mail-page", page === "mail");
  if (page === "home") ui.selectedId = null;
  if (page === "mail") bootMail();
  else render();
}

function openModal(html) {
  const el = $("modal");
  el.innerHTML = `<div class="modal-card">${html}</div>`;
  el.classList.remove("hidden");
}

function closeModal() {
  $("modal").classList.add("hidden");
  $("modal").innerHTML = "";
}

function dueHtml(task) {
  if (!task.due_at) return "";
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const overdue = !task.completed_at && (
    task.due_has_time ? task.due_at < Date.now() : task.due_at < start.getTime()
  );
  const label = task.due_has_time
    ? `${fmtShortDay(task.due_at)} ${fmtTime(task.due_at)}`
    : fmtShortDay(task.due_at);
  return `<span class="${overdue ? "overdue" : ""}">${esc(label)}</span>`;
}

function starBtn(task) {
  const on = !!Number(task.starred);
  return `<button class="task-star-btn ${on ? "on" : ""}" data-act="star" type="button" title="${on ? "Unstar" : "Star — pin on Home"}" aria-label="${on ? "Unstar" : "Star"}" aria-pressed="${on ? "true" : "false"}">
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="${on
      ? "M12 2.5l2.9 6.1 6.7.8-4.9 4.5 1.3 6.6L12 17.3 5.9 20.5l1.3-6.6L2.4 9.4l6.7-.8L12 2.5Z"
      : "M12 4.2l2.1 4.4 4.9.6-3.6 3.3.9 4.8L12 15.2 7.7 17.3l.9-4.8L5 9.2l4.9-.6L12 4.2m0-1.7L8.5 9.2 2 10.1l4.8 4.4-1.3 6.5L12 17.8l6.5 3.2-1.3-6.5L22 10.1 15.5 9.2 12 2.5Z"}"/></svg>
  </button>`;
}

function taskRow(task, extra = "", { contextLabel = "" } = {}) {
  const tags = (task.tags || []).map((t) => `<span class="chip">@${esc(t.name)}</span>`).join("");
  const rec = task.recurrence ? `<span class="chip">${esc(recurrenceLabel(task.recurrence))}</span>` : "";
  const proj = task.project_id ? db.getProject(task.project_id) : null;
  const projChip = proj ? `<span class="chip chip-project">${esc(proj.name)}</span>` : "";
  const ctxChip = contextLabel
    ? `<span class="chip chip-context">${esc(contextLabel)}</span>`
    : "";
  const linkBtn = task.url
    ? `<button class="task-link-btn" data-act="open-link" data-url="${esc(task.url)}" type="button" title="Open link in new tab" aria-label="Open link in new tab">
         <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10.59 13.41a1 1 0 0 0 1.41 1.41l6-6V11a1 1 0 1 0 2 0V5a1 1 0 0 0-1-1h-6a1 1 0 1 0 0 2h2.17l-6.58 6.59ZM5 6a3 3 0 0 1 3-3h3a1 1 0 1 1 0 2H8a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3a1 1 0 1 1 2 0v3a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6Z"/></svg>
       </button>`
    : "";
  return `<li class="task-row ${extra}${ui.selectedId === task.id ? " selected" : ""}${Number(task.starred) ? " starred" : ""}" data-id="${task.id}" draggable="true">
    <button class="check p${task.priority}" data-act="complete" title="Complete" type="button"></button>
    <div>
      <span class="task-title" dir="auto">${esc(task.title)}</span>
      <div class="task-meta">${ctxChip}${dueHtml(task)}${projChip}${tags}${rec}${linkBtn}</div>
    </div>
    ${starBtn(task)}
  </li>`;
}

function insertHintPhrase(input, phrase) {
  if (!input || !phrase) return;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const already = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, "i").test(input.value);
  if (!already) {
    const cur = input.value.trim();
    input.value = cur ? `${cur} ${phrase}` : phrase;
  }
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

const HINT_GROUPS = [
  { label: "Date", items: ["today", "tomorrow", "tonight", "monday", "friday", "next week", "5pm"] },
  { label: "Repeat", items: ["every day", "every weekday", "every week", "every month", "every year", "every 3 days"] },
  { label: "More", items: ["p1", "p2", "p3", "#Work", "@later"] },
];

function openHintModal(inputId) {
  const home = inputId === "home-quick-input";
  const blurb = home
    ? `On Home, no date means <b>today</b>. Click a phrase to add it.`
    : `Click a phrase to add it. No date stays in Inbox (except on Today view).`;
  const rows = HINT_GROUPS.map((g) => `
    <div class="hint-row"><span class="hint-label">${esc(g.label)}</span>
      ${g.items.map((p) => `<button type="button" class="hint-chip" data-insert="${esc(p)}">${esc(p)}</button>`).join("")}
    </div>`).join("");
  openModal(`<div class="hint-sheet" data-hint-for="${esc(inputId)}">
    <h2>Phrases</h2>
    <p class="hint">${blurb}</p>
    ${rows}
  </div>`);
}

function submitQuickAdd(raw, defaults = {}) {
  const text = raw.trim();
  if (!text) return;
  const parsed = parseQuickAdd(text);
  let dueAt = parsed.dueAt;
  let dueHasTime = parsed.dueHasTime;
  if (!dueAt && defaults.dueToday) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    dueAt = d.getTime();
    dueHasTime = false;
  }
  const id = db.addTask({
    title: parsed.title,
    priority: parsed.priority,
    due_at: dueAt,
    due_has_time: dueHasTime,
    recurrence: parsed.recurrence,
    projectName: parsed.projectName,
    tags: parsed.tags,
    project_id: defaults.project_id || (ui.view === "project" ? ui.projectId : null),
    parent_id: defaults.parent_id || null,
  });
  pushUndo("Task added", () => db.deleteTask(id));
  render();
}

async function connectFolderFlow() {
  try {
    const picked = await db.pickFolder();
    if (picked.existing && db.stats().open + db.stats().done > 0) {
      openModal(`
        <h2>This folder already has a database</h2>
        <p class="hint">Merge keeps tasks from this browser and from <b>todobox.sqlite</b> in “${esc(picked.name)}”. Load replaces this browser. Keep current overwrites the file.</p>
        <div class="btn-row">
          <button class="primary" id="folder-merge" type="button">Merge</button>
          <button class="ghost-btn" id="folder-load" type="button">Load folder file</button>
          <button class="ghost-btn" id="folder-overwrite" type="button">Keep current</button>
        </div>
      `);
      $("folder-merge").onclick = async () => {
        await db.connectFolder(picked.handle, picked.existing, "merge");
        ui.folderWritable = true;
        closeModal();
        toast(`Merged with ${picked.name}`);
        render();
      };
      $("folder-load").onclick = async () => {
        await db.connectFolder(picked.handle, picked.existing, "load");
        ui.folderWritable = true;
        closeModal();
        toast(`Loaded data from ${picked.name}`);
        render();
      };
      $("folder-overwrite").onclick = async () => {
        await db.connectFolder(picked.handle, picked.existing, "overwrite");
        ui.folderWritable = true;
        closeModal();
        toast(`Saving current data to ${picked.name}`);
        render();
      };
      return;
    }
    await db.connectFolder(picked.handle, picked.existing, picked.existing ? "load" : "overwrite");
    ui.folderWritable = true;
    toast(picked.existing ? `Loaded data from ${picked.name}` : `Saving to ${picked.name}`);
    render();
  } catch (err) {
    if (err?.name !== "AbortError") toast(err.message || "Could not open folder");
  }
}

function exportBackup() {
  const bytes = db.exportBytes();
  const blob = new Blob([bytes], { type: "application/vnd.sqlite3" });
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `todobox-${stamp}.sqlite`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function wireFavicons(root) {
  root.querySelectorAll(".dial-icon img").forEach((img) => {
    img.addEventListener("error", () => {
      const title = img.closest(".dial")?.querySelector(".dial-title")?.textContent || "?";
      img.replaceWith(Object.assign(document.createElement("span"), {
        className: "letter",
        textContent: title.trim().charAt(0).toUpperCase(),
      }));
    });
  });
}

function dialHtml(item, kind) {
  const icon = faviconUrl(item.url, 32);
  return `<div class="dial" data-kind="${kind}" data-id="${esc(item.id || item.url)}" data-url="${esc(item.url)}" title="${esc(item.title)}">
    <span class="dial-icon">
      <img src="${esc(icon)}" alt="" />
      <button class="dial-x" data-act="remove" type="button" title="Remove">×</button>
    </span>
    <span class="dial-title">${esc(item.title || hostnameOf(item.url))}</span>
  </div>`;
}

function renderFolderPill() {
  const pill = $("folder-pill");
  const name = db.getFolderName();
  pill.hidden = false;
  pill.style.cursor = "pointer";
  if (!name) {
    pill.textContent = "Connect folder";
    pill.title = "Choose a folder to save todobox.sqlite";
    pill.onclick = connectFolderFlow;
    return;
  }
  if (!ui.folderWritable) {
    pill.textContent = "Reconnect folder";
    pill.title = `Allow access to ${name} so TodoBox can save todobox.sqlite`;
    pill.onclick = async () => {
      const ok = await db.requestFolderPermission();
      ui.folderWritable = ok;
      if (ok) await db.flush();
      else await connectFolderFlow();
      render();
    };
    return;
  }
  pill.textContent = name;
  pill.title = `Database folder: ${name}`;
  pill.onclick = () => {
    $("settings").classList.remove("hidden");
    renderSettings();
  };
}

function renderHome() {
  $("hello").textContent = greeting();
  $("date-line").textContent = fmtDay(Date.now());
  renderFolderPill();

  const shortcuts = db.listShortcuts();
  const shortHtml = shortcuts.map((s) => dialHtml(s, "shortcut")).join("")
    + `<button class="dial-add" id="add-shortcut" type="button"><span class="dial-icon">+</span><span class="dial-title">Add</span></button>`;
  $("shortcut-grid").innerHTML = shortHtml;
  $("add-shortcut").onclick = () => openShortcutModal();
  wireFavicons($("shortcut-grid"));

  const topsiteSection = $("topsite-grid")?.closest("section");
  if (topsiteSection) topsiteSection.classList.toggle("hidden", !hasTopSites);
  if (hasTopSites) {
    const visible = topSites.filter((s) => !ui.hiddenTopSites.includes(s.url)).slice(0, 8);
    $("topsite-grid").innerHTML = visible.length
      ? visible.map((s) => dialHtml({ ...s, id: s.url }, "top")).join("")
      : `<p class="empty">Visit a few sites and they will appear here.</p>`;
    wireFavicons($("topsite-grid"));
  }

  const starred = db.listStarredTasks();
  const starredIds = new Set(starred.map((t) => t.id));
  const today = db.queryTasks("today").filter((t) => !starredIds.has(t.id));
  const starredHtml = starred.map((t) => (
    taskRow(t, "starred-pin", { contextLabel: db.taskContextLabel(t) })
  )).join("");
  const todayHtml = today.map((t) => taskRow(t)).join("");
  if (starredHtml || todayHtml) {
    $("home-today-list").innerHTML = `${starredHtml}${todayHtml}`;
  } else {
    $("home-today-list").innerHTML = `<li class="empty-row"><p class="empty">Nothing due today. Type a task below — it will be set for today.</p></li>`;
  }
  renderNotes();
}

function notePreview(body) {
  const line = String(body || "").trim().split(/\n/)[0] || "Empty note";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

const NOTE_MAX_LINES = 6;

function fitNoteTextarea(ta) {
  if (!ta) return;
  const cs = getComputedStyle(ta);
  const line = parseFloat(cs.lineHeight) || 20;
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const max = line * NOTE_MAX_LINES + pad + border;
  ta.style.maxHeight = "none";
  ta.style.height = "auto";
  const needed = ta.scrollHeight;
  ta.style.height = `${Math.min(needed, max)}px`;
  ta.style.maxHeight = `${max}px`;
  ta.style.overflowY = needed > max + 1 ? "auto" : "hidden";
}

function fitAllNoteTextareas(root = document) {
  root.querySelectorAll(".note-add, .note-card textarea").forEach(fitNoteTextarea);
}

function noteCard(note) {
  return `<article class="note-card" data-note-id="${esc(note.id)}">
    <textarea dir="auto" rows="3">${esc(note.body)}</textarea>
    <div class="note-actions">
      <button type="button" class="note-act-btn" data-note-act="archive" title="Archive" aria-label="Archive">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-9a2 2 0 0 1-2-2V5Zm2 0v3h14V5H5Zm4 7a1 1 0 0 0 0 2h6a1 1 0 1 0 0-2H9Z"/></svg>
      </button>
      <button type="button" class="note-act-btn note-trash" data-note-act="trash" title="Move to Trash" aria-label="Move to Trash">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M9 3a2 2 0 0 0-2 2v1H4a1 1 0 1 0 0 2h1l1 11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-11h1a1 1 0 1 0 0-2h-3V5a2 2 0 0 0-2-2H9Zm6 3V5H9v1h6Zm-6 4a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Zm6 1a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Z"/></svg>
      </button>
    </div>
  </article>`;
}

function renderNotes() {
  const notes = db.listNotes();
  const html = notes.length
    ? notes.map(noteCard).join("")
    : `<p class="empty">No notes yet.</p>`;
  document.querySelectorAll(".notes-list").forEach((list) => {
    const focused = list.querySelector("textarea:focus");
    const focusedId = focused?.closest("[data-note-id]")?.dataset.noteId;
    const focusedVal = focused?.value;
    const start = focused?.selectionStart;
    const end = focused?.selectionEnd;
    list.innerHTML = html;
    if (!focusedId) return;
    const again = list.querySelector(`[data-note-id="${CSS.escape(focusedId)}"] textarea`);
    if (!again) return;
    again.value = focusedVal;
    again.focus();
    if (typeof start === "number" && typeof end === "number") {
      again.selectionStart = start;
      again.selectionEnd = end;
    }
  });
  fitAllNoteTextareas();
}

function navBtn(id, label, count, active) {
  return `<button class="nav-btn ${active ? "active" : ""}" data-view="${id}" type="button">${esc(label)}<span class="count">${count}</span></button>`;
}

function currentTasks() {
  if (ui.view === "project") return db.queryTasks("project", { projectId: ui.projectId, query: ui.query, priority: ui.priority });
  if (ui.view === "tag") return db.queryTasks("tag", { tagId: ui.tagId, query: ui.query, priority: ui.priority });
  return db.queryTasks(ui.view, { query: ui.query, priority: ui.priority });
}

function viewTitle() {
  if (ui.view === "project") return db.getProject(ui.projectId)?.name || "Project";
  if (ui.view === "tag") return `@${db.listTags().find((t) => t.id === ui.tagId)?.name || "tag"}`;
  return {
    inbox: "Inbox",
    today: "Today",
    upcoming: "Upcoming",
    completed: "Completed",
    archive: "Archive",
    trash: "Trash",
  }[ui.view] || "Tasks";
}

function renderWorkspace() {
  const stats = db.stats();
  $("smart-nav").innerHTML = [
    navBtn("today", "Today", stats.today, ui.view === "today"),
    navBtn("inbox", "Inbox", db.queryTasks("inbox").length, ui.view === "inbox"),
    navBtn("upcoming", "Upcoming", db.queryTasks("upcoming").length, ui.view === "upcoming"),
    navBtn("completed", "Completed", stats.done, ui.view === "completed"),
    navBtn("archive", "Archive", stats.archive, ui.view === "archive"),
    navBtn("trash", "Trash", stats.trash, ui.view === "trash"),
  ].join("");

  const projects = db.listProjects();
  $("project-nav").innerHTML = projects.map((p) => {
    const n = db.queryTasks("project", { projectId: p.id }).length;
    return `<button class="proj-btn ${ui.view === "project" && ui.projectId === p.id ? "active" : ""}" data-project="${p.id}" type="button" title="Right-click to rename, archive, or move to Trash">
      <span><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</span>
      <span class="count">${n}</span>
    </button>`;
  }).join("") || `<p class="hint">No projects yet.</p>`;

  const tags = db.listTags();
  $("tag-nav").innerHTML = tags.map((t) => (
    `<div class="nav-row">
      <button class="nav-btn ${ui.view === "tag" && ui.tagId === t.id ? "active" : ""}" data-tag="${t.id}" type="button" title="Right-click to rename or delete">@${esc(t.name)}<span class="count">${t.use_count}</span></button>
      <button class="nav-x" data-act="delete-tag" data-tag="${t.id}" type="button" title="Delete tag">×</button>
    </div>`
  )).join("") || `<p class="hint">Tags appear from @name in quick add.</p>`;

  $("list-title").textContent = viewTitle();
  $("list-sub").textContent = ui.view === "today"
    ? "Due today, overdue, and daily repeats"
    : ui.view === "archive"
      ? "Parked for later. Unarchive to use again."
      : ui.view === "trash"
        ? "Deleted by mistake? Restore it. Delete forever removes it from the database."
        : "";
  $("board-toggle").classList.toggle("hidden", ui.view !== "project");
  $("board-toggle").textContent = ui.board ? "List" : "Board";
  $("task-filter").value = ui.query;
  $("priority-filter").value = ui.priority;
  const special = ui.view === "archive" || ui.view === "trash";
  $("quick-add").classList.toggle("hidden", special);
  $("quick-hint-open")?.classList.toggle("hidden", special);
  document.querySelector(".list-actions")?.classList.toggle("hidden", special);

  if (ui.view === "archive") {
    renderArchive();
    renderDetail();
    renderFolderPill();
    renderNotes();
    return;
  }
  if (ui.view === "trash") {
    renderTrash();
    renderDetail();
    renderFolderPill();
    renderNotes();
    return;
  }

  const tasks = currentTasks();
  if (ui.view === "project" && ui.board) {
    renderBoard(tasks);
  } else {
    const groups = ui.view === "upcoming" ? groupByDay(tasks) : null;
    if (groups) {
      $("list-body").innerHTML = groups.map(([day, items]) => (
        `<h3 class="side-label">${esc(fmtDay(day))}</h3><ul class="task-list">${items.map((t) => taskRow(t)).join("")}</ul>`
      )).join("") || `<p class="empty">Nothing in the next two weeks.</p>`;
    } else {
      $("list-body").innerHTML = tasks.length
        ? `<ul class="task-list">${tasks.map((t) => {
          const kids = db.getTask(t.id)?.subtasks?.filter((s) => !s.completed_at) || [];
          return taskRow(t) + kids.map((s) => taskRow(s, "sub")).join("");
        }).join("")}</ul>`
        : `<p class="empty">No tasks here.</p>`;
    }
  }
  renderDetail();
  renderFolderPill();
  renderNotes();
}

function groupByDay(tasks) {
  const map = new Map();
  for (const task of tasks) {
    const key = new Date(task.due_at).setHours(0, 0, 0, 0);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(task);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

function shelfItem(kind, id, title, meta, actions) {
  const buttons = actions.map((a) => (
    `<button type="button" class="${a.danger ? "danger-btn" : "ghost-btn"}" data-shelf-act="${a.act}" data-shelf-kind="${kind}" data-shelf-id="${id}">${esc(a.label)}</button>`
  )).join("");
  return `<div class="shelf-item">
    <div class="${kind === "task" ? "task-row" : "shelf-copy"}" data-id="${kind === "task" ? id : ""}" style="border:0;padding:0">
      <div>
        <span class="task-title" dir="auto">${esc(title)}</span>
        ${meta ? `<div class="task-meta">${esc(meta)}</div>` : ""}
      </div>
    </div>
    <div class="shelf-actions">${buttons}</div>
  </div>`;
}

function renderArchive() {
  const projects = db.listArchivedProjects();
  const tasks = db.listArchivedTasks();
  const notes = db.listArchivedNotes();
  const projectHtml = projects.map((p) => shelfItem("project", p.id, p.name, `${db.countProjectTasks(p.id)} tasks`, [
    { act: "unarchive", label: "Unarchive" },
    { act: "trash", label: "Move to Trash", danger: true },
  ])).join("");
  const taskHtml = tasks.map((t) => shelfItem("task", t.id, t.title, "Archived task", [
    { act: "unarchive", label: "Unarchive" },
    { act: "trash", label: "Move to Trash", danger: true },
  ])).join("");
  const noteHtml = notes.map((n) => shelfItem("note", n.id, notePreview(n.body), "Archived note", [
    { act: "unarchive", label: "Unarchive" },
    { act: "trash", label: "Move to Trash", danger: true },
  ])).join("");
  $("list-body").innerHTML = (projects.length || tasks.length || notes.length)
    ? `${projects.length ? `<h3 class="side-label">Projects</h3>${projectHtml}` : ""}${tasks.length ? `<h3 class="side-label">Tasks</h3>${taskHtml}` : ""}${notes.length ? `<h3 class="side-label">Notes</h3>${noteHtml}` : ""}`
    : `<p class="empty">Archive is empty. Archive a task, project, or note to park it here.</p>`;
}

function renderTrash() {
  const projects = db.listTrashedProjects();
  const tasks = db.listTrashedTasks();
  const notes = db.listTrashedNotes();
  const hasItems = projects.length || tasks.length || notes.length;
  const projectHtml = projects.map((p) => shelfItem("project", p.id, p.name, `${db.countProjectTasks(p.id, "trash")} tasks`, [
    { act: "restore", label: "Restore" },
    { act: "purge", label: "Delete forever", danger: true },
  ])).join("");
  const taskHtml = tasks.map((t) => shelfItem("task", t.id, t.title, "In Trash", [
    { act: "restore", label: "Restore" },
    { act: "purge", label: "Delete forever", danger: true },
  ])).join("");
  const noteHtml = notes.map((n) => shelfItem("note", n.id, notePreview(n.body), "In Trash", [
    { act: "restore", label: "Restore" },
    { act: "purge", label: "Delete forever", danger: true },
  ])).join("");
  $("list-body").innerHTML = `
    <div class="btn-row" style="margin-bottom:12px">
      <button class="danger-btn" id="empty-trash" type="button" ${hasItems ? "" : "disabled"}>Empty Trash</button>
    </div>
    ${hasItems
      ? `${projects.length ? `<h3 class="side-label">Projects</h3>${projectHtml}` : ""}${tasks.length ? `<h3 class="side-label">Tasks</h3>${taskHtml}` : ""}${notes.length ? `<h3 class="side-label">Notes</h3>${noteHtml}` : ""}`
      : `<p class="empty">Trash is empty.</p>`}
  `;
  $("empty-trash")?.addEventListener("click", () => {
    if (!hasItems) return;
    openModal(`
      <h2>Empty Trash?</h2>
      <p class="hint">This permanently deletes everything in Trash from the database. You cannot undo this.</p>
      <div class="btn-row">
        <button class="danger-btn" id="empty-yes" type="button">Delete forever</button>
        <button class="ghost-btn" id="empty-no" type="button">Cancel</button>
      </div>
    `);
    $("empty-yes").onclick = () => {
      db.emptyTrash();
      ui.selectedId = null;
      closeModal();
      toast("Trash emptied");
      render();
    };
    $("empty-no").onclick = closeModal;
  });
}

function renderBoard(tasks) {
  const sections = db.listSections(ui.projectId);
  const cols = [{ id: "", name: "No section" }, ...sections];
  $("list-body").innerHTML = `<div class="board">${cols.map((col) => {
    const items = tasks.filter((t) => (t.section_id || "") === (col.id || ""));
    return `<div class="board-col" data-section="${esc(col.id)}">
      <h3>${esc(col.name)}</h3>
      <ul class="task-list">${items.map((t) => taskRow(t)).join("") || `<p class="empty">Drop tasks here</p>`}</ul>
    </div>`;
  }).join("")}
  <div class="board-col">
    <button class="side-add" id="add-section" type="button">+ New section</button>
  </div>
  </div>`;
  $("add-section")?.addEventListener("click", () => {
    openModal(`
      <h2>New section</h2>
      <div class="field"><input id="section-name" placeholder="Section name" /></div>
      <div class="btn-row"><button class="primary" id="section-save" type="button">Create</button></div>
    `);
    $("section-name").focus();
    $("section-save").onclick = () => {
      const name = $("section-name").value.trim();
      if (name) db.addSection(ui.projectId, name);
      closeModal();
      render();
    };
  });
}

function renderDetail() {
  const pane = $("detail-pane");
  const task = ui.selectedId ? db.getTask(ui.selectedId) : null;
  document.querySelector(".workspace")?.classList.toggle("detail-open", Boolean(task));
  if (!task) {
    pane.innerHTML = `<p class="empty">Select a task to edit it.</p>`;
    return;
  }
  const projects = db.listProjects();
  const sections = task.project_id ? db.listSections(task.project_id) : [];
  const rem = task.reminders?.[0];
  pane.innerHTML = `
    <div class="detail-star-row">
      ${starBtn(task)}
      <span class="hint">${Number(task.starred) ? "Starred — pinned on Home" : "Star to pin on Home"}</span>
    </div>
    <div class="field"><label>Title</label><input id="d-title" dir="auto" value="${esc(task.title)}" /></div>
    <div class="field"><label>Notes</label><textarea id="d-notes" dir="auto">${esc(task.notes || "")}</textarea></div>
    <div class="field"><label>Link</label><input id="d-url" value="${esc(task.url || "")}" placeholder="https://" /></div>
    <div class="row-2">
      <div class="field"><label>Project</label>
        <select id="d-project">
          <option value="">Inbox</option>
          ${projects.map((p) => `<option value="${p.id}" ${p.id === task.project_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        </select>
      </div>
      <div class="field"><label>Section</label>
        <select id="d-section" ${task.project_id ? "" : "disabled"}>
          <option value="">None</option>
          ${sections.map((s) => `<option value="${s.id}" ${s.id === task.section_id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="row-2">
      <div class="field"><label>Priority</label>
        <select id="d-priority">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${Number(task.priority) === n ? "selected" : ""}>P${n}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Repeat</label>
        <select id="d-rec">
          <option value="">Does not repeat</option>
          ${["daily", "weekly", "monthly", "yearly", "weekdays"].map((v) => `<option value="${v}" ${task.recurrence === v ? "selected" : ""}>${esc(recurrenceLabel(v))}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="row-2">
      <div class="field"><label>Due date</label><input id="d-date" type="date" value="${task.due_at ? esc(fmtDateInput(task.due_at)) : ""}" /></div>
      <div class="field"><label>Time</label><input id="d-time" type="time" value="${task.due_at && task.due_has_time ? esc(fmtTimeInput(task.due_at)) : ""}" /></div>
    </div>
    <div class="field"><label>Reminder</label><input id="d-remind" type="datetime-local" value="${rem ? `${fmtDateInput(rem.remind_at)}T${fmtTimeInput(rem.remind_at)}` : ""}" /></div>
    <div class="field"><label>Tags</label><input id="d-tags" value="${esc((task.tags || []).map((t) => t.name).join(", "))}" placeholder="work, waiting" /></div>
    <div class="field"><label>Subtasks</label>
      <ul class="task-list" id="d-subs">${(task.subtasks || []).map((s) => taskRow(s)).join("")}</ul>
      <form id="d-sub-form" class="quick-row"><input id="d-sub-input" placeholder="Add subtask" dir="auto" /></form>
    </div>
    <p class="hint">Created ${esc(fmtDay(task.created_at))}</p>
    <div class="btn-row">
      ${task.deleted_at
        ? `<button class="primary" id="d-restore" type="button">Restore</button>
           <button class="danger-btn" id="d-purge" type="button">Delete forever</button>`
        : task.archived
          ? `<button class="ghost-btn" id="d-unarchive" type="button">Unarchive</button>
             <button class="action-icon-btn danger" id="d-delete" type="button" title="Move to Trash" aria-label="Move to Trash">
               <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M9 3a2 2 0 0 0-2 2v1H4a1 1 0 1 0 0 2h1l1 11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-11h1a1 1 0 1 0 0-2h-3V5a2 2 0 0 0-2-2H9Zm6 3V5H9v1h6Zm-6 4a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Zm6 1a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Z"/></svg>
             </button>`
          : `<button class="action-icon-btn" id="d-archive" type="button" title="Archive" aria-label="Archive">
               <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-9a2 2 0 0 1-2-2V5Zm2 0v3h14V5H5Zm4 7a1 1 0 0 0 0 2h6a1 1 0 1 0 0-2H9Z"/></svg>
             </button>
             <button class="action-icon-btn danger" id="d-delete" type="button" title="Move to Trash" aria-label="Move to Trash">
               <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M9 3a2 2 0 0 0-2 2v1H4a1 1 0 1 0 0 2h1l1 11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-11h1a1 1 0 1 0 0-2h-3V5a2 2 0 0 0-2-2H9Zm6 3V5H9v1h6Zm-6 4a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Zm6 1a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Z"/></svg>
             </button>`}
    </div>
  `;

  const save = () => {
    const date = $("d-date").value;
    const time = $("d-time").value;
    const due = parseDateTimeLocal(date, time);
    const remindRaw = $("d-remind").value;
    db.updateTask(task.id, {
      title: $("d-title").value.trim() || task.title,
      notes: $("d-notes").value,
      url: $("d-url").value.trim(),
      project_id: $("d-project").value || null,
      section_id: $("d-section").value || null,
      priority: Number($("d-priority").value),
      recurrence: $("d-rec").value || null,
      due_at: due,
      due_has_time: Boolean(time),
      tags: $("d-tags").value.split(",").map((s) => s.trim()).filter(Boolean),
      remind_at: remindRaw ? new Date(remindRaw).getTime() : null,
    });
    render();
  };

  ["d-title", "d-notes", "d-url", "d-tags"].forEach((id) => {
    $(id).addEventListener("change", save);
  });
  ["d-project", "d-section", "d-priority", "d-rec", "d-date", "d-time", "d-remind"].forEach((id) => {
    $(id).addEventListener("change", save);
  });
  $("d-sub-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("d-sub-input").value.trim();
    if (!title) return;
    db.addTask({ title, parent_id: task.id, project_id: task.project_id });
    $("d-sub-input").value = "";
    render();
  });
  $("d-delete")?.addEventListener("click", () => {
    db.trashTask(task.id);
    ui.selectedId = null;
    pushUndo("Moved to Trash", () => db.restoreFromTrash(task.id));
    toast("Moved to Trash", "Undo", undoLast);
    render();
  });
  $("d-archive")?.addEventListener("click", () => {
    db.archiveTask(task.id);
    ui.selectedId = null;
    toast("Archived");
    render();
  });
  $("d-unarchive")?.addEventListener("click", () => {
    db.unarchiveTask(task.id);
    toast("Unarchived");
    render();
  });
  $("d-restore")?.addEventListener("click", () => {
    db.restoreFromTrash(task.id);
    toast("Restored");
    render();
  });
  $("d-purge")?.addEventListener("click", () => {
    db.purgeTask(task.id);
    ui.selectedId = null;
    toast("Deleted forever");
    render();
  });
}

async function loadSoundList() {
  if (ui.soundList) return ui.soundList;
  try {
    const resp = await fetch(await getAssetUrl("sounds/index.json"));
    const files = await resp.json();
    ui.soundList = await Promise.all(files.map(async (f) => {
      const dur = await getAudioDuration(f);
      return { file: f, duration: dur };
    }));
  } catch {
    ui.soundList = [];
  }
  return ui.soundList;
}

function getAudioDuration(filename) {
  return new Promise((resolve) => {
    getAssetUrl(`sounds/${filename}`).then((url) => {
      const a = new Audio(url);
      a.addEventListener("loadedmetadata", () => resolve(a.duration));
      a.addEventListener("error", () => resolve(0));
    }).catch(() => resolve(0));
  });
}

function fmtDuration(secs) {
  if (!secs || secs <= 0) return "";
  const s = Math.round(secs);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function soundDisplayName(filename) {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
}

let previewAudio = null;

function stopPreview() {
  if (!previewAudio) return;
  previewAudio.pause();
  previewAudio.currentTime = 0;
  previewAudio = null;
  const btn = $("preview-sound");
  if (btn) btn.textContent = "▶";
}

async function renderSettings() {
  stopPreview();
  const name = db.getFolderName() || "Not connected";
  const sounds = await loadSoundList();
  const { notificationSound, mailNotifications } = await storageGet(["notificationSound", "mailNotifications"]);
  const currentSound = notificationSound || "none";
  const mailNotifyOn = mailNotifications !== false;
  const soundOptions = [
    `<option value="none" ${currentSound === "none" ? "selected" : ""}>None (silent)</option>`,
    ...sounds.map((s) => {
      const dur = fmtDuration(s.duration);
      const label = dur ? `${soundDisplayName(s.file)}  —  ${dur}` : soundDisplayName(s.file);
      return `<option value="${esc(s.file)}" ${currentSound === s.file ? "selected" : ""}>${esc(label)}</option>`;
    }),
  ].join("");
  $("settings-body").innerHTML = `
    <div class="settings-section">
      <h3 class="settings-label">General</h3>
      <div class="field">
        <label>Appearance</label>
        <select id="set-theme">
          <option value="system" ${ui.themePref === "system" ? "selected" : ""}>System</option>
          <option value="light" ${ui.themePref === "light" ? "selected" : ""}>Light</option>
          <option value="dark" ${ui.themePref === "dark" ? "selected" : ""}>Dark</option>
        </select>
      </div>
      <div class="field">
        <label>Notification sound</label>
        <div class="sound-row">
          <select id="set-sound">${soundOptions}</select>
          <button class="sound-preview" id="preview-sound" type="button" title="Play / Stop">▶</button>
        </div>
      </div>
      <label class="check-row">
        <input id="set-mail-notify" type="checkbox" ${mailNotifyOn ? "checked" : ""} />
        Email notifications
      </label>
      <p class="hint">Desktop toast + sound when new mail arrives. Badge count still updates either way.</p>
    </div>
    <div class="settings-section">
      <h3 class="settings-label">Data</h3>
      <div class="field">
        <label>Database folder</label>
        <p class="hint">${esc(name)}</p>
        <div class="btn-row">
          <button class="primary" id="set-folder" type="button">Choose folder</button>
          <button class="ghost-btn" id="set-export" type="button">Export backup</button>
          <label class="ghost-btn" style="display:inline-block">
            Import
            <input id="set-import" type="file" accept=".sqlite,.db" hidden />
          </label>
          ${db.getFolderName() ? `<button class="ghost-btn" id="set-disconnect" type="button">Disconnect</button>` : ""}
        </div>
      </div>
    </div>
    <div class="settings-section">
      <h3 class="settings-label">Help</h3>
      <p class="hint">Quick add understands: today, tomorrow, tonight, monday, 5pm, every day, every weekday, every week, every month, every year, every 3 days, p1, #Project, @tag. Click the <b>?</b> button next to the add field for shortcuts.</p>
      <p class="hint">Keys: <kbd>Q</kbd> quick add · <kbd>/</kbd> filter · <kbd>Esc</kbd> home · <kbd>Ctrl+Z</kbd> undo</p>
    </div>
    <p class="settings-footer">TodoBox by <a href="https://moeinmollaee.com" target="_blank" rel="noreferrer">Moein Mollaee</a></p>
  `;
  $("set-theme").onchange = (e) => applyTheme(e.target.value);
  $("set-sound").onchange = (e) => {
    stopPreview();
    storageSet({ notificationSound: e.target.value });
  };
  $("set-mail-notify").onchange = (e) => {
    storageSet({ mailNotifications: !!e.target.checked });
  };
  $("preview-sound").onclick = () => {
    if (previewAudio) {
      stopPreview();
      return;
    }
    const val = $("set-sound").value;
    if (val === "none") return;
    getAssetUrl(`sounds/${val}`).then((url) => {
      previewAudio = new Audio(url);
      $("preview-sound").textContent = "■";
      previewAudio.play().catch(() => {});
      previewAudio.addEventListener("ended", () => {
        previewAudio = null;
        const btn = $("preview-sound");
        if (btn) btn.textContent = "▶";
      });
    });
  };
  $("set-folder").onclick = connectFolderFlow;
  $("set-export").onclick = exportBackup;
  $("set-disconnect")?.addEventListener("click", async () => {
    await db.disconnectFolder();
    ui.folderWritable = false;
    toast("Folder disconnected. Data stays in the browser until you connect a folder.");
    render();
  });
  $("set-import").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await db.importSqliteFile(file);
    toast("Database imported");
    render();
  };
}

function render() {
  if (!db.isReady()) return;
  if (ui.page === "home") renderHome();
  else if (ui.page === "tasks") renderWorkspace();
  if (!$("settings").classList.contains("hidden")) renderSettings();
}

function openShortcutModal(existing) {
  openModal(`
    <h2>${existing ? "Edit shortcut" : "Add shortcut"}</h2>
    <div class="field"><label>URL</label><input id="sc-url" value="${esc(existing?.url || "")}" placeholder="https://github.com" /></div>
    <div class="field"><label>Name</label><input id="sc-title" value="${esc(existing?.title || "")}" placeholder="Optional" /></div>
    <div class="btn-row">
      <button class="primary" id="sc-save" type="button">Save</button>
      ${existing ? `<button class="danger-btn" id="sc-del" type="button">Remove</button>` : ""}
    </div>
  `);
  $("sc-url").focus();
  $("sc-save").onclick = () => {
    let url = $("sc-url").value.trim();
    if (!url) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
    const title = $("sc-title").value.trim() || hostnameOf(url);
    if (existing) db.updateShortcut(existing.id, title, url);
    else db.addShortcut(title, url);
    closeModal();
    render();
  };
  $("sc-del")?.addEventListener("click", () => {
    db.deleteShortcut(existing.id);
    closeModal();
    render();
  });
}

function removeTag(id) {
  const tag = db.getTag(id);
  if (!tag) return;
  db.deleteTag(id);
  if (ui.tagId === id) {
    ui.view = "inbox";
    ui.tagId = null;
  }
  toast(`Deleted @${tag.name}`);
  render();
}

function completeFromUi(id) {
  const snap = db.snapshotTask(id);
  const result = db.completeTask(id);
  if (ui.selectedId === id && !result.recurring) ui.selectedId = null;
  pushUndo("Task completed", () => {
    if (result.recurring) db.updateTask(id, { due_at: snap.due_at });
    else db.uncompleteTask(id);
  });
  toast(result.recurring ? "Next occurrence scheduled" : "Completed", "Undo", undoLast);
  render();
}

function bind() {
  $("go-home").onclick = () => setPage("home");
  $("go-tasks").onclick = () => setPage("tasks");
  $("go-mail").onclick = () => setPage("mail");
  $("home-open-tasks").onclick = () => setPage("tasks");
  $("toggle-theme").onclick = cycleTheme;
  $("open-settings").onclick = () => { $("settings").classList.remove("hidden"); renderSettings(); };
  $("close-settings").onclick = () => { stopPreview(); $("settings").classList.add("hidden"); };
  $("settings").addEventListener("click", (e) => {
    if (e.target === $("settings")) { stopPreview(); $("settings").classList.add("hidden"); }
  });
  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal")) closeModal();
  });

  $("web-search").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("web-q").value.trim();
    if (!q) return;
    location.href = looksLikeUrl(q)
      ? toNavigableUrl(q)
      : `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  });

  $("home-quick").addEventListener("submit", (e) => {
    e.preventDefault();
    submitQuickAdd($("home-quick-input").value, { dueToday: true });
    $("home-quick-input").value = "";
  });
  $("quick-add").addEventListener("submit", (e) => {
    e.preventDefault();
    submitQuickAdd($("quick-input").value);
    $("quick-input").value = "";
  });

  document.querySelectorAll(".note-add-form").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const ta = form.querySelector(".note-add");
      if (!db.addNote(ta.value)) return;
      document.querySelectorAll(".note-add").forEach((el) => {
        el.value = "";
        fitNoteTextarea(el);
      });
      toast("Note added");
      renderNotes();
    });
    form.querySelector(".note-add")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  });
  document.addEventListener("input", (e) => {
    const ta = e.target.closest?.(".note-add, .note-card textarea");
    if (!ta) return;
    fitNoteTextarea(ta);
    if (!ta.closest(".note-card")) return;
    const id = ta.closest("[data-note-id]")?.dataset.noteId;
    if (!id) return;
    document.querySelectorAll(`.note-card[data-note-id="${CSS.escape(id)}"] textarea`).forEach((other) => {
      if (other === ta) return;
      other.value = ta.value;
      fitNoteTextarea(other);
    });
  });
  document.addEventListener("change", (e) => {
    const ta = e.target.closest?.(".note-card textarea");
    if (!ta) return;
    const id = ta.closest("[data-note-id]")?.dataset.noteId;
    if (!id) return;
    db.updateNote(id, ta.value);
    document.querySelectorAll(`.note-card[data-note-id="${CSS.escape(id)}"] textarea`).forEach((other) => {
      if (other === ta) return;
      other.value = ta.value;
      fitNoteTextarea(other);
    });
  });
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-note-act]");
    if (!btn) return;
    const id = btn.closest("[data-note-id]")?.dataset.noteId;
    if (!id) return;
    const act = btn.dataset.noteAct;
    if (act === "archive") {
      db.archiveNote(id);
      toast("Note archived", "Undo", () => { db.unarchiveNote(id); render(); });
    }
    if (act === "trash") {
      db.trashNote(id);
      toast("Note moved to Trash", "Undo", () => { db.restoreNote(id); render(); });
    }
    render();
  });

  document.addEventListener("click", (e) => {
    const opener = e.target.closest("[data-open-hints]");
    if (opener) {
      openHintModal(opener.dataset.openHints);
      return;
    }
    const chip = e.target.closest(".hint-chip[data-insert]");
    if (!chip) return;
    const wrap = chip.closest("[data-hint-for]");
    const input = wrap ? $(wrap.dataset.hintFor) : null;
    if (!input) return;
    insertHintPhrase(input, chip.dataset.insert);
  });

  $("smart-nav").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (!btn) return;
    ui.view = btn.dataset.view;
    ui.projectId = null;
    ui.tagId = null;
    ui.selectedId = null;
    ui.board = false;
    render();
  });
  $("project-nav").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-project]");
    if (!btn) return;
    ui.view = "project";
    ui.projectId = btn.dataset.project;
    ui.selectedId = null;
    render();
  });
  $("project-nav").addEventListener("contextmenu", (e) => {
    const btn = e.target.closest("[data-project]");
    if (!btn) return;
    e.preventDefault();
    const project = db.getProject(btn.dataset.project);
    if (!project) return;
    openModal(`
      <h2>Project</h2>
      <div class="field"><input id="pr-name" dir="auto" value="${esc(project.name)}" /></div>
      <div class="btn-row">
        <button class="primary" id="pr-save" type="button">Save</button>
        <button class="action-icon-btn" id="pr-archive" type="button" title="Archive" aria-label="Archive">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-9a2 2 0 0 1-2-2V5Zm2 0v3h14V5H5Zm4 7a1 1 0 0 0 0 2h6a1 1 0 1 0 0-2H9Z"/></svg>
        </button>
        <button class="action-icon-btn danger" id="pr-del" type="button" title="Move to Trash" aria-label="Move to Trash">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M9 3a2 2 0 0 0-2 2v1H4a1 1 0 1 0 0 2h1l1 11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-11h1a1 1 0 1 0 0-2h-3V5a2 2 0 0 0-2-2H9Zm6 3V5H9v1h6Zm-6 4a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Zm6 1a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Z"/></svg>
        </button>
      </div>
    `);
    $("pr-save").onclick = () => {
      const name = $("pr-name").value.trim();
      if (name) db.renameProject(project.id, name);
      closeModal();
      render();
    };
    $("pr-archive").onclick = () => {
      db.archiveProject(project.id);
      if (ui.projectId === project.id) {
        ui.view = "archive";
        ui.projectId = null;
      }
      closeModal();
      toast("Project archived");
      render();
    };
    $("pr-del").onclick = () => {
      db.trashProject(project.id);
      if (ui.projectId === project.id) {
        ui.view = "trash";
        ui.projectId = null;
      }
      closeModal();
      toast("Project moved to Trash", "Undo", () => {
        db.restoreProject(project.id);
        render();
      });
      render();
    };
  });
  $("tag-nav").addEventListener("click", (e) => {
    const del = e.target.closest("[data-act=delete-tag]");
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      removeTag(del.dataset.tag);
      return;
    }
    const btn = e.target.closest("[data-tag]");
    if (!btn || btn.dataset.act === "delete-tag") return;
    ui.view = "tag";
    ui.tagId = btn.dataset.tag;
    ui.projectId = null;
    ui.selectedId = null;
    render();
  });
  $("tag-nav").addEventListener("contextmenu", (e) => {
    const btn = e.target.closest("[data-tag]");
    if (!btn || btn.dataset.act === "delete-tag") return;
    e.preventDefault();
    const tag = db.getTag(btn.dataset.tag);
    if (!tag) return;
    openModal(`
      <h2>Tag</h2>
      <div class="field"><input id="tg-name" dir="auto" value="${esc(tag.name)}" /></div>
      <div class="btn-row">
        <button class="primary" id="tg-save" type="button">Save</button>
        <button class="danger-btn" id="tg-del" type="button">Delete tag</button>
      </div>
    `);
    $("tg-save").onclick = () => {
      const name = $("tg-name").value.trim();
      if (name) db.renameTag(tag.id, name);
      closeModal();
      render();
    };
    $("tg-del").onclick = () => {
      closeModal();
      removeTag(tag.id);
    };
  });
  $("add-project").onclick = () => {
    openModal(`
      <h2>New project</h2>
      <div class="field"><input id="p-name" placeholder="Project name" dir="auto" /></div>
      <div class="btn-row"><button class="primary" id="p-save" type="button">Create</button></div>
    `);
    $("p-name").focus();
    $("p-save").onclick = () => {
      const name = $("p-name").value.trim();
      if (!name) return;
      const color = PROJECT_COLORS[db.listProjects().length % PROJECT_COLORS.length];
      ui.view = "project";
      ui.projectId = db.addProject(name, color);
      closeModal();
      setPage("tasks");
    };
  };

  $("task-filter").addEventListener("input", (e) => { ui.query = e.target.value; renderWorkspace(); });
  $("priority-filter").addEventListener("change", (e) => { ui.priority = e.target.value; render(); });
  $("board-toggle").onclick = () => { ui.board = !ui.board; render(); };

  const onTaskClick = (e) => {
    const shelfBtn = e.target.closest("[data-shelf-act]");
    if (shelfBtn) {
      e.preventDefault();
      e.stopPropagation();
      const act = shelfBtn.dataset.shelfAct;
      const kind = shelfBtn.dataset.shelfKind;
      const id = shelfBtn.dataset.shelfId;
      if (kind === "project") {
        if (act === "restore") { db.restoreProject(id); toast("Project restored"); }
        if (act === "unarchive") { db.unarchiveProject(id); toast("Project unarchived"); }
        if (act === "trash") { db.trashProject(id); toast("Moved to Trash"); }
        if (act === "purge") { db.purgeProject(id); toast("Deleted forever"); }
        if (ui.projectId === id) ui.projectId = null;
      } else if (kind === "note") {
        if (act === "restore") { db.restoreNote(id); toast("Note restored"); }
        if (act === "unarchive") { db.unarchiveNote(id); toast("Note unarchived"); }
        if (act === "trash") { db.trashNote(id); toast("Moved to Trash"); }
        if (act === "purge") { db.purgeNote(id); toast("Deleted forever"); }
      } else {
        if (act === "restore") { db.restoreFromTrash(id); toast("Restored"); }
        if (act === "unarchive") { db.unarchiveTask(id); toast("Unarchived"); }
        if (act === "trash") { db.trashTask(id); toast("Moved to Trash"); }
        if (act === "purge") { db.purgeTask(id); toast("Deleted forever"); }
        if (ui.selectedId === id) ui.selectedId = null;
      }
      render();
      return;
    }
    const removeDial = e.target.closest(".dial-x");
    if (removeDial) {
      e.preventDefault();
      e.stopPropagation();
      const dial = removeDial.closest(".dial");
      if (dial?.dataset.kind === "shortcut") db.deleteShortcut(dial.dataset.id);
      if (dial?.dataset.kind === "top") {
        ui.hiddenTopSites.push(dial.dataset.id);
        db.setSetting("hiddenTopSites", ui.hiddenTopSites);
      }
      render();
      return;
    }
    const dial = e.target.closest(".dial[data-url]");
    if (dial && !e.target.closest("#add-shortcut")) {
      location.href = dial.dataset.url;
      return;
    }
    const complete = e.target.closest("[data-act=complete]");
    if (complete) {
      e.preventDefault();
      e.stopPropagation();
      completeFromUi(complete.closest("[data-id]").dataset.id);
      return;
    }
    const star = e.target.closest("[data-act=star]");
    if (star) {
      e.preventDefault();
      e.stopPropagation();
      const id = star.closest("[data-id]")?.dataset.id || ui.selectedId;
      if (!id) return;
      const task = db.getTask(id);
      if (!task) return;
      db.updateTask(id, { starred: Number(task.starred) ? 0 : 1 });
      render();
      return;
    }
    const openLink = e.target.closest("[data-act=open-link]");
    if (openLink) {
      e.preventDefault();
      e.stopPropagation();
      const targetUrl = toNavigableUrl(openLink.dataset.url || "");
      if (targetUrl) window.open(targetUrl, "_blank", "noopener,noreferrer");
      return;
    }
    const row = e.target.closest(".task-row");
    if (row) {
      ui.selectedId = row.dataset.id;
      if (ui.page !== "tasks") setPage("tasks");
      else render();
    }
  };
  $("home-today-list").addEventListener("click", onTaskClick);
  $("list-body").addEventListener("click", onTaskClick);
  $("detail-pane").addEventListener("click", onTaskClick);
  $("shortcut-grid").addEventListener("click", onTaskClick);
  $("topsite-grid").addEventListener("click", onTaskClick);
  $("shortcut-grid").addEventListener("contextmenu", (e) => {
    const dial = e.target.closest(".dial[data-kind=shortcut]");
    if (!dial) return;
    e.preventDefault();
    const item = db.listShortcuts().find((s) => s.id === dial.dataset.id);
    if (item) openShortcutModal(item);
  });

  let dragId = null;
  $("list-body").addEventListener("dragstart", (e) => {
    const row = e.target.closest(".task-row");
    if (!row) return;
    dragId = row.dataset.id;
    e.dataTransfer.effectAllowed = "move";
  });
  $("list-body").addEventListener("dragover", (e) => {
    if (!dragId) return;
    e.preventDefault();
  });
  $("list-body").addEventListener("drop", (e) => {
    e.preventDefault();
    if (!dragId) return;
    const col = e.target.closest("[data-section]");
    const row = e.target.closest(".task-row");
    if (col && ui.view === "project") {
      db.moveTask(dragId, { projectId: ui.projectId, sectionId: col.dataset.section || null });
    } else if (row && row.dataset.id !== dragId) {
      const ids = [...$("list-body").querySelectorAll(".task-row")].map((el) => el.dataset.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(row.dataset.id);
      if (from >= 0 && to >= 0) {
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        db.reorderOpenTasks(ids);
      }
    }
    dragId = null;
    render();
  });

  document.addEventListener("keydown", (e) => {
    const typing = /input|textarea|select/i.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undoLast();
      return;
    }
    if (e.key === "Escape") {
      closeModal();
      $("settings").classList.add("hidden");
      if (ui.selectedId) { ui.selectedId = null; render(); return; }
      if (ui.page === "tasks" || ui.page === "mail") setPage("home");
      return;
    }
    if (typing) return;
    if (e.key === "q" || e.key === "Q") {
      e.preventDefault();
      if (ui.page === "home") $("home-quick-input").focus();
      else $("quick-input").focus();
    }
    if (e.key === "/") {
      e.preventDefault();
      setPage("tasks");
      $("task-filter").focus();
    }
    if (ui.selectedId && ["1", "2", "3", "4"].includes(e.key)) {
      db.updateTask(ui.selectedId, { priority: Number(e.key) });
      render();
    }
    if (ui.selectedId && e.key.toLowerCase() === "d") completeFromUi(ui.selectedId);
  });

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) {
      db.flush();
      return;
    }
    const result = await db.pullFolder();
    if (result?.applied) render();
  });
  window.addEventListener("pagehide", () => { db.flush(); });
  setInterval(async () => {
    if (document.hidden) return;
    const result = await db.pullFolder();
    if (result?.applied) render();
  }, 15000);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (ui.themePref === "system") applyTheme("system");
  });
  window.addEventListener("todobox:open-tasks", () => setPage("tasks"));
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "open-tasks") setPage("tasks");
    });
  }
}

async function boot() {
  await initWebApp();
  initMailUi({
    toast,
    openModal,
    closeModal,
    findTaskByMailId: (messageId) => db.findTaskByMailMessageId(messageId),
    addTask: (fields) => {
      const id = db.addTask(fields);
      pushUndo("Task added", () => db.deleteTask(id));
      return id;
    },
    openTasks: (taskId) => {
      if (taskId) {
        const task = db.getTask(taskId);
        ui.selectedId = taskId;
        // Mail meetings often have a future due date — Today would hide them.
        ui.view = viewForTaskVisibility(task);
        ui.projectId = task?.project_id || null;
        ui.tagId = null;
      }
      setPage("tasks");
      render();
    },
  });
  bind();
  const params = new URLSearchParams(location.search);
  if (params.get("view") === "tasks") ui.page = "tasks";
  if (params.get("view") === "mail") ui.page = "mail";
  topSites = await getTopSites();
  const { theme } = await storageGet("theme");
  applyTheme(theme || "system");
  await db.init();
  ui.folderWritable = await db.folderWritable();
  ui.themePref = db.getSetting("theme", theme || "system");
  applyTheme(ui.themePref);
  ui.hiddenTopSites = db.getSetting("hiddenTopSites", []) || [];
  setPage(ui.page);
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<p style="padding:24px;font-family:sans-serif">TodoBox failed to start. ${esc(err.message || err)}</p>`;
});

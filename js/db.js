import { debounce, likeEscape, uid } from "./util.js";
import { nextOccurrence } from "./nlp.js";
import { getAssetUrlSync, syncReminders } from "./platform/index.js";

const DB_FILE = "todobox.sqlite";
const IDB_NAME = "todobox";
const IDB_STORE = "kv";
const SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#0f6e62',
  archived INTEGER DEFAULT 0,
  deleted_at INTEGER,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  project_id TEXT,
  section_id TEXT,
  title TEXT NOT NULL,
  notes TEXT DEFAULT '',
  url TEXT DEFAULT '',
  priority INTEGER DEFAULT 4,
  due_at INTEGER,
  due_has_time INTEGER DEFAULT 0,
  recurrence TEXT,
  completed_at INTEGER,
  archived INTEGER DEFAULT 0,
  deleted_at INTEGER,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#6f6d66',
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (task_id, tag_id)
);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  remind_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shortcuts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS tombstones (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  deleted_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  archived INTEGER DEFAULT 0,
  deleted_at INTEGER,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks(completed_at);
`;

let SQL = null;
let db = null;
let dirHandle = null;
let sqlReady = false;
let schemaTouched = false;
let lastFileHash = "";
let persistBusy = false;
let persistQueued = false;
let persistQueuedWrite = false;

const listeners = new Set();

function emit() {
  listeners.forEach((fn) => {
    try { fn(); } catch { /* ignore */ }
  });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const idb = await openIdb();
  try {
    return await new Promise((resolve, reject) => {
      const req = idb.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    idb.close();
  }
}

async function idbSet(key, value) {
  const idb = await openIdb();
  try {
    await new Promise((resolve, reject) => {
      const req = idb.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } finally {
    idb.close();
  }
}

function tableColumns(table, target = db) {
  return all(`PRAGMA table_info(${table})`, [], target).map((row) => row.name);
}

function ensureColumn(table, name, spec, target = db) {
  if (!tableColumns(table, target).includes(name)) {
    target.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${spec}`);
    if (target === db) schemaTouched = true;
  }
}

const LIVE_TASK = "deleted_at IS NULL";
const ACTIVE_TASK = "deleted_at IS NULL AND archived = 0";
const LIVE_PROJECT = `(project_id IS NULL OR project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL AND archived = 0))`;

function backfillUpdatedAt(target = db) {
  target.run("UPDATE projects SET updated_at = COALESCE(updated_at, created_at, 0) WHERE updated_at IS NULL");
  target.run("UPDATE sections SET updated_at = 0 WHERE updated_at IS NULL");
  target.run("UPDATE tags SET updated_at = 0 WHERE updated_at IS NULL");
  target.run("UPDATE shortcuts SET updated_at = 0 WHERE updated_at IS NULL");
  target.run("UPDATE settings SET updated_at = 0 WHERE updated_at IS NULL");
}

function ensureSchema(target = db, { migrate = true } = {}) {
  target.exec(SCHEMA);
  ensureColumn("projects", "deleted_at", "INTEGER", target);
  ensureColumn("tasks", "deleted_at", "INTEGER", target);
  ensureColumn("projects", "updated_at", "INTEGER", target);
  ensureColumn("sections", "updated_at", "INTEGER", target);
  ensureColumn("tags", "updated_at", "INTEGER", target);
  ensureColumn("shortcuts", "updated_at", "INTEGER", target);
  ensureColumn("settings", "updated_at", "INTEGER", target);
  backfillUpdatedAt(target);
  if (!migrate) return;
  const row = target.exec("PRAGMA user_version");
  const version = row?.[0]?.values?.[0]?.[0] ?? 0;
  if (version < 4) {
    // Remove reminders that were auto-created from due date alone (legacy behavior).
    const autos = all(`
      SELECT r.id AS rid, r.remind_at, t.due_at, t.due_has_time
      FROM reminders r
      JOIN tasks t ON t.id = r.task_id
      WHERE t.due_at IS NOT NULL
    `, [], target);
    for (const item of autos) {
      if (item.due_has_time) {
        if (item.remind_at === item.due_at) {
          run("DELETE FROM reminders WHERE id = ?", [item.rid], target);
          if (target === db) schemaTouched = true;
        }
      } else {
        const nine = new Date(item.due_at);
        nine.setHours(9, 0, 0, 0);
        if (item.remind_at === nine.getTime()) {
          run("DELETE FROM reminders WHERE id = ?", [item.rid], target);
          if (target === db) schemaTouched = true;
        }
      }
    }
  }
  if (version < SCHEMA_VERSION) target.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  if (target !== db) return;
  const missingDue = all(
    `SELECT id, recurrence FROM tasks
     WHERE completed_at IS NULL AND due_at IS NULL AND deleted_at IS NULL
       AND recurrence IS NOT NULL AND TRIM(recurrence) != ''`
  );
  if (missingDue.length) {
    for (const item of missingDue) {
      run("UPDATE tasks SET due_at = ? WHERE id = ?", [ensureDueForRecurrence(null, item.recurrence), item.id]);
    }
    schemaTouched = true;
  }
}

function createDb(bytes) {
  db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
  ensureSchema();
  sqlReady = true;
}

export function isReady() {
  return sqlReady;
}

export function getFolderName() {
  return dirHandle?.name || null;
}

export function hasFolder() {
  return Boolean(dirHandle);
}

export async function folderWritable() {
  if (!dirHandle) return false;
  const opts = { mode: "readwrite" };
  return (await dirHandle.queryPermission(opts)) === "granted";
}

export async function requestFolderPermission() {
  if (!dirHandle) return false;
  const opts = { mode: "readwrite" };
  if (await dirHandle.queryPermission(opts) === "granted") return true;
  return (await dirHandle.requestPermission(opts)) === "granted";
}

function all(sql, params = [], target = db) {
  const stmt = target.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function one(sql, params = [], target = db) {
  return all(sql, params, target)[0] || null;
}

function run(sql, params = [], target = db) {
  target.run(sql, params);
}

export function exportBytes() {
  return db.export();
}

async function writeFolderFile(bytes) {
  if (!dirHandle || !(await folderWritable())) return false;
  const handle = await dirHandle.getFileHandle(DB_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  return true;
}

async function readFolderFile() {
  if (!dirHandle || !(await folderWritable())) return null;
  try {
    const handle = await dirHandle.getFileHandle(DB_FILE);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

async function hashBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function rowTime(row) {
  return Number(row?.updated_at || 0);
}

function upsertRow(table, row, pk = "id") {
  const names = tableColumns(table).filter((name) => Object.prototype.hasOwnProperty.call(row, name));
  if (!names.includes(pk)) return;
  const rest = names.filter((n) => n !== pk);
  const placeholders = names.map(() => "?").join(", ");
  const setClause = rest.length
    ? rest.map((n) => `${n} = excluded.${n}`).join(", ")
    : `${pk} = excluded.${pk}`;
  run(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${placeholders}) ON CONFLICT(${pk}) DO UPDATE SET ${setClause}`,
    names.map((n) => (row[n] === undefined ? null : row[n]))
  );
}

function addTombstone(id, kind) {
  const ts = Date.now();
  run(
    `INSERT INTO tombstones(id, kind, deleted_at) VALUES(?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at, kind = excluded.kind`,
    [id, kind, ts]
  );
}

function mergeTombstones(incoming) {
  let applied = false;
  for (const row of all("SELECT * FROM tombstones", [], incoming)) {
    const local = one("SELECT * FROM tombstones WHERE id = ?", [row.id]);
    if (!local || Number(row.deleted_at) > Number(local.deleted_at)) {
      upsertRow("tombstones", row);
      applied = true;
    }
  }
  return applied;
}

function mergeTags(incoming) {
  const tagIdMap = new Map();
  let applied = false;
  for (const row of all("SELECT * FROM tags", [], incoming)) {
    const localId = one("SELECT * FROM tags WHERE id = ?", [row.id]);
    const localName = one("SELECT * FROM tags WHERE name = ? COLLATE NOCASE", [row.name]);
    const incomingTs = rowTime(row);
    if (localId) {
      tagIdMap.set(row.id, row.id);
      if (incomingTs > rowTime(localId)) {
        upsertRow("tags", row);
        applied = true;
      }
    } else if (localName) {
      tagIdMap.set(row.id, localName.id);
      if (incomingTs > rowTime(localName)) {
        upsertRow("tags", { ...row, id: localName.id });
        applied = true;
      }
    } else {
      upsertRow("tags", row);
      tagIdMap.set(row.id, row.id);
      applied = true;
    }
  }
  return { tagIdMap, applied };
}

function mergeLwwTable(incoming, table, pk = "id") {
  const won = new Set();
  let applied = false;
  for (const row of all(`SELECT * FROM ${table}`, [], incoming)) {
    const local = one(`SELECT * FROM ${table} WHERE ${pk} = ?`, [row[pk]]);
    const incomingTs = rowTime(row);
    if (!local) {
      upsertRow(table, row, pk);
      won.add(row[pk]);
      applied = true;
    } else if (incomingTs > rowTime(local)) {
      upsertRow(table, row, pk);
      won.add(row[pk]);
      applied = true;
    }
  }
  return { won, applied };
}

function replaceTaskChildren(incoming, taskId, tagIdMap) {
  run("DELETE FROM task_tags WHERE task_id = ?", [taskId]);
  run("DELETE FROM reminders WHERE task_id = ?", [taskId]);
  for (const link of all("SELECT * FROM task_tags WHERE task_id = ?", [taskId], incoming)) {
    const tagId = tagIdMap.get(link.tag_id) || link.tag_id;
    if (!one("SELECT id FROM tags WHERE id = ?", [tagId])) continue;
    run("INSERT OR IGNORE INTO task_tags(task_id, tag_id) VALUES(?, ?)", [taskId, tagId]);
  }
  for (const rem of all("SELECT * FROM reminders WHERE task_id = ?", [taskId], incoming)) {
    run(
      "INSERT OR REPLACE INTO reminders(id, task_id, remind_at) VALUES(?, ?, ?)",
      [rem.id, rem.task_id, rem.remind_at]
    );
  }
}

function applyTombstones() {
  let applied = false;
  for (const stone of all("SELECT * FROM tombstones")) {
    const ts = Number(stone.deleted_at) || 0;
    if (stone.kind === "task") {
      const row = one("SELECT updated_at FROM tasks WHERE id = ?", [stone.id]);
      if (row && rowTime(row) > ts) {
        run("DELETE FROM tombstones WHERE id = ?", [stone.id]);
        continue;
      }
      if (row) {
        run("DELETE FROM task_tags WHERE task_id = ?", [stone.id]);
        run("DELETE FROM reminders WHERE task_id = ?", [stone.id]);
        run("DELETE FROM tasks WHERE id = ?", [stone.id]);
        applied = true;
      }
    } else if (stone.kind === "note") {
      const row = one("SELECT updated_at FROM notes WHERE id = ?", [stone.id]);
      if (row && rowTime(row) > ts) {
        run("DELETE FROM tombstones WHERE id = ?", [stone.id]);
        continue;
      }
      if (row) {
        run("DELETE FROM notes WHERE id = ?", [stone.id]);
        applied = true;
      }
    } else if (stone.kind === "project") {
      const row = one("SELECT updated_at FROM projects WHERE id = ?", [stone.id]);
      if (row && rowTime(row) > ts) {
        run("DELETE FROM tombstones WHERE id = ?", [stone.id]);
        continue;
      }
      if (row) {
        run("DELETE FROM projects WHERE id = ?", [stone.id]);
        applied = true;
      }
    } else if (stone.kind === "section") {
      const row = one("SELECT updated_at FROM sections WHERE id = ?", [stone.id]);
      if (row && rowTime(row) > ts) {
        run("DELETE FROM tombstones WHERE id = ?", [stone.id]);
        continue;
      }
      if (row) {
        run("UPDATE tasks SET section_id = NULL WHERE section_id = ?", [stone.id]);
        run("DELETE FROM sections WHERE id = ?", [stone.id]);
        applied = true;
      }
    } else if (stone.kind === "tag") {
      const row = one("SELECT updated_at FROM tags WHERE id = ?", [stone.id]);
      if (row && rowTime(row) > ts) {
        run("DELETE FROM tombstones WHERE id = ?", [stone.id]);
        continue;
      }
      if (row) {
        run("DELETE FROM task_tags WHERE tag_id = ?", [stone.id]);
        run("DELETE FROM tags WHERE id = ?", [stone.id]);
        applied = true;
      }
    } else if (stone.kind === "shortcut") {
      const row = one("SELECT updated_at FROM shortcuts WHERE id = ?", [stone.id]);
      if (row && rowTime(row) > ts) {
        run("DELETE FROM tombstones WHERE id = ?", [stone.id]);
        continue;
      }
      if (row) {
        run("DELETE FROM shortcuts WHERE id = ?", [stone.id]);
        applied = true;
      }
    }
  }
  return applied;
}

function mergeFromBytes(bytes) {
  if (!bytes || bytes.length < 100 || !SQL) return false;
  let incoming;
  try {
    incoming = new SQL.Database(new Uint8Array(bytes));
    ensureSchema(incoming, { migrate: false });
    let applied = mergeTombstones(incoming);
    const tags = mergeTags(incoming);
    applied = tags.applied || applied;
    for (const table of ["projects", "sections", "notes", "shortcuts", "tasks"]) {
      const result = mergeLwwTable(incoming, table);
      applied = result.applied || applied;
      if (table === "tasks") {
        for (const taskId of result.won) replaceTaskChildren(incoming, taskId, tags.tagIdMap);
      }
    }
    const settings = mergeLwwTable(incoming, "settings", "key");
    applied = settings.applied || applied;
    applied = applyTombstones() || applied;
    return applied;
  } catch (err) {
    console.warn("TodoBox folder merge skipped", err);
    return false;
  } finally {
    try { incoming?.close(); } catch { /* ignore */ }
  }
}

async function persist({ writeAlways = true } = {}) {
  if (!sqlReady) return { applied: false };
  if (persistBusy) {
    persistQueued = true;
    persistQueuedWrite = persistQueuedWrite || writeAlways;
    return { applied: false };
  }
  persistBusy = true;
  let applied = false;
  try {
    const disk = await readFolderFile();
    if (disk && disk.length > 100) {
      const hash = await hashBytes(disk);
      if (hash !== lastFileHash) {
        applied = mergeFromBytes(disk);
        if (!applied) lastFileHash = hash;
      }
    }
    if (writeAlways || applied) {
      const bytes = db.export();
      await idbSet("sqliteBytes", bytes);
      await writeFolderFile(bytes);
      lastFileHash = await hashBytes(bytes);
      await writeSnapshotHtml();
      await syncReminderAlarms();
    }
  } catch (err) {
    console.warn("TodoBox save failed", err);
  } finally {
    persistBusy = false;
  }
  if (persistQueued) {
    persistQueued = false;
    const write = persistQueuedWrite;
    persistQueuedWrite = false;
    const again = await persist({ writeAlways: write });
    return { applied: applied || again.applied };
  }
  return { applied };
}

export async function pullFolder() {
  if (!sqlReady || !dirHandle) return { applied: false };
  const result = await persist({ writeAlways: false });
  if (result.applied) emit();
  return result;
}

async function writeSnapshotHtml() {
  if (!dirHandle || !(await folderWritable())) return;
  try {
    const data = snapshotData();
    const html = buildSnapshotHtml(data);
    const handle = await dirHandle.getFileHandle("todobox.html", { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Blob([html], { type: "text/html" }));
    await writable.close();
  } catch { /* non-critical */ }
}

function snapshotData() {
  const projects = all("SELECT * FROM projects WHERE archived = 0 AND deleted_at IS NULL ORDER BY sort_order, name");
  const tasks = all(`
    SELECT t.*, p.name AS project_name FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL AND t.archived = 0 AND t.completed_at IS NULL AND t.parent_id IS NULL
      AND (t.project_id IS NULL OR t.project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL AND archived = 0))
    ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at, t.priority, t.sort_order
    LIMIT 500
  `);
  const completed = all(`
    SELECT t.*, p.name AS project_name FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL AND t.archived = 0 AND t.completed_at IS NOT NULL AND t.parent_id IS NULL
      AND (t.project_id IS NULL OR t.project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL AND archived = 0))
    ORDER BY t.completed_at DESC LIMIT 50
  `);
  const notes = all("SELECT * FROM notes WHERE archived = 0 AND deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC");
  return { projects, tasks, completed, notes, exported: Date.now() };
}

function buildSnapshotHtml(data) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (ts) => { if (!ts) return ""; const d = new Date(ts); return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); };
  const fmtTime = (ts) => { if (!ts) return ""; return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); };
  const fmtFull = (ts) => { if (!ts) return ""; return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  const pri = (p) => ["", "P1", "P2", "P3", "P4"][p] || "";

  const byProject = new Map();
  const inbox = [];
  for (const t of data.tasks) {
    if (t.project_id) {
      if (!byProject.has(t.project_id)) byProject.set(t.project_id, { name: t.project_name || "Project", tasks: [] });
      byProject.get(t.project_id).tasks.push(t);
    } else {
      inbox.push(t);
    }
  }

  const taskRow = (t) => {
    const due = t.due_at ? `<span class="due">${esc(fmtDate(t.due_at))}${t.due_has_time ? " " + esc(fmtTime(t.due_at)) : ""}</span>` : "";
    const p = t.priority && t.priority < 4 ? `<span class="pri p${t.priority}">${pri(t.priority)}</span>` : "";
    const proj = t.project_name && !t.project_id ? "" : (t.project_name ? `<span class="proj">${esc(t.project_name)}</span>` : "");
    return `<li class="task">${p}<span class="title" dir="auto">${esc(t.title)}</span>${due}${proj}</li>`;
  };

  const taskRowCompleted = (t) => {
    const done = t.completed_at ? `<span class="due">${esc(fmtFull(t.completed_at))}</span>` : "";
    return `<li class="task done"><span class="title" dir="auto">${esc(t.title)}</span>${done}</li>`;
  };

  let sections = "";
  if (inbox.length) {
    sections += `<section><h2>Inbox</h2><ul>${inbox.map(taskRow).join("")}</ul></section>`;
  }
  for (const [, group] of byProject) {
    sections += `<section><h2>${esc(group.name)}</h2><ul>${group.tasks.map(taskRow).join("")}</ul></section>`;
  }
  if (data.completed.length) {
    sections += `<section><h2>Completed</h2><ul>${data.completed.map(taskRowCompleted).join("")}</ul></section>`;
  }
  if (data.notes.length) {
    sections += `<section><h2>Notes</h2><div class="notes">${data.notes.map((n) => `<div class="note" dir="auto">${esc(n.body).replace(/\n/g, "<br>")}</div>`).join("")}</div></section>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TodoBox</title>
<style>
:root{--bg:#f3f0e8;--paper:#fffcf6;--ink:#1c1b17;--muted:#6f6d66;--line:rgba(28,27,23,.08);--accent:#0f6e62;--p1:#c4472c;--p2:#d4891a;--p3:#3b7bb8;--radius:14px;--shadow:0 8px 30px rgba(28,27,23,.06)}
@media(prefers-color-scheme:dark){:root{--bg:#111210;--paper:#1a1b18;--ink:#f2efe6;--muted:#a4a198;--line:rgba(242,239,230,.09);--accent:#73cbb9;--p1:#e06a55;--p2:#e0a24a;--p3:#6ea4d6;--shadow:0 10px 30px rgba(0,0,0,.35)}}
*{box-sizing:border-box;margin:0}
body{font-family:"Segoe UI","Tahoma","Noto Naskh Arabic",system-ui,sans-serif;background:var(--bg);color:var(--ink);padding:20px 16px 60px}
.wrap{max-width:700px;margin:0 auto}
header{text-align:center;margin-bottom:24px}
header h1{font-size:22px;letter-spacing:-.02em;margin-bottom:4px}
header p{font-size:13px;color:var(--muted)}
section{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;margin-bottom:16px;box-shadow:var(--shadow)}
section h2{font-size:13px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
ul{list-style:none;padding:0}
.task{display:flex;align-items:baseline;gap:8px;padding:7px 0;border-top:1px solid var(--line);flex-wrap:wrap}
.task:first-child{border-top:0}
.title{flex:1;min-width:0;word-break:break-word}
.done .title{text-decoration:line-through;opacity:.55}
.due{font-size:12px;color:var(--muted);white-space:nowrap}
.pri{font-size:11px;font-weight:700;border-radius:999px;padding:1px 7px}
.p1{color:var(--p1)}.p2{color:var(--p2)}.p3{color:var(--p3)}
.proj{font-size:11px;background:rgba(15,110,98,.12);color:var(--accent);border-radius:999px;padding:1px 8px}
.notes{display:grid;gap:10px}
.note{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;unicode-bidi:plaintext}
.empty{text-align:center;color:var(--muted);padding:20px 0;font-size:14px}
footer{text-align:center;color:var(--muted);font-size:12px;margin-top:24px}
footer a{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
<header>
<h1>TodoBox</h1>
<p>Exported ${esc(fmtFull(data.exported))} &middot; Read-only snapshot</p>
</header>
${sections || `<p class="empty">No tasks or notes yet.</p>`}
<footer>TodoBox by <a href="https://moeinmollaee.com">Moein Mollaee</a></footer>
</div>
</body>
</html>`;
}

const schedulePersist = debounce(() => {
  persist().catch((err) => console.warn("TodoBox save failed", err));
}, 500);

function changed() {
  schedulePersist();
  emit();
}

export async function flush() {
  schedulePersist.cancel();
  await persist();
}

async function syncReminderAlarms() {
  const items = all(`
    SELECT r.id, r.task_id, r.remind_at, t.title
    FROM reminders r
    JOIN tasks t ON t.id = r.task_id
    WHERE t.completed_at IS NULL AND t.deleted_at IS NULL AND t.archived = 0 AND r.remind_at > ?
    ORDER BY r.remind_at ASC
    LIMIT 60
  `, [Date.now() - 60 * 1000]);
  try {
    await syncReminders(items);
  } catch {
    /* popup/newtab may run without a listening worker yet */
  }
}

export async function init() {
  SQL = await window.initSqlJs({
    locateFile: (file) => getAssetUrlSync(`vendor/${file}`),
  });

  dirHandle = (await idbGet("dirHandle")) || null;
  let bytes = null;

  if (dirHandle) {
    try {
      if (await folderWritable()) {
        bytes = await readFolderFile();
      }
    } catch {
      dirHandle = null;
    }
  }
  if (!bytes) bytes = await idbGet("sqliteBytes");
  createDb(bytes);
  const exported = db.export();
  await idbSet("sqliteBytes", exported);
  if (schemaTouched) await writeFolderFile(exported);
  lastFileHash = await hashBytes(exported);
  await syncReminderAlarms();
  return { folder: getFolderName(), writable: await folderWritable() };
}

export async function pickFolder() {
  const handle = await window.showDirectoryPicker({
    id: "todobox-data",
    mode: "readwrite",
    startIn: "documents",
  });
  await handle.requestPermission({ mode: "readwrite" });
  let existing = null;
  try {
    const fileHandle = await handle.getFileHandle(DB_FILE);
    const file = await fileHandle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > 100) existing = bytes;
  } catch {
    existing = null;
  }
  return { handle, existing, name: handle.name };
}

export async function connectFolder(handle, existing, mode = "load") {
  dirHandle = handle;
  await idbSet("dirHandle", handle);
  if (existing && mode === "load") {
    createDb(existing);
    await idbSet("sqliteBytes", existing);
    lastFileHash = "";
    emit();
  } else if (existing && mode === "merge") {
    mergeFromBytes(existing);
    lastFileHash = "";
    emit();
  }
  await persist();
  return { name: handle.name, loadedExisting: Boolean(existing && mode !== "overwrite") };
}

export async function disconnectFolder() {
  dirHandle = null;
  await idbSet("dirHandle", null);
  emit();
}

export async function importSqliteFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  createDb(bytes);
  await persist();
  emit();
}

export function getSetting(key, fallback = null) {
  const row = one("SELECT value FROM settings WHERE key = ?", [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setSetting(key, value) {
  run(
    `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), Date.now()]
  );
  changed();
}

export function listProjects() {
  return all("SELECT * FROM projects WHERE archived = 0 AND deleted_at IS NULL ORDER BY sort_order, name");
}

export function listArchivedProjects() {
  return all("SELECT * FROM projects WHERE archived = 1 AND deleted_at IS NULL ORDER BY name");
}

export function listTrashedProjects() {
  return all("SELECT * FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC");
}

export function getProject(id) {
  return one("SELECT * FROM projects WHERE id = ?", [id]);
}

export function addProject(name, color = "#0f6e62") {
  const id = uid();
  const now = Date.now();
  const max = one("SELECT COALESCE(MAX(sort_order), 0) AS m FROM projects")?.m || 0;
  run(
    "INSERT INTO projects(id, name, color, sort_order, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
    [id, name.trim(), color, max + 10, now, now]
  );
  changed();
  return id;
}

export function renameProject(id, name) {
  run("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?", [name.trim(), Date.now(), id]);
  changed();
}

export function archiveProject(id) {
  run("UPDATE projects SET archived = 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [Date.now(), id]);
  changed();
}

export function unarchiveProject(id) {
  run("UPDATE projects SET archived = 0, updated_at = ? WHERE id = ?", [Date.now(), id]);
  changed();
}

export function trashProject(id) {
  const ts = Date.now();
  run("UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [ts, ts, id]);
  run("UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE project_id = ? AND deleted_at IS NULL", [ts, ts, id]);
  changed();
}

export function restoreProject(id) {
  const ts = Date.now();
  run("UPDATE projects SET deleted_at = NULL, archived = 0, updated_at = ? WHERE id = ?", [ts, id]);
  run("UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE project_id = ?", [ts, id]);
  changed();
}

export function purgeProject(id) {
  const tasks = all("SELECT id FROM tasks WHERE project_id = ?", [id]);
  for (const task of tasks) purgeTask(task.id);
  const sections = all("SELECT id FROM sections WHERE project_id = ?", [id]);
  for (const section of sections) {
    addTombstone(section.id, "section");
  }
  run("DELETE FROM sections WHERE project_id = ?", [id]);
  addTombstone(id, "project");
  run("DELETE FROM projects WHERE id = ?", [id]);
  changed();
}

export function listSections(projectId) {
  return all("SELECT * FROM sections WHERE project_id = ? ORDER BY sort_order, name", [projectId]);
}

export function addSection(projectId, name) {
  const id = uid();
  const now = Date.now();
  const max = one("SELECT COALESCE(MAX(sort_order), 0) AS m FROM sections WHERE project_id = ?", [projectId])?.m || 0;
  run(
    "INSERT INTO sections(id, project_id, name, sort_order, updated_at) VALUES(?, ?, ?, ?, ?)",
    [id, projectId, name.trim(), max + 10, now]
  );
  changed();
  return id;
}

export function renameSection(id, name) {
  run("UPDATE sections SET name = ?, updated_at = ? WHERE id = ?", [name.trim(), Date.now(), id]);
  changed();
}

export function deleteSection(id) {
  run("UPDATE tasks SET section_id = NULL, updated_at = ? WHERE section_id = ?", [Date.now(), id]);
  addTombstone(id, "section");
  run("DELETE FROM sections WHERE id = ?", [id]);
  changed();
}

export function listTags() {
  return all(`
    SELECT g.*, COUNT(t.id) AS use_count
    FROM tags g
    LEFT JOIN task_tags tt ON tt.tag_id = g.id
    LEFT JOIN tasks t ON t.id = tt.task_id AND t.deleted_at IS NULL
    GROUP BY g.id
    ORDER BY g.name
  `);
}

export function getTag(id) {
  return one("SELECT * FROM tags WHERE id = ?", [id]);
}

export function renameTag(id, name) {
  const clean = String(name || "").trim().replace(/^@/, "");
  if (!clean) return;
  run("UPDATE tags SET name = ?, updated_at = ? WHERE id = ?", [clean, Date.now(), id]);
  changed();
}

export function deleteTag(id) {
  addTombstone(id, "tag");
  run("DELETE FROM task_tags WHERE tag_id = ?", [id]);
  run("DELETE FROM tags WHERE id = ?", [id]);
  changed();
}

function pruneUnusedTags() {
  run("DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM task_tags)");
}

export function getOrCreateTag(name) {
  const clean = name.trim().replace(/^@/, "");
  if (!clean) return null;
  const existing = one("SELECT * FROM tags WHERE name = ? COLLATE NOCASE", [clean]);
  if (existing) return existing;
  const tag = { id: uid(), name: clean, color: "#6f6d66", updated_at: Date.now() };
  run("INSERT INTO tags(id, name, color, updated_at) VALUES(?, ?, ?, ?)", [tag.id, tag.name, tag.color, tag.updated_at]);
  changed();
  return tag;
}

function attachTags(taskId, names) {
  for (const name of names || []) {
    const tag = getOrCreateTag(name);
    if (!tag) continue;
    run("INSERT OR IGNORE INTO task_tags(task_id, tag_id) VALUES(?, ?)", [taskId, tag.id]);
  }
}

export function setTaskTags(taskId, names) {
  run("DELETE FROM task_tags WHERE task_id = ?", [taskId]);
  attachTags(taskId, names);
  pruneUnusedTags();
  run("UPDATE tasks SET updated_at = ? WHERE id = ?", [Date.now(), taskId]);
  changed();
}

export function tagsForTask(taskId) {
  return all(`
    SELECT g.* FROM tags g
    JOIN task_tags tt ON tt.tag_id = g.id
    WHERE tt.task_id = ?
    ORDER BY g.name
  `, [taskId]);
}

function findProjectByName(name) {
  if (!name) return null;
  return one("SELECT * FROM projects WHERE archived = 0 AND deleted_at IS NULL AND name = ? COLLATE NOCASE", [name]);
}

function ensureDueForRecurrence(dueAt, recurrence) {
  if (dueAt || !recurrence) return dueAt || null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (recurrence === "weekdays") {
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

function todayMatchSql() {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const weekday = new Date().getDay() >= 1 && new Date().getDay() <= 5;
  const sql = `(
    (due_at IS NOT NULL AND due_at <= ?)
    OR (due_at IS NULL AND recurrence IN ('daily', 'every:1:days'))
    ${weekday ? "OR (due_at IS NULL AND recurrence = 'weekdays')" : ""}
  )`;
  return { sql, end: end.getTime() };
}

export function addTask(fields) {
  const now = Date.now();
  const id = fields.id || uid();
  let projectId = fields.project_id || null;
  if (!projectId && fields.projectName) {
    const project = findProjectByName(fields.projectName);
    projectId = project?.id || addProject(fields.projectName);
  }
  const max = one(
    "SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks WHERE IFNULL(project_id,'') = IFNULL(?, '') AND IFNULL(parent_id,'') = IFNULL(?, '') AND completed_at IS NULL",
    [projectId, fields.parent_id || null]
  )?.m || 0;

  const recurrence = fields.recurrence || null;
  const dueAt = ensureDueForRecurrence(fields.due_at || null, recurrence);
  const dueHasTime = fields.due_has_time ? 1 : 0;

  run(
    `INSERT INTO tasks(
      id, parent_id, project_id, section_id, title, notes, url, priority,
      due_at, due_has_time, recurrence, completed_at, archived, sort_order, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`,
    [
      id,
      fields.parent_id || null,
      projectId,
      fields.section_id || null,
      fields.title.trim(),
      fields.notes || "",
      fields.url || "",
      fields.priority || 4,
      dueAt,
      dueHasTime,
      recurrence,
      max + 10,
      now,
      now,
    ]
  );
  attachTags(id, fields.tags);
  // Reminder only when explicitly set — due date / "today" must NOT create alarms.
  if (fields.remind_at) {
    run("INSERT INTO reminders(id, task_id, remind_at) VALUES(?, ?, ?)", [uid(), id, fields.remind_at]);
  }
  changed();
  return id;
}

export function getTask(id) {
  const task = one("SELECT * FROM tasks WHERE id = ?", [id]);
  if (!task) return null;
  task.tags = tagsForTask(id);
  task.reminders = all("SELECT * FROM reminders WHERE task_id = ? ORDER BY remind_at", [id]);
  task.subtasks = all("SELECT * FROM tasks WHERE parent_id = ? AND archived = 0 AND deleted_at IS NULL ORDER BY sort_order, created_at", [id]);
  return task;
}

export function updateTask(id, patch) {
  if (Object.prototype.hasOwnProperty.call(patch, "recurrence") || Object.prototype.hasOwnProperty.call(patch, "due_at")) {
    const cur = one("SELECT due_at, recurrence FROM tasks WHERE id = ?", [id]);
    const rec = Object.prototype.hasOwnProperty.call(patch, "recurrence") ? patch.recurrence : cur?.recurrence;
    const due = Object.prototype.hasOwnProperty.call(patch, "due_at") ? patch.due_at : cur?.due_at;
    patch.due_at = ensureDueForRecurrence(due, rec);
  }
  const allowed = [
    "title", "notes", "url", "priority", "due_at", "due_has_time",
    "recurrence", "project_id", "section_id", "parent_id", "sort_order",
  ];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${key} = ?`);
      params.push(patch[key]);
    }
  }
  if (!sets.length && !patch.tags && !Object.prototype.hasOwnProperty.call(patch, "remind_at")) return;
  if (sets.length) {
    sets.push("updated_at = ?");
    params.push(Date.now(), id);
    run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, params);
  }
  if (patch.tags) {
    run("DELETE FROM task_tags WHERE task_id = ?", [id]);
    attachTags(id, patch.tags);
    pruneUnusedTags();
    if (!sets.length) run("UPDATE tasks SET updated_at = ? WHERE id = ?", [Date.now(), id]);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "remind_at")) {
    run("DELETE FROM reminders WHERE task_id = ?", [id]);
    if (patch.remind_at) {
      run("INSERT INTO reminders(id, task_id, remind_at) VALUES(?, ?, ?)", [uid(), id, patch.remind_at]);
    }
    if (!sets.length && !patch.tags) run("UPDATE tasks SET updated_at = ? WHERE id = ?", [Date.now(), id]);
  }
  changed();
}

export function snapshotTask(id) {
  const task = getTask(id);
  if (!task) return null;
  return JSON.parse(JSON.stringify(task));
}

export function restoreSnapshot(snap) {
  if (!snap) return;
  run("DELETE FROM task_tags WHERE task_id = ?", [snap.id]);
  run("DELETE FROM reminders WHERE task_id = ?", [snap.id]);
  const existing = one("SELECT id FROM tasks WHERE id = ?", [snap.id]);
  if (existing) {
    run("DELETE FROM tasks WHERE id = ?", [snap.id]);
  }
  run(
    `INSERT INTO tasks(
      id, parent_id, project_id, section_id, title, notes, url, priority,
      due_at, due_has_time, recurrence, completed_at, archived, sort_order, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snap.id, snap.parent_id, snap.project_id, snap.section_id, snap.title, snap.notes || "",
      snap.url || "", snap.priority, snap.due_at, snap.due_has_time, snap.recurrence,
      snap.completed_at, snap.archived || 0, snap.sort_order, snap.created_at, Date.now(),
    ]
  );
  for (const tag of snap.tags || []) {
    run("INSERT OR IGNORE INTO tags(id, name, color) VALUES(?, ?, ?)", [tag.id, tag.name, tag.color]);
    run("INSERT OR IGNORE INTO task_tags(task_id, tag_id) VALUES(?, ?)", [snap.id, tag.id]);
  }
  for (const rem of snap.reminders || []) {
    run("INSERT INTO reminders(id, task_id, remind_at) VALUES(?, ?, ?)", [rem.id, snap.id, rem.remind_at]);
  }
  changed();
}

export function completeTask(id) {
  const task = one("SELECT * FROM tasks WHERE id = ?", [id]);
  if (!task || task.completed_at) return { recurring: false };
  if (task.recurrence && task.due_at) {
    const next = nextOccurrence(task.due_at, task.recurrence);
    const rem = one("SELECT remind_at FROM reminders WHERE task_id = ? ORDER BY remind_at LIMIT 1", [id]);
    run("UPDATE tasks SET due_at = ?, completed_at = NULL, updated_at = ? WHERE id = ?", [next, Date.now(), id]);
    run("DELETE FROM reminders WHERE task_id = ?", [id]);
    // Only carry an explicit reminder forward; never invent one from due date alone.
    if (rem && next != null) {
      const offset = rem.remind_at - task.due_at;
      run("INSERT INTO reminders(id, task_id, remind_at) VALUES(?, ?, ?)", [uid(), id, next + offset]);
    }
    changed();
    return { recurring: true, next };
  }
  run("UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?", [Date.now(), Date.now(), id]);
  changed();
  return { recurring: false };
}

export function uncompleteTask(id) {
  run("UPDATE tasks SET completed_at = NULL, updated_at = ? WHERE id = ?", [Date.now(), id]);
  changed();
}

export function archiveTask(id) {
  run("UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [Date.now(), id]);
  changed();
}

export function unarchiveTask(id) {
  run("UPDATE tasks SET archived = 0, updated_at = ? WHERE id = ?", [Date.now(), id]);
  changed();
}

export function trashTask(id) {
  const ts = Date.now();
  const stack = [id];
  while (stack.length) {
    const current = stack.pop();
    const kids = all("SELECT id FROM tasks WHERE parent_id = ? AND deleted_at IS NULL", [current]);
    for (const kid of kids) stack.push(kid.id);
    run("UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [ts, ts, current]);
  }
  changed();
}

export function restoreFromTrash(id) {
  const stack = [id];
  while (stack.length) {
    const current = stack.pop();
    const kids = all("SELECT id FROM tasks WHERE parent_id = ?", [current]);
    for (const kid of kids) stack.push(kid.id);
    run("UPDATE tasks SET deleted_at = NULL, archived = 0, updated_at = ? WHERE id = ?", [Date.now(), current]);
  }
  changed();
}

export function purgeTask(id) {
  const kids = all("SELECT id FROM tasks WHERE parent_id = ?", [id]);
  for (const kid of kids) purgeTask(kid.id);
  addTombstone(id, "task");
  run("DELETE FROM task_tags WHERE task_id = ?", [id]);
  run("DELETE FROM reminders WHERE task_id = ?", [id]);
  run("DELETE FROM tasks WHERE id = ?", [id]);
  pruneUnusedTags();
  changed();
}

export function deleteTask(id) {
  trashTask(id);
}

export function emptyTrash() {
  const projects = all("SELECT id FROM projects WHERE deleted_at IS NOT NULL");
  for (const project of projects) purgeProject(project.id);
  const tasks = all("SELECT id FROM tasks WHERE deleted_at IS NOT NULL");
  for (const task of tasks) purgeTask(task.id);
  const notes = all("SELECT id FROM notes WHERE deleted_at IS NOT NULL");
  for (const note of notes) purgeNote(note.id);
  changed();
}

export function listArchivedTasks() {
  return hydrate(all(`
    SELECT * FROM tasks
    WHERE deleted_at IS NULL AND archived = 1 AND parent_id IS NULL
    ORDER BY updated_at DESC
    LIMIT 300
  `));
}

export function listTrashedTasks() {
  return hydrate(all(`
    SELECT * FROM tasks
    WHERE deleted_at IS NOT NULL AND parent_id IS NULL
      AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL))
    ORDER BY deleted_at DESC
    LIMIT 300
  `));
}

export function countArchive() {
  const projects = one("SELECT COUNT(*) AS n FROM projects WHERE archived = 1 AND deleted_at IS NULL")?.n || 0;
  const tasks = one("SELECT COUNT(*) AS n FROM tasks WHERE archived = 1 AND deleted_at IS NULL AND parent_id IS NULL")?.n || 0;
  const notes = one("SELECT COUNT(*) AS n FROM notes WHERE archived = 1 AND deleted_at IS NULL")?.n || 0;
  return projects + tasks + notes;
}

export function countTrash() {
  const projects = one("SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NOT NULL")?.n || 0;
  const tasks = one(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE deleted_at IS NOT NULL AND parent_id IS NULL
      AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL))
  `)?.n || 0;
  const notes = one("SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NOT NULL")?.n || 0;
  return projects + tasks + notes;
}

export function countProjectTasks(projectId, mode = "live") {
  if (mode === "trash") {
    return one("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND parent_id IS NULL AND deleted_at IS NOT NULL", [projectId])?.n || 0;
  }
  return one(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND parent_id IS NULL AND ${LIVE_TASK}`, [projectId])?.n || 0;
}

export function listNotes() {
  return all("SELECT * FROM notes WHERE archived = 0 AND deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC");
}

export function listArchivedNotes() {
  return all("SELECT * FROM notes WHERE archived = 1 AND deleted_at IS NULL ORDER BY updated_at DESC");
}

export function listTrashedNotes() {
  return all("SELECT * FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC");
}

export function addNote(body) {
  const text = String(body || "").trim();
  if (!text) return null;
  const id = uid();
  const now = Date.now();
  run(
    "INSERT INTO notes(id, body, archived, deleted_at, sort_order, created_at, updated_at) VALUES(?, ?, 0, NULL, 0, ?, ?)",
    [id, text, now, now]
  );
  changed();
  return id;
}

export function updateNote(id, body) {
  run("UPDATE notes SET body = ?, updated_at = ? WHERE id = ?", [String(body || ""), Date.now(), id]);
  changed();
}

export function archiveNote(id) {
  run("UPDATE notes SET archived = 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [Date.now(), id]);
  changed();
}

export function unarchiveNote(id) {
  run("UPDATE notes SET archived = 0, updated_at = ? WHERE id = ?", [Date.now(), id]);
  changed();
}

export function trashNote(id) {
  const ts = Date.now();
  run("UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [ts, ts, id]);
  changed();
}

export function restoreNote(id) {
  run("UPDATE notes SET deleted_at = NULL, archived = 0, updated_at = ? WHERE id = ?", [Date.now(), id]);
  changed();
}

export function purgeNote(id) {
  addTombstone(id, "note");
  run("DELETE FROM notes WHERE id = ?", [id]);
  changed();
}

export function reorderOpenTasks(ids) {
  ids.forEach((id, index) => {
    run("UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?", [(index + 1) * 10, Date.now(), id]);
  });
  changed();
}

export function moveTask(id, { projectId = undefined, sectionId = undefined }) {
  const sets = ["updated_at = ?"];
  const params = [Date.now()];
  if (projectId !== undefined) {
    sets.push("project_id = ?");
    params.push(projectId);
    if (projectId === null) sets.push("section_id = NULL");
  }
  if (sectionId !== undefined) {
    sets.push("section_id = ?");
    params.push(sectionId);
  }
  params.push(id);
  run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, params);
  changed();
}

function hydrate(rows) {
  return rows.map((row) => ({
    ...row,
    tags: tagsForTask(row.id),
  }));
}

export function countToday() {
  const { sql, end } = todayMatchSql();
  const row = one(
    `SELECT COUNT(*) AS n FROM tasks
     WHERE ${ACTIVE_TASK} AND parent_id IS NULL AND ${LIVE_PROJECT}
       AND completed_at IS NULL AND ${sql}`,
    [end]
  );
  return row?.n || 0;
}

export function queryTasks(view, opts = {}) {
  const now = Date.now();
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const endToday = new Date();
  endToday.setHours(23, 59, 59, 999);
  const endUpcoming = new Date(startToday);
  endUpcoming.setDate(endUpcoming.getDate() + 14);
  endUpcoming.setHours(23, 59, 59, 999);

  const where = [ACTIVE_TASK, "parent_id IS NULL", LIVE_PROJECT];
  const params = [];

  if (view === "completed") {
    where.length = 0;
    where.push(ACTIVE_TASK, "parent_id IS NULL", LIVE_PROJECT, "completed_at IS NOT NULL");
  } else {
    where.push("completed_at IS NULL");
  }

  if (view === "inbox") {
    where.push("project_id IS NULL");
  } else if (view === "today") {
    const today = todayMatchSql();
    where.push(today.sql);
    params.push(today.end);
  } else if (view === "upcoming") {
    where.push("due_at IS NOT NULL AND due_at > ? AND due_at <= ?");
    params.push(endToday.getTime(), endUpcoming.getTime());
  } else if (view === "project") {
    where.push("project_id = ?");
    params.push(opts.projectId);
  } else if (view === "tag") {
    where.push("id IN (SELECT task_id FROM task_tags WHERE tag_id = ?)");
    params.push(opts.tagId);
  }

  if (opts.query) {
    where.push("(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
    const like = `%${likeEscape(opts.query)}%`;
    params.push(like, like);
  }

  if (opts.priority) {
    where.push("priority = ?");
    params.push(Number(opts.priority));
  }

  const order = view === "completed"
    ? "completed_at DESC"
    : "CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, priority, sort_order, created_at";

  const rows = all(
    `SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT 500`,
    params
  );
  void now;
  void startToday;
  return hydrate(rows);
}

export function searchAll(query) {
  if (!query.trim()) return [];
  const like = `%${likeEscape(query.trim())}%`;
  return hydrate(all(
    `SELECT * FROM tasks
     WHERE ${ACTIVE_TASK} AND completed_at IS NULL AND ${LIVE_PROJECT}
       AND (title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')
     ORDER BY priority, due_at, created_at LIMIT 80`,
    [like, like]
  ));
}

export function listShortcuts() {
  return all("SELECT * FROM shortcuts ORDER BY sort_order, title");
}

export function addShortcut(title, url) {
  const id = uid();
  const now = Date.now();
  const max = one("SELECT COALESCE(MAX(sort_order), 0) AS m FROM shortcuts")?.m || 0;
  run(
    "INSERT INTO shortcuts(id, title, url, sort_order, updated_at) VALUES(?, ?, ?, ?, ?)",
    [id, title.trim(), url.trim(), max + 10, now]
  );
  changed();
  return id;
}

export function updateShortcut(id, title, url) {
  run("UPDATE shortcuts SET title = ?, url = ?, updated_at = ? WHERE id = ?", [title.trim(), url.trim(), Date.now(), id]);
  changed();
}

export function deleteShortcut(id) {
  addTombstone(id, "shortcut");
  run("DELETE FROM shortcuts WHERE id = ?", [id]);
  changed();
}

export function reorderShortcuts(ids) {
  const ts = Date.now();
  ids.forEach((id, index) => {
    run("UPDATE shortcuts SET sort_order = ?, updated_at = ? WHERE id = ?", [(index + 1) * 10, ts, id]);
  });
  changed();
}

export function stats() {
  return {
    open: one(`SELECT COUNT(*) AS n FROM tasks WHERE completed_at IS NULL AND ${ACTIVE_TASK} AND parent_id IS NULL AND ${LIVE_PROJECT}`)?.n || 0,
    today: countToday(),
    done: one(`SELECT COUNT(*) AS n FROM tasks WHERE completed_at IS NOT NULL AND ${ACTIVE_TASK} AND parent_id IS NULL AND ${LIVE_PROJECT}`)?.n || 0,
    archive: countArchive(),
    trash: countTrash(),
  };
}

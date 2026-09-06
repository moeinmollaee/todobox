import * as db from "./db.js";
import { parseQuickAdd } from "./nlp.js";
import { esc, fmtShortDay, fmtTime } from "./util.js";

const $ = (id) => document.getElementById(id);

function row(task) {
  const due = task.due_has_time ? `${fmtShortDay(task.due_at)} ${fmtTime(task.due_at)}` : fmtShortDay(task.due_at);
  return `<li class="task-row" data-id="${task.id}">
    <button class="check p${task.priority}" data-act="complete" type="button"></button>
    <div>
      <span class="task-title" dir="auto">${esc(task.title)}</span>
      <div class="task-meta">${esc(due)}</div>
    </div>
  </li>`;
}

function paint() {
  const tasks = db.queryTasks("today");
  $("popup-list").innerHTML = tasks.map(row).join("");
  $("popup-empty").hidden = tasks.length > 0;
}

async function boot() {
  await db.init();
  await db.pullFolder();
  paint();
  $("popup-add").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("popup-q").value.trim();
    if (!text) return;
    const parsed = parseQuickAdd(text);
    let dueAt = parsed.dueAt;
    if (!dueAt) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      dueAt = d.getTime();
    }
    db.addTask({
      title: parsed.title,
      priority: parsed.priority,
      due_at: dueAt,
      due_has_time: parsed.dueHasTime,
      recurrence: parsed.recurrence,
      projectName: parsed.projectName,
      tags: parsed.tags,
    });
    $("popup-q").value = "";
    paint();
  });
  $("popup-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act=complete]");
    if (!btn) return;
    db.completeTask(btn.closest("[data-id]").dataset.id);
    paint();
  });
  $("open-full").onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("newtab.html") + "?view=tasks" });
  };
  $("popup-q").focus();
}

boot();

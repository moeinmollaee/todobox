const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function nextWeekday(from, weekday) {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const delta = (weekday + 7 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + delta);
  return d;
}

function applyTime(date, hours, minutes, meridiem) {
  let h = hours;
  if (meridiem) {
    const mer = meridiem.toLowerCase();
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
  }
  date.setHours(h, minutes, 0, 0);
  return date;
}

function take(text, regex) {
  const match = text.match(regex);
  if (!match) return { text, match: null };
  const cleaned = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`;
  return { text: cleaned.replace(/\s{2,}/g, " ").trim(), match };
}

export function parseQuickAdd(input, now = new Date()) {
  let text = String(input || "").trim();
  const result = {
    title: "",
    priority: 4,
    dueAt: null,
    dueHasTime: false,
    recurrence: null,
    projectName: null,
    tags: [],
  };

  const tags = [];
  text = text.replace(/(^|\s)@([\p{L}\p{N}_-]+)/gu, (_, sp, name) => {
    tags.push(name);
    return sp;
  });
  result.tags = tags;

  const project = text.match(/(^|\s)#([\p{L}\p{N}_-]+)/u);
  if (project) {
    result.projectName = project[2];
    text = `${text.slice(0, project.index)} ${text.slice(project.index + project[0].length)}`;
  }

  let taken = take(text, /\b(?:p|priority\s*)([1-4])\b/i);
  if (taken.match) result.priority = Number(taken.match[1]);
  text = taken.text;

  taken = take(text, /\bevery\s+(\d+)\s+days?\b/i);
  if (taken.match) {
    result.recurrence = `every:${taken.match[1]}:days`;
    text = taken.text;
  } else {
    taken = take(text, /\bevery\s+weekday[s]?\b/i);
    if (taken.match) {
      result.recurrence = "weekdays";
      text = taken.text;
    } else {
      taken = take(text, /\bevery\s+day\b|\bdaily\b/i);
      if (taken.match) {
        result.recurrence = "daily";
        text = taken.text;
      } else {
        taken = take(text, /\bevery\s+week\b|\bweekly\b/i);
        if (taken.match) {
          result.recurrence = "weekly";
          text = taken.text;
        } else {
          taken = take(text, /\bevery\s+month\b|\bmonthly\b/i);
          if (taken.match) {
            result.recurrence = "monthly";
            text = taken.text;
          } else {
            taken = take(text, /\bevery\s+year\b|\byearly\b/i);
            if (taken.match) {
              result.recurrence = "yearly";
              text = taken.text;
            }
          }
        }
      }
    }
  }

  let due = null;
  let hasTime = false;

  taken = take(text, /\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  let timeMatch = taken.match;
  if (!timeMatch) {
    taken = take(text, /\b(\d{1,2})(?::(\d{2}))\s*(am|pm)\b/i);
    timeMatch = taken.match;
  }
  if (!timeMatch) {
    taken = take(text, /\b(\d{1,2})\s*(am|pm)\b/i);
    if (taken.match) {
      timeMatch = [taken.match[0], taken.match[1], "0", taken.match[2]];
    }
  }
  text = taken.text;

  taken = take(text, /\btomorrow\b/i);
  if (taken.match) {
    due = new Date(now);
    due.setDate(due.getDate() + 1);
    due.setHours(0, 0, 0, 0);
    text = taken.text;
  } else {
    taken = take(text, /\btonight\b/i);
    if (taken.match) {
      due = new Date(now);
      due.setHours(20, 0, 0, 0);
      hasTime = true;
      text = taken.text;
    } else {
      taken = take(text, /\btoday\b/i);
      if (taken.match) {
        due = new Date(now);
        due.setHours(0, 0, 0, 0);
        text = taken.text;
      } else {
        taken = take(text, /\bnext\s+week\b/i);
        if (taken.match) {
          due = new Date(now);
          due.setDate(due.getDate() + 7);
          due.setHours(0, 0, 0, 0);
          text = taken.text;
        } else {
          const dayRe = new RegExp(`\\b(?:next\\s+)?(${WEEKDAYS.join("|")}|${WEEKDAY_SHORT.join("|")})\\b`, "i");
          taken = take(text, dayRe);
          if (taken.match) {
            const token = taken.match[1].toLowerCase();
            const idx = WEEKDAYS.indexOf(token) !== -1
              ? WEEKDAYS.indexOf(token)
              : WEEKDAY_SHORT.indexOf(token);
            due = nextWeekday(now, idx);
            text = taken.text;
          }
        }
      }
    }
  }

  if (timeMatch) {
    const hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2] || 0);
    const mer = timeMatch[3] || (hours <= 7 ? "pm" : undefined);
    if (!due) {
      due = new Date(now);
      due.setHours(0, 0, 0, 0);
    }
    applyTime(due, hours, minutes, mer);
    if (due.getTime() < now.getTime() - 60 * 1000 && !/\btoday\b/i.test(input)) {
      due.setDate(due.getDate() + 1);
    }
    hasTime = true;
  }

  if (!due && result.recurrence) {
    due = new Date(now);
    due.setHours(0, 0, 0, 0);
  }

  result.dueAt = due ? due.getTime() : null;
  result.dueHasTime = hasTime;
  result.title = text.replace(/\s{2,}/g, " ").trim() || String(input || "").trim();
  return result;
}

export function addRecurrence(fromTs, recurrence) {
  const d = new Date(fromTs);
  if (recurrence === "daily") {
    d.setDate(d.getDate() + 1);
  } else if (recurrence === "weekly") {
    d.setDate(d.getDate() + 7);
  } else if (recurrence === "monthly") {
    d.setMonth(d.getMonth() + 1);
  } else if (recurrence === "yearly") {
    d.setFullYear(d.getFullYear() + 1);
  } else if (recurrence === "weekdays") {
    do {
      d.setDate(d.getDate() + 1);
    } while (d.getDay() === 0 || d.getDay() === 6);
  } else {
    const m = /^every:(\d+):days$/.exec(recurrence || "");
    if (m) d.setDate(d.getDate() + Number(m[1]));
    else d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

export function nextOccurrence(fromTs, recurrence, now = Date.now()) {
  let t = fromTs;
  let guard = 0;
  do {
    t = addRecurrence(t, recurrence);
    guard += 1;
  } while (t <= now && guard < 400);
  return t;
}
